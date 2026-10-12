import type { QueryClient } from "@tanstack/react-query";
import { enrichProductsWithCachedImages } from "@/lib/offline/image-cache";
import { getQueue, isTempId, type PendingOp } from "@/lib/offline/queue";
import { idbGet, idbSet, LOCAL_KEYS, writeOfflineMeta } from "@/lib/offline/storage";

/**
 * В локальном сторе держим только ссылки на фото — сами снимки лежат в отдельном
 * кэше изображений (IndexedDB). Иначе каталог писал десятки мегабайт data URL
 * при каждом сохранении.
 */
function stripEmbeddedImages<T extends { image_url?: string | null }>(products: T[]): T[] {
  let changed = false;
  const next = products.map((product) => {
    if (typeof product.image_url === "string" && product.image_url.startsWith("data:")) {
      changed = true;
      return {
        ...product,
        image_url: (product as { image_remote_url?: string | null }).image_remote_url ?? null,
      };
    }
    return product;
  });
  return changed ? next : products;
}

export async function saveLocalProducts(products: unknown[]): Promise<void> {
  await idbSet(
    LOCAL_KEYS.products,
    stripEmbeddedImages(products as Array<{ image_url?: string | null }>),
  );
}

export async function loadLocalProducts<T = any[]>(): Promise<T | null> {
  return idbGet<T>(LOCAL_KEYS.products);
}

/** Каталог для показа без сети: ссылки из стора + фотографии из кэша изображений. */
export async function loadLocalProductsWithImages<T = any[]>(): Promise<T | null> {
  const rows = await loadLocalProducts<any[]>();
  if (!rows?.length) return (rows as T) ?? null;
  return (await enrichProductsWithCachedImages(rows, { fetchMissing: false })) as T;
}

export async function saveLocalCategories(categories: unknown[]): Promise<void> {
  await idbSet(LOCAL_KEYS.categories, categories);
}

export async function loadLocalCategories<T = any[]>(): Promise<T | null> {
  return idbGet<T>(LOCAL_KEYS.categories);
}

export async function saveLocalTransactions(txs: unknown[]): Promise<void> {
  await idbSet(LOCAL_KEYS.transactions, txs);
}

export async function loadLocalTransactions<T = any[]>(): Promise<T | null> {
  return idbGet<T>(LOCAL_KEYS.transactions);
}

export async function saveLocalGemstones(gems: unknown[]): Promise<void> {
  await idbSet(LOCAL_KEYS.gemstones, gems);
}

export async function loadLocalGemstones<T = any[]>(): Promise<T | null> {
  return idbGet<T>(LOCAL_KEYS.gemstones);
}

/**
 * Наложить ещё не отправленные изменения из офлайн-очереди на данные сервера.
 * Без этого любой рефетч (обновление, возврат в приложение) затирал в интерфейсе
 * то, что пользователь только что сделал без сети.
 */
export async function applyPendingProductOps(products: any[]): Promise<any[]> {
  const ops = await getQueue();
  if (ops.length === 0) return products;

  const byId = new Map<string, any>(products.map((p) => [p.id, p]));

  for (const op of ops) {
    if (op.kind === "product.delete") {
      byId.delete(op.productId);
      continue;
    }

    if (op.kind === "product.insert") {
      const existing = byId.get(op.tempId);
      byId.set(op.tempId, {
        ...op.payload,
        id: op.tempId,
        image_url:
          op.imageDataUrl ??
          (typeof op.payload.image_url === "string" ? op.payload.image_url : null),
        created_at: existing?.created_at ?? op.createdAt,
        categories: existing?.categories ?? null,
        _pending: true,
      });
      continue;
    }

    if (op.kind === "product.update") {
      const existing = byId.get(op.productId);
      if (!existing && !isTempId(op.productId)) continue;
      const next: any = { ...(existing ?? {}), ...op.payload, id: op.productId, _pending: true };
      if (op.clearImage) next.image_url = null;
      else if (op.imageDataUrl) next.image_url = op.imageDataUrl;
      byId.set(op.productId, next);
    }
  }

  return [...byId.values()];
}

export async function applyPendingTransactionOps(txs: any[]): Promise<any[]> {
  const ops = await getQueue();
  if (ops.length === 0) return txs;

  let out = txs;
  const prepend: any[] = [];

  for (const op of ops) {
    if (op.kind === "transaction.delete") {
      out = out.filter((t) => t.id !== op.transactionId);
    } else if (op.kind === "transaction.insert") {
      if (out.some((t) => t.id === op.tempId)) continue;
      prepend.push({
        id: op.tempId,
        ...op.payload,
        created_at: op.payload.created_at ?? op.createdAt,
        _pending: true,
      });
    }
  }

  return prepend.length ? [...prepend, ...out] : out;
}

export async function applyPendingCategoryOps(categories: any[]): Promise<any[]> {
  const ops = await getQueue();
  const inserts = ops.filter(
    (op): op is Extract<PendingOp, { kind: "category.insert" }> => op.kind === "category.insert",
  );
  if (inserts.length === 0) return categories;

  const known = new Set(categories.map((c) => c.id));
  const extra = inserts
    .filter((op) => !known.has(op.tempId))
    .map((op) => ({ id: op.tempId, name: op.name, created_at: op.createdAt, _pending: true }));

  if (extra.length === 0) return categories;
  return [...categories, ...extra].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Сохранить снимок каталога: фото берём из локального кэша (без сети) и
 * оставляем сверху всё, что ещё не отправлено на сервер.
 */
export async function saveCatalogSnapshot(products: any[]): Promise<any[]> {
  const withPending = await applyPendingProductOps(products);
  const enriched = await enrichProductsWithCachedImages(withPending, { fetchMissing: false });

  const previous = (await loadLocalProducts<any[]>()) ?? [];
  const ids = new Set(enriched.map((p) => p.id));
  const localOnly = previous.filter((p) => isTempId(p.id) && !ids.has(p.id));
  const next = localOnly.length ? [...localOnly, ...enriched] : enriched;

  await saveLocalProducts(next);
  writeOfflineMeta({ lastSyncAt: new Date().toISOString(), lastError: null });
  return next;
}

export async function hydrateQueryClientFromLocal(queryClient: QueryClient): Promise<void> {
  const [products, categories, transactions, gemstones] = await Promise.all([
    loadLocalProductsWithImages<any[]>(),
    loadLocalCategories(),
    loadLocalTransactions(),
    loadLocalGemstones(),
  ]);

  const productsWithPending = products?.length ? await applyPendingProductOps(products) : [];

  if (productsWithPending.length && !queryClient.getQueryData(["products-full"])) {
    queryClient.setQueryData(["products-full"], productsWithPending);
  }
  if (productsWithPending.length && !queryClient.getQueryData(["products-min"])) {
    queryClient.setQueryData(
      ["products-min"],
      productsWithPending.map((p: any) => ({
        id: p.id,
        title: p.title,
        sku: p.sku,
        sale_price: p.sale_price,
        status: p.status,
        quantity: p.quantity,
        price_per_gram: p.price_per_gram,
        _pending: p._pending,
      })),
    );
  }
  if (categories?.length && !queryClient.getQueryData(["categories"])) {
    queryClient.setQueryData(["categories"], await applyPendingCategoryOps(categories));
  }
  if (transactions?.length && !queryClient.getQueryData(["transactions"])) {
    queryClient.setQueryData(["transactions"], await applyPendingTransactionOps(transactions));
  }
  if (gemstones?.length && !queryClient.getQueryData(["products-gemstones"])) {
    queryClient.setQueryData(["products-gemstones"], gemstones);
  }
}

export function patchProductsCache(queryClient: QueryClient, updater: (list: any[]) => any[]) {
  const full =
    queryClient.getQueryData<any[]>(["products-full"]) ??
    queryClient.getQueryData<any[]>(["products-min"]) ??
    [];
  const next = updater([...full]);
  queryClient.setQueryData(["products-full"], next);
  queryClient.setQueryData(
    ["products-min"],
    next.map((p: any) => ({
      id: p.id,
      title: p.title,
      sku: p.sku,
      sale_price: p.sale_price,
      status: p.status,
      quantity: p.quantity,
      price_per_gram: p.price_per_gram,
      _pending: p._pending,
    })),
  );
  void saveLocalProducts(next);
}

export function patchTransactionsCache(queryClient: QueryClient, updater: (list: any[]) => any[]) {
  const current = queryClient.getQueryData<any[]>(["transactions"]) ?? [];
  const next = updater([...current]).slice(0, 100);
  queryClient.setQueryData(["transactions"], next);
  void saveLocalTransactions(next);
}

export function patchCategoriesCache(queryClient: QueryClient, updater: (list: any[]) => any[]) {
  const current = queryClient.getQueryData<any[]>(["categories"]) ?? [];
  const next = updater([...current]);
  queryClient.setQueryData(["categories"], next);
  void saveLocalCategories(next);
}

export function applyLocalStockChange(
  queryClient: QueryClient,
  productId: string,
  type: string,
  direction: "apply" | "revert",
) {
  if (type === "consignment") return;

  patchProductsCache(queryClient, (list) =>
    list.map((p) => {
      if (p.id !== productId) return p;
      let qty =
        p.quantity != null
          ? Math.round(Number(p.quantity))
          : p.price_per_gram != null
            ? Math.round(Number(p.price_per_gram))
            : 1;
      let status = p.status;

      if (direction === "apply") {
        if (type === "sale") {
          qty = Math.max(0, qty - 1);
          if (qty === 0) status = "продано";
        } else if (type === "return") {
          qty += 1;
          status = "в наличии";
        } else if (type === "write-off") {
          qty = Math.max(0, qty - 1);
          if (qty === 0) status = "списано";
        }
      } else {
        if (type === "sale") {
          qty += 1;
          status = "в наличии";
        } else if (type === "return") {
          qty = Math.max(0, qty - 1);
          if (qty === 0) status = "продано";
        } else if (type === "write-off") {
          qty += 1;
          status = "в наличии";
        }
      }

      return {
        ...p,
        quantity: qty,
        price_per_gram: p.price_per_gram != null ? qty : p.price_per_gram,
        status,
      };
    }),
  );
}

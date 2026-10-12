import type { QueryClient } from "@tanstack/react-query";
import { enrichProductsWithCachedImages } from "@/lib/offline/image-cache";
import { idbGet, idbSet, LOCAL_KEYS, writeOfflineMeta } from "@/lib/offline/storage";

export async function saveLocalProducts(products: unknown[]): Promise<void> {
  await idbSet(LOCAL_KEYS.products, products);
}

export async function loadLocalProducts<T = any[]>(): Promise<T | null> {
  return idbGet<T>(LOCAL_KEYS.products);
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

/** Persist fetched catalog + cache images for offline APK use. */
export async function mirrorCatalogToLocal(products: any[]): Promise<any[]> {
  const enriched = await enrichProductsWithCachedImages(products, {
    fetchMissing: true,
    concurrency: 3,
  });
  await saveLocalProducts(enriched);
  writeOfflineMeta({ lastSyncAt: new Date().toISOString(), lastError: null });
  return enriched;
}

export async function hydrateQueryClientFromLocal(queryClient: QueryClient): Promise<void> {
  const [products, categories, transactions, gemstones] = await Promise.all([
    loadLocalProducts(),
    loadLocalCategories(),
    loadLocalTransactions(),
    loadLocalGemstones(),
  ]);

  if (products?.length && !queryClient.getQueryData(["products-full"])) {
    queryClient.setQueryData(["products-full"], products);
  }
  if (products?.length && !queryClient.getQueryData(["products-min"])) {
    queryClient.setQueryData(
      ["products-min"],
      products.map((p: any) => ({
        id: p.id,
        title: p.title,
        sku: p.sku,
        sale_price: p.sale_price,
        status: p.status,
        quantity: p.quantity,
        price_per_gram: p.price_per_gram,
      })),
    );
  }
  if (categories?.length && !queryClient.getQueryData(["categories"])) {
    queryClient.setQueryData(["categories"], categories);
  }
  if (transactions?.length && !queryClient.getQueryData(["transactions"])) {
    queryClient.setQueryData(["transactions"], transactions);
  }
  if (gemstones?.length && !queryClient.getQueryData(["products-gemstones"])) {
    queryClient.setQueryData(["products-gemstones"], gemstones);
  }
}

export function patchProductsCache(queryClient: QueryClient, updater: (list: any[]) => any[]) {
  const full = queryClient.getQueryData<any[]>(["products-full"])
    ?? queryClient.getQueryData<any[]>(["products-min"])
    ?? [];
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

      const saleLike = type === "sale" || type === "write-off";
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

      void saleLike;
      return {
        ...p,
        quantity: qty,
        price_per_gram: p.price_per_gram != null ? qty : p.price_per_gram,
        status,
      };
    }),
  );
}

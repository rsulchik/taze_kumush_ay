import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { putLocalImage, removeCachedImage } from "@/lib/offline/image-cache";
import {
  applyPendingCategoryOps,
  applyPendingTransactionOps,
  hydrateQueryClientFromLocal,
  patchProductsCache,
  patchTransactionsCache,
  saveLocalCategories,
  saveLocalGemstones,
  saveLocalTransactions,
} from "@/lib/offline/local-db";
import {
  errorMessage,
  isBrowserOnline,
  isNetworkError,
  onConnectivityChange,
} from "@/lib/offline/network";
import {
  clearOpErrors,
  dequeueById,
  getQueue,
  isTempId,
  updateOp,
  type PendingOp,
} from "@/lib/offline/queue";
import { idbGet, idbSet, LOCAL_KEYS, writeOfflineMeta } from "@/lib/offline/storage";
import { fetchAllGemstones, fetchProductsFull, mirrorImagesInBackground } from "@/lib/catalog";
import { deleteProductImageFromStorage, resolveProductImageUrl } from "@/lib/product-image";
import { applyTransactionQuantity, revertTransactionQuantity } from "@/lib/product-quantity";
import { alignStockField, isMissingColumnError, resetStockColumnProbe } from "@/lib/product-stock";

type ProductInsert = Database["public"]["Tables"]["products"]["Insert"];
type ProductUpdate = Database["public"]["Tables"]["products"]["Update"];

let syncing = false;
const tempIdMap = new Map<string, string>();

/** Постоянно падающие операции не блокируют очередь навсегда: раз в 10 минут пробуем снова. */
const BLOCKED_COOLDOWN_MS = 10 * 60 * 1000;
const RETRY_DELAYS = [30_000, 60_000, 120_000, 300_000, 300_000];

export type FlushResult = { ok: number; failed: number; blocked: number };

async function restoreTempIdMap(): Promise<void> {
  const stored = await idbGet<Record<string, string>>(LOCAL_KEYS.tempIdMap);
  for (const [tempId, serverId] of Object.entries(stored ?? {})) {
    tempIdMap.set(tempId, serverId);
  }
}

async function rememberTempId(tempId: string, serverId: string): Promise<void> {
  tempIdMap.set(tempId, serverId);
  await idbSet(LOCAL_KEYS.tempIdMap, Object.fromEntries(tempIdMap));
}

function resolveId(id: string | null | undefined): string | null {
  if (!id) return null;
  return tempIdMap.get(id) ?? id;
}

function tempIdOf(op: PendingOp): string | null {
  if (
    op.kind === "product.insert" ||
    op.kind === "category.insert" ||
    op.kind === "transaction.insert"
  ) {
    return op.tempId;
  }
  return null;
}

function referencedIds(op: PendingOp): string[] {
  const ids: Array<string | null | undefined> = [];
  if (op.kind === "product.insert") ids.push(op.payload.category_id as string | null | undefined);
  if (op.kind === "product.update") {
    ids.push(op.productId, op.payload.category_id as string | null | undefined);
  }
  if (op.kind === "product.delete") ids.push(op.productId);
  if (op.kind === "transaction.insert") ids.push(op.payload.product_id);
  if (op.kind === "transaction.delete") ids.push(op.productId);
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function dataUrlToFile(dataUrl: string, sku: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = blob.type.includes("png") ? "png" : "jpg";
  return new File([blob], `${sku || "product"}.${ext}`, { type: blob.type || "image/jpeg" });
}

async function resolveImageForSync(
  payload: Record<string, unknown>,
  imageDataUrl?: string | null,
): Promise<Record<string, unknown>> {
  const next = { ...payload };
  const sku = String(next.sku ?? "product");

  const uploadDataUrl = async (dataUrl: string) => {
    const file = await dataUrlToFile(dataUrl, sku);
    return resolveProductImageUrl(file, sku);
  };

  if (imageDataUrl?.startsWith("data:")) {
    try {
      next.image_url = await uploadDataUrl(imageDataUrl);
    } catch {
      // keep data URL in DB if upload fails
      next.image_url = imageDataUrl;
    }
  } else if (typeof next.image_url === "string" && next.image_url.startsWith("data:")) {
    try {
      next.image_url = await uploadDataUrl(next.image_url);
    } catch {
      // keep as-is
    }
  }

  return next;
}

/**
 * Запись изделия с защитой от несовпадения колонки остатка: если база ответила,
 * что колонки нет (схема изменилась / определение устарело), перепроверяем схему
 * и отправляем ещё раз — иначе операция навсегда застрянет в очереди.
 */
async function writeProductRow(
  kind: "insert" | "update",
  payload: Record<string, unknown>,
  productId?: string,
): Promise<{ fields: Record<string, unknown>; row: any }> {
  const send = async (fields: Record<string, unknown>) =>
    kind === "insert"
      ? await supabase
          .from("products")
          .insert(fields as ProductInsert)
          .select("*")
          .single()
      : await supabase
          .from("products")
          .update(fields as ProductUpdate)
          .eq("id", productId!);

  let fields = await alignStockField(payload);
  let result = (await send(fields)) as { data?: any; error?: any };

  if (result.error && isMissingColumnError(result.error)) {
    resetStockColumnProbe();
    fields = await alignStockField(payload);
    result = (await send(fields)) as { data?: any; error?: any };
  }

  if (result.error) throw result.error;
  return { fields, row: result.data ?? null };
}

function minProductRow(p: any) {
  return {
    id: p.id,
    title: p.title,
    sku: p.sku,
    sale_price: p.sale_price,
    status: p.status,
    quantity: p.quantity,
    price_per_gram: p.price_per_gram,
    _pending: p._pending,
  };
}

async function processOp(qc: QueryClient, op: PendingOp): Promise<void> {
  switch (op.kind) {
    case "category.insert": {
      const mapped = resolveId(op.tempId);
      if (mapped && !isTempId(mapped) && mapped !== op.tempId) {
        return;
      }
      const { data, error } = await supabase
        .from("categories")
        .insert({ name: op.name })
        .select()
        .single();
      if (error) throw error;
      await rememberTempId(op.tempId, data.id);
      const cats = (qc.getQueryData<any[]>(["categories"]) ?? []).map((c) =>
        c.id === op.tempId ? { ...c, id: data.id, _pending: false } : c,
      );
      qc.setQueryData(["categories"], cats);
      await saveLocalCategories(cats);
      // Remap category_id on products waiting in cache
      patchProductsCache(qc, (list) =>
        list.map((p) => (p.category_id === op.tempId ? { ...p, category_id: data.id } : p)),
      );
      return;
    }
    case "product.insert": {
      const payload = await resolveImageForSync(
        {
          ...op.payload,
          category_id: resolveId(op.payload.category_id as string | null) ?? op.payload.category_id,
        },
        op.imageDataUrl,
      );
      const { row: data } = await writeProductRow("insert", payload);
      if (!data?.id) throw new Error("Сервер не вернул созданное изделие");
      await rememberTempId(op.tempId, data.id);
      patchProductsCache(qc, (list) =>
        list.map((p) =>
          p.id === op.tempId ? { ...p, ...data, categories: p.categories, _pending: false } : p,
        ),
      );
      if (typeof data.image_url === "string") {
        if (data.image_url.startsWith("data:")) await putLocalImage(data.id, data.image_url);
        else if (op.imageDataUrl) await putLocalImage(data.id, op.imageDataUrl);
      }
      await removeCachedImage(op.tempId);
      return;
    }
    case "product.update": {
      const productId = resolveId(op.productId)!;
      if (isTempId(productId)) throw new Error("Товар ещё не синхронизирован");
      const payload = await resolveImageForSync(
        {
          ...op.payload,
          category_id: resolveId(op.payload.category_id as string | null) ?? op.payload.category_id,
        },
        op.imageDataUrl,
      );
      if (op.clearImage) payload.image_url = null;
      const { fields } = await writeProductRow("update", payload, productId);
      if (op.clearImage && op.previousImageUrl) {
        await deleteProductImageFromStorage(op.previousImageUrl);
      } else if (
        fields.image_url &&
        op.previousImageUrl &&
        fields.image_url !== op.previousImageUrl
      ) {
        await deleteProductImageFromStorage(op.previousImageUrl);
      }
      patchProductsCache(qc, (list) =>
        list.map((p) => (p.id === op.productId ? { ...p, _pending: false } : p)),
      );
      return;
    }
    case "product.delete": {
      const productId = resolveId(op.productId)!;
      if (isTempId(productId)) {
        // never reached server — nothing to delete remotely
        return;
      }
      const { error } = await supabase.from("products").delete().eq("id", productId);
      if (error) throw error;
      await deleteProductImageFromStorage(op.imageUrl ?? null);
      return;
    }
    case "transaction.insert": {
      const productId = resolveId(op.payload.product_id);
      const { data, error } = await supabase
        .from("transactions")
        .insert({
          product_id: productId,
          type: op.payload.type,
          final_price: op.payload.final_price,
          employee_name: op.payload.employee_name,
          notes: op.payload.notes,
        })
        .select("id")
        .single();
      if (error) throw error;
      // Без этой записи операцию, созданную офлайн, нельзя потом удалить/исправить.
      if (data?.id) {
        await rememberTempId(op.tempId, data.id);
        patchTransactionsCache(qc, (list) =>
          list.map((t) => (t.id === op.tempId ? { ...t, id: data.id, _pending: false } : t)),
        );
      }
      if (productId) await applyTransactionQuantity(productId, op.payload.type);
      return;
    }
    case "transaction.delete": {
      const txId = resolveId(op.transactionId)!;
      if (isTempId(txId)) return;
      const { error } = await supabase.from("transactions").delete().eq("id", txId);
      if (error) throw error;
      const productId = resolveId(op.productId);
      if (productId) await revertTransactionQuantity(productId, op.type);
      return;
    }
  }
}

async function countBlocked(): Promise<number> {
  const queue = await getQueue();
  return queue.filter((op) => op.blockedAt).length;
}

/**
 * Отправить очередь на сервер.
 *
 * Ошибка связи останавливает проход (порядок операций важен), а ошибка сервера
 * (например, неверные данные) помечает только свою операцию и пропускает
 * остальные — одна «битая» запись больше не замораживает всю синхронизацию.
 */
export async function flushOfflineQueue(qc: QueryClient): Promise<FlushResult> {
  if (!isBrowserOnline() || syncing) {
    return { ok: 0, failed: 0, blocked: await countBlocked() };
  }
  syncing = true;
  let ok = 0;
  let failed = 0;

  try {
    await restoreTempIdMap();
    const queue = await getQueue();
    const blockedTempIds = new Set<string>();

    for (const op of queue) {
      const blockedAt = op.blockedAt ? Date.parse(op.blockedAt) : 0;
      const cooldownOver = blockedAt > 0 && Date.now() - blockedAt > BLOCKED_COOLDOWN_MS;

      if (op.blockedAt && !cooldownOver) {
        const tempId = tempIdOf(op);
        if (tempId) blockedTempIds.add(tempId);
        continue;
      }

      if (referencedIds(op).some((id) => blockedTempIds.has(id))) {
        // Операция зависит от неудачной — подождём её.
        continue;
      }

      try {
        await processOp(qc, op);
        await dequeueById(op.id);
        ok += 1;
      } catch (err) {
        const message = errorMessage(err) || "неизвестная ошибка";
        const transient = isNetworkError(err);
        failed += 1;
        writeOfflineMeta({ lastError: message });
        await updateOp(op.id, {
          attempts: (op.attempts ?? 0) + 1,
          lastError: message,
          blockedAt: transient ? null : new Date().toISOString(),
        });
        if (transient) break;
        const tempId = tempIdOf(op);
        if (tempId) blockedTempIds.add(tempId);
      }
    }

    if (ok > 0 && failed === 0) {
      writeOfflineMeta({ lastSyncAt: new Date().toISOString(), lastError: null });
    }
  } finally {
    syncing = false;
  }

  return { ok, failed, blocked: await countBlocked() };
}

export async function pullFromServer(qc: QueryClient): Promise<void> {
  if (!isBrowserOnline()) return;

  try {
    resetStockColumnProbe();

    const products = await fetchProductsFull();
    qc.setQueryData(["products-full"], products);
    qc.setQueryData(["products-min"], products.map(minProductRow));
    mirrorImagesInBackground(qc, products);

    const { data: cats, error: catsError } = await supabase
      .from("categories")
      .select("*")
      .order("name");
    if (catsError) throw catsError;
    if (cats) {
      const merged = await applyPendingCategoryOps(cats);
      qc.setQueryData(["categories"], merged);
      await saveLocalCategories(merged);
    }

    const { data: txs, error: txsError } = await supabase
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (txsError) throw txsError;
    if (txs) {
      const merged = await applyPendingTransactionOps(txs);
      qc.setQueryData(["transactions"], merged);
      await saveLocalTransactions(merged);
    }

    try {
      const gems = await fetchAllGemstones();
      qc.setQueryData(["products-gemstones"], gems);
      await saveLocalGemstones(gems);
    } catch {
      // optional
    }

    writeOfflineMeta({ lastSyncAt: new Date().toISOString(), lastError: null });
  } catch (err) {
    writeOfflineMeta({ lastError: errorMessage(err) });
  }
}

export async function syncNow(
  qc: QueryClient,
  opts?: { retryBlocked?: boolean },
): Promise<FlushResult> {
  if (!isBrowserOnline()) {
    return { ok: 0, failed: 0, blocked: await countBlocked() };
  }

  if (opts?.retryBlocked) await clearOpErrors();

  const result = await flushOfflineQueue(qc);

  // Тянем данные сервера, даже если часть операций застряла: не отправленные
  // локальные правки сохраняются поверх ответа сервера (см. applyPendingProductOps).
  if (result.failed === 0) {
    await pullFromServer(qc);
  }

  return result;
}

let stopSync: (() => void) | null = null;

export function startOfflineSync(qc: QueryClient): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (stopSync) return stopSync;

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryStep = 0;
  let stopped = false;

  const scheduleRetry = (failed: number) => {
    if (stopped) return;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryStep = failed > 0 ? Math.min(retryStep + 1, RETRY_DELAYS.length - 1) : 0;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void run();
    }, RETRY_DELAYS[retryStep]);
  };

  const run = async (retryBlocked = false) => {
    if (stopped) return;
    if (!isBrowserOnline()) {
      // Событие «online» на телефонах приходит не всегда — проверяем сами.
      scheduleRetry(1);
      return;
    }
    const result = await syncNow(qc, { retryBlocked });
    scheduleRetry(result.failed);
  };

  void (async () => {
    await restoreTempIdMap();
    await hydrateQueryClientFromLocal(qc);
    await run();
  })();

  const unsub = onConnectivityChange((online) => {
    if (online) {
      retryStep = 0;
      void run(true);
    }
  });

  const onVisible = () => {
    if (document.visibilityState === "visible" && isBrowserOnline()) {
      void run();
    }
  };
  document.addEventListener("visibilitychange", onVisible);

  stopSync = () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    unsub();
    document.removeEventListener("visibilitychange", onVisible);
    stopSync = null;
  };

  return stopSync;
}

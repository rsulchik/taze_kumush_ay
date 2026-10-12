import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { putLocalImage, removeCachedImage } from "@/lib/offline/image-cache";
import { hydrateQueryClientFromLocal, patchProductsCache, saveLocalCategories, saveLocalGemstones, saveLocalTransactions } from "@/lib/offline/local-db";
import { isBrowserOnline, onConnectivityChange } from "@/lib/offline/network";
import { dequeueById, getQueue, isTempId, type PendingOp } from "@/lib/offline/queue";
import { idbGet, idbSet, LOCAL_KEYS, writeOfflineMeta } from "@/lib/offline/storage";
import { fetchAllGemstones, fetchProductsFull } from "@/lib/catalog";
import { deleteProductImageFromStorage, resolveProductImageUrl } from "@/lib/product-image";
import { applyTransactionQuantity, revertTransactionQuantity } from "@/lib/product-quantity";

let syncing = false;
let started = false;
const tempIdMap = new Map<string, string>();

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

  if (imageDataUrl?.startsWith("data:")) {
    try {
      const file = await dataUrlToFile(imageDataUrl, sku);
      next.image_url = await resolveProductImageUrl(file, sku);
    } catch {
      // keep data URL in DB if upload fails
      next.image_url = imageDataUrl;
    }
  } else if (typeof next.image_url === "string" && next.image_url.startsWith("data:")) {
    try {
      const file = await dataUrlToFile(next.image_url, sku);
      next.image_url = await resolveProductImageUrl(file, sku);
    } catch {
      // keep as-is
    }
  }

  return next;
}

async function processOp(qc: QueryClient, op: PendingOp): Promise<void> {
  switch (op.kind) {
    case "category.insert": {
      const mapped = resolveId(op.tempId);
      if (mapped && !isTempId(mapped) && mapped !== op.tempId) {
        return;
      }
      const { data, error } = await supabase.from("categories").insert({ name: op.name }).select().single();
      if (error) throw error;
      await rememberTempId(op.tempId, data.id);
      const cats = (qc.getQueryData<any[]>(["categories"]) ?? []).map((c) =>
        c.id === op.tempId ? { ...c, id: data.id } : c,
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
      const { data, error } = await supabase.from("products").insert(payload).select("*").single();
      if (error) throw error;
      await rememberTempId(op.tempId, data.id);
      patchProductsCache(qc, (list) =>
        list.map((p) => (p.id === op.tempId ? { ...p, ...data, categories: p.categories } : p)),
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
      const { error } = await supabase.from("products").update(payload).eq("id", productId);
      if (error) throw error;
      if (op.clearImage && op.previousImageUrl) {
        await deleteProductImageFromStorage(op.previousImageUrl);
      } else if (payload.image_url && op.previousImageUrl && payload.image_url !== op.previousImageUrl) {
        await deleteProductImageFromStorage(op.previousImageUrl);
      }
      return;
    }
    case "product.delete": {
      const productId = resolveId(op.productId)!;
      if (isTempId(productId)) {
        // never reached server — nothing to delete remotely
        return;
      }
      await deleteProductImageFromStorage(op.imageUrl ?? null);
      const { error } = await supabase.from("products").delete().eq("id", productId);
      if (error) throw error;
      return;
    }
    case "transaction.insert": {
      const productId = resolveId(op.payload.product_id);
      const { error } = await supabase.from("transactions").insert({
        product_id: productId,
        type: op.payload.type,
        final_price: op.payload.final_price,
        employee_name: op.payload.employee_name,
        notes: op.payload.notes,
      });
      if (error) throw error;
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

export async function flushOfflineQueue(qc: QueryClient): Promise<{ ok: number; failed: number }> {
  if (!isBrowserOnline() || syncing) return { ok: 0, failed: 0 };
  syncing = true;
  let ok = 0;
  let failed = 0;

  try {
    await restoreTempIdMap();
    const queue = await getQueue();
    for (const op of queue) {
      try {
        await processOp(qc, op);
        await dequeueById(op.id);
        ok += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        writeOfflineMeta({ lastError: message });
        // Stop on first failure to preserve order (temp id mapping)
        break;
      }
    }

    if (ok > 0 && failed === 0) {
      writeOfflineMeta({ lastSyncAt: new Date().toISOString(), lastError: null });
    }
  } finally {
    syncing = false;
  }

  return { ok, failed };
}

export async function pullFromServer(qc: QueryClient): Promise<void> {
  if (!isBrowserOnline()) return;

  try {
    const products = await fetchProductsFull();
    qc.setQueryData(["products-full"], products);
    qc.setQueryData(
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

    const { data: cats } = await supabase.from("categories").select("*").order("name");
    if (cats) {
      qc.setQueryData(["categories"], cats);
      await saveLocalCategories(cats);
    }

    const { data: txs } = await supabase
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (txs) {
      qc.setQueryData(["transactions"], txs);
      await saveLocalTransactions(txs);
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
    const message = err instanceof Error ? err.message : String(err);
    writeOfflineMeta({ lastError: message });
  }
}

export async function syncNow(qc: QueryClient): Promise<void> {
  if (!isBrowserOnline()) return;
  await flushOfflineQueue(qc);
  const remaining = await getQueue();
  if (remaining.length === 0) {
    await pullFromServer(qc);
  }
}

export function startOfflineSync(qc: QueryClient): () => void {
  if (started || typeof window === "undefined") return () => undefined;
  started = true;

  void (async () => {
    await restoreTempIdMap();
    await hydrateQueryClientFromLocal(qc);
    if (isBrowserOnline()) {
      await syncNow(qc);
    }
  })();

  const unsub = onConnectivityChange((online) => {
    if (online) void syncNow(qc);
  });

  const onVisible = () => {
    if (document.visibilityState === "visible" && isBrowserOnline()) {
      void syncNow(qc);
    }
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    started = false;
    unsub();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

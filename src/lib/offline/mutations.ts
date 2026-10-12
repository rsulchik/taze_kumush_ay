import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { putLocalImage, removeCachedImage } from "@/lib/offline/image-cache";
import {
  applyLocalStockChange,
  patchCategoriesCache,
  patchProductsCache,
  patchTransactionsCache,
} from "@/lib/offline/local-db";
import { isBrowserOnline, isNetworkError } from "@/lib/offline/network";
import { enqueue, isTempId, newOpId, newTempId, removeOps } from "@/lib/offline/queue";
import {
  compressImageToDataUrl,
  deleteProductImageFromStorage,
  resolveProductImageUrl,
} from "@/lib/product-image";
import { applyTransactionQuantity, revertTransactionQuantity } from "@/lib/product-quantity";
import { stockInsertField, stockUpdateField } from "@/lib/product-stock";

type ProductInsert = Database["public"]["Tables"]["products"]["Insert"];
type ProductUpdate = Database["public"]["Tables"]["products"]["Update"];
type TransactionInsert = Database["public"]["Tables"]["transactions"]["Insert"];
type StockFields = { quantity?: number; price_per_gram?: number };

async function fileToOfflineDataUrl(file: File): Promise<string> {
  const dataUrl = await compressImageToDataUrl(file, 1000, 0.78);
  if (dataUrl.length > 850_000) {
    return compressImageToDataUrl(file, 720, 0.65);
  }
  return dataUrl;
}

export type ProductSaveInput = {
  isEdit: boolean;
  productId?: string;
  initialImageUrl?: string | null;
  form: {
    title: string;
    sku: string;
    category_id: string;
    metal_type: string;
    assay: string;
    size: string;
    total_weight: string;
    metal_weight: string;
    cost_price: string;
    sale_price: string;
    status: string;
    quantity: string;
    description: string;
  };
  imageFile: File | null;
  imagePreview: string | null;
};

/** Фото: онлайн — в Storage, офлайн (или если Storage недоступен) — data URL в базе. */
async function resolveImageForSave(
  file: File,
): Promise<{ imageUrl: string | null; imageDataUrl: string | null }> {
  if (isBrowserOnline()) {
    try {
      const uploaded = await resolveProductImageUrl(file, "product");
      if (uploaded.startsWith("data:")) return { imageUrl: uploaded, imageDataUrl: uploaded };
      return { imageUrl: uploaded, imageDataUrl: null };
    } catch {
      // сеть отпала или Storage не настроен — работаем как офлайн
    }
  }
  const dataUrl = await fileToOfflineDataUrl(file);
  return { imageUrl: dataUrl, imageDataUrl: dataUrl };
}

export async function saveProductOfflineAware(qc: QueryClient, input: ProductSaveInput) {
  const quantity = parseInt(input.form.quantity, 10);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Укажите корректное количество (0 или больше).");
  }
  if (input.form.status === "в наличии" && quantity < 1) {
    throw new Error("Для статуса «в наличии» количество должно быть не меньше 1.");
  }

  let image_url: string | null | undefined = undefined;
  let imageDataUrl: string | null = null;

  if (input.imageFile) {
    const resolved = await resolveImageForSave(input.imageFile);
    image_url = resolved.imageUrl;
    imageDataUrl = resolved.imageDataUrl;
  } else if (input.isEdit && !input.imagePreview && input.initialImageUrl) {
    image_url = null;
  }

  const stock: StockFields = (
    input.isEdit
      ? await stockUpdateField(quantity).catch(() => ({ quantity }))
      : await stockInsertField(quantity).catch(() => ({ quantity }))
  ) as StockFields;

  const payload: ProductInsert = {
    title: input.form.title.trim(),
    sku: input.form.sku.trim(),
    category_id: input.form.category_id || null,
    metal_type: input.form.metal_type,
    assay: parseInt(input.form.assay, 10),
    size: input.form.size ? parseFloat(input.form.size) : null,
    total_weight: parseFloat(input.form.total_weight),
    metal_weight: parseFloat(input.form.metal_weight),
    cost_price: input.form.cost_price ? parseFloat(input.form.cost_price) : null,
    sale_price: parseFloat(input.form.sale_price),
    status: input.form.status,
    ...stock,
    description: input.form.description || null,
    ...(image_url !== undefined ? { image_url } : {}),
  };

  const canTryServer = isBrowserOnline() && !(input.isEdit && isTempId(input.productId));

  if (input.isEdit && input.productId) {
    if (canTryServer) {
      const { error } = await supabase
        .from("products")
        .update(payload as ProductUpdate)
        .eq("id", input.productId);
      if (!error) {
        if (
          input.initialImageUrl &&
          (image_url === null ||
            (typeof image_url === "string" && image_url !== input.initialImageUrl))
        ) {
          await deleteProductImageFromStorage(input.initialImageUrl);
        }
        patchProductsCache(qc, (list) =>
          list.map((p) => {
            if (p.id !== input.productId) return p;
            const next: any = { ...p, ...payload, _pending: false };
            if (image_url !== undefined) next.image_url = image_url;
            return next;
          }),
        );
        if (typeof image_url === "string" && image_url.startsWith("data:")) {
          await putLocalImage(input.productId, image_url);
        }
        if (image_url === null) await removeCachedImage(input.productId);
        return { offline: false };
      }
      if (!isNetworkError(error)) throw error;
      // связь пропала — сохраняем в очередь ниже
    }

    await enqueue({
      id: newOpId(),
      createdAt: new Date().toISOString(),
      kind: "product.update",
      productId: input.productId,
      payload: payload as Record<string, unknown>,
      imageDataUrl:
        imageDataUrl ??
        (typeof image_url === "string" && image_url.startsWith("data:") ? image_url : undefined),
      clearImage: image_url === null,
      previousImageUrl: input.initialImageUrl ?? null,
    });

    patchProductsCache(qc, (list) =>
      list.map((p) => {
        if (p.id !== input.productId) return p;
        const next: any = { ...p, ...payload, _pending: true };
        if (image_url !== undefined) next.image_url = image_url;
        return next;
      }),
    );
    if (typeof image_url === "string" && image_url.startsWith("data:")) {
      await putLocalImage(input.productId, image_url);
    }
    if (image_url === null) await removeCachedImage(input.productId);
    return { offline: true };
  }

  // insert
  const insertPayload: ProductInsert = { ...payload, image_url: image_url ?? null };

  if (canTryServer) {
    const { data, error } = await supabase
      .from("products")
      .insert(insertPayload)
      .select("*")
      .single();
    if (!error && data) {
      patchProductsCache(qc, (list) => [{ ...data, categories: null, _pending: false }, ...list]);
      if (typeof data.image_url === "string" && data.image_url.startsWith("data:")) {
        await putLocalImage(data.id, data.image_url);
      }
      return { offline: false, id: data.id };
    }
    if (error && !isNetworkError(error)) throw error;
  }

  const tempId = newTempId();
  const localRow = {
    id: tempId,
    ...insertPayload,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    categories: null,
    _pending: true,
  };

  await enqueue({
    id: newOpId(),
    createdAt: new Date().toISOString(),
    kind: "product.insert",
    tempId,
    payload: insertPayload as Record<string, unknown>,
    imageDataUrl:
      imageDataUrl ??
      (typeof insertPayload.image_url === "string" && insertPayload.image_url.startsWith("data:")
        ? insertPayload.image_url
        : null),
  });
  patchProductsCache(qc, (list) => [localRow, ...list]);
  if (typeof insertPayload.image_url === "string" && insertPayload.image_url.startsWith("data:")) {
    await putLocalImage(tempId, insertPayload.image_url);
  }
  return { offline: true, id: tempId };
}

export async function deleteProductOfflineAware(
  qc: QueryClient,
  product: { id: string; image_url?: string | null; image_remote_url?: string | null },
) {
  const imageUrl = product.image_remote_url ?? product.image_url ?? null;
  const localOnly = isTempId(product.id);
  const canTryServer = isBrowserOnline() && !localOnly;
  let sent = false;

  if (localOnly) {
    // Товар ещё не был на сервере: убираем его из очереди, удалять нечего.
    await removeOps(
      (op) =>
        (op.kind === "product.insert" && op.tempId === product.id) ||
        (op.kind === "product.update" && op.productId === product.id),
    );
  } else if (canTryServer) {
    const { error } = await supabase.from("products").delete().eq("id", product.id);
    if (!error) {
      sent = true;
      await deleteProductImageFromStorage(imageUrl);
    } else if (!isNetworkError(error)) {
      throw error;
    }
  }

  if (!localOnly && !sent) {
    await enqueue({
      id: newOpId(),
      createdAt: new Date().toISOString(),
      kind: "product.delete",
      productId: product.id,
      imageUrl,
    });
  }

  patchProductsCache(qc, (list) => list.filter((p) => p.id !== product.id));
  await removeCachedImage(product.id);
  return { offline: !sent };
}

export async function addCategoryOfflineAware(qc: QueryClient, name: string) {
  if (isBrowserOnline()) {
    const { data, error } = await supabase.from("categories").insert({ name }).select().single();
    if (!error && data) {
      patchCategoriesCache(qc, (list) =>
        [...list, data].sort((a, b) => a.name.localeCompare(b.name)),
      );
      return { offline: false, category: data };
    }
    if (error && !isNetworkError(error)) throw error;
  }

  const tempId = newTempId();
  const cat = { id: tempId, name, created_at: new Date().toISOString(), _pending: true };
  await enqueue({
    id: newOpId(),
    createdAt: new Date().toISOString(),
    kind: "category.insert",
    tempId,
    name,
  });
  patchCategoriesCache(qc, (list) => [...list, cat].sort((a, b) => a.name.localeCompare(b.name)));
  return { offline: true, category: cat };
}

export async function saveTransactionOfflineAware(
  qc: QueryClient,
  form: {
    product_id: string;
    type: string;
    final_price: string;
    employee_name: string;
    notes: string;
  },
) {
  const payload: TransactionInsert = {
    product_id: form.product_id || null,
    type: form.type,
    final_price: parseFloat(form.final_price),
    employee_name: form.employee_name || null,
    notes: form.notes || null,
  };

  const canTryServer = isBrowserOnline() && !(form.product_id && isTempId(form.product_id));

  if (canTryServer) {
    const { data, error } = await supabase
      .from("transactions")
      .insert(payload)
      .select("id")
      .single();
    if (!error && data) {
      if (form.product_id) {
        await applyTransactionQuantity(form.product_id, form.type).catch(() => undefined);
        applyLocalStockChange(qc, form.product_id, form.type, "apply");
      }
      patchTransactionsCache(qc, (list) => [
        { id: data.id, ...payload, created_at: new Date().toISOString() },
        ...list,
      ]);
      return { offline: false };
    }
    if (error && !isNetworkError(error)) throw error;
  }

  const tempId = newTempId();
  await enqueue({
    id: newOpId(),
    createdAt: new Date().toISOString(),
    kind: "transaction.insert",
    tempId,
    payload: {
      product_id: payload.product_id ?? null,
      type: payload.type,
      final_price: payload.final_price,
      employee_name: payload.employee_name ?? null,
      notes: payload.notes ?? null,
      created_at: new Date().toISOString(),
    },
  });
  patchTransactionsCache(qc, (list) => [
    {
      id: tempId,
      ...payload,
      created_at: new Date().toISOString(),
      _pending: true,
    },
    ...list,
  ]);
  if (form.product_id) applyLocalStockChange(qc, form.product_id, form.type, "apply");
  return { offline: true };
}

export async function deleteTransactionOfflineAware(
  qc: QueryClient,
  tx: { id: string; product_id: string | null; type: string },
) {
  const localOnly = isTempId(tx.id);
  const canTryServer = isBrowserOnline() && !localOnly;
  let sent = false;

  if (localOnly) {
    await removeOps((op) => op.kind === "transaction.insert" && op.tempId === tx.id);
  } else if (canTryServer) {
    const { error } = await supabase.from("transactions").delete().eq("id", tx.id);
    if (!error) {
      sent = true;
      if (tx.product_id) {
        await revertTransactionQuantity(tx.product_id, tx.type).catch(() => undefined);
      }
    } else if (!isNetworkError(error)) {
      throw error;
    }
  }

  if (!localOnly && !sent) {
    await enqueue({
      id: newOpId(),
      createdAt: new Date().toISOString(),
      kind: "transaction.delete",
      transactionId: tx.id,
      productId: tx.product_id,
      type: tx.type,
    });
  }

  patchTransactionsCache(qc, (list) => list.filter((t) => t.id !== tx.id));
  if (tx.product_id) applyLocalStockChange(qc, tx.product_id, tx.type, "revert");
  return { offline: !sent };
}

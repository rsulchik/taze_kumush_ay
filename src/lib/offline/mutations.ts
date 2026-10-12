import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { putLocalImage, removeCachedImage } from "@/lib/offline/image-cache";
import {
  applyLocalStockChange,
  patchCategoriesCache,
  patchProductsCache,
  patchTransactionsCache,
} from "@/lib/offline/local-db";
import { isBrowserOnline } from "@/lib/offline/network";
import { enqueue, isTempId, newOpId, newTempId } from "@/lib/offline/queue";
import {
  compressImageToDataUrl,
  deleteProductImageFromStorage,
  resolveProductImageUrl,
} from "@/lib/product-image";
import { applyTransactionQuantity, revertTransactionQuantity } from "@/lib/product-quantity";
import { stockInsertField, stockUpdateField } from "@/lib/product-stock";

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

export async function saveProductOfflineAware(qc: QueryClient, input: ProductSaveInput) {
  const quantity = parseInt(input.form.quantity, 10);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("Укажите корректное количество (0 или больше).");
  }
  if (input.form.status === "в наличии" && quantity < 1) {
    throw new Error("Для статуса «в наличии» количество должно быть не меньше 1.");
  }

  let image_url: string | null | undefined = undefined;
  let imageDataUrl: string | null | undefined = undefined;

  if (input.imageFile) {
    if (isBrowserOnline()) {
      try {
        image_url = await resolveProductImageUrl(input.imageFile, input.form.sku.trim());
      } catch {
        image_url = await fileToOfflineDataUrl(input.imageFile);
      }
    } else {
      image_url = await fileToOfflineDataUrl(input.imageFile);
      imageDataUrl = image_url;
    }
  } else if (input.isEdit && !input.imagePreview && input.initialImageUrl) {
    image_url = null;
  }

  const stock = input.isEdit ? await stockUpdateField(quantity).catch(() => ({ quantity })) : await stockInsertField(quantity).catch(() => ({ quantity }));

  const payload: Record<string, unknown> = {
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

  const online = isBrowserOnline();

  if (input.isEdit && input.productId) {
    if (online && !isTempId(input.productId)) {
      const { error } = await supabase.from("products").update(payload).eq("id", input.productId);
      if (error) throw error;
      if (image_url != null && input.initialImageUrl && image_url !== input.initialImageUrl) {
        await deleteProductImageFromStorage(input.initialImageUrl);
      }
      if (image_url === null && input.initialImageUrl) {
        await deleteProductImageFromStorage(input.initialImageUrl);
      }
    } else {
      await enqueue({
        id: newOpId(),
        createdAt: new Date().toISOString(),
        kind: "product.update",
        productId: input.productId,
        payload,
        imageDataUrl: imageDataUrl ?? (typeof image_url === "string" && image_url.startsWith("data:") ? image_url : undefined),
        clearImage: image_url === null,
        previousImageUrl: input.initialImageUrl ?? null,
      });
    }

    patchProductsCache(qc, (list) =>
      list.map((p) => {
        if (p.id !== input.productId) return p;
        const next = { ...p, ...payload };
        if (image_url !== undefined) next.image_url = image_url;
        return next;
      }),
    );
    if (typeof image_url === "string" && image_url.startsWith("data:")) {
      await putLocalImage(input.productId, image_url);
    }
    if (image_url === null) await removeCachedImage(input.productId);
    return { offline: !online || isTempId(input.productId) };
  }

  // insert
  const tempId = newTempId();
  const insertPayload = {
    ...payload,
    image_url: image_url ?? null,
  };

  if (online) {
    const { data, error } = await supabase.from("products").insert(insertPayload).select("*").single();
    if (error) throw error;
    const row = {
      ...data,
      categories: null,
    };
    patchProductsCache(qc, (list) => [row, ...list]);
    if (typeof data.image_url === "string" && data.image_url.startsWith("data:")) {
      await putLocalImage(data.id, data.image_url);
    }
    return { offline: false, id: data.id };
  }

  const localRow = {
    id: tempId,
    ...insertPayload,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    categories: null,
  };
  await enqueue({
    id: newOpId(),
    createdAt: new Date().toISOString(),
    kind: "product.insert",
    tempId,
    payload: insertPayload,
    imageDataUrl: typeof insertPayload.image_url === "string" && insertPayload.image_url.startsWith("data:")
      ? insertPayload.image_url
      : imageDataUrl ?? null,
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
  const online = isBrowserOnline() && !isTempId(product.id);

  if (online) {
    await deleteProductImageFromStorage(imageUrl);
    const { error } = await supabase.from("products").delete().eq("id", product.id);
    if (error) throw error;
  } else {
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
  return { offline: !online };
}

export async function addCategoryOfflineAware(qc: QueryClient, name: string) {
  if (isBrowserOnline()) {
    const { data, error } = await supabase.from("categories").insert({ name }).select().single();
    if (error) throw error;
    patchCategoriesCache(qc, (list) => [...list, data].sort((a, b) => a.name.localeCompare(b.name)));
    return { offline: false, category: data };
  }

  const tempId = newTempId();
  const cat = { id: tempId, name, created_at: new Date().toISOString() };
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
  const payload = {
    product_id: form.product_id || null,
    type: form.type,
    final_price: parseFloat(form.final_price),
    employee_name: form.employee_name || null,
    notes: form.notes || null,
  };

  const online = isBrowserOnline() && !(form.product_id && isTempId(form.product_id));

  if (online) {
    const { error } = await supabase.from("transactions").insert(payload);
    if (error) throw error;
    if (form.product_id) await applyTransactionQuantity(form.product_id, form.type);
    applyLocalStockChange(qc, form.product_id, form.type, "apply");
    // refresh list from server on next invalidate; also optimistic prepend
    patchTransactionsCache(qc, (list) => [
      {
        id: crypto.randomUUID(),
        ...payload,
        created_at: new Date().toISOString(),
      },
      ...list,
    ]);
    return { offline: false };
  }

  const tempId = newTempId();
  await enqueue({
    id: newOpId(),
    createdAt: new Date().toISOString(),
    kind: "transaction.insert",
    tempId,
    payload: { ...payload, created_at: new Date().toISOString() },
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
  const online = isBrowserOnline() && !isTempId(tx.id);

  if (online) {
    const { error } = await supabase.from("transactions").delete().eq("id", tx.id);
    if (error) throw error;
    if (tx.product_id) await revertTransactionQuantity(tx.product_id, tx.type);
  } else {
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
  return { offline: !online };
}

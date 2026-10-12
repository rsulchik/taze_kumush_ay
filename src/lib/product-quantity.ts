import { supabase } from "@/integrations/supabase/client";
import { detectStockColumn, getProductStock, stockUpdateField } from "@/lib/product-stock";

async function fetchProductStockRow(productId: string) {
  const useQty = await detectStockColumn();
  const fields = useQty ? "quantity, status" : "price_per_gram, status";
  return supabase.from("products").select(fields).eq("id", productId).single();
}

/** Учёт остатка при создании операции. */
export async function applyTransactionQuantity(productId: string, type: string): Promise<void> {
  if (type === "consignment") return;

  const { data: p, error } = await fetchProductStockRow(productId);
  if (error || !p) return;

  let qty = getProductStock(p);
  let status = p.status;

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

  const stock = await stockUpdateField(qty);
  await supabase.from("products").update({ ...stock, status }).eq("id", productId);
}

/** Откат остатка при удалении операции. */
export async function revertTransactionQuantity(productId: string, type: string): Promise<void> {
  if (type === "consignment") return;

  const { data: p, error } = await fetchProductStockRow(productId);
  if (error || !p) return;

  let qty = getProductStock(p);
  let status = p.status;

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

  const stock = await stockUpdateField(qty);
  await supabase.from("products").update({ ...stock, status }).eq("id", productId);
}

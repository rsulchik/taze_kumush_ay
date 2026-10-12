import { supabase } from "@/integrations/supabase/client";
import { isBrowserOnline } from "@/lib/offline/network";
import { loadLocalProducts } from "@/lib/offline/local-db";

/** true = колонка quantity, false = временно price_per_gram (пока не выполнен SQL-миграция) */
let useQuantityColumn: boolean | null = null;

export function isMissingColumnError(error: unknown, column?: string): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  if (!/does not exist|column.*not found/i.test(message)) return false;
  if (!column) return true;
  return new RegExp(`\\b${column}\\b`, "i").test(message);
}

export async function detectStockColumn(): Promise<boolean> {
  if (useQuantityColumn !== null) return useQuantityColumn;
  if (!isBrowserOnline()) {
    useQuantityColumn = true;
    return useQuantityColumn;
  }
  try {
    const { error } = await supabase.from("products").select("quantity").limit(1);
    useQuantityColumn = !error;
  } catch {
    useQuantityColumn = true;
  }
  return useQuantityColumn;
}

export function getStockSelectField(): "quantity" | "price_per_gram" | null {
  if (useQuantityColumn === true) return "quantity";
  if (useQuantityColumn === false) return "price_per_gram";
  return null;
}

export function getProductStock(product: {
  quantity?: number | null;
  price_per_gram?: number | null;
}): number {
  if (product.quantity != null && !Number.isNaN(Number(product.quantity))) {
    return Math.max(0, Math.round(Number(product.quantity)));
  }
  if (product.price_per_gram != null && !Number.isNaN(Number(product.price_per_gram))) {
    return Math.max(0, Math.round(Number(product.price_per_gram)));
  }
  return 1;
}

export async function stockInsertField(quantity: number): Promise<Record<string, number>> {
  const useQty = await detectStockColumn();
  return useQty ? { quantity } : { price_per_gram: quantity };
}

export async function stockUpdateField(quantity: number): Promise<Record<string, number>> {
  return stockInsertField(quantity);
}

const PICKER_FIELDS = "id, title, sku, sale_price, status, price_per_gram";

function toPickerRow(p: any) {
  return {
    id: p.id,
    title: p.title,
    sku: p.sku,
    sale_price: p.sale_price,
    status: p.status,
    quantity: p.quantity,
    price_per_gram: p.price_per_gram,
  };
}

/** Список изделий для выбора в операциях (с офлайн-фолбэком из локального кэша). */
export async function fetchProductsForPicker() {
  if (!isBrowserOnline()) {
    const local = await loadLocalProducts<any[]>();
    if (local?.length) {
      return [...local].map(toPickerRow).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
  }

  try {
    const { data, error } = await supabase.from("products").select(PICKER_FIELDS).order("title");
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    const local = await loadLocalProducts<any[]>();
    if (local?.length) {
      return [...local].map(toPickerRow).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
    throw err;
  }
}

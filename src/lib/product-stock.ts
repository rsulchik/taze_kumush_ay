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

/** Схема могла измениться (применили миграцию) — перепроверяем колонку при следующем обращении. */
export function resetStockColumnProbe(): void {
  useQuantityColumn = null;
}

export async function detectStockColumn(): Promise<boolean> {
  if (useQuantityColumn !== null) return useQuantityColumn;

  // Без сети проверить нельзя: делаем предположение, но НЕ запоминаем его,
  // иначе после восстановления связи приложение будет писать в несуществующую колонку.
  if (!isBrowserOnline()) return true;

  try {
    const { error } = await supabase.from("products").select("quantity").limit(1);
    if (!error) {
      useQuantityColumn = true;
    } else if (isMissingColumnError(error, "quantity")) {
      useQuantityColumn = false;
    } else {
      // Таймаут/сеть/права — это не ответ про схему, оставляем определение на потом.
      return true;
    }
  } catch {
    return true;
  }

  return useQuantityColumn;
}

/** Привести поле остатка к той колонке, которая реально есть в базе (для очереди, собранной офлайн). */
export async function alignStockField<T extends Record<string, unknown>>(payload: T): Promise<T> {
  const useQty = await detectStockColumn();
  const next: Record<string, unknown> = { ...payload };

  const qty = typeof next.quantity === "number" ? next.quantity : null;
  const legacy = typeof next.price_per_gram === "number" ? next.price_per_gram : null;

  if (useQty) {
    if (qty == null && legacy != null) next.quantity = legacy;
    delete next.price_per_gram;
  } else {
    if (legacy == null && qty != null) next.price_per_gram = qty;
    delete next.quantity;
  }

  return next as T;
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
      return [...local]
        .map(toPickerRow)
        .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
  }

  try {
    const { data, error } = await supabase.from("products").select(PICKER_FIELDS).order("title");
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    const local = await loadLocalProducts<any[]>();
    if (local?.length) {
      return [...local]
        .map(toPickerRow)
        .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
    throw err;
  }
}

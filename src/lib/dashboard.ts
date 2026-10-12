import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchProductsFull, isTimeoutError } from "@/lib/catalog";
import { loadLocalProducts, loadLocalTransactions } from "@/lib/offline/local-db";
import { isBrowserOnline } from "@/lib/offline/network";

export type DashboardData = {
  products: Array<{
    id: string;
    metal_type: string;
    assay: number;
    metal_weight: number;
    sale_price: number;
    status: string;
    category_id: string | null;
    categories?: { name: string } | null;
    quantity?: number | null;
    price_per_gram?: number | null;
  }>;
  txs: Array<{
    final_price: number;
    created_at: string;
    type: string;
  }>;
};

async function fetchRecentTransactions() {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const sinceMs = Date.parse(since);

  if (!isBrowserOnline()) {
    const local = (await loadLocalTransactions<any[]>()) ?? [];
    return local
      .filter((t) => Date.parse(t.created_at) >= sinceMs)
      .map((t) => ({ final_price: t.final_price, created_at: t.created_at, type: t.type }));
  }

  const { data, error } = await supabase
    .from("transactions")
    .select("final_price, created_at, type")
    .gte("created_at", since);
  if (error) throw error;
  return data ?? [];
}

export async function fetchDashboard(queryClient: QueryClient): Promise<DashboardData> {
  let products = queryClient.getQueryData<any[]>(["products-full"]);

  if (!products?.length) {
    try {
      products = await fetchProductsFull();
      queryClient.setQueryData(["products-full"], products);
    } catch (error) {
      products =
        queryClient.getQueryData<any[]>(["products-full"]) ??
        (await loadLocalProducts<any[]>()) ??
        [];
      if (!products.length) throw error;
    }
  }

  const inStock = products.filter((p) => p.status === "в наличии");

  let txs: DashboardData["txs"] = [];
  try {
    txs = await fetchRecentTransactions();
  } catch (error) {
    const cached = queryClient.getQueryData<DashboardData>(["dashboard"]);
    if (cached?.txs?.length) {
      txs = cached.txs;
    } else {
      const local = (await loadLocalTransactions<any[]>()) ?? [];
      const sinceMs = Date.now() - 30 * 24 * 3600 * 1000;
      txs = local
        .filter((t) => Date.parse(t.created_at) >= sinceMs)
        .map((t) => ({ final_price: t.final_price, created_at: t.created_at, type: t.type }));
      if (!txs.length && !isTimeoutError(error) && !inStock.length) {
        throw error;
      }
    }
  }

  return { products: inStock, txs };
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return "неизвестная ошибка";
}

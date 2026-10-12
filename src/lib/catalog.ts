import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { enrichProductsWithCachedImages, onImagesCached } from "@/lib/offline/image-cache";
import {
  loadLocalProducts,
  loadLocalProductsWithImages,
  saveCatalogSnapshot,
  saveLocalCategories,
  saveLocalGemstones,
  saveLocalProducts,
} from "@/lib/offline/local-db";
import { isBrowserOnline } from "@/lib/offline/network";
import { isTempId } from "@/lib/offline/queue";
import {
  detectStockColumn,
  isMissingColumnError,
  resetStockColumnProbe,
} from "@/lib/product-stock";

const PRODUCT_LIST_FIELDS =
  "id, title, sku, status, category_id, metal_type, assay, size, total_weight, metal_weight, cost_price, sale_price, description, created_at";

const LIST_BATCH_SIZE = 40;
const IMAGE_BATCH_SIZE = 15;
const GEMSTONE_BATCH_SIZE = 80;

export function isTimeoutError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return /statement timeout|canceling statement/i.test(message);
}

async function fetchCategoriesMap(): Promise<Record<string, { name: string }>> {
  const { data, error } = await supabase.from("categories").select("id, name");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((c) => [c.id, { name: c.name }]));
}

async function fetchProductListRows(selectFields: string) {
  const merged: any[] = [];
  let from = 0;

  while (true) {
    const to = from + LIST_BATCH_SIZE - 1;
    const { data, error } = await supabase.from("products").select(selectFields).range(from, to);
    if (error) throw error;

    const rows = data ?? [];
    merged.push(...rows);
    if (rows.length < LIST_BATCH_SIZE) break;
    from += LIST_BATCH_SIZE;
  }

  return merged;
}

async function fetchProductImages(productIds: string[]) {
  const imageById = new Map<string, string | null>();

  for (let i = 0; i < productIds.length; i += IMAGE_BATCH_SIZE) {
    const chunk = productIds.slice(i, i + IMAGE_BATCH_SIZE);
    const { data, error } = await supabase.from("products").select("id, image_url").in("id", chunk);
    if (error) {
      if (isTimeoutError(error)) continue;
      throw error;
    }
    for (const row of data ?? []) {
      imageById.set(row.id, row.image_url ?? null);
    }
  }

  return imageById;
}

function attachCategories(products: any[], categoriesMap: Record<string, { name: string }>) {
  return products.map((product) => ({
    ...product,
    image_url: product.image_url ?? null,
    categories: product.category_id ? (categoriesMap[product.category_id] ?? null) : null,
  }));
}

let imageMirrorRun: Promise<void> | null = null;
let imageNotificationsStarted = false;

/**
 * Фото докачиваются в фоне. Раньше каталог ждал скачивания ВСЕХ фотографий
 * (по одному запросу на снимок), поэтому на медленной сети список не появлялся минутами.
 */
export function mirrorImagesInBackground(queryClient: QueryClient | null, products: any[]): void {
  if (imageMirrorRun || !isBrowserOnline()) return;

  imageMirrorRun = (async () => {
    try {
      const enriched = await enrichProductsWithCachedImages(products, {
        fetchMissing: true,
        concurrency: 2,
      });

      const ids = new Set(enriched.map((p) => p.id));
      const localOnly = ((await loadLocalProducts<any[]>()) ?? []).filter(
        (p) => isTempId(p.id) && !ids.has(p.id),
      );
      await saveLocalProducts(localOnly.length ? [...localOnly, ...enriched] : enriched);

      if (queryClient) {
        startImageNotifications(queryClient);
      }
    } catch {
      // Фоновое кэширование фото не должно ломать каталог.
    } finally {
      imageMirrorRun = null;
    }
  })();
}

/** Когда фото докачалось — подставить его в открытый список без перезагрузки. */
function startImageNotifications(queryClient: QueryClient): void {
  if (imageNotificationsStarted) return;
  imageNotificationsStarted = true;

  onImagesCached(() => {
    const current = queryClient.getQueryData<any[]>(["products-full"]);
    if (!current?.length) return;
    void enrichProductsWithCachedImages(current, { fetchMissing: false }).then((next) => {
      queryClient.setQueryData(["products-full"], next);
      void saveLocalProducts(next);
    });
  });
}

export async function fetchProductsFull() {
  if (!isBrowserOnline()) {
    const local = await loadLocalProductsWithImages<any[]>();
    if (local?.length) return local;
    throw new Error("Нет сети и нет сохранённого каталога. Подключитесь к интернету один раз.");
  }

  try {
    const categoriesMap = await fetchCategoriesMap();
    await saveLocalCategories(
      Object.entries(categoriesMap).map(([id, c]) => ({ id, name: c.name })),
    );
    const useQty = await detectStockColumn();
    const variants = useQty
      ? [`${PRODUCT_LIST_FIELDS}, quantity`, PRODUCT_LIST_FIELDS]
      : [`${PRODUCT_LIST_FIELDS}, price_per_gram`, PRODUCT_LIST_FIELDS];

    let lastError: unknown = null;
    for (const selectFields of variants) {
      try {
        const products = await fetchProductListRows(selectFields);
        const productIds = products.map((p) => p.id).filter(Boolean);

        let imageById = new Map<string, string | null>();
        if (productIds.length > 0) {
          try {
            imageById = await fetchProductImages(productIds);
          } catch (error) {
            if (!isTimeoutError(error)) throw error;
          }
        }

        const withImages = products.map((product) => ({
          ...product,
          image_url: imageById.get(product.id) ?? null,
        }));

        const attached = attachCategories(withImages, categoriesMap);
        // Список отдаём сразу (фото — из локального кэша), остальное докачивается в фоне.
        return await saveCatalogSnapshot(attached);
      } catch (error) {
        lastError = error;
        if (isMissingColumnError(error)) continue;
        if (!isTimeoutError(error)) throw error;
      }
    }

    throw lastError ?? new Error("Не удалось загрузить каталог.");
  } catch (error) {
    const local = await loadLocalProductsWithImages<any[]>();
    if (local?.length) return local;
    throw error;
  }
}

export async function fetchAllGemstones() {
  if (!isBrowserOnline()) {
    const { loadLocalGemstones } = await import("@/lib/offline/local-db");
    return (await loadLocalGemstones<any[]>()) ?? [];
  }

  try {
    const merged: any[] = [];
    let from = 0;

    while (true) {
      const to = from + GEMSTONE_BATCH_SIZE - 1;
      const { data, error } = await supabase
        .from("gemstones")
        .select("id, product_id, stone_name, quantity, carat_weight")
        .range(from, to);
      if (error) throw error;

      const rows = data ?? [];
      merged.push(...rows);
      if (rows.length < GEMSTONE_BATCH_SIZE) break;
      from += GEMSTONE_BATCH_SIZE;
    }

    await saveLocalGemstones(merged);
    return merged;
  } catch (error) {
    const { loadLocalGemstones } = await import("@/lib/offline/local-db");
    const local = await loadLocalGemstones<any[]>();
    if (local) return local;
    throw error;
  }
}

export async function fetchProductsGemstones(_queryClient: QueryClient) {
  return fetchAllGemstones();
}

export async function prefetchCatalog(queryClient: QueryClient) {
  startImageNotifications(queryClient);
  resetStockColumnProbe();

  try {
    await queryClient.prefetchQuery({
      queryKey: ["products-full"],
      queryFn: fetchProductsFull,
    });
    const products = queryClient.getQueryData<any[]>(["products-full"]);
    if (products?.length) {
      mirrorImagesInBackground(queryClient, products);
    }
  } catch {
    // Keep showing persisted cache when the server is slow.
  }

  void queryClient
    .prefetchQuery({
      queryKey: ["products-gemstones"],
      queryFn: () => fetchAllGemstones(),
    })
    .catch(() => undefined);
}

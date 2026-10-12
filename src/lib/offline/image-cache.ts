import { idbGet, idbSet, LOCAL_KEYS } from "@/lib/offline/storage";
import { compressImageToDataUrl } from "@/lib/product-image";

type ImageCacheEntry = { source: string; dataUrl: string };
type ImageCacheMap = Record<string, ImageCacheEntry>;

const WRITE_DELAY_MS = 300;
const NOTIFY_DELAY_MS = 600;

/**
 * Карта фото держится в памяти. Раньше каждый товар читал и записывал ВСЮ карту
 * из IndexedDB — на каталоге из сотен позиций это подвешивало приложение
 * (чтение и сериализация десятков мегабайт на каждое фото).
 */
let mapCache: ImageCacheMap | null = null;
let loading: Promise<ImageCacheMap> | null = null;

let dirty = false;
let writeTimer: number | null = null;
let flushing: Promise<void> | null = null;
let hooksInstalled = false;

const listeners = new Set<(ids: string[]) => void>();
let pendingNotify = new Set<string>();
let notifyTimer: number | null = null;

async function readMap(): Promise<ImageCacheMap> {
  if (mapCache) return mapCache;
  if (!loading) {
    loading = idbGet<ImageCacheMap>(LOCAL_KEYS.images).then((stored) => stored ?? {});
  }
  const loaded = await loading;
  if (!mapCache) mapCache = loaded;
  return mapCache;
}

function installFlushHooks(): void {
  if (hooksInstalled || typeof window === "undefined") return;
  hooksInstalled = true;
  const flush = () => void flushImageCache();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
}

function schedulePersist(): void {
  installFlushHooks();
  dirty = true;
  if (typeof window === "undefined") {
    void flushImageCache();
    return;
  }
  if (writeTimer != null) return;
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    void flushImageCache();
  }, WRITE_DELAY_MS);
}

/** Дописать карту фото в IndexedDB (вызывается автоматически, вручную — перед уходом в фон). */
export function flushImageCache(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    while (dirty && mapCache) {
      dirty = false;
      await idbSet(LOCAL_KEYS.images, mapCache);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function notifyImages(ids: string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) pendingNotify.add(id);

  const emit = () => {
    notifyTimer = null;
    const batch = [...pendingNotify];
    pendingNotify = new Set();
    if (batch.length === 0) return;
    for (const cb of listeners) cb(batch);
  };

  if (typeof window === "undefined") {
    emit();
    return;
  }
  if (notifyTimer != null) return;
  notifyTimer = window.setTimeout(emit, NOTIFY_DELAY_MS);
}

/** Подписка на появление новых закэшированных фото (чтобы интерфейс подтянул их без перезагрузки). */
export function onImagesCached(cb: (productIds: string[]) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/** Скачать фото и сохранить его как data URL, чтобы оно открывалось без сети. */
export async function cacheRemoteImage(
  productId: string,
  imageUrl: string,
): Promise<string | null> {
  if (!imageUrl || imageUrl.startsWith("data:")) return imageUrl || null;

  const map = await readMap();
  const hit = map[productId];
  if (hit?.source === imageUrl && hit.dataUrl) return hit.dataUrl;

  try {
    const res = await fetch(imageUrl, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;

    let dataUrl: string;
    if (blob.size > 400_000) {
      const file = new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" });
      dataUrl = await compressImageToDataUrl(file, 900, 0.72);
    } else {
      dataUrl = await blobToDataUrl(blob);
    }

    if (dataUrl.length > 900_000) {
      const file = new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" });
      dataUrl = await compressImageToDataUrl(file, 720, 0.65);
    }

    map[productId] = { source: imageUrl, dataUrl };
    schedulePersist();
    return dataUrl;
  } catch {
    return null;
  }
}

export async function getCachedImage(
  productId: string,
  imageUrl: string | null,
): Promise<string | null> {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("data:")) return imageUrl;
  const map = await readMap();
  const hit = map[productId];
  if (hit?.source === imageUrl) return hit.dataUrl;
  return null;
}

export async function putLocalImage(productId: string, dataUrl: string): Promise<void> {
  const map = await readMap();
  map[productId] = { source: dataUrl, dataUrl };
  schedulePersist();
  notifyImages([productId]);
}

export async function removeCachedImage(productId: string): Promise<void> {
  const map = await readMap();
  if (!(productId in map)) return;
  delete map[productId];
  schedulePersist();
}

/** Оставить только фото, которые уже есть в кэше, — без обращения к сети. */
export async function enrichProductsWithCachedImages<
  T extends { id: string; image_url?: string | null },
>(
  products: T[],
  opts?: { fetchMissing?: boolean; concurrency?: number },
): Promise<Array<T & { image_remote_url?: string | null }>> {
  const fetchMissing = opts?.fetchMissing ?? false;
  const concurrency = opts?.concurrency ?? 4;
  const map = await readMap();
  const result: Array<T & { image_remote_url?: string | null }> = new Array(products.length);
  const missingIdx: number[] = [];
  const cachedNow: string[] = [];

  for (let idx = 0; idx < products.length; idx += 1) {
    const p = products[idx]!;
    const url = p.image_url ?? null;

    if (!url) {
      // Сервер не отдал ссылку (таймаут пакета) — но фото уже может быть в кэше.
      const cached = map[p.id];
      result[idx] = cached?.dataUrl ? { ...p, image_url: cached.dataUrl } : p;
      continue;
    }

    if (url.startsWith("data:")) {
      // Фото лежит прямо в записи (Storage не настроен) — переносим его в кэш
      // изображений, чтобы оно осталось доступным после очистки ссылок в сторе.
      const existing = map[p.id];
      if (existing?.source !== url) {
        map[p.id] = { source: url, dataUrl: url };
        schedulePersist();
      }
      result[idx] = p;
      continue;
    }

    const hit = map[p.id];
    if (hit?.source === url && hit.dataUrl) {
      result[idx] = { ...p, image_url: hit.dataUrl, image_remote_url: url };
      continue;
    }

    if (fetchMissing) {
      result[idx] = { ...p, image_remote_url: url };
      missingIdx.push(idx);
    } else {
      result[idx] = p;
    }
  }

  if (missingIdx.length > 0) {
    let cursor = 0;
    async function worker() {
      while (cursor < missingIdx.length) {
        const idx = missingIdx[cursor++]!;
        const item = result[idx]!;
        const remote = item.image_remote_url!;
        const dataUrl = await cacheRemoteImage(item.id, remote);
        if (!dataUrl) continue;
        result[idx] = { ...item, image_url: dataUrl, image_remote_url: remote };
        cachedNow.push(item.id);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, missingIdx.length) }, () => worker()),
    );
    await flushImageCache();
    notifyImages(cachedNow);
  }

  return result;
}

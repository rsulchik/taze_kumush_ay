import { idbGet, idbSet, LOCAL_KEYS } from "@/lib/offline/storage";
import { compressImageToDataUrl } from "@/lib/product-image";

type ImageCacheMap = Record<string, { source: string; dataUrl: string }>;

async function readMap(): Promise<ImageCacheMap> {
  return (await idbGet<ImageCacheMap>(LOCAL_KEYS.images)) ?? {};
}

async function writeMap(map: ImageCacheMap): Promise<void> {
  await idbSet(LOCAL_KEYS.images, map);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/** Fetch remote image and store as data URL for offline display. */
export async function cacheRemoteImage(productId: string, imageUrl: string): Promise<string | null> {
  if (!imageUrl || imageUrl.startsWith("data:")) return imageUrl || null;

  const map = await readMap();
  const hit = map[productId];
  if (hit?.source === imageUrl && hit.dataUrl) return hit.dataUrl;

  try {
    const res = await fetch(imageUrl, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/") && blob.size === 0) return null;

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
    await writeMap(map);
    return dataUrl;
  } catch {
    return null;
  }
}

export async function getCachedImage(productId: string, imageUrl: string | null): Promise<string | null> {
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
  await writeMap(map);
}

export async function removeCachedImage(productId: string): Promise<void> {
  const map = await readMap();
  delete map[productId];
  await writeMap(map);
}

/** Enrich products so image_url is a data URL when possible (keeps remote in image_remote_url). */
export async function enrichProductsWithCachedImages<T extends { id: string; image_url?: string | null }>(
  products: T[],
  opts?: { fetchMissing?: boolean; concurrency?: number },
): Promise<Array<T & { image_remote_url?: string | null }>> {
  const fetchMissing = opts?.fetchMissing ?? false;
  const concurrency = opts?.concurrency ?? 4;
  const result: Array<T & { image_remote_url?: string | null }> = new Array(products.length);

  let i = 0;
  async function worker() {
    while (i < products.length) {
      const idx = i++;
      const p = products[idx]!;
      const url = p.image_url ?? null;
      if (!url) {
        result[idx] = p;
        continue;
      }
      if (url.startsWith("data:")) {
        result[idx] = p;
        continue;
      }

      let dataUrl = await getCachedImage(p.id, url);
      if (!dataUrl && fetchMissing) {
        dataUrl = await cacheRemoteImage(p.id, url);
      }

      if (dataUrl) {
        result[idx] = { ...p, image_url: dataUrl, image_remote_url: url };
      } else {
        result[idx] = p;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, () => worker()));
  return result;
}

import { del, get, set } from "idb-keyval";

/**
 * Persistent storage for Capacitor / browser.
 * IndexedDB holds large catalogs + photos; localStorage holds small meta
 * (localStorage alone cannot fit product photos).
 */

const LS_META_KEY = "kumush-offline-meta-v1";

export type OfflineMeta = {
  lastSyncAt: string | null;
  pendingCount: number;
  lastError: string | null;
};

export async function idbGet<T>(key: string): Promise<T | null> {
  if (typeof window === "undefined") return null;
  try {
    return (await get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function idbSet<T>(key: string, value: T): Promise<void> {
  if (typeof window === "undefined") return;
  await set(key, value);
}

export async function idbDel(key: string): Promise<void> {
  if (typeof window === "undefined") return;
  await del(key);
}

export function readOfflineMeta(): OfflineMeta {
  if (typeof window === "undefined") {
    return { lastSyncAt: null, pendingCount: 0, lastError: null };
  }
  try {
    const raw = localStorage.getItem(LS_META_KEY);
    if (!raw) return { lastSyncAt: null, pendingCount: 0, lastError: null };
    return { lastSyncAt: null, pendingCount: 0, lastError: null, ...JSON.parse(raw) };
  } catch {
    return { lastSyncAt: null, pendingCount: 0, lastError: null };
  }
}

export function writeOfflineMeta(patch: Partial<OfflineMeta>): OfflineMeta {
  const next = { ...readOfflineMeta(), ...patch };
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LS_META_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded — ignore meta write
    }
  }
  return next;
}

export const LOCAL_KEYS = {
  products: "kumush-local-products-v1",
  categories: "kumush-local-categories-v1",
  transactions: "kumush-local-transactions-v1",
  gemstones: "kumush-local-gemstones-v1",
  images: "kumush-local-images-v1",
  queue: "kumush-offline-queue-v1",
  tempIdMap: "kumush-offline-temp-id-map-v1",
} as const;

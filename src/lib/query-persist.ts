import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";

const PERSIST_KEY = "kumush-query-cache-v1";

const PERSISTABLE_QUERY_KEYS = new Set([
  "products-full",
  "products-gemstones",
  "products-min",
  "dashboard",
  "transactions",
  "categories",
]);

/** Keep cached catalog/photos long enough for offline Capacitor APK use. */
export const queryGcTimeMs = 1000 * 60 * 60 * 24 * 30;
export const queryStaleTimeMs = 1000 * 60 * 5;

export const queryPersister: Persister = createAsyncStoragePersister({
  key: PERSIST_KEY,
  storage: {
    getItem: async (key) => {
      if (typeof window === "undefined") return null;
      return (await get<string>(key)) ?? null;
    },
    setItem: async (key, value) => {
      if (typeof window === "undefined") return;
      await set(key, value);
    },
    removeItem: async (key) => {
      if (typeof window === "undefined") return;
      await del(key);
    },
  },
});

export const queryPersistOptions = {
  persister: queryPersister,
  maxAge: queryGcTimeMs,
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { queryKey: readonly unknown[] }) => {
      const rootKey = query.queryKey[0];
      return typeof rootKey === "string" && PERSISTABLE_QUERY_KEYS.has(rootKey);
    },
  },
};

export async function clearQueryCache() {
  if (typeof window === "undefined") return;
  await del(PERSIST_KEY);
}

export type { PersistedClient };

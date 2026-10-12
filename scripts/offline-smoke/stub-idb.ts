const store = new Map<string, any>();
export const __store = store;
export async function get<T>(key: string): Promise<T | undefined> {
  const value = store.get(key);
  return value === undefined ? undefined : structuredClone(value);
}
export async function set(key: string, value: any): Promise<void> {
  store.set(key, structuredClone(value));
}
export async function del(key: string): Promise<void> {
  store.delete(key);
}
export function clear(): void {
  store.clear();
}

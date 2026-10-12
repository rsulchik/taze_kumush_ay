export function useServerFn<T extends (...args: any[]) => any>(fn: T): T {
  return fn;
}

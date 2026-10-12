export function matchesProductSearch(
  product: {
    title?: string | null;
    sku?: string | null;
    id?: string | null;
  },
  query: string,
): boolean {
  const raw = query.trim().toLowerCase();
  if (!raw) return true;

  const title = String(product.title ?? "").toLowerCase();
  const sku = String(product.sku ?? "").toLowerCase();
  const id = String(product.id ?? "").toLowerCase();
  const compact = (s: string) => s.replace(/[\s\-_/]+/g, "");
  const digits = (s: string) => s.replace(/\D/g, "");

  const qCompact = compact(raw);
  const qDigits = digits(raw);
  const skuCompact = compact(sku);
  const skuDigits = digits(sku);

  if (title.includes(raw) || sku.includes(raw) || id.includes(raw)) return true;
  if (qCompact && skuCompact.includes(qCompact)) return true;
  if (qDigits.length >= 1 && skuDigits.includes(qDigits)) return true;
  return false;
}

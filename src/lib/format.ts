export const fmtMoney = (n: number | null | undefined) =>
  n == null 
    ? "—" 
    : new Intl.NumberFormat("tk-TM", { 
        style: "currency", 
        currency: "tmt", 
        maximumFractionDigits: 0 
      }).format(n);

export const fmtWeight = (g: number | null | undefined) =>
  g == null ? "—" : `${Number(g).toFixed(2)} г`;

export const fmtCarat = (c: number | null | undefined) =>
  c == null ? "—" : `${Number(c).toFixed(2)} ct`;

export const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });

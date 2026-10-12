/* Мини-замена supabase-js для проверки офлайн-очереди:
   таблицы в памяти + режимы «связь пропала» и «ошибка сервера». */

export const tables: Record<string, any[]> = {
  products: [],
  categories: [],
  transactions: [],
  gemstones: [],
};

const KNOWN_PRODUCT_COLUMNS = [
  "id",
  "title",
  "sku",
  "status",
  "category_id",
  "metal_type",
  "assay",
  "size",
  "total_weight",
  "metal_weight",
  "cost_price",
  "sale_price",
  "description",
  "created_at",
  "updated_at",
  "image_url",
  "quantity",
  "price_per_gram",
];

export const control = {
  mode: "ok" as "ok" | "network" | "permanent",
  columns: new Set<string>([...KNOWN_PRODUCT_COLUMNS]),
  log: [] as string[],
};

function err(message: string, code = "P0001") {
  return { message, code, details: null, hint: null };
}

function matches(row: any, filters: Array<[string, (value: any) => boolean]>) {
  return filters.every(([column, test]) => test(row[column]));
}

function pick(data: any, columns: string) {
  const cols = columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (cols.length === 0 || cols.includes("*")) return data;
  const one = (row: any) => {
    if (!row) return row;
    const out: any = {};
    for (const col of cols) out[col] = row[col] ?? null;
    return out;
  };
  return Array.isArray(data) ? data.map(one) : one(data);
}

function execute(state: any): { data: any; error: any } {
  if (control.mode === "network")
    return { data: null, error: err("TypeError: Failed to fetch", "") };
  if (control.mode === "permanent") {
    return {
      data: null,
      error: err('duplicate key value violates unique constraint "products_sku_key"', "23505"),
    };
  }

  control.log.push(`${state.op}:${state.table}`);
  const rows = tables[state.table] ?? (tables[state.table] = []);

  if (state.table === "products" && (state.op === "insert" || state.op === "update")) {
    const items = Array.isArray(state.payload) ? state.payload : [state.payload];
    for (const item of items) {
      for (const key of Object.keys(item ?? {})) {
        if (!control.columns.has(key))
          return { data: null, error: err(`column products.${key} does not exist`, "42703") };
      }
    }
  }

  if (state.op === "insert") {
    const items = Array.isArray(state.payload) ? state.payload : [state.payload];
    const created: any[] = [];
    for (const item of items) {
      if (state.table === "products" && item?.sku && rows.some((r) => r.sku === item.sku)) {
        return {
          data: null,
          error: err('duplicate key value violates unique constraint "products_sku_key"', "23505"),
        };
      }
      const row = {
        id: `${state.table}-${rows.length + 1}`,
        created_at: new Date().toISOString(),
        ...item,
      };
      rows.push(row);
      created.push(row);
    }
    const value = state.single ? created[0] : created;
    return { data: state.select ? pick(value, state.select) : null, error: null };
  }

  if (state.op === "update") {
    for (const row of rows.filter((r) => matches(r, state.filters)))
      Object.assign(row, state.payload);
    return { data: null, error: null };
  }

  if (state.op === "delete") {
    tables[state.table] = rows.filter((row) => !matches(row, state.filters));
    return { data: null, error: null };
  }

  if (state.select && state.select !== "*") {
    for (const column of state.select
      .split(",")
      .map((c: string) => c.trim())
      .filter(Boolean)) {
      const table = state.table === "products" ? "products" : null;
      if (table && !control.columns.has(column)) {
        return { data: null, error: err(`column ${table}.${column} does not exist`, "42703") };
      }
    }
  }

  let found = rows.filter((row) => matches(row, state.filters));
  if (state.limit != null) found = found.slice(0, state.limit);
  if (state.single) {
    if (found.length === 0)
      return {
        data: null,
        error: err("JSON object requested, multiple (or no) rows returned", "PGRST116"),
      };
    return { data: state.select ? pick(found[0], state.select) : found[0], error: null };
  }
  return { data: state.select ? pick(found, state.select) : found, error: null };
}

function builder(table: string, op: string, payload?: any) {
  const state: any = { table, op, payload, select: null, single: false, limit: null, filters: [] };
  const api: any = {
    select(columns?: string) {
      state.select = columns && columns.trim() ? columns : "*";
      return api;
    },
    eq(column: string, value: any) {
      state.filters.push([column, (candidate: any) => candidate === value]);
      return api;
    },
    in(column: string, values: any[]) {
      state.filters.push([column, (candidate: any) => values.includes(candidate)]);
      return api;
    },
    order() {
      return api;
    },
    limit(count: number) {
      state.limit = count;
      return api;
    },
    range() {
      return api;
    },
    single() {
      state.single = true;
      return api;
    },
    then(resolve: any, reject: any) {
      return Promise.resolve(execute(state)).then(resolve, reject);
    },
  };
  return api;
}

export const supabase = {
  from(table: string) {
    return {
      select: (columns?: string) => builder(table, "select").select(columns),
      insert: (payload: any) => builder(table, "insert", payload),
      update: (payload: any) => builder(table, "update", payload),
      delete: () => builder(table, "delete"),
    };
  },
  storage: {
    from() {
      return {
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://stub.test/photo.jpg" } }),
        remove: async () => ({ error: null }),
      };
    },
  },
};

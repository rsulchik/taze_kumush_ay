/* Проверка офлайн-сценариев: сеть пропала на записи, очередь, синхронизация,
   постоянная ошибка сервера, локальные операции и наложение очереди на данные сервера. */
import { QueryClient } from "@tanstack/react-query";
import { control, tables } from "./stub-supabase";

const mem = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
  setItem: (key: string, value: string) => void mem.set(key, String(value)),
  removeItem: (key: string) => void mem.delete(key),
};

(globalThis as any).localStorage = localStorageStub;
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
  writable: true,
});
(globalThis as any).document = {
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible",
};
(globalThis as any).window = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  localStorage: localStorageStub,
  confirm: () => true,
};

const mutations = await import("@/lib/offline/mutations");
const queue = await import("@/lib/offline/queue");
const sync = await import("@/lib/offline/sync");
const localDb = await import("@/lib/offline/local-db");
const stock = await import("@/lib/product-stock");

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const qc = new QueryClient();

const baseForm = {
  title: "Кольцо",
  sku: "K-001",
  category_id: "",
  metal_type: "Золото",
  assay: "585",
  size: "17.5",
  total_weight: "4.5",
  metal_weight: "4",
  cost_price: "100",
  sale_price: "200",
  status: "в наличии",
  quantity: "2",
  description: "",
};

function saveNew(overrides: Partial<typeof baseForm>) {
  return mutations.saveProductOfflineAware(qc, {
    isEdit: false,
    form: { ...baseForm, ...overrides },
    imageFile: null,
    imagePreview: null,
  });
}

section("1. Связь пропала прямо во время сохранения");
control.mode = "network";
const offlineSave = await saveNew({});
check("сохранение не упало с ошибкой", offlineSave.offline === true);
const queued = await queue.getQueue();
check("операция попала в очередь", queued.length === 1 && queued[0].kind === "product.insert");
check("остаток сохранён в колонку quantity", (queued[0] as any).payload.quantity === 2, queued[0]);
const cachedOffline = qc.getQueryData<any[]>(["products-full"]) ?? [];
check("изделие видно в каталоге", cachedOffline.length === 1 && cachedOffline[0]._pending === true);
check("у изделия локальный id", String(cachedOffline[0].id).startsWith("local-"));

section("2. Очередь уходит на сервер при появлении связи");
control.mode = "ok";
const flush1 = await sync.flushOfflineQueue(qc);
check("операция отправлена без сбоев", flush1.ok === 1 && flush1.failed === 0, flush1);
check(
  "изделие появилось на сервере",
  tables.products.length === 1 && tables.products[0].sku === "K-001",
);
check("очередь пуста", (await queue.getQueue()).length === 0);
const cachedSynced = qc.getQueryData<any[]>(["products-full"]) ?? [];
check(
  "локальная карточка заменена серверной записью",
  cachedSynced[0].id === tables.products[0].id && cachedSynced[0]._pending === false,
  cachedSynced[0],
);

section("3. Одна «битая» запись не блокирует остальную очередь");
control.mode = "network";
await saveNew({ sku: "K-001", title: "Дубль" });
await saveNew({ sku: "K-002", title: "Серьги" });
control.mode = "ok";
const flush2 = await sync.flushOfflineQueue(qc);
check(
  "вторая операция прошла",
  tables.products.some((p) => p.sku === "K-002"),
);
check(
  "статистика очереди честная",
  flush2.ok === 1 && flush2.failed === 1 && flush2.blocked === 1,
  flush2,
);
const rest = await queue.getQueue();
check(
  "проблемная операция осталась с текстом ошибки",
  rest.length === 1 && !!rest[0].blockedAt && /duplicate key/.test(String(rest[0].lastError)),
  rest[0],
);

section("4. Операция (продажа), созданная офлайн");
const productRow = tables.products.find((p) => p.sku === "K-002")!;
productRow.quantity = 3;
// имитируем снимок с сервера (в приложении кэш обновляется запросом данных)
qc.setQueryData(
  ["products-full"],
  (qc.getQueryData<any[]>(["products-full"]) ?? []).map((p) =>
    p.id === productRow.id ? { ...p, quantity: 3 } : p,
  ),
);
control.mode = "network";
await mutations.saveTransactionOfflineAware(qc, {
  product_id: productRow.id,
  type: "sale",
  final_price: "200",
  employee_name: "Aýgül",
  notes: "",
});
check(
  "продажа в очереди",
  (await queue.getQueue()).some((op) => op.kind === "transaction.insert"),
);
const localTx = (qc.getQueryData<any[]>(["transactions"]) ?? [])[0];
check(
  "продажа видна в списке как локальная",
  localTx?._pending === true && String(localTx?.id).startsWith("local-"),
);
check(
  "остаток уменьшен локально",
  (qc.getQueryData<any[]>(["products-full"]) ?? []).find((p) => p.id === productRow.id)
    ?.quantity === 2,
);

control.mode = "ok";
await sync.flushOfflineQueue(qc);
check("продажа дошла до сервера", tables.transactions.length === 1);
check("остаток уменьшен на сервере", productRow.quantity === 2, productRow.quantity);
const syncedTx = (qc.getQueryData<any[]>(["transactions"]) ?? []).find((t) => !t._pending);
check(
  "локальная продажа получила серверный id",
  !!syncedTx && syncedTx.id === tables.transactions[0].id,
  syncedTx,
);

await mutations.deleteTransactionOfflineAware(qc, {
  id: tables.transactions[0].id,
  product_id: productRow.id,
  type: "sale",
});
check("продажу можно удалить после синхронизации", tables.transactions.length === 0);
check("остаток вернулся", productRow.quantity === 3, productRow.quantity);

section("5. Локальные правки не затираются данными сервера");
control.mode = "network";
await saveNew({ sku: "K-003", title: "Браслет" });
const serverRows = [
  {
    id: "srv-1",
    title: "Старое кольцо",
    sku: "K-100",
    quantity: 1,
    status: "в наличии",
    image_url: null,
  },
];
const merged = await localDb.applyPendingProductOps(serverRows);
check(
  "новое локальное изделие добавлено к серверным",
  merged.some((p) => p.id === "srv-1") &&
    merged.some((p) => p.sku === "K-003" && p._pending === true),
  merged.map((p) => [p.sku, p._pending]),
);

await mutations.saveProductOfflineAware(qc, {
  isEdit: true,
  productId: "srv-1",
  initialImageUrl: null,
  form: { ...baseForm, sku: "K-100", title: "Переименовано", quantity: "5" },
  imageFile: null,
  imagePreview: null,
});
const mergedEdit = await localDb.applyPendingProductOps(serverRows);
const edited = mergedEdit.find((p) => p.id === "srv-1");
check(
  "офлайн-правка накладывается поверх данных сервера",
  edited?.title === "Переименовано" && edited?.quantity === 5 && edited?._pending === true,
  edited,
);

await mutations.deleteProductOfflineAware(qc, { id: "srv-1", image_url: null });
const mergedDelete = await localDb.applyPendingProductOps(serverRows);
check("офлайн-удаление скрывает изделие", !mergedDelete.some((p) => p.id === "srv-1"));

const localId = merged.find((p) => p.sku === "K-003")!.id;
await mutations.deleteProductOfflineAware(qc, { id: localId, image_url: null });
const afterDrop = await queue.getQueue();
check(
  "удаление ещё не отправленного изделия убирает его из очереди",
  !afterDrop.some((op) => op.kind === "product.insert" && op.tempId === localId),
  afterDrop.map((op) => op.kind),
);

section("6. Схема без колонки quantity (старая база)");
// определение колонки уже закэшировано как «quantity есть» — схема поменялась «на ходу»
control.columns.delete("quantity");
control.mode = "network";
await saveNew({ sku: "K-004", title: "Подвеска" });
const staleOp = (await queue.getQueue()).find(
  (op) => op.kind === "product.insert" && op.payload.sku === "K-004",
);
check(
  "офлайн-запись сохранена локально",
  (staleOp as any)?.payload.quantity === 2,
  (staleOp as any)?.payload,
);
control.mode = "ok";
await sync.flushOfflineQueue(qc);
const staleRow = tables.products.find((p) => p.sku === "K-004");
check(
  "устаревшее определение колонки исправляется на лету",
  !!staleRow && staleRow.price_per_gram === 2 && !("quantity" in staleRow),
  staleRow,
);

// приложение после перезапуска/переподключения определяет колонку заново
stock.resetStockColumnProbe();
control.mode = "network";
await saveNew({ sku: "K-005", title: "Серьги-2" });
control.mode = "ok";
await sync.flushOfflineQueue(qc);
const freshRow = tables.products.find((p) => p.sku === "K-005");
check(
  "без кэша определения колонка выбирается сразу правильно",
  !!freshRow && freshRow.price_per_gram === 2 && !("quantity" in freshRow),
  freshRow,
);
const leftOver = await queue.getQueue();
check(
  "в очереди осталась только проблема из п.3",
  leftOver.length === 1 && !!leftOver[0].blockedAt,
  leftOver.map((op) => [op.kind, op.blockedAt]),
);

section("7. Повтор отправки после исправления проблемы");
tables.products = tables.products.filter((p) => p.sku !== "K-001");
await queue.clearOpErrors();
await sync.flushOfflineQueue(qc);
check(
  "ранее неудачная операция ушла на сервер",
  tables.products.some((p) => p.sku === "K-001"),
);
check(
  "очередь пуста",
  (await queue.getQueue()).length === 0,
  (await queue.getQueue()).map((op) => op.kind),
);

console.log(`\n${passed} проверок пройдено, ${failures.length} провалено`);
if (failures.length > 0) {
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
}

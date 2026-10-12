import { idbGet, idbSet, LOCAL_KEYS, writeOfflineMeta } from "@/lib/offline/storage";

export type PendingOpMeta = {
  /** сколько раз операцию уже пытались отправить */
  attempts?: number;
  /** последняя ошибка отправки (для интерфейса) */
  lastError?: string | null;
  /** время, когда операция «заблокирована» постоянной ошибкой сервера */
  blockedAt?: string | null;
};

type PendingOpBody =
  | {
      id: string;
      createdAt: string;
      kind: "product.insert";
      tempId: string;
      payload: Record<string, unknown>;
      imageDataUrl?: string | null;
    }
  | {
      id: string;
      createdAt: string;
      kind: "product.update";
      productId: string;
      payload: Record<string, unknown>;
      imageDataUrl?: string | null;
      clearImage?: boolean;
      previousImageUrl?: string | null;
    }
  | {
      id: string;
      createdAt: string;
      kind: "product.delete";
      productId: string;
      imageUrl?: string | null;
    }
  | {
      id: string;
      createdAt: string;
      kind: "category.insert";
      tempId: string;
      name: string;
    }
  | {
      id: string;
      createdAt: string;
      kind: "transaction.insert";
      tempId: string;
      payload: {
        product_id: string | null;
        type: string;
        final_price: number;
        employee_name: string | null;
        notes: string | null;
        created_at?: string;
      };
    }
  | {
      id: string;
      createdAt: string;
      kind: "transaction.delete";
      transactionId: string;
      productId: string | null;
      type: string;
    };

export type PendingOp = PendingOpBody & PendingOpMeta;

const EMPTY: readonly PendingOp[] = [];

let snapshot: PendingOp[] | null = null;
let loading: Promise<PendingOp[]> | null = null;
const listeners = new Set<(ops: readonly PendingOp[]) => void>();

async function readQueue(force = false): Promise<PendingOp[]> {
  if (!force) {
    if (snapshot) return snapshot;
    if (loading) return loading;
  }

  const promise = idbGet<PendingOp[]>(LOCAL_KEYS.queue).then(
    (stored) => (stored ?? []) as PendingOp[],
  );
  loading = promise;
  try {
    const ops = await promise;
    snapshot = ops;
    return ops;
  } finally {
    if (loading === promise) loading = null;
  }
}

function notify(): void {
  const ops: readonly PendingOp[] = snapshot ?? EMPTY;
  for (const cb of listeners) cb(ops);
}

/** Копия очереди (из памяти, если уже загружена). */
export async function getQueue(force = false): Promise<PendingOp[]> {
  return [...(await readQueue(force))];
}

/** Синхронный снимок очереди для интерфейса (пустой массив, если ещё не загружена). */
export function getQueueSnapshot(): readonly PendingOp[] {
  return snapshot ?? EMPTY;
}

/** Подписка на изменения очереди — чтобы баннер не опрашивал IndexedDB каждые 4 секунды. */
export function subscribeQueue(cb: (ops: readonly PendingOp[]) => void): () => void {
  listeners.add(cb);
  cb(snapshot ?? EMPTY);
  return () => {
    listeners.delete(cb);
  };
}

export async function setQueue(ops: PendingOp[]): Promise<void> {
  snapshot = ops;
  await idbSet(LOCAL_KEYS.queue, ops);
  writeOfflineMeta({ pendingCount: ops.length });
  notify();
}

export async function enqueue(op: PendingOp): Promise<void> {
  const q = await readQueue();
  await setQueue([...q, op]);
}

export async function dequeueById(id: string): Promise<void> {
  const q = await readQueue();
  if (!q.some((op) => op.id === id)) return;
  await setQueue(q.filter((op) => op.id !== id));
}

export async function updateOp(id: string, patch: Partial<PendingOp>): Promise<void> {
  const q = await readQueue();
  const idx = q.findIndex((op) => op.id === id);
  if (idx === -1) return;
  const next = [...q];
  next[idx] = { ...next[idx], ...patch } as PendingOp;
  await setQueue(next);
}

/** Убрать операции из очереди (например, изменения по локальному товару, который тут же удалили). */
export async function removeOps(predicate: (op: PendingOp) => boolean): Promise<number> {
  const q = await readQueue();
  const next = q.filter((op) => !predicate(op));
  if (next.length === q.length) return 0;
  await setQueue(next);
  return q.length - next.length;
}

/** Снять признак «ошибка» со всех операций, чтобы повторить отправку. */
export async function clearOpErrors(): Promise<void> {
  const q = await readQueue();
  if (!q.some((op) => op.blockedAt || op.lastError)) return;
  await setQueue(q.map((op) => ({ ...op, blockedAt: null, lastError: null })));
}

export function newOpId(): string {
  return crypto.randomUUID();
}

export function isTempId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("local-");
}

export function newTempId(): string {
  return `local-${crypto.randomUUID()}`;
}

/** Все локальные (ещё не отправленные на сервер) идентификаторы из очереди. */
export function collectTempIds(ops: readonly PendingOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    if (
      op.kind === "product.insert" ||
      op.kind === "category.insert" ||
      op.kind === "transaction.insert"
    ) {
      ids.add(op.tempId);
    }
  }
  return ids;
}

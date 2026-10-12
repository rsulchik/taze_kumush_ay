import { idbGet, idbSet, LOCAL_KEYS, writeOfflineMeta } from "@/lib/offline/storage";

export type PendingOp =
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

export async function getQueue(): Promise<PendingOp[]> {
  return (await idbGet<PendingOp[]>(LOCAL_KEYS.queue)) ?? [];
}

export async function setQueue(ops: PendingOp[]): Promise<void> {
  await idbSet(LOCAL_KEYS.queue, ops);
  writeOfflineMeta({ pendingCount: ops.length });
}

export async function enqueue(op: PendingOp): Promise<void> {
  const q = await getQueue();
  q.push(op);
  await setQueue(q);
}

export async function dequeueById(id: string): Promise<void> {
  const q = await getQueue();
  await setQueue(q.filter((op) => op.id !== id));
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

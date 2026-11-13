import type { Activity, Customer, Task } from "./types";

export type PendingMutation =
  | { kind: "customer"; entity: Customer; expectedRevision: number; mutationId: string }
  | { kind: "task"; entity: Task; expectedRevision: number; mutationId: string }
  | { kind: "activity"; entity: Activity; mutationId: string };

export interface OutboxRow {
  key: string;
  entries: PendingMutation[];
  conflict: boolean;
}

const DATABASE = "hays-crm-outbox-v1";
const STORE = "mutations";
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Device storage is unavailable. CRM changes were not queued."));
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { connection = undefined; reject(request.error ?? new Error("Could not open CRM outbox.")); };
      request.onblocked = () => { connection = undefined; reject(new Error("CRM outbox is blocked by another tab.")); };
    });
  }
  return connection;
}

async function update<T>(key: string, change: (row: OutboxRow | undefined) => { row?: OutboxRow; result: T }): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(key);
    let result: T;
    request.onsuccess = () => {
      const changed = change(request.result as OutboxRow | undefined);
      result = changed.result;
      if (changed.row) store.put(changed.row);
      else store.delete(key);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Could not save CRM outbox."));
  });
}

export const mutationKey = (kind: string, id: string): string => `${kind}:${id}`;

export async function enqueue(mutation: PendingMutation): Promise<void> {
  const key = mutationKey(mutation.kind, mutation.entity.id);
  await update(key, row => ({
    row: { key, conflict: row?.conflict ?? false, entries: [...(row?.entries ?? []), structuredClone(mutation)] },
    result: undefined,
  }));
}

export async function listPending(): Promise<OutboxRow[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    tx.oncomplete = () => resolve(request.result as OutboxRow[]);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Could not read CRM outbox."));
  });
}

export async function acknowledge(key: string, mutationId: string, serverRevision?: number): Promise<boolean> {
  return update(key, row => {
    if (!row || row.conflict || row.entries[0]?.mutationId !== mutationId) return { row, result: false };
    const entries = row.entries.slice(1);
    if (entries[0] && entries[0].kind !== "activity" && serverRevision !== undefined) entries[0] = { ...entries[0], expectedRevision: serverRevision };
    return { row: entries.length ? { ...row, entries } : undefined, result: true };
  });
}

export async function markConflict(key: string, mutationId: string): Promise<void> {
  await update(key, row => ({ row: row && row.entries[0]?.mutationId === mutationId ? { ...row, conflict: true } : row, result: undefined }));
}

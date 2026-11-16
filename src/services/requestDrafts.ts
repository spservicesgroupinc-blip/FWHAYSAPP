import type { ChangeRequest, JobEntry, RequestAttachment } from "../types";
import { type uploadAttachment } from "./storage";

export interface DraftFile { name: string; type: string; lastModified: number; blob: Blob }
export interface DraftPhoto extends DraftFile { id: string; edited: boolean }
export interface DraftValues {
  customerText: string;
  selectedJob: JobEntry | null;
  initialRequest?: ChangeRequest;
  note: string;
  requestType?: ChangeRequest["requestType"];
  customerCredits: boolean;
  amount: string;
  amountSign: "+" | "-";
  emailAddress: string;
  photos: DraftPhoto[];
  pdf: DraftFile | null;
}
export type UploadFile = Parameters<typeof uploadAttachment>[1];
export interface SubmissionCheckpoint {
  request: ChangeRequest;
  saveMutation: string;
  attachMutation: string;
  uploads: { source: DraftFile; kind: "photo" | "document"; attachmentId: string; mutationId: string; prepared?: UploadFile; uploaded?: RequestAttachment }[];
  saved?: ChangeRequest;
  linked?: ChangeRequest;
  email: "idle" | "sending" | "sent" | "uncertain";
  emailError?: string;
}
export interface RequestDraft {
  id: string;
  scope: string;
  updatedAt: string;
  values: DraftValues;
  submission?: SubmissionCheckpoint;
}
const memoryDrafts = new Map<string, RequestDraft>();
function draftKey(scope: string, id: string): string {
  return `${scope}:${id}`;
}

let idbUnavailable = false;
let connection: Promise<IDBDatabase | null> | undefined;

function database(): Promise<IDBDatabase | null> {
  if (idbUnavailable || typeof indexedDB === "undefined") return Promise.resolve(null);
  connection ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open("hays-request-drafts-v1", 1);
      request.onupgradeneeded = () => {
        try {
          request.result.createObjectStore("drafts", {keyPath: ["scope", "id"]});
        } catch {
          // ignore
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          connection = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        connection = undefined;
        idbUnavailable = true;
        resolve(null);
      };
    } catch {
      connection = undefined;
      idbUnavailable = true;
      resolve(null);
    }
  });
  return connection;
}

function notifyDraftsChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("request-drafts-changed"));
  }
}

async function operation<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
  memoryFallback: () => T,
): Promise<T> {
  const db = await database();
  if (!db) return memoryFallback();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction("drafts", mode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Internal error") || (err instanceof DOMException && err.name === "UnknownError")) {
        idbUnavailable = true;
        resolve(memoryFallback());
        return;
      }
      reject(err);
      return;
    }
    const request = work(tx.objectStore("drafts"));
    tx.oncomplete = () => {
      if (mode === "readwrite") notifyDraftsChanged();
      resolve(request.result as T);
    };
    tx.onabort = tx.onerror = () => {
      const msg = tx.error ? tx.error.message : "";
      if (msg.includes("Internal error") || (tx.error && tx.error.name === "UnknownError")) {
        idbUnavailable = true;
        resolve(memoryFallback());
        return;
      }
      reject(tx.error || new Error("Draft could not be saved. Keep this page open and retry."));
    };
  });
}

export const readDraft = (id: string, scope = "supabase") =>
  operation<RequestDraft | undefined>(
    "readonly",
    store => store.get([scope, id]),
    () => memoryDrafts.get(draftKey(scope, id)),
  );

export async function listDrafts(scope = "supabase") {
  return operation<RequestDraft[]>(
    "readonly",
    store => store.getAll(),
    () => Array.from(memoryDrafts.values()),
  ).then(rows =>
    (rows || [])
      .filter(row => row.scope === scope)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

export async function saveDraft(row: RequestDraft) {
  const saveMemory = () => {
    const key = draftKey(row.scope, row.id);
    const existing = memoryDrafts.get(key);
    if (existing?.submission && existing.submission.saveMutation !== row.submission?.saveMutation) {
      throw new Error("This draft is already being submitted. Open Requests to continue.");
    }
    memoryDrafts.set(key, row);
    notifyDraftsChanged();
  };

  const db = await database();
  if (!db) {
    saveMemory();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction("drafts", "readwrite");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Internal error") || (err instanceof DOMException && err.name === "UnknownError")) {
        idbUnavailable = true;
        try {
          saveMemory();
          resolve();
        } catch (memErr) {
          reject(memErr);
        }
        return;
      }
      reject(err);
      return;
    }
    const store = tx.objectStore("drafts");
    const current = store.get([row.scope, row.id]);
    let conflict = false;
    current.onsuccess = () => {
      const existing = current.result as RequestDraft | undefined;
      if (existing?.submission && existing.submission.saveMutation !== row.submission?.saveMutation) {
        conflict = true;
        tx.abort();
        return;
      }
      store.put(row);
    };
    tx.oncomplete = () => {
      notifyDraftsChanged();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      const msg = tx.error ? tx.error.message : "";
      if (msg.includes("Internal error") || (tx.error && tx.error.name === "UnknownError")) {
        idbUnavailable = true;
        try {
          saveMemory();
          resolve();
        } catch (memErr) {
          reject(memErr);
        }
        return;
      }
      reject(
        conflict
          ? new Error("This draft is already being submitted. Open Requests to continue.")
          : tx.error || new Error("Draft could not be saved. Keep this page open and retry."),
      );
    };
  });
}

export async function deleteDraft(id: string, scope = "supabase") {
  await operation(
    "readwrite",
    store => store.delete([scope, id]),
    () => {
      memoryDrafts.delete(draftKey(scope, id));
      notifyDraftsChanged();
    },
  );
}

export function subscribeDrafts(callback: () => void) {
  window.addEventListener("request-drafts-changed", callback);
  return () => window.removeEventListener("request-drafts-changed", callback);
}

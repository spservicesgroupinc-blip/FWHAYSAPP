import type { DocumentRow, WorkspaceRow } from "./types";

const DATABASE = "hays-job-workspaces-v1";
const LS_WORKSPACES_KEY = "hays_job_workspaces_v1_workspaces";
const LS_DOCUMENTS_KEY = "hays_job_workspaces_v1_documents";

let connection: Promise<IDBDatabase> | undefined;
let idbUnavailable = false;

// Fallback in-memory stores backed by localStorage
let fallbackWorkspaces: Map<string, WorkspaceRow> | undefined;
let fallbackDocuments: Map<string, DocumentRow> | undefined;

function getFallbackWorkspaces(): Map<string, WorkspaceRow> {
  if (fallbackWorkspaces) return fallbackWorkspaces;
  const map = new Map<string, WorkspaceRow>();
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(LS_WORKSPACES_KEY);
      if (raw) {
        const list: WorkspaceRow[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item?.workspace?.id) map.set(item.workspace.id, item);
          }
        }
      }
    }
  } catch {
    // Ignore storage errors
  }
  fallbackWorkspaces = map;
  return map;
}

function persistFallbackWorkspaces(map: Map<string, WorkspaceRow>) {
  fallbackWorkspaces = map;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        LS_WORKSPACES_KEY,
        JSON.stringify(Array.from(map.values())),
      );
    }
  } catch {
    // Ignore storage quota or access errors
  }
}

function getFallbackDocuments(): Map<string, DocumentRow> {
  if (fallbackDocuments) return fallbackDocuments;
  const map = new Map<string, DocumentRow>();
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(LS_DOCUMENTS_KEY);
      if (raw) {
        const list: DocumentRow[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item?.document?.id) map.set(item.document.id, item);
          }
        }
      }
    }
  } catch {
    // Ignore storage errors
  }
  fallbackDocuments = map;
  return map;
}

function persistFallbackDocuments(map: Map<string, DocumentRow>) {
  fallbackDocuments = map;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        LS_DOCUMENTS_KEY,
        JSON.stringify(Array.from(map.values())),
      );
    }
  } catch {
    // Ignore storage quota or access errors
  }
}

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined" || idbUnavailable) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      try {
        const open = indexedDB.open(DATABASE, 1);
        open.onupgradeneeded = () => {
          try {
            open.result.createObjectStore("workspaces", { keyPath: "workspace.id" });
            const documents = open.result.createObjectStore("documents", {
              keyPath: "document.id",
            });
            documents.createIndex("workspace", "document.workspaceId");
          } catch (err) {
            reject(err);
          }
        };
        open.onsuccess = () => {
          const db = open.result;
          db.onversionchange = () => {
            try {
              db.close();
            } catch {
              // ignore
            }
            connection = undefined;
          };
          resolve(db);
        };
        open.onerror = () => {
          connection = undefined;
          idbUnavailable = true;
          reject(open.error || new Error("Could not open IndexedDB"));
        };
        open.onblocked = () => {
          connection = undefined;
        };
      } catch (err) {
        connection = undefined;
        idbUnavailable = true;
        reject(err);
      }
    });
  }
  return connection;
}

async function read<T>(
  store: string,
  operation: (store: IDBObjectStore) => IDBRequest,
  fallbackRead: () => T,
): Promise<T> {
  if (!idbUnavailable && typeof indexedDB !== "undefined") {
    try {
      const db = await database();
      return await new Promise<T>((resolve, reject) => {
        try {
          const tx = db.transaction(store, "readonly");
          const req = operation(tx.objectStore(store));
          tx.oncomplete = () => resolve(req.result as T);
          tx.onabort = tx.onerror = () => {
            reject(tx.error || new Error("Could not read device storage."));
          };
        } catch (err) {
          reject(err);
        }
      });
    } catch (error) {
      console.warn(`IndexedDB read failed for ${store}, using fallback:`, error);
      idbUnavailable = true;
      connection = undefined;
    }
  }
  return fallbackRead();
}

/** Read and replace in one transaction, so competing tabs cannot drop newer edits. */
async function update<T>(
  store: string,
  id: string,
  change: (current: T | undefined) => T | undefined,
  fallbackUpdate: () => T | undefined,
): Promise<T | undefined> {
  if (!idbUnavailable && typeof indexedDB !== "undefined") {
    try {
      const db = await database();
      return await new Promise<T | undefined>((resolve, reject) => {
        try {
          const tx = db.transaction(store, "readwrite");
          const table = tx.objectStore(store);
          const request = table.get(id);
          let result: T | undefined;
          request.onsuccess = () => {
            try {
              result = change(request.result as T | undefined);
              if (result) table.put(result);
            } catch (error) {
              tx.abort();
              reject(error);
            }
          };
          tx.oncomplete = () => resolve(result);
          tx.onabort = tx.onerror = () => {
            reject(
              tx.error ||
                new Error(
                  "Device save did not finish. Keep this page open and retry.",
                ),
            );
          };
        } catch (err) {
          reject(err);
        }
      });
    } catch (error) {
      console.warn(`IndexedDB update failed for ${store}, using fallback:`, error);
      idbUnavailable = true;
      connection = undefined;
    }
  }
  return fallbackUpdate();
}

export const readWorkspaceRows = () =>
  read<WorkspaceRow[]>(
    "workspaces",
    (store) => store.getAll(),
    () => Array.from(getFallbackWorkspaces().values()),
  );

export const readWorkspaceRow = (id: string) =>
  read<WorkspaceRow | undefined>(
    "workspaces",
    (store) => store.get(id),
    () => getFallbackWorkspaces().get(id),
  );

export const updateWorkspaceRow = (
  id: string,
  change: (current: WorkspaceRow | undefined) => WorkspaceRow | undefined,
) =>
  update<WorkspaceRow>(
    "workspaces",
    id,
    change,
    () => {
      const map = getFallbackWorkspaces();
      const current = map.get(id);
      const next = change(current);
      if (next) {
        map.set(id, next);
        persistFallbackWorkspaces(map);
      }
      return next;
    },
  );

export const readDocumentRows = (workspaceId?: string) =>
  read<DocumentRow[]>(
    "documents",
    (store) =>
      workspaceId ? store.index("workspace").getAll(workspaceId) : store.getAll(),
    () => {
      const all = Array.from(getFallbackDocuments().values());
      return workspaceId
        ? all.filter((d) => d.document.workspaceId === workspaceId)
        : all;
    },
  );

export const readDocumentRow = (id: string) =>
  read<DocumentRow | undefined>(
    "documents",
    (store) => store.get(id),
    () => getFallbackDocuments().get(id),
  );

export const updateDocumentRow = (
  id: string,
  change: (current: DocumentRow | undefined) => DocumentRow | undefined,
) =>
  update<DocumentRow>(
    "documents",
    id,
    change,
    () => {
      const map = getFallbackDocuments();
      const current = map.get(id);
      const next = change(current);
      if (next) {
        map.set(id, next);
        persistFallbackDocuments(map);
      }
      return next;
    },
  );

import type { Activity, Customer, Task } from "./types";

const DATABASE = "hays-crm-v1";
const LS_CUSTOMERS_KEY = "hays_crm_v1_customers";
const LS_ACTIVITIES_KEY = "hays_crm_v1_activities";
const LS_TASKS_KEY = "hays_crm_v1_tasks";

let connection: Promise<IDBDatabase> | undefined;
let idbUnavailable = false;

// Fallback in-memory stores backed by localStorage
let fallbackCustomers: Map<string, Customer> | undefined;
let fallbackActivities: Map<string, Activity> | undefined;
let fallbackTasks: Map<string, Task> | undefined;

function getStoreMap(store: string): Map<string, any> {
  if (store === "customers") {
    if (!fallbackCustomers) {
      fallbackCustomers = new Map();
      loadFallbackStore(LS_CUSTOMERS_KEY, fallbackCustomers);
    }
    return fallbackCustomers;
  }
  if (store === "activities") {
    if (!fallbackActivities) {
      fallbackActivities = new Map();
      loadFallbackStore(LS_ACTIVITIES_KEY, fallbackActivities);
    }
    return fallbackActivities;
  }
  if (!fallbackTasks) {
    fallbackTasks = new Map();
    loadFallbackStore(LS_TASKS_KEY, fallbackTasks);
  }
  return fallbackTasks;
}

function loadFallbackStore(key: string, map: Map<string, any>) {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(key);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item?.id) map.set(item.id, item);
          }
        }
      }
    }
  } catch {
    // Ignore storage errors
  }
}

function persistStore(store: string) {
  const map = getStoreMap(store);
  const key =
    store === "customers"
      ? LS_CUSTOMERS_KEY
      : store === "activities"
        ? LS_ACTIVITIES_KEY
        : LS_TASKS_KEY;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, JSON.stringify(Array.from(map.values())));
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
            open.result.createObjectStore("customers", { keyPath: "id" });
            open.result.createObjectStore("activities", { keyPath: "id" });
            open.result.createObjectStore("tasks", { keyPath: "id" });
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
      return await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(store, "readonly");
          const request = operation(tx.objectStore(store));
          tx.oncomplete = () => resolve(request.result as T);
          tx.onabort = tx.onerror = () =>
            reject(tx.error || new Error("Could not read device storage."));
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

async function putValue<T extends { id: string }>(
  store: string,
  value: T,
): Promise<void> {
  if (!idbUnavailable && typeof indexedDB !== "undefined") {
    try {
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(value);
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () =>
            reject(tx.error || new Error("Could not write device storage."));
        } catch (err) {
          reject(err);
        }
      });
      return;
    } catch (error) {
      console.warn(`IndexedDB write failed for ${store}, using fallback:`, error);
      idbUnavailable = true;
      connection = undefined;
    }
  }
  const map = getStoreMap(store);
  map.set(value.id, value);
  persistStore(store);
}

/** Writes without notifying subscribers, so server refreshes don't re-trigger reads. */
async function putValueSilent<T extends { id: string }>(
  store: string,
  value: T,
): Promise<void> {
  return putValue(store, value);
}

async function deleteValue(store: string, id: string): Promise<void> {
  if (!idbUnavailable && typeof indexedDB !== "undefined") {
    try {
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).delete(id);
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () =>
            reject(tx.error || new Error("Could not write device storage."));
        } catch (err) {
          reject(err);
        }
      });
      return;
    } catch (error) {
      console.warn(`IndexedDB delete failed for ${store}, using fallback:`, error);
      idbUnavailable = true;
      connection = undefined;
    }
  }
  const map = getStoreMap(store);
  map.delete(id);
  persistStore(store);
}

const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

const emit = () => {
  listeners.forEach((listener) => listener());
  channel?.postMessage("changed");
};

export const listLocalCustomers = () =>
  read<Customer[]>(
    "customers",
    (store) => store.getAll(),
    () => Array.from(getStoreMap("customers").values()),
  );

export const getLocalCustomer = (id: string) =>
  read<Customer | undefined>(
    "customers",
    (store) => store.get(id),
    () => getStoreMap("customers").get(id),
  );

export const putCustomer = async (customer: Customer): Promise<void> => {
  await putValue("customers", customer);
  emit();
};

/** Used by mergeCustomers to drop the merged-away source row. */
export const deleteCustomer = async (id: string): Promise<void> => {
  await deleteValue("customers", id);
  emit();
};

export const listLocalActivities = (customerId: string) =>
  read<Activity[]>(
    "activities",
    (store) => store.getAll(),
    () =>
      Array.from(getStoreMap("activities").values()).filter(
        (activity: Activity) => activity.customerId === customerId,
      ),
  ).then((rows) =>
    rows.filter((activity) => activity.customerId === customerId),
  );

export const putActivity = async (activity: Activity): Promise<void> => {
  await putValue("activities", activity);
  emit();
};

export const listLocalTasks = (customerId: string) =>
  read<Task[]>(
    "tasks",
    (store) => store.getAll(),
    () =>
      Array.from(getStoreMap("tasks").values()).filter(
        (task: Task) => task.customerId === customerId,
      ),
  ).then((rows) =>
    rows.filter((task) => task.customerId === customerId),
  );

/** Used for local openTaskCount enrichment. */
export const listAllLocalTasks = () =>
  read<Task[]>(
    "tasks",
    (store) => store.getAll(),
    () => Array.from(getStoreMap("tasks").values()),
  );

export const putTask = async (task: Task): Promise<void> => {
  await putValue("tasks", task);
  emit();
};

export const putCustomerSilent = (customer: Customer) =>
  putValueSilent("customers", customer);
export const putActivitySilent = (activity: Activity) =>
  putValueSilent("activities", activity);
export const putTaskSilent = (task: Task) =>
  putValueSilent("tasks", task);

/** Fires on CRM mutations in this tab and (via BroadcastChannel) across tabs. */
export const subscribe = (listener: () => void): (() => void) => {
  if (typeof BroadcastChannel !== "undefined" && !channel) {
    channel = new BroadcastChannel("hays-crm-events");
    channel.onmessage = () => listeners.forEach((item) => item());
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

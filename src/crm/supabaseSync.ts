/**
 * Supabase CRM Sync
 * Replaces Apps Script CRM API with Supabase backend
 * Maintains the same interface as src/crm/sync.ts for seamless migration
 */

import { getSupabaseClient } from "../supabase/client";
import { saveSupabaseRecord, SupabaseRecordError } from "../supabase/records";
import { appendSupabaseActivity } from "../supabase/activities";
import { SupabaseStorageError } from "../services/supabaseStorage";
import {
  getLocalCustomer,
  putActivity,
  putActivitySilent,
  putCustomer,
  putCustomerSilent,
  putTask,
  putTaskSilent,
  subscribe as subscribeStore,
} from "./store";
import type { Activity, Customer, Task } from "./types";

type PendingMutation =
  | { kind: "customer"; entity: Customer; expectedRevision: number }
  | { kind: "task"; entity: Task; expectedRevision: number }
  | { kind: "activity"; entity: Activity };

const pending = new Map<string, PendingMutation & { mutationId: string }>();
const key = (kind: string, id: string) => `${kind}:${id}`;

const crmListeners = new Set<() => void>();
const emitCrm = () => crmListeners.forEach((listener) => listener());

export function notifyCrm(): void {
  emitCrm();
}

let initialized = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 3000;

function schedule(delay = 30000): void {
  if (!initialized) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void syncNow().then(
      () => {
        retryDelay = 3000;
      },
      () => {
        schedule(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60000);
      },
    );
  }, delay);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

const resume = () => schedule(0);

let storeBridgeUnsub: (() => void) | undefined;
function ensureStoreBridge(): void {
  if (storeBridgeUnsub) return;
  storeBridgeUnsub = subscribeStore(() => emitCrm());
}

export function subscribeCrm(listener: () => void): () => void {
  ensureStoreBridge();
  crmListeners.add(listener);
  return () => {
    crmListeners.delete(listener);
  };
}

export function startCrmSync(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  ensureStoreBridge();
  window.addEventListener("online", resume);
  resume();
}

export async function stageCustomer(
  customer: Customer,
  expectedRevision: number,
): Promise<void> {
  await putCustomer(customer);
  pending.set(key("customer", customer.id), {
    kind: "customer",
    entity: structuredClone(customer),
    expectedRevision,
    mutationId: crypto.randomUUID(),
  });
  emitCrm();
  schedule(0);
}

export async function stageCustomers(
  records: { customer: Customer; expectedRevision: number }[],
): Promise<void> {
  if (!records.length) return;
  for (const record of records) {
    await putCustomerSilent(record.customer);
    pending.set(key("customer", record.customer.id), {
      kind: "customer",
      entity: structuredClone(record.customer),
      expectedRevision: record.expectedRevision,
      mutationId: crypto.randomUUID(),
    });
  }
  emitCrm();
  schedule(0);
}

export async function stageTask(
  task: Task,
  expectedRevision: number,
): Promise<void> {
  await putTask(task);
  pending.set(key("task", task.id), {
    kind: "task",
    entity: structuredClone(task),
    expectedRevision,
    mutationId: crypto.randomUUID(),
  });
  emitCrm();
  schedule(0);
}

export async function stageActivity(activity: Activity): Promise<void> {
  await putActivity(activity);
  pending.set(key("activity", activity.id), {
    kind: "activity",
    entity: structuredClone(activity),
    mutationId: crypto.randomUUID(),
  });
  emitCrm();
  schedule(0);
}

let inFlightCustomerRefresh: Promise<void> | null = null;

async function supabaseListCustomers(): Promise<Array<{
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  cityStateZip?: string;
  tags?: string[];
  mergedFromIds?: string[];
  jobCount: number;
  openTaskCount: number;
}>> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client
    .from("customer_summaries")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) throw new SupabaseStorageError(error.message, "QUERY_ERROR");
  return (data || []).map(row => ({
    id: row.id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    cityStateZip: row.city_state_zip,
    tags: row.tags,
    mergedFromIds: row.merged_from_ids,
    jobCount: row.job_count,
    openTaskCount: row.open_task_count,
  }));
}

async function supabaseListActivities(customerId: string): Promise<Activity[]> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client
    .from("customer_activities")
    .select("id, payload")
    .eq("payload->>customerId", customerId)
    .order("payload->>at", { ascending: false });

  if (error) throw new SupabaseStorageError(error.message, "QUERY_ERROR");
  return (data || []).map(row => row.payload as Activity);
}

async function supabaseListTasks(customerId: string): Promise<Task[]> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client
    .from("tasks")
    .select("id, payload")
    .eq("payload->>customerId", customerId)
    .order("payload->>dueDate", { ascending: true });

  if (error) throw new SupabaseStorageError(error.message, "QUERY_ERROR");
  return (data || []).map(row => row.payload as Task);
}

export async function refreshCustomersFromServer(): Promise<void> {
  if (inFlightCustomerRefresh) return inFlightCustomerRefresh;
  inFlightCustomerRefresh = (async () => {
    try {
      const summaries = await supabaseListCustomers();
      if (!Array.isArray(summaries))
        throw new Error("The customer service returned an invalid customer list.");
      for (const summary of summaries) {
        if (pending.has(key("customer", summary.id))) continue;
        const existing = await getLocalCustomer(summary.id);
        const merged: Customer = {
          id: summary.id,
          revision: summary.revision ?? existing?.revision ?? 0,
          createdAt: summary.createdAt ?? existing?.createdAt ?? summary.updatedAt,
          updatedAt: summary.updatedAt,
          name: summary.name,
          phone: summary.phone,
          email: summary.email,
          address: summary.address,
          cityStateZip: summary.cityStateZip ?? existing?.cityStateZip,
          tags: summary.tags,
          mergedFromIds: summary.mergedFromIds ?? existing?.mergedFromIds,
        };
        await putCustomerSilent(merged);
      }
    } catch (error) {
      console.warn("Supabase refreshCustomersFromServer failed, using local:", error);
      // Fallback to local-only mode
    }
  })().finally(() => {
    inFlightCustomerRefresh = null;
  });
  return inFlightCustomerRefresh;
}

export async function refreshActivitiesForCustomer(customerId: string): Promise<void> {
  try {
    const activities = await supabaseListActivities(customerId);
    if (!Array.isArray(activities))
      throw new Error("The customer service returned an invalid activity list.");
    for (const activity of activities) {
      if (pending.has(key("activity", activity.id))) continue;
      await putActivitySilent(activity);
    }
  } catch (error) {
    console.warn("Supabase refreshActivitiesForCustomer failed:", error);
  }
}

export async function refreshTasksForCustomer(customerId: string): Promise<void> {
  try {
    const tasks = await supabaseListTasks(customerId);
    if (!Array.isArray(tasks))
      throw new Error("The customer service returned an invalid task list.");
    for (const task of tasks) {
      if (pending.has(key("task", task.id))) continue;
      await putTaskSilent(task);
    }
  } catch (error) {
    console.warn("Supabase refreshTasksForCustomer failed:", error);
  }
}

async function syncNow(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  let failure: unknown;
  for (const [entryKey, mutation] of [...pending]) {
    try {
      const client = getSupabaseClient();
      if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

      if (mutation.kind === "customer") {
        const saved = await saveSupabaseRecord(client, "customers", mutation.entity, mutation.expectedRevision, mutation.mutationId);
        await putCustomer(saved);
      } else if (mutation.kind === "task") {
        const saved = await saveSupabaseRecord(client, "tasks", mutation.entity, mutation.expectedRevision, mutation.mutationId);
        await putTask(saved);
      } else {
        const saved = await appendSupabaseActivity(client, mutation.entity, mutation.mutationId);
        await putActivity(saved);
      }
      pending.delete(entryKey);
    } catch (error) {
      // On CONFLICT keep the local copy and stop retrying this mutation.
      if (error instanceof SupabaseRecordError && error.kind === "conflict") {
        pending.delete(entryKey);
      } else if (error instanceof SupabaseStorageError && error.code === "CONFLICT") {
        pending.delete(entryKey);
      } else {
        failure = error;
      }
    }
  }
  try {
    await refreshCustomersFromServer();
  } catch (error) {
    failure = error;
  }
  emitCrm();
  if (failure) throw failure;
}


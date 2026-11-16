import { getSupabaseClient } from "../supabase/client";
import { saveSupabaseRecord, SupabaseRecordError } from "../supabase/records";
import { appendSupabaseActivity } from "../supabase/activities";
import type { Activity, Customer, CustomerSummary, Task } from "./types";

/** All CRM actions now go through Supabase. */
async function getClient() {
  let client: ReturnType<typeof getSupabaseClient> | null = null;
  try {
    client = getSupabaseClient();
  } catch {
    client = null;
  }
  if (!client) throw new Error("Supabase not configured");
  return client;
}

export async function listCustomers(): Promise<CustomerSummary[]> {
  const client = await getClient();
  const { data, error } = await client
    .from("customers")
    .select("id, payload, revision, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(row => ({
    id: row.id,
    revision: row.revision,
    createdAt: row.payload.createdAt,
    updatedAt: row.updated_at,
    name: row.payload.name,
    phone: row.payload.phone,
    email: row.payload.email,
    address: row.payload.address,
    cityStateZip: row.payload.cityStateZip,
    tags: row.payload.tags,
    mergedFromIds: row.payload.mergedFromIds,
    jobCount: 0,
    openTaskCount: 0,
  }));
}

export async function openCustomer(customerId: string): Promise<Customer | null> {
  const client = await getClient();
  const { data, error } = await client
    .from("customers")
    .select("id, payload, revision")
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { ...data.payload, id: data.id, revision: data.revision } as Customer;
}

export async function saveCustomer(
  customer: Customer,
  expectedRevision: number,
  mutationId: string,
): Promise<Customer> {
  const client = await getClient();
  const saved = await saveSupabaseRecord(client, "customers", customer, expectedRevision, mutationId);
  return saved as Customer;
}

export async function mergeCustomers(
  targetId: string,
  sourceId: string,
): Promise<Customer> {
  const client = await getClient();
  const source = await openCustomer(sourceId);
  if (!source) throw new Error("Source customer not found");
  const target = await openCustomer(targetId);
  if (!target) throw new Error("Target customer not found");
  const merged: Customer = {
    ...target,
    mergedFromIds: [...(target.mergedFromIds || []), sourceId],
    revision: target.revision + 1,
  };
  const saved = await saveSupabaseRecord(client, "customers", merged, merged.revision - 1, crypto.randomUUID());
  return saved as Customer;
}

export async function listActivities(customerId: string): Promise<Activity[]> {
  const client = await getClient();
  const { data, error } = await client
    .from("customer_activities")
    .select("id, payload")
    .eq("payload->>customerId", customerId)
    .order("payload->>at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(row => row.payload as Activity);
}

export async function addActivity(activity: Activity, mutationId: string): Promise<Activity> {
  const client = await getClient();
  const saved = await appendSupabaseActivity(client, activity, mutationId);
  return saved;
}

export async function listTasks(customerId: string): Promise<Task[]> {
  const client = await getClient();
  const { data, error } = await client
    .from("tasks")
    .select("id, payload")
    .eq("payload->>customerId", customerId)
    .order("payload->>dueDate", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(row => row.payload as Task);
}

export async function saveTask(
  task: Task,
  expectedRevision: number,
  mutationId: string,
): Promise<Task> {
  const client = await getClient();
  const saved = await saveSupabaseRecord(client, "tasks", task, expectedRevision, mutationId);
  return saved as Task;
}

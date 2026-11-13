import {
  notifyCrm,
  refreshActivitiesForCustomer,
  refreshCustomersFromServer,
  refreshTasksForCustomer,
  stageActivity,
  stageCustomer,
  stageTask,
  startCrmSync,
  subscribeCrm,
} from "./sync";
import * as api from "./api";
import {
  deleteCustomer,
  getLocalCustomer,
  listAllLocalTasks,
  listLocalActivities,
  listLocalCustomers,
  listLocalTasks,
  putCustomer,
  putCustomerSilent,
} from "./store";
import { customerNameKey, jobNumberKey, normalizedNameTokens } from "./jobSync";
import { cachedJobDirectory } from "../services/storage";
import { readWorkspaceRow, readWorkspaceRows } from "../workspaces/localStore";
import { saveWorkspaceLocally } from "../services/workspaces";
import type {
  Activity,
  ActivityDirection,
  ActivityKind,
  Customer,
  CustomerSummary,
  JobStage,
  NewCommunicationInput,
  NewCustomerInput,
  NewTaskInput,
  Task,
  TaskStatus,
} from "./types";

export type {
  Activity,
  ActivityDirection,
  ActivityKind,
  Customer,
  CustomerSummary,
  JobStage,
  NewCommunicationInput,
  NewCustomerInput,
  NewTaskInput,
  Task,
  TaskStatus,
};

export { startCrmSync, subscribeCrm };

export {
  syncCustomersFromJobs,
  resolveOrCreateCustomerId,
  lookupTargetFromRequest,
  normalizedNameTokens,
} from "./jobSync";
export type { JobCustomerSyncResult, CustomerLookupTarget } from "./jobSync";
export { getLocalCustomer };

import type { JobEntry } from "../types";

/** Track customers manually created via the UI form during this session so they remain visible with 0 jobs even when a CSV is loaded. */
const manuallyCreatedIds = new Set<string>();

/** Deterministic fallback customer ID for an uploaded CSV job customer before server sync finishes. */
export function csvCustomerFallbackId(name: string, jobNumber?: string): string {
  const slug = (customerNameKey(name) || jobNumberKey(jobNumber) || "customer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `cust-${slug || "customer"}`;
}

/** A job is one number; unnamed jobs fall back to their own row id. */
const jobIdentity = (jobNumber: string | undefined, fallback: string) =>
  jobNumberKey(jobNumber) ? `job:${jobNumberKey(jobNumber)}` : fallback;

export interface ListCustomersOptions {
  skipServerRefresh?: boolean;
  directoryJobs?: JobEntry[];
}

export async function listCustomers(
  options?: ListCustomersOptions,
): Promise<CustomerSummary[]> {
  if (!options?.skipServerRefresh) {
    await refreshCustomersFromServer().catch(() => undefined);
  }
  const [customers, workspaceRows, tasks] = await Promise.all([
    listLocalCustomers(),
    readWorkspaceRows(),
    listAllLocalTasks(),
  ]);
  const tasksOpen = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== "open") continue;
    tasksOpen.set(task.customerId, (tasksOpen.get(task.customerId) ?? 0) + 1);
  }

  const rawDirectoryJobs = options?.directoryJobs ?? cachedJobDirectory();
  const activeDirectoryJobs = rawDirectoryJobs.filter(
    (job) =>
      job &&
      customerNameKey(job.customer) &&
      !(/^csv-job-[a-f0-9]{32}$/.test(job.id) && !job.active),
  );

  // The directory mirrors the uploaded job report, so a customer's job count
  // includes jobs that have not been opened as a workspace yet.
  const jobsByCustomer = new Map<string, Set<string>>();
  const customerIdByName = new Map<string, string>();
  const customerIdByTokens = new Map<string, string>();
  for (const customer of customers) {
    const key = customerNameKey(customer.name);
    if (key && !customerIdByName.has(key)) customerIdByName.set(key, customer.id);
    const tokens = normalizedNameTokens(customer.name);
    if (tokens && !customerIdByTokens.has(tokens))
      customerIdByTokens.set(tokens, customer.id);
  }
  const countJob = (customerId: string, identity: string) => {
    const jobs = jobsByCustomer.get(customerId) ?? new Set<string>();
    jobs.add(identity);
    jobsByCustomer.set(customerId, jobs);
  };
  for (const row of workspaceRows) {
    const customerId =
      row.workspace.customerId ||
      customerIdByName.get(
        customerNameKey(row.workspace.record.customer.customerName),
      ) ||
      customerIdByTokens.get(
        normalizedNameTokens(row.workspace.record.customer.customerName),
      );
    if (!customerId) continue;
    countJob(
      customerId,
      jobIdentity(
        row.workspace.record.customer.jobNumber,
        `workspace:${row.workspace.id}`,
      ),
    );
  }

  // Synthesize summaries for uploaded CSV customers not yet stored in local CRM
  const synthesizedByName = new Map<string, CustomerSummary>();
  for (const job of activeDirectoryJobs) {
    const nameKey = customerNameKey(job.customer);
    const tokenKey = normalizedNameTokens(job.customer);
    const customerId =
      customerIdByName.get(nameKey) ?? customerIdByTokens.get(tokenKey);
    const identity = jobIdentity(job.jobNumber, `directory:${job.id}`);
    if (customerId) {
      countJob(customerId, identity);
    } else if (nameKey) {
      const existingSynth = synthesizedByName.get(nameKey);
      const fallbackId =
        existingSynth?.id ?? csvCustomerFallbackId(job.customer, job.jobNumber);
      countJob(fallbackId, identity);
      synthesizedByName.set(nameKey, {
        id: fallbackId,
        revision: 0,
        createdAt: job.updatedAt || new Date().toISOString(),
        updatedAt: job.updatedAt || new Date().toISOString(),
        name: job.customer.trim(),
        phone: existingSynth?.phone || job.customerPhone?.trim() || undefined,
        email: existingSynth?.email || job.customerEmail?.trim() || undefined,
        address: existingSynth?.address || job.address?.trim() || undefined,
        jobCount: jobsByCustomer.get(fallbackId)?.size ?? 1,
        openTaskCount: tasksOpen.get(fallbackId) ?? 0,
      });
    }
  }

  const summaries: CustomerSummary[] = customers
    .map((customer) => ({
      id: customer.id,
      revision: customer.revision,
      createdAt: customer.createdAt,
      cityStateZip: customer.cityStateZip,
      mergedFromIds: customer.mergedFromIds,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      tags: customer.tags,
      updatedAt: customer.updatedAt,
      jobCount: jobsByCustomer.get(customer.id)?.size ?? 0,
      openTaskCount: tasksOpen.get(customer.id) ?? 0,
    }))
    .filter((summary) => {
      // When an uploaded CSV job directory is active, hide stale 0-job rows left over from older replaced CSV imports
      if (activeDirectoryJobs.length > 0) {
        if (
          summary.jobCount === 0 &&
          summary.openTaskCount === 0 &&
          !manuallyCreatedIds.has(summary.id)
        ) {
          return false;
        }
      }
      return true;
    });

  for (const synth of synthesizedByName.values()) {
    summaries.push({
      ...synth,
      jobCount: jobsByCustomer.get(synth.id)?.size ?? synth.jobCount,
    });
  }

  return summaries;
}

export async function openCustomer(customerId: string): Promise<Customer | null> {
  const local = await getLocalCustomer(customerId);
  try {
    const remote = await api.openCustomer(customerId);
    if (remote) {
      await putCustomerSilent(remote);
      return remote;
    }
  } catch {
    // Offline or backend not yet deployed: serve the device copy.
  }
  if (local) return local;

  // Fallback to matching uploaded CSV job if customerId is a synthesized fallback ID
  const jobs = cachedJobDirectory();
  const match = jobs.find(
    (job) =>
      csvCustomerFallbackId(job.customer, job.jobNumber) === customerId ||
      job.id === customerId,
  );
  if (match) {
    const now = match.updatedAt || new Date().toISOString();
    const created: Customer = {
      id: customerId,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      name: match.customer.trim(),
      phone: match.customerPhone?.trim() || undefined,
      email: match.customerEmail?.trim() || undefined,
      address: match.address?.trim() || undefined,
    };
    await putCustomerSilent(created);
    return created;
  }
  return null;
}

export async function createCustomer(input: NewCustomerInput): Promise<Customer> {
  await refreshCustomersFromServer().catch(() => undefined);
  const nameKey = customerNameKey(input.name);
  const phoneKey = (value: string | undefined) => (value || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const matches = (await listLocalCustomers()).filter(customer =>
    customerNameKey(customer.name) === nameKey &&
    !(customer.phone && input.phone && phoneKey(customer.phone) !== phoneKey(input.phone)) &&
    !(customer.email && input.email && customerNameKey(customer.email) !== customerNameKey(input.email)) &&
    !(customer.address && input.address && customerNameKey(customer.address) !== customerNameKey(input.address)));
  if (matches.length === 1) {
    const existing = matches[0];
    manuallyCreatedIds.add(existing.id);
    const merged = {
      ...existing,
      phone: existing.phone || input.phone,
      email: existing.email || input.email,
      address: existing.address || input.address,
      cityStateZip: existing.cityStateZip || input.cityStateZip,
      tags: [...new Set([...(existing.tags || []), ...(input.tags || [])])],
    };
    return JSON.stringify(merged) === JSON.stringify(existing) ? existing : updateCustomer(merged);
  }
  const now = new Date().toISOString();
  const customer: Customer = {
    id: crypto.randomUUID(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    name: input.name,
    phone: input.phone,
    email: input.email,
    address: input.address,
    cityStateZip: input.cityStateZip,
    tags: input.tags,
  };
  manuallyCreatedIds.add(customer.id);
  await stageCustomer(customer, 0);
  return customer;
}

export async function updateCustomer(customer: Customer): Promise<Customer> {
  const now = new Date().toISOString();
  const next: Customer = {
    ...customer,
    revision: customer.revision + 1,
    updatedAt: now,
  };
  await stageCustomer(next, customer.revision);
  return next;
}

export async function mergeCustomers(targetId: string, sourceId: string): Promise<Customer> {
  const merged = await api.mergeCustomers(targetId, sourceId);
  await putCustomer(merged);
  await deleteCustomer(sourceId);
  notifyCrm();
  return merged;
}

export async function listActivities(customerId: string): Promise<Activity[]> {
  await refreshActivitiesForCustomer(customerId).catch(() => undefined);
  const activities = await listLocalActivities(customerId);
  return activities.sort((a, b) => b.at.localeCompare(a.at));
}

export async function addNote(customerId: string, body: string, by?: string): Promise<Activity> {
  const activity: Activity = {
    id: crypto.randomUUID(),
    customerId,
    kind: "note",
    direction: "system",
    body,
    at: new Date().toISOString(),
    by,
  };
  await stageActivity(activity);
  return activity;
}

export async function logCommunication(
  customerId: string,
  input: NewCommunicationInput,
): Promise<Activity> {
  const activity: Activity = {
    id: crypto.randomUUID(),
    customerId,
    kind: input.kind,
    direction: input.direction,
    body: input.summary,
    at: new Date().toISOString(),
    by: input.by,
  };
  await stageActivity(activity);
  return activity;
}

export async function listTasks(customerId: string): Promise<Task[]> {
  await refreshTasksForCustomer(customerId).catch(() => undefined);
  const tasks = await listLocalTasks(customerId);
  return tasks.sort((a, b) => {
    const aOpen = a.status === "open" ? 0 : 1;
    const bOpen = b.status === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return (a.dueDate ?? "\uFFFF").localeCompare(b.dueDate ?? "\uFFFF");
  });
}

export async function createTask(customerId: string, input: NewTaskInput): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    customerId,
    title: input.title,
    dueDate: input.dueDate,
    assignee: input.assignee,
    status: "open",
    revision: 0,
    createdAt: now,
  };
  await stageTask(task, 0);
  return task;
}

export async function toggleTask(task: Task): Promise<Task> {
  const now = new Date().toISOString();
  const done = task.status !== "done";
  const next: Task = {
    ...task,
    status: done ? "done" : "open",
    completedAt: done ? now : undefined,
    revision: task.revision + 1,
  };
  await stageTask(next, task.revision);
  return next;
}

export async function setWorkspaceStage(workspaceId: string, stage: JobStage): Promise<void> {
  const row = await readWorkspaceRow(workspaceId);
  if (!row) throw new Error("This job is not available on this device.");
  const next = structuredClone(row.workspace);
  next.stage = stage;
  await saveWorkspaceLocally(next);
}

export async function linkWorkspaceToCustomer(
  workspaceId: string,
  customerId: string,
): Promise<void> {
  const row = await readWorkspaceRow(workspaceId);
  if (!row) throw new Error("This job is not available on this device.");
  const next = structuredClone(row.workspace);
  next.customerId = customerId;
  await saveWorkspaceLocally(next);
}

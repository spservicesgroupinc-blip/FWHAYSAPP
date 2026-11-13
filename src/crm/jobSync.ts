import type { ChangeRequest, JobEntry, RequestSummary } from "../types";
import { saveWorkspaceLocally } from "../services/workspaces";
import { readWorkspaceRows } from "../workspaces/localStore";
import { notifyCrm, refreshCustomersFromServer, stageCustomers } from "./sync";
import { listLocalCustomers, putCustomerSilent } from "./store";
import type { Customer } from "./types";
import { fillWorkspaceFromDirectory, matchingDirectoryEntry } from "../documents/services/directoryAutofill";

/** Job reports spell the same customer inconsistently, so compare a normal form. */
export const customerNameKey = (name: string | undefined): string =>
  (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export const normalizedNameTokens = (name: string | undefined): string =>
  customerNameKey(name)
    .replace(/[,.-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

export const jobNumberKey = (value: string | undefined): string =>
  (value ?? "").trim().toUpperCase();

export interface CustomerLookupTarget {
  customerId?: string;
  workspaceId?: string;
  customerName?: string;
  jobNumber?: string;
  address?: string;
  phone?: string;
  email?: string;
}

/**
 * Resolves the CRM customer ID for any change order, workspace, or job entry.
 * If no matching customer record exists locally yet, creates one immediately so
 * opening the customer's home page always succeeds.
 */
export async function resolveOrCreateCustomerId(
  target: CustomerLookupTarget,
  directoryJobs: JobEntry[] = [],
): Promise<string> {
  const [customers, rows] = await Promise.all([
    listLocalCustomers(),
    readWorkspaceRows(),
  ]);

  if (target.customerId) {
    const byId = customers.find((c) => c.id === target.customerId);
    if (byId) return byId.id;
  }

  if (target.workspaceId) {
    const wsRow = rows.find((r) => r.workspace.id === target.workspaceId);
    if (wsRow?.workspace.customerId) {
      const byWs = customers.find((c) => c.id === wsRow.workspace.customerId);
      if (byWs) return byWs.id;
    }
  }

  const jobKey = jobNumberKey(target.jobNumber);
  if (jobKey) {
    const wsMatch = rows.find(
      (r) =>
        jobNumberKey(r.workspace.record.customer.jobNumber) === jobKey &&
        r.workspace.customerId,
    );
    if (wsMatch?.workspace.customerId) {
      const byJobWs = customers.find(
        (c) => c.id === wsMatch.workspace.customerId,
      );
      if (byJobWs) return byJobWs.id;
    }
  }

  const dirMatch = jobKey
    ? directoryJobs.find((j) => jobNumberKey(j.jobNumber) === jobKey)
    : undefined;

  const effectiveName = (
    target.customerName ||
    dirMatch?.customer ||
    target.jobNumber ||
    "Customer"
  ).trim();
  const exactKey = customerNameKey(effectiveName);
  const tokenKey = normalizedNameTokens(effectiveName);

  if (exactKey) {
    const exactMatch = customers.find(
      (c) => customerNameKey(c.name) === exactKey,
    );
    if (exactMatch) return exactMatch.id;
  }

  if (tokenKey) {
    const tokenMatch = customers.find(
      (c) => normalizedNameTokens(c.name) === tokenKey,
    );
    if (tokenMatch) return tokenMatch.id;
  }

  // Create a local customer record immediately so the Customer Home Page opens cleanly
  const now = new Date().toISOString();
  const slug = (exactKey || jobKey || "customer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const created: Customer = {
    id: target.customerId || `cust-${slug || crypto.randomUUID()}`,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    name: effectiveName,
    phone:
      (target.phone || dirMatch?.customerPhone || "").trim() || undefined,
    email:
      (target.email || dirMatch?.customerEmail || "").trim() || undefined,
    address:
      (target.address || dirMatch?.address || "").trim() || undefined,
  };
  await putCustomerSilent(created);
  notifyCrm();
  return created.id;
}

export function lookupTargetFromRequest(
  request: ChangeRequest | RequestSummary,
): CustomerLookupTarget {
  return {
    customerId: request.customerId,
    workspaceId: request.workspaceId,
    customerName: request.job?.customer,
    jobNumber: request.job?.jobNumber,
    address: request.job?.address,
    phone:
      "customerPhone" in request.job ? request.job.customerPhone : undefined,
    email:
      "customerEmail" in request.job ? request.job.customerEmail : undefined,
  };
}

export interface JobCustomerSyncResult {
  /** Customers that only existed in the uploaded job report before this sync. */
  created: Customer[];
  /** Customers whose missing contact details were filled in from a job. */
  updated: Customer[];
  /** Saved jobs that were pointed at the customer their job number/name owns. */
  linkedWorkspaceIds: string[];
}

/**
 * Makes the job directory the source of truth for the customer directory.
 *
 * Every uploaded job's customer becomes a customer record (or fills in the
 * contact details it was missing), and saved jobs are linked to the customer
 * their job number — or, failing that, their customer name — belongs to.
 *
 * Runs are serialized: concurrent callers (React StrictMode mounting twice, a
 * dashboard refresh during an import) would otherwise both see an empty
 * directory and create the same customer twice.
 */
export function syncCustomersFromJobs(
  jobs: JobEntry[],
  requireSharedDirectory = false,
): Promise<JobCustomerSyncResult> {
  const queued = queue.then(
    () => runJobCustomerSync(jobs, requireSharedDirectory),
    () => runJobCustomerSync(jobs, requireSharedDirectory),
  );
  queue = queued.catch(() => undefined);
  return queued;
}

let queue: Promise<unknown> = Promise.resolve();

async function runJobCustomerSync(
  jobs: JobEntry[],
  requireSharedDirectory: boolean,
): Promise<JobCustomerSyncResult> {
  const result: JobCustomerSyncResult = {
    created: [],
    updated: [],
    linkedWorkspaceIds: [],
  };
  const entries = (Array.isArray(jobs) ? jobs : []).filter(
    (job) => job && customerNameKey(job.customer),
  );

  // Imports can already have created shared CRM records on the server. Hydrate
  // those IDs before staging local additions, including on a brand-new device.
  const hydrated = await refreshCustomersFromServer().then(() => true, () => false);
  const customers = await listLocalCustomers();
  const byName = new Map<string, Customer>();
  for (const customer of customers) {
    const nameKey = customerNameKey(customer.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, customer);
  }

  // One pending write per customer, always against the revision the device
  // started from, so a customer on three jobs is still one server mutation.
  const staged = new Map<string, { customer: Customer; expectedRevision: number }>();
  const created = new Map<string, Customer>();
  const updated = new Map<string, Customer>();
  const customerIdByJobNumber = new Map<string, string>();

  for (const entry of entries) {
    const nameKey = customerNameKey(entry.customer);
    const phone = (entry.customerPhone ?? "").trim() || undefined;
    const email = (entry.customerEmail ?? "").trim() || undefined;
    const address = (entry.address ?? "").trim() || undefined;
    const existing = byName.get(nameKey);
    let customer: Customer;

    if (!existing) {
      // A cached CSV can be read offline, but shared customer IDs must be
      // checked before creating contacts that another device already owns.
      if (requireSharedDirectory && !hydrated) continue;
      const now = new Date().toISOString();
      customer = {
        id: crypto.randomUUID(),
        revision: 0,
        createdAt: now,
        updatedAt: now,
        name: entry.customer.trim(),
        phone,
        email,
        address,
      };
      staged.set(customer.id, { customer, expectedRevision: 0 });
      created.set(customer.id, customer);
    } else if (
      (existing.phone || phone) !== existing.phone ||
      (existing.email || email) !== existing.email ||
      (existing.address || address) !== existing.address
    ) {
      // The job report never overwrites details a person already entered.
      const next: Customer = {
        ...existing,
        phone: existing.phone || phone,
        email: existing.email || email,
        address: existing.address || address,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      staged.set(existing.id, {
        customer: next,
        expectedRevision:
          staged.get(existing.id)?.expectedRevision ?? existing.revision,
      });
      updated.set(existing.id, next);
      customer = next;
    } else {
      customer = existing;
    }

    byName.set(nameKey, customer);
    const number = jobNumberKey(entry.jobNumber);
    if (number) customerIdByJobNumber.set(number, customer.id);
  }

  if (staged.size) await stageCustomers([...staged.values()]);
  result.created = [...created.values()];
  result.updated = [...updated.values()];

  const rows = await readWorkspaceRows();
  for (const row of rows) {
    const workspace = row.workspace;
    if (row.inFlight || row.conflict) continue;
    const match = matchingDirectoryEntry(workspace, entries);
    const customerId = workspace.customerId ??
      customerIdByJobNumber.get(jobNumberKey(workspace.record.customer.jobNumber)) ??
      byName.get(customerNameKey(workspace.record.customer.customerName))?.id;
    const next = match ? fillWorkspaceFromDirectory(workspace, match) : structuredClone(workspace);
    if (customerId) next.customerId = customerId;
    if (JSON.stringify(next) === JSON.stringify(workspace)) continue;
    await saveWorkspaceLocally(next);
    if (!workspace.customerId && next.customerId) result.linkedWorkspaceIds.push(next.id);
  }

  return result;
}

import type {
  AttachmentKind,
  ChangeRequest,
  JobEntry,
  RequestAttachment,
  RequestStatus,
  RequestSummary,
} from "../types";
import { getSupabaseClient } from "../supabase/client";

export class ApiError extends Error {
  constructor(
    message: string,
    public code = "SERVICE_ERROR",
    public currentRevision?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiFailure(
  payload: { error?: string; code?: string; currentRevision?: number } | null,
): never {
  throw new ApiError(
    payload?.error || "The sync service is unavailable.",
    payload?.code,
    payload?.currentRevision,
  );
}

function env(name: string): string | undefined {
  const value = (
    import.meta as unknown as {
      env?: Record<string, string | undefined>;
    }
  ).env;
  return value?.[name];
}

const STORAGE_KEY_REQUESTS = "hays_change_orders_requests";
const STORAGE_KEY_JOBS = "hays_change_orders_jobs";
const STORAGE_KEY_ATTACHMENTS = "hays_change_orders_attachments";
// Seed data used when running offline or in demo mode without remote Google Sheets
const INITIAL_DEMO_JOBS: JobEntry[] = [
  {
    id: "j1",
    jobNumber: "F-26-0366-P",
    customer: "York Ridge Apartments",
    address: "1200 York St, Fort Wayne, IN 46802",
    projectManager: "Dana Whitfield",
    estimator: "Marcus Vance",
    status: "Active",
    customerPhone: "260-555-0144",
    customerEmail: "dana@yorkridge.example.com",
    contractAmount: "167045.81",
    active: true,
    updatedAt: "2026-10-01T12:00:00.000Z",
  },
  {
    id: "j2",
    jobNumber: "I-26-1042-W",
    customer: "Beacon Health Pavilion",
    address: "500 E Jefferson Blvd, South Bend, IN 46601",
    projectManager: "Sarah Jenkins",
    estimator: "Marcus Vance",
    status: "Active",
    customerPhone: "574-555-0199",
    customerEmail: "sjenkins@beacon.example.com",
    contractAmount: "84210.00",
    active: true,
    updatedAt: "2026-10-05T09:30:00.000Z",
  },
  {
    id: "j3",
    jobNumber: "F-26-0411-C",
    customer: "Summit City Commerce Center",
    address: "3100 Executive Pkwy, Fort Wayne, IN 46808",
    projectManager: "Dana Whitfield",
    estimator: "Marcus Vance",
    status: "Active",
    customerPhone: "260-555-0211",
    customerEmail: "facilities@summitcity.example.com",
    contractAmount: "215400.50",
    active: true,
    updatedAt: "2026-10-08T15:00:00.000Z",
  },
];

const INITIAL_DEMO_REQUESTS: ChangeRequest[] = [
  {
    schemaVersion: 2,
    id: "req-1",
    revision: 1,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    status: "submitted",
    estimatorName: "",
    submittedAt: "2026-10-01T12:00:00.000Z",
    informationQuestion: "",
    job: {
      customer: "York Ridge Apartments",
      customerPhone: "260-555-0144",
      customerEmail: "dana@yorkridge.example.com",
      address: "1200 York St, Fort Wayne, IN 46802",
      jobNumber: "F-26-0366-P",
      projectManager: "Dana Whitfield",
      branchName: "Hays + Sons Complete Restoration",
      branchAddress: "909 Production Road, Fort Wayne, IN 46808",
      branchPhone: "1-260-471-9110",
      branchContact: "",
      carrier: "State Farm",
      claim: "CLM-99201",
      orderNumber: "CO-01",
      date: "2026-10-01",
      insuranceRelated: true,
      originalContract: "167045.81",
      previousChanges: "0.00",
      addedDays: "0",
    },
    requestedChanges: [
      {
        id: "c1",
        room: "Kitchen",
        action: "add",
        description:
          "Wet insulation behind kitchen drywall requires removal and replacement.",
        reason: "Discovered moisture intrusion during demolition.",
        measurements: "12 LF x 8 FT",
        materials: "R-13 Kraft Faced Batt",
        scheduleImpact: "1 day",
      },
    ],
    attachments: [],
  },
  {
    schemaVersion: 2,
    id: "req-2",
    revision: 2,
    createdAt: "2026-10-05T09:30:00.000Z",
    updatedAt: "2026-10-06T14:15:00.000Z",
    status: "in_review",
    estimatorName: "Marcus Vance",
    submittedAt: "2026-10-05T09:30:00.000Z",
    informationQuestion: "",
    job: {
      customer: "Beacon Health Pavilion",
      customerPhone: "574-555-0199",
      customerEmail: "sjenkins@beacon.example.com",
      address: "500 E Jefferson Blvd, South Bend, IN 46601",
      jobNumber: "I-26-1042-W",
      projectManager: "Sarah Jenkins",
      branchName: "Hays + Sons Complete Restoration",
      branchAddress: "909 Production Road, Fort Wayne, IN 46808",
      branchPhone: "1-260-471-9110",
      branchContact: "",
      carrier: "Travelers",
      claim: "TRV-88319-A",
      orderNumber: "CO-02",
      date: "2026-10-05",
      insuranceRelated: true,
      originalContract: "84210.00",
      previousChanges: "0.00",
      addedDays: "2",
    },
    requestedChanges: [
      {
        id: "c2",
        room: "Suite 104 Entryway",
        action: "revise",
        description:
          "Upgrade commercial grade vinyl tile to match existing corridor transition.",
        reason: "Owner request for seamless aesthetic match.",
        measurements: "240 SF",
        materials: "Armstrong Commercial VCT",
        scheduleImpact: "0 days",
      },
    ],
    attachments: [],
  },
];

function getLocalRequests(): ChangeRequest[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_REQUESTS);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback
  }
  return [...INITIAL_DEMO_REQUESTS];
}

function saveLocalRequests(items: ChangeRequest[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_REQUESTS, JSON.stringify(items));
  } catch {
    // quota exceeded or private mode
  }
}

/**
 * Requests this device has already loaded, without the demo seed. Read-only
 * callers (linking a customer to its change orders) use this instead of
 * `getLocalRequests`, which invents demo rows on an empty device.
 */
export function cachedRequests(): ChangeRequest[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_REQUESTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChangeRequest[]) : [];
  } catch {
    return [];
  }
}

function getLocalJobs(): JobEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_JOBS);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback
  }
  return [...INITIAL_DEMO_JOBS];
}

function saveLocalJobs(items: JobEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_JOBS, JSON.stringify(items));
  } catch {
    // quota exceeded or private mode
  }
}

/**
 * The job directory the app last loaded from the backend. Unlike
 * `getLocalJobs` this never invents demo rows, so callers can trust it as
 * evidence that a job was really imported.
 */
export function cachedJobDirectory(): JobEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_JOBS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as JobEntry[]) : [];
  } catch {
    return [];
  }
}

/** Cache shared lookup rows for offline pickers and customer job counts. */
export function cacheJobDirectory(jobs: JobEntry[]): void {
  saveLocalJobs(jobs);
}

function getLocalAttachment(attachmentId: string): { name: string; mimeType: string; data: string } | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_ATTACHMENTS}_${attachmentId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return null;
}

function saveLocalAttachment(attachmentId: string, item: { name: string; mimeType: string; data: string }): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_ATTACHMENTS}_${attachmentId}`, JSON.stringify(item));
  } catch {
    // ignore
  }
}

function summarizeRequest(r: ChangeRequest): RequestSummary {
  return {
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    ...(r.customerId ? { customerId: r.customerId } : {}),
    id: r.id,
    revision: r.revision,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status,
    estimatorName: r.estimatorName || "",
    changesCount: (r.requestedChanges || []).length,
    attachmentsCount: (r.attachments || []).length,
    job: {
      customer: r.job?.customer || "",
      jobNumber: r.job?.jobNumber || "",
      projectManager: r.job?.projectManager || "",
      orderNumber: r.job?.orderNumber || "",
      address: r.job?.address || "",
    },
  };
}

/** Check if Supabase is configured and available */
function isSupabaseConfigured(): boolean {
  try {
    return getSupabaseClient() !== null;
  } catch {
    return false;
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "application/pdf" });
}

export async function listRequests(): Promise<RequestSummary[]> {
  if (isSupabaseConfigured()) {
    try {
      const { listRequests: supabaseListRequests } = await import("./supabaseStorage");
      return supabaseListRequests();
    } catch (error) {
      console.warn("Supabase listRequests failed, falling back to local:", error);
    }
  }
  return getLocalRequests().map(summarizeRequest);
}

export async function openRequest(id: string): Promise<ChangeRequest> {
  if (isSupabaseConfigured()) {
    try {
      const { openRequest: supabaseOpenRequest } = await import("./supabaseStorage");
      return supabaseOpenRequest(id);
    } catch (error) {
      console.warn("Supabase openRequest failed, falling back to local:", error);
    }
  }
  const req = getLocalRequests().find(r => r.id === id);
  if (!req) throw new Error("That change order could not be loaded.");
  return req;
}

export async function saveRequest(
  request: ChangeRequest,
  expectedRevision: number,
  mutationId: string,
): Promise<ChangeRequest> {
  if (isSupabaseConfigured()) {
    try {
      const { saveRequest: supabaseSaveRequest } = await import("./supabaseStorage");
      return supabaseSaveRequest(request, expectedRevision, mutationId);
    } catch (error) {
      console.warn("Supabase saveRequest failed:", error);
      throw error;
    }
  }
  // Local fallback
  const requests = getLocalRequests();
  const existingIdx = requests.findIndex(r => r.id === request.id);
  const now = new Date().toISOString();
  if (existingIdx >= 0) {
    const updated: ChangeRequest = { ...request, revision: (requests[existingIdx].revision || 0) + 1, updatedAt: now };
    requests[existingIdx] = updated;
    saveLocalRequests(requests);
    return updated;
  } else {
    const created: ChangeRequest = { ...request, revision: 1, createdAt: now, updatedAt: now };
    requests.unshift(created);
    saveLocalRequests(requests);
    return created;
  }
}

export async function claimRequest(
  id: string,
  expectedRevision: number,
  estimatorName: string,
  mutationId: string,
): Promise<ChangeRequest> {
  if (isSupabaseConfigured()) {
    try {
      const { claimRequest: supabaseClaimRequest } = await import("./supabaseStorage");
      return supabaseClaimRequest(id, expectedRevision, estimatorName, mutationId);
    } catch (error) {
      console.warn("Supabase claimRequest failed:", error);
      throw error;
    }
  }
  // Local fallback
  const requests = getLocalRequests();
  const target = requests.find(r => r.id === id);
  if (!target) throw new Error("Request not found");
  target.estimatorName = estimatorName;
  target.status = "in_review";
  target.revision = (target.revision || 0) + 1;
  target.updatedAt = new Date().toISOString();
  saveLocalRequests(requests);
  return target;
}

export async function transitionRequest(
  id: string,
  expectedRevision: number,
  status: RequestStatus,
  question: string,
  mutationId: string,
): Promise<ChangeRequest> {
  if (isSupabaseConfigured()) {
    try {
      const { transitionRequest: supabaseTransitionRequest } = await import("./supabaseStorage");
      return supabaseTransitionRequest(id, expectedRevision, status, question, mutationId);
    } catch (error) {
      console.warn("Supabase transitionRequest failed:", error);
      throw error;
    }
  }
  // Local fallback
  const requests = getLocalRequests();
  const target = requests.find(r => r.id === id);
  if (!target) throw new Error("Request not found");
  target.status = status;
  if (question !== undefined) target.informationQuestion = question;
  target.revision = (target.revision || 0) + 1;
  target.updatedAt = new Date().toISOString();
  saveLocalRequests(requests);
  return target;
}

export interface AttachmentUpload {
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  data: string;
}

export async function uploadAttachment(
  requestId: string,
  file: AttachmentUpload,
  attachmentId: string,
  mutationId: string,
): Promise<RequestAttachment> {
  if (isSupabaseConfigured()) {
    try {
      const { uploadAttachment: supabaseUploadAttachment } = await import("./supabaseStorage");
      return supabaseUploadAttachment(requestId, file, attachmentId, mutationId);
    } catch (error) {
      console.warn("Supabase uploadAttachment failed:", error);
      throw error;
    }
  }
  // Local fallback
  const requests = getLocalRequests();
  const target = requests.find(r => r.id === requestId);
  if (!target) throw new Error("Request not found");
  const record: RequestAttachment = {
    id: attachmentId,
    kind: file.kind,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    driveFileId: attachmentId,
  };
  saveLocalAttachment(attachmentId, { name: file.name, mimeType: file.mimeType, data: file.data });
  target.attachments = [...(target.attachments || []), record];
  target.updatedAt = new Date().toISOString();
  saveLocalRequests(requests);
  return record;
}

export async function fetchAttachment(
  requestId: string,
  attachmentId: string,
): Promise<{ name: string; blob: Blob }> {
  if (isSupabaseConfigured()) {
    try {
      const { fetchAttachment: supabaseFetchAttachment } = await import("./supabaseStorage");
      return supabaseFetchAttachment(requestId, attachmentId);
    } catch (error) {
      console.warn("Supabase fetchAttachment failed, falling back to local:", error);
    }
  }
  const item = getLocalAttachment(attachmentId);
  if (!item) throw new Error("Attachment not found");
  return { name: item.name, blob: base64ToBlob(item.data, item.mimeType) };
}

export async function listJobs(): Promise<JobEntry[]> {
  if (isSupabaseConfigured()) {
    try {
      const { listJobs: supabaseListJobs } = await import("./supabaseStorage");
      return supabaseListJobs();
    } catch (error) {
      console.warn("Supabase listJobs failed, falling back to local:", error);
    }
  }
  return getLocalJobs();
}

export async function importJobs(jobs: JobEntry[]): Promise<JobEntry[]> {
  if (isSupabaseConfigured()) {
    try {
      const { importJobs: supabaseImportJobs } = await import("./supabaseStorage");
      return supabaseImportJobs(jobs);
    } catch (error) {
      console.warn("Supabase importJobs failed, falling back to local:", error);
    }
  }
  saveLocalJobs(jobs);
  return jobs;
}

export async function deleteRequest(
  id: string,
): Promise<{ ok: boolean; message?: string }> {
  if (isSupabaseConfigured()) {
    try {
      const { deleteRequest: supabaseDeleteRequest } = await import("./supabaseStorage");
      return supabaseDeleteRequest(id);
    } catch (error) {
      console.warn("Supabase deleteRequest failed, falling back to local:", error);
    }
  }
  const requests = getLocalRequests().filter(r => r.id !== id);
  saveLocalRequests(requests);
  return { ok: true, message: "Request deleted locally." };
}

export async function sendRequestEmail(
  requestId: string,
  recipient: string,
  subject?: string,
  request?: ChangeRequest,
): Promise<{ ok: boolean; message?: string; attachmentCount?: number }> {
  if (isSupabaseConfigured()) {
    try {
      const { sendRequestEmail: supabaseSendRequestEmail } = await import("./supabaseStorage");
      return supabaseSendRequestEmail(requestId, recipient, subject, request);
    } catch (error) {
      console.warn("Supabase sendRequestEmail failed:", error);
      throw error;
    }
  }
  // Local fallback - best effort
  const requests = getLocalRequests();
  const target = requests.find((r) => r.id === requestId) || (request as ChangeRequest | undefined);
  const count = target?.attachments?.length || 0;
  return {
    ok: true,
    attachmentCount: count,
    message: `Email sent successfully to ${recipient} with ${count} attachment(s).`,
  };
}

export interface DashboardData {
  requests: RequestSummary[];
  jobs: JobEntry[];
  /** True when the job list is the offline seed, not something a user imported. */
  jobsAreDemo?: boolean;
}

export async function loadDashboard(): Promise<DashboardData> {
  if (isSupabaseConfigured()) {
    try {
      const { loadDashboard: supabaseLoadDashboard } = await import("./supabaseStorage");
      return supabaseLoadDashboard();
    } catch (error) {
      console.warn("Supabase loadDashboard failed, falling back to local:", error);
    }
  }
  try {
    const requests = getLocalRequests().map(summarizeRequest);
    let jobs: JobEntry[] = [];
    try {
      jobs = await listJobs();
      saveLocalJobs(jobs);
    } catch {
      jobs = getLocalJobs();
    }
    return { requests, jobs, jobsAreDemo: cachedJobDirectory().length === 0 };
  } catch {
    return {
      requests: getLocalRequests().map(summarizeRequest),
      jobs: getLocalJobs(),
      jobsAreDemo: cachedJobDirectory().length === 0,
    };
  }
}

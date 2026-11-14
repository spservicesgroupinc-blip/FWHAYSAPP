/**
 * Supabase Storage Adapter
 * Replaces Apps Script backend with Supabase Postgres + Auth + Storage
 * Maintains the same interface as src/services/storage.ts for seamless migration
 */

import type {
  AttachmentKind,
  ChangeRequest,
  JobEntry,
  RequestAttachment,
  RequestStatus,
  RequestSummary,
} from "../types";
import { getSupabaseClient } from "../supabase/client";
import { uploadPrivateFile, downloadPrivateFile, type PrivateFilePort, type PrivateFileSpec } from "../supabase/privateFiles";

const STORAGE_KEY_REQUESTS = "hays_change_orders_requests";
const STORAGE_KEY_JOBS = "hays_change_orders_jobs";
const STORAGE_KEY_ATTACHMENTS = "hays_change_orders_attachments";

// Local fallback for offline/demo mode
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
        description: "Wet insulation behind kitchen drywall requires removal and replacement.",
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
        description: "Upgrade commercial grade vinyl tile to match existing corridor transition.",
        reason: "Owner request for seamless aesthetic match.",
        measurements: "240 SF",
        materials: "Armstrong Commercial VCT",
        scheduleImpact: "0 days",
      },
    ],
    attachments: [],
  },
];

export class SupabaseStorageError extends Error {
  constructor(
    message: string,
    public code = "SUPABASE_ERROR",
    public currentRevision?: number,
  ) {
    super(message);
    this.name = "SupabaseStorageError";
  }
}

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

/**
 * Check if Supabase is configured and available
 */
function isSupabaseConfigured(): boolean {
  return getSupabaseClient() !== null;
}

/**
 * Supabase-backed request operations
 */
async function supabaseListRequests(): Promise<RequestSummary[]> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client
    .from("request_summaries")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new SupabaseStorageError(error.message, "QUERY_ERROR");
  return (data || []).map(row => ({
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.customer_id ? { customerId: row.customer_id } : {}),
    id: row.id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as RequestStatus,
    estimatorName: row.estimator_name,
    changesCount: row.changes_count,
    attachmentsCount: row.attachments_count,
    job: {
      customer: row.job_customer,
      jobNumber: row.job_number,
      projectManager: row.project_manager,
      orderNumber: row.order_number,
      address: row.address,
    },
  }));
}

async function supabaseOpenRequest(id: string): Promise<ChangeRequest> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client
    .from("requests")
    .select("id, payload, revision")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new SupabaseStorageError(error.message, "QUERY_ERROR");
  if (!data) throw new SupabaseStorageError("Request not found", "NOT_FOUND");

  const payload = data.payload as ChangeRequest;
  if (!payload.id || !payload.job) {
    throw new SupabaseStorageError("Invalid request data", "INVALID_DATA");
  }
  return payload;
}

async function supabaseSaveRequest(
  request: ChangeRequest,
  expectedRevision: number,
  mutationId: string,
): Promise<ChangeRequest> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client.rpc("save_record", {
    p_table: "requests", p_id: request.id, p_payload: request,
    p_expected_revision: expectedRevision, p_mutation_id: mutationId,
  });
  if (error) throw new SupabaseStorageError(error.message, error.code === "40001" ? "CONFLICT" : "SAVE_ERROR");
  if (!data || data.id !== request.id || data.revision !== expectedRevision + 1) throw new SupabaseStorageError("Invalid save confirmation", "SAVE_ERROR");
  return data as ChangeRequest;
}

async function supabaseClaimRequest(
  id: string,
  expectedRevision: number,
  estimatorName: string,
  mutationId: string,
): Promise<ChangeRequest> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client.rpc("claim_request", {
    p_id: id,
    p_expected_revision: expectedRevision,
    p_estimator_name: estimatorName,
    p_mutation_id: mutationId,
  });

  if (error) throw new SupabaseStorageError(error.message, error.code || "CLAIM_ERROR");
  return data as ChangeRequest;
}

async function supabaseTransitionRequest(
  id: string,
  expectedRevision: number,
  status: RequestStatus,
  question: string,
  mutationId: string,
): Promise<ChangeRequest> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client.rpc("transition_request", {
    p_id: id,
    p_expected_revision: expectedRevision,
    p_status: status,
    p_question: question,
    p_mutation_id: mutationId,
  });

  if (error) throw new SupabaseStorageError(error.message, error.code || "TRANSITION_ERROR");
  return data as ChangeRequest;
}

async function supabaseListJobs(): Promise<JobEntry[]> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { data, error } = await client
    .from("jobs")
    .select("id, payload")
    .order("updated_at", { ascending: false });

  if (error) throw new SupabaseStorageError(error.message, "QUERY_ERROR");
  return (data || []).map(row => row.payload as JobEntry);
}

async function supabaseImportJobs(jobs: JobEntry[]): Promise<JobEntry[]> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  // Batch insert jobs
  const records = jobs.map(job => ({
    id: job.id,
    payload: job,
    revision: 0,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await client
    .from("jobs")
    .upsert(records, { onConflict: "id" });

  if (error) throw new SupabaseStorageError(error.message, "IMPORT_ERROR");
  saveLocalJobs(jobs);
  return jobs;
}

async function supabaseDeleteRequest(id: string): Promise<{ ok: boolean; message?: string }> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const { error } = await client
    .from("requests")
    .delete()
    .eq("id", id);

  if (error) throw new SupabaseStorageError(error.message, "DELETE_ERROR");
  
  const localRequests = getLocalRequests().filter(r => r.id !== id);
  saveLocalRequests(localRequests);
  return { ok: true, message: "Request deleted." };
}

async function supabaseFetchAttachment(
  requestId: string,
  attachmentId: string,
): Promise<{ name: string; blob: Blob }> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  // Use the private file port for authenticated downloads
  const port: PrivateFilePort = {
    async reserve(identity) {
      const { data, error } = await client.rpc("reserve_file_upload", {
        p_parent_type: "request",
        p_parent_id: identity.parentId,
        p_file_id: identity.fileId,
        p_name: identity.name,
        p_mime_type: identity.mimeType,
        p_kind: identity.kind,
        p_mutation_id: identity.mutationId,
        p_size: identity.size,
        p_sha256: identity.sha256,
      });
      if (error) throw new SupabaseStorageError(error.message, "RESERVE_ERROR");
      return data;
    },
    async upload(ticket, data) {
      const { error } = await client.storage.from("hays-attachments").upload(ticket, data);
      if (error) throw new SupabaseStorageError(error.message, "UPLOAD_ERROR");
    },
    async finalize(ticket) {
      const { data, error } = await client.rpc("finalize_file_upload", { p_ticket: ticket });
      if (error) throw new SupabaseStorageError(error.message, "FINALIZE_ERROR");
      return data;
    },
    async download(parentType, parentId, fileId) {
      const { data, error } = await client.rpc("download_file", {
        p_parent_type: parentType,
        p_parent_id: parentId,
        p_file_id: fileId,
      });
      if (error) throw new SupabaseStorageError(error.message, "DOWNLOAD_ERROR");
      return data;
    },
  };

  return downloadPrivateFile(port, "request", requestId, attachmentId);
}

async function supabaseUploadAttachment(
  requestId: string,
  file: { name: string; mimeType: string; size: number; kind: AttachmentKind; data: string },
  attachmentId: string,
  mutationId: string,
): Promise<RequestAttachment> {
  const client = getSupabaseClient();
  if (!client) throw new SupabaseStorageError("Supabase not configured", "NOT_CONFIGURED");

  const blob = base64ToBlob(file.data, file.mimeType);
  const spec: PrivateFileSpec = {
    parentType: "request",
    parentId: requestId,
    fileId: attachmentId,
    name: file.name,
    mimeType: file.mimeType as PrivateFileSpec["mimeType"],
    kind: file.kind,
  };

  const port: PrivateFilePort = {
    async reserve(identity) {
      const { data, error } = await client.rpc("reserve_file_upload", {
        p_parent_type: "request",
        p_parent_id: identity.parentId,
        p_file_id: identity.fileId,
        p_name: identity.name,
        p_mime_type: identity.mimeType,
        p_kind: identity.kind,
        p_mutation_id: identity.mutationId,
        p_size: identity.size,
        p_sha256: identity.sha256,
      });
      if (error) throw new SupabaseStorageError(error.message, "RESERVE_ERROR");
      return data;
    },
    async upload(ticket, data) {
      const { error } = await client.storage.from("hays-attachments").upload(ticket, data);
      if (error) throw new SupabaseStorageError(error.message, "UPLOAD_ERROR");
    },
    async finalize(ticket) {
      const { data, error } = await client.rpc("finalize_file_upload", { p_ticket: ticket });
      if (error) throw new SupabaseStorageError(error.message, "FINALIZE_ERROR");
      return data;
    },
    async download(parentType, parentId, fileId) {
      const { data, error } = await client.rpc("download_file", {
        p_parent_type: parentType,
        p_parent_id: parentId,
        p_file_id: fileId,
      });
      if (error) throw new SupabaseStorageError(error.message, "DOWNLOAD_ERROR");
      return data;
    },
  };

  const receipt = await uploadPrivateFile(port, spec, blob, mutationId);
  
  return {
    id: receipt.fileId,
    kind: receipt.kind as AttachmentKind,
    name: receipt.name,
    mimeType: receipt.mimeType,
    size: receipt.size,
    driveFileId: receipt.fileId, // Now using Supabase file ID
  };
}

async function supabaseLoadDashboard(): Promise<{
  requests: RequestSummary[];
  jobs: JobEntry[];
  jobsAreDemo?: boolean;
}> {
  try {
    const [requests, jobs] = await Promise.all([
      supabaseListRequests(),
      supabaseListJobs(),
    ]);
    return { requests, jobs };
  } catch (error) {
    // Fallback to local storage
    try {
      const requests = getLocalRequests().map(summarizeRequest);
      let jobs: JobEntry[] = [];
      try {
        jobs = await supabaseListJobs();
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
}

// Blob utilities
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

/**
 * Main exported functions - use Supabase when configured, fallback to local storage
 */
export async function listRequests(): Promise<RequestSummary[]> {
  if (isSupabaseConfigured()) {
    try {
      return await supabaseListRequests();
    } catch (error) {
      console.warn("Supabase listRequests failed, falling back to local:", error);
    }
  }
  return getLocalRequests().map(summarizeRequest);
}

export async function openRequest(id: string): Promise<ChangeRequest> {
  if (isSupabaseConfigured()) {
    try {
      return await supabaseOpenRequest(id);
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
      return await supabaseSaveRequest(request, expectedRevision, mutationId);
    } catch (error) {
      console.warn("Supabase saveRequest failed, falling back to local:", error);
      // Don't fall back for saves - they need to go to the server
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
      return await supabaseClaimRequest(id, expectedRevision, estimatorName, mutationId);
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
      return await supabaseTransitionRequest(id, expectedRevision, status, question, mutationId);
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
      return await supabaseUploadAttachment(requestId, file, attachmentId, mutationId);
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
      return await supabaseFetchAttachment(requestId, attachmentId);
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
      return await supabaseListJobs();
    } catch (error) {
      console.warn("Supabase listJobs failed, falling back to local:", error);
    }
  }
  return getLocalJobs();
}

export async function importJobs(jobs: JobEntry[]): Promise<JobEntry[]> {
  if (isSupabaseConfigured()) {
    try {
      return await supabaseImportJobs(jobs);
    } catch (error) {
      console.warn("Supabase importJobs failed, falling back to local:", error);
    }
  }
  saveLocalJobs(jobs);
  return jobs;
}

export async function deleteRequest(id: string): Promise<{ ok: boolean; message?: string }> {
  if (isSupabaseConfigured()) {
    try {
      return await supabaseDeleteRequest(id);
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
  // The Supabase email integration has not been implemented yet.
  throw new SupabaseStorageError("Email sending is not available in this migration build.", "NOT_IMPLEMENTED");
}

export interface DashboardData {
  requests: RequestSummary[];
  jobs: JobEntry[];
  jobsAreDemo?: boolean;
}

export async function loadDashboard(): Promise<DashboardData> {
  if (isSupabaseConfigured()) {
    try {
      return await supabaseLoadDashboard();
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

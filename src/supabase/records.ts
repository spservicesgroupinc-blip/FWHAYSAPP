import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../workspaces/types";
import type { Customer, Task } from "../crm/types";

export interface SupabaseRecords {
  workspaces: Workspace;
  customers: Customer;
  tasks: Task;
}

export class SupabaseRecordError extends Error {
  constructor(public readonly kind: "conflict" | "invalid" | "service", message: string) {
    super(message);
    this.name = "SupabaseRecordError";
  }
}

/**
 * Caller must persist mutationId together with the exact payload and revision.
 * Reusing those values after an uncertain network failure is safe; never create
 * a new ID until the prior operation is confirmed or explicitly resolved.
 */
export async function saveSupabaseRecord<K extends keyof SupabaseRecords>(
  client: Pick<SupabaseClient, "rpc">,
  table: K,
  record: SupabaseRecords[K],
  expectedRevision: number,
  mutationId: string,
): Promise<SupabaseRecords[K]> {
  if (!record.id || !mutationId || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new SupabaseRecordError("invalid", "A record ID, mutation ID and valid expected revision are required.");
  }
  const { data, error } = await client.rpc("save_record", {
    p_table: table,
    p_id: record.id,
    p_payload: record,
    p_expected_revision: expectedRevision,
    p_mutation_id: mutationId,
  });
  if (error) {
    const kind = error.code === "40001" ? "conflict" : error.code === "22023" ? "invalid" : "service";
    throw new SupabaseRecordError(kind, kind === "conflict" ? "This record changed elsewhere. Resolve the conflict before saving." : kind === "invalid" ? "The record or retry identifier was rejected." : "Could not save this record. Your pending changes should be retained for retry.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.id !== record.id || data.revision !== expectedRevision + 1) {
    throw new SupabaseRecordError("service", "The server returned an invalid save confirmation. Retain the same retry identifier.");
  }
  return data as SupabaseRecords[K];
}

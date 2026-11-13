import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../workspaces/types";
import { saveSupabaseRecord, SupabaseRecordError } from "./records";

export interface WorkspacePage {
  workspaces: Workspace[];
  nextCursor: string | null;
}

function workspaceFromRow(row: unknown): Workspace {
  if (!row || typeof row !== "object") throw new SupabaseRecordError("service", "The workspace service returned an invalid record.");
  const { id, payload, revision } = row as { id?: unknown; payload?: unknown; revision?: unknown };
  if (typeof id !== "string" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SupabaseRecordError("service", "The workspace service returned an invalid record.");
  }
  const value = payload as Partial<Workspace>;
  if (value.id !== id || !Number.isInteger(revision) || value.revision !== revision ||
      typeof value.updatedAt !== "string" || !value.record || typeof value.record !== "object" ||
      typeof value.originalContract !== "string" || typeof value.previousChanges !== "string") {
    throw new SupabaseRecordError("service", "The workspace service returned an inconsistent record.");
  }
  return value as Workspace;
}

/** Read a bounded page in stable ID order. A cursor is the last ID returned. */
export async function listSupabaseWorkspaces(
  client: Pick<SupabaseClient, "from">,
  cursor: string | null = null,
  limit = 50,
): Promise<WorkspacePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && !cursor)) {
    throw new SupabaseRecordError("invalid", "A valid workspace page size and cursor are required.");
  }
  let query = client.from("workspaces").select("id,payload,revision").order("id", { ascending: true }).limit(limit + 1);
  if (cursor !== null) query = query.gt("id", cursor);
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new SupabaseRecordError("service", "Could not load workspaces. Please retry.");
  const workspaces = data.slice(0, limit).map(workspaceFromRow);
  return { workspaces, nextCursor: data.length > limit ? workspaces[workspaces.length - 1].id : null };
}

/** A null result means no row was visible to the current user. */
export async function openSupabaseWorkspace(client: Pick<SupabaseClient, "from">, id: string): Promise<Workspace | null> {
  if (!id) throw new SupabaseRecordError("invalid", "A workspace ID is required.");
  const { data, error } = await client.from("workspaces").select("id,payload,revision").eq("id", id).maybeSingle();
  if (error) throw new SupabaseRecordError("service", "Could not open this workspace. Please retry.");
  return data === null ? null : workspaceFromRow(data);
}

/** Retain the same mutation ID, payload and revision when retrying uncertain saves. */
export async function saveSupabaseWorkspace(client: Pick<SupabaseClient, "rpc">, workspace: Workspace, expectedRevision: number, mutationId: string): Promise<Workspace> {
  return saveSupabaseRecord(client, "workspaces", workspace, expectedRevision, mutationId);
}

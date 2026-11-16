import { getSupabaseClient } from "../supabase/client";

/** All workspace actions now go through Supabase. Falls back to local-only when Supabase is not configured. */
export async function workspaceApi<T>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  let client: ReturnType<typeof getSupabaseClient> | null = null;
  try {
    client = getSupabaseClient();
  } catch {
    client = null;
  }
  if (!client) {
    // Local-only fallback for tests and offline mode
    switch (action) {
      case "listWorkspaces":
        return { workspaces: [] } as unknown as T;
      case "openWorkspace":
        throw new Error("Workspace not found");
      case "saveWorkspace":
        return { workspace: payload.workspace as any, mutation: { id: payload.mutationId as string, revision: (payload.workspace as any)?.revision + 1 || 1 } } as unknown as T;
      case "saveJobDocument":
        return { document: payload.document as any } as unknown as T;
      case "listJobDocuments":
        return { documents: [] } as unknown as T;
      case "fetchJobDocument":
        throw new Error("Document not found");
      case "getCustomerReference":
        throw new Error("Customer reference not found");
      case "replaceCustomerReference":
        return { reference: payload.reference as any } as unknown as T;
      case "analyzeIntake":
        return { analysis: {} as any } as unknown as T;
      default:
        throw new Error(`Unknown workspace action: ${action}`);
    }
  }

  switch (action) {
    case "listWorkspaces": {
      const { data, error } = await client
        .from("workspaces")
        .select("id, payload, revision")
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { workspaces: (data || []).map(row => row.payload as any) } as unknown as T;
    }
    case "openWorkspace": {
      const { data, error } = await client
        .from("workspaces")
        .select("id, payload, revision")
        .eq("id", payload.workspaceId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Workspace not found");
      return data.payload as unknown as T;
    }
    case "saveWorkspace": {
      const { saveSupabaseRecord } = await import("../supabase/records");
      const saved = await saveSupabaseRecord(
        client,
        "workspaces",
        payload.workspace as any,
        payload.expectedRevision as number,
        payload.mutationId as string,
      );
      return { workspace: saved, mutation: { id: payload.mutationId, revision: saved.revision } } as unknown as T;
    }
    case "saveJobDocument": {
      const saved = await client.rpc("save_record_job_documents", {
        p_id: payload.documentId,
        p_payload: payload.document,
        p_expected_revision: 0,
        p_mutation_id: payload.mutationId,
      });
      if (saved.error) throw new Error(saved.error.message);
      return { document: saved.data } as unknown as T;
    }
    case "listJobDocuments": {
      const { data, error } = await client
        .from("job_documents")
        .select("id, payload")
        .eq("payload->>workspaceId", payload.workspaceId as string);
      if (error) throw new Error(error.message);
      return { documents: (data || []).map(row => row.payload as any) } as unknown as T;
    }
    case "fetchJobDocument": {
      const { data, error } = await client
        .from("job_documents")
        .select("id, payload")
        .eq("id", payload.documentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Document not found");
      return { name: data.payload.name, mimeType: "application/pdf", data: "" } as unknown as T;
    }
    case "getCustomerReference": {
      const { data, error } = await client
        .from("customer_reference")
        .select("id, payload, revision, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Customer reference not found");
      return { reference: data.payload } as unknown as T;
    }
    case "replaceCustomerReference": {
      const { data, error } = await client
        .from("customer_reference")
        .upsert(payload.reference as any, { onConflict: "id" })
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { reference: data } as unknown as T;
    }
    case "analyzeIntake": {
      // AI intake is handled by Edge Functions; return a placeholder for now
      return { analysis: {} as any } as unknown as T;
    }
    default:
      throw new Error(`Unknown workspace action: ${action}`);
  }
}

/**
 * Supabase Edge Functions for File Storage
 * Handles reservation, upload, finalize, and download of private files
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReserveRequest {
  parentType: "request" | "workspace";
  parentId: string;
  fileId: string;
  name: string;
  mimeType: string;
  kind: string;
  mutationId: string;
  size: number;
  sha256: string;
  inputFingerprint?: string;
  templateVersion?: number;
}

interface UploadRequest {
  ticket: string;
  data: string; // base64
}

interface FinalizeRequest {
  ticket: string;
}

interface DownloadRequest {
  parentType: "request" | "workspace";
  parentId: string;
  fileId: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check staff membership
    const { data: staff, error: staffError } = await supabase
      .from("staff_members")
      .select("role, active")
      .eq("user_id", user.id)
      .maybeSingle();

    if (staffError || !staff || !staff.active) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    if (path.endsWith("/reserve") && req.method === "POST") {
      return await handleReserve(supabase, user.id, await req.json());
    }
    if (path.endsWith("/upload") && req.method === "POST") {
      return await handleUpload(supabase, await req.json());
    }
    if (path.endsWith("/finalize") && req.method === "POST") {
      return await handleFinalize(supabase, await req.json());
    }
    if (path.endsWith("/download") && req.method === "POST") {
      return await handleDownload(supabase, user.id, await req.json());
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function handleReserve(supabase: any, userId: string, body: ReserveRequest) {
  const { parentType, parentId, fileId, name, mimeType, kind, mutationId, size, sha256, inputFingerprint, templateVersion } = body;

  // Verify parent record access
  const table = parentType === "request" ? "requests" : "workspaces";
  const { data: parent, error: parentError } = await supabase
    .from(table)
    .select("id")
    .eq("id", parentId)
    .maybeSingle();

  if (parentError || !parent) {
    return new Response(JSON.stringify({ error: "Parent record not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Check for existing reservation with same mutationId
  const { data: existing } = await supabase
    .from("file_reservations")
    .select("*")
    .eq("mutation_id", mutationId)
    .maybeSingle();

  if (existing) {
    // Verify it matches
    if (existing.sha256 !== sha256 || existing.size !== size || existing.file_id !== fileId) {
      return new Response(JSON.stringify({ error: "Mutation ID already used with different data" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ state: "complete", receipt: existing }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Create reservation
  const ticket = crypto.randomUUID();
  const objectPath = `${parentType}s/${parentId}/${fileId}`;

  const { error: insertError } = await supabase
    .from("file_reservations")
    .insert({
      ticket,
      parent_type: parentType,
      parent_id: parentId,
      file_id: fileId,
      name,
      mime_type: mimeType,
      kind,
      mutation_id: mutationId,
      size,
      sha256,
      input_fingerprint: inputFingerprint,
      template_version: templateVersion,
      object_path: objectPath,
      user_id: userId,
      state: "reserved",
    });

  if (insertError) {
    return new Response(JSON.stringify({ error: insertError.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    state: "upload",
    ticket,
    identity: body,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleUpload(supabase: any, body: UploadRequest) {
  const { ticket, data } = body;

  const { data: reservation, error: resError } = await supabase
    .from("file_reservations")
    .select("*")
    .eq("ticket", ticket)
    .maybeSingle();

  if (resError || !reservation) {
    return new Response(JSON.stringify({ error: "Invalid or expired ticket" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (reservation.state !== "reserved") {
    return new Response(JSON.stringify({ error: "Reservation not in upload state" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Decode base64 and upload to storage
  const binary = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  
  const { error: uploadError } = await supabase.storage
    .from("hays-private")
    .upload(reservation.object_path, binary, {
      contentType: reservation.mime_type,
      upsert: false,
    });

  if (uploadError) {
    return new Response(JSON.stringify({ error: uploadError.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Update reservation state
  await supabase
    .from("file_reservations")
    .update({ state: "uploaded" })
    .eq("ticket", ticket);

  return new Response(JSON.stringify({ state: "finalize", ticket, identity: reservation }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleFinalize(supabase: any, body: FinalizeRequest) {
  const { ticket } = body;

  const { data: reservation, error: resError } = await supabase
    .from("file_reservations")
    .select("*")
    .eq("ticket", ticket)
    .maybeSingle();

  if (resError || !reservation) {
    return new Response(JSON.stringify({ error: "Invalid or expired ticket" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (reservation.state !== "uploaded") {
    return new Response(JSON.stringify({ error: "File not uploaded yet" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify file exists and matches
  const { data: fileData, error: downloadError } = await supabase.storage
    .from("hays-private")
    .download(reservation.object_path);

  if (downloadError || !fileData) {
    return new Response(JSON.stringify({ error: "File verification failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  
  if (bytes.length !== reservation.size) {
    return new Response(JSON.stringify({ error: "File size mismatch" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify SHA-256
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  
  if (hashHex !== reservation.sha256) {
    return new Response(JSON.stringify({ error: "File checksum mismatch" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Mark as complete
  await supabase
    .from("file_reservations")
    .update({ state: "complete", completed_at: new Date().toISOString() })
    .eq("ticket", ticket);

  const receipt = {
    parentType: reservation.parent_type,
    parentId: reservation.parent_id,
    fileId: reservation.file_id,
    name: reservation.name,
    mimeType: reservation.mime_type,
    kind: reservation.kind,
    mutationId: reservation.mutation_id,
    size: reservation.size,
    sha256: reservation.sha256,
    inputFingerprint: reservation.input_fingerprint,
    templateVersion: reservation.template_version,
  };

  return new Response(JSON.stringify({ state: "complete", receipt }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleDownload(supabase: any, userId: string, body: DownloadRequest) {
  const { parentType, parentId, fileId } = body;

  // Verify parent record access
  const table = parentType === "request" ? "requests" : "workspaces";
  const { data: parent, error: parentError } = await supabase
    .from(table)
    .select("id")
    .eq("id", parentId)
    .maybeSingle();

  if (parentError || !parent) {
    return new Response(JSON.stringify({ error: "Parent record not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Get file reservation
  const { data: reservation, error: resError } = await supabase
    .from("file_reservations")
    .select("*")
    .eq("parent_type", parentType)
    .eq("parent_id", parentId)
    .eq("file_id", fileId)
    .eq("state", "complete")
    .maybeSingle();

  if (resError || !reservation) {
    return new Response(JSON.stringify({ error: "File not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Download file
  const { data: fileData, error: downloadError } = await supabase.storage
    .from("hays-private")
    .download(reservation.object_path);

  if (downloadError || !fileData) {
    return new Response(JSON.stringify({ error: "File download failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

  return new Response(JSON.stringify({
    receipt: {
      parentType: reservation.parent_type,
      parentId: reservation.parent_id,
      fileId: reservation.file_id,
      name: reservation.name,
      mimeType: reservation.mime_type,
      kind: reservation.kind,
      mutationId: reservation.mutation_id,
      size: reservation.size,
      sha256: reservation.sha256,
      inputFingerprint: reservation.input_fingerprint,
      templateVersion: reservation.template_version,
    },
    data: base64,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Activity } from "../crm/types";

export class SupabaseActivityError extends Error {
  constructor(public readonly kind: "invalid" | "not_found" | "denied" | "service", message: string) {
    super(message);
    this.name = "SupabaseActivityError";
  }
}

/**
 * Persist the exact activity and mutation ID before calling. If the outcome is
 * uncertain, retry those same values; the server atomically deduplicates them.
 * This adapter is not connected to the production CRM sync.
 */
export async function appendSupabaseActivity(
  client: Pick<SupabaseClient, "rpc">,
  activity: Activity,
  mutationId: string,
): Promise<Activity> {
  if (!activity || typeof activity.id !== "string" || !activity.id.trim() ||
      typeof activity.customerId !== "string" || !activity.customerId.trim() ||
      typeof mutationId !== "string" || !mutationId.trim() ||
      typeof activity.kind !== "string" || !activity.kind.trim() ||
      !["inbound", "outbound", "system"].includes(activity.direction) ||
      typeof activity.body !== "string" || typeof activity.at !== "string" || !activity.at) {
    throw new SupabaseActivityError("invalid", "Activity details and a retry identifier are required.");
  }
  // Freeze the wire payload, including the omission of undefined fields, so a
  // caller's later edits cannot change the operation while it is in flight.
  const payload = JSON.parse(JSON.stringify(activity)) as Activity;
  let response;
  try {
    response = await client.rpc("append_customer_activity", { p_activity: payload, p_mutation_id: mutationId });
  } catch {
    throw new SupabaseActivityError("service", "The activity could not be confirmed. Keep the same retry identifier and try again.");
  }
  if (response.error) {
    const kind = response.error.code === "22023" ? "invalid" : response.error.code === "P0002" ? "not_found" : response.error.code === "42501" ? "denied" : "service";
    const message = kind === "invalid" ? "The activity or retry identifier was rejected." : kind === "not_found" ? "The customer is unavailable." : kind === "denied" ? "Your account cannot add this activity." : "The activity could not be confirmed. Keep the same retry identifier and try again.";
    throw new SupabaseActivityError(kind, message);
  }
  const result: unknown = response.data;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new SupabaseActivityError("service", "The activity confirmation was invalid. Keep the same retry identifier.");
  }
  const expected = payload as unknown as Record<string, unknown>;
  const actual = result as Record<string, unknown>;
  const keys = Object.keys(expected);
  if (keys.length !== Object.keys(actual).length || keys.some((key) => actual[key] !== expected[key])) {
    throw new SupabaseActivityError("service", "The activity confirmation did not match. Keep the same retry identifier.");
  }
  return result as Activity;
}

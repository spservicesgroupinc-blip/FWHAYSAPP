import type { ChangeRequest, JobEntry, RequestStatus, RequestSummary } from "../types";
import type { Workspace } from "../workspaces/types";
import { formatCents, moneyCents } from "./contract";
import { signedAmountLabel, signedMoneyCents } from "./changeOrder";

export interface CustomerFinancialSummary {
  hasContractData: boolean;
  originalContractCents: bigint;
  originalContractFormatted: string;
  priorAuthorizedCents: bigint;
  priorAuthorizedFormatted: string;
  completedChangesCents: bigint;
  completedChangesFormatted: string;
  completedCount: number;
  pendingChangesCents: bigint;
  pendingChangesFormatted: string;
  pendingCount: number;
  netApprovedChangesCents: bigint;
  netApprovedChangesFormatted: string;
  currentTotalCents: bigint;
  currentTotalFormatted: string;
  projectedTotalCents: bigint;
  projectedTotalFormatted: string;
}

export interface CustomerTimelineEvent {
  id: string;
  kind: "contract_origin" | "prior_changes" | "change_order";
  date: string;
  title: string;
  subtitle: string;
  description: string;
  jobNumber: string;
  orderNumber?: string;
  status?: RequestStatus;
  requestType?: "change_order" | "insurance_supplement";
  customerCredits?: boolean;
  estimatorName?: string;
  amountCents: bigint | null;
  amountFormatted: string;
  runningTotalCents: bigint | null;
  runningTotalFormatted: string;
  requestId?: string;
  workspaceId?: string;
}

function normJobKey(jobNumber: string | undefined, fallbackId: string): string {
  const cleaned = (jobNumber ?? "").trim().toUpperCase();
  return cleaned ? `job:${cleaned}` : `id:${fallbackId}`;
}

export function extractRequestAmountRaw(
  request: ChangeRequest | RequestSummary,
): string {
  if (
    "finalChangeOrder" in request &&
    request.finalChangeOrder?.amount?.trim()
  ) {
    return request.finalChangeOrder.amount.trim();
  }
  if ("knownChangeAmount" in request && request.knownChangeAmount?.trim()) {
    return request.knownChangeAmount.trim();
  }
  return "";
}

export function extractRequestAmountCents(
  request: ChangeRequest | RequestSummary,
): bigint | null {
  const raw = extractRequestAmountRaw(request);
  return raw ? signedMoneyCents(raw) : null;
}

export function extractRequestAmountLabel(
  request: ChangeRequest | RequestSummary,
): string {
  const raw = extractRequestAmountRaw(request);
  if (!raw) return "Amount pending";
  const label = signedAmountLabel(raw);
  return label === "Not provided" || label === "Unavailable"
    ? "Amount pending"
    : label;
}

export function extractRequestDescription(
  request: ChangeRequest | RequestSummary,
): string {
  if (
    "finalChangeOrder" in request &&
    request.finalChangeOrder?.scope?.trim()
  ) {
    return request.finalChangeOrder.scope.trim();
  }
  if (
    "requestedChanges" in request &&
    request.requestedChanges?.[0]?.description?.trim()
  ) {
    return request.requestedChanges[0].description.trim();
  }
  return "";
}

function formatSignedCents(cents: bigint): string {
  if (cents === 0n) return "$0.00";
  return `${cents > 0n ? "+" : ""}${formatCents(cents)}`;
}

export function calculateCustomerFinancials(params: {
  workspaces: Workspace[];
  importedJobs: JobEntry[];
  requests: (ChangeRequest | RequestSummary)[];
}): CustomerFinancialSummary {
  const { workspaces, importedJobs, requests } = params;

  const contractByJob = new Map<string, bigint>();
  const priorByJob = new Map<string, bigint>();

  // 1. Original contracts from linked workspaces
  for (const ws of workspaces) {
    const key = normJobKey(ws.record.customer.jobNumber, ws.id);
    const cents = moneyCents(ws.originalContract ?? "");
    if (cents !== null && !contractByJob.has(key)) {
      contractByJob.set(key, cents);
    }
    const prior = signedMoneyCents(ws.previousChanges ?? "");
    if (prior !== null && prior !== 0n && !priorByJob.has(key)) {
      priorByJob.set(key, prior);
    }
  }

  // 2. Original contracts from imported CSV jobs
  for (const job of importedJobs) {
    const key = normJobKey(job.jobNumber, job.id);
    const cents = moneyCents(job.contractAmount ?? "");
    if (cents !== null && !contractByJob.has(key)) {
      contractByJob.set(key, cents);
    }
  }

  // 3. Sort requests oldest-first so earliest request per job can supply baseline originalContract & previousChanges
  const chronological = [...requests].sort((a, b) =>
    (a.createdAt || a.updatedAt).localeCompare(b.createdAt || b.updatedAt),
  );

  const seenJobInRequests = new Set<string>();
  for (const req of chronological) {
    const key = normJobKey(req.job?.jobNumber, req.id);
    if ("originalContract" in req.job && req.job.originalContract) {
      const origCents = moneyCents(req.job.originalContract);
      if (origCents !== null && !contractByJob.has(key)) {
        contractByJob.set(key, origCents);
      }
    }
    if (!seenJobInRequests.has(key)) {
      seenJobInRequests.add(key);
      if ("previousChanges" in req.job && req.job.previousChanges) {
        const prevCents = signedMoneyCents(req.job.previousChanges);
        if (prevCents !== null && prevCents !== 0n && !priorByJob.has(key)) {
          priorByJob.set(key, prevCents);
        }
      }
    }
  }

  let originalContractCents = 0n;
  for (const amount of contractByJob.values()) {
    originalContractCents += amount;
  }

  let priorAuthorizedCents = 0n;
  for (const amount of priorByJob.values()) {
    priorAuthorizedCents += amount;
  }

  let completedChangesCents = 0n;
  let completedCount = 0;
  let pendingChangesCents = 0n;
  let pendingCount = 0;
  let hasAnyRequestAmount = false;

  for (const req of chronological) {
    const cents = extractRequestAmountCents(req);
    if (cents !== null) hasAnyRequestAmount = true;
    if (req.status === "completed") {
      completedCount += 1;
      if (cents !== null) completedChangesCents += cents;
    } else {
      pendingCount += 1;
      if (cents !== null) pendingChangesCents += cents;
    }
  }

  const hasContractData =
    contractByJob.size > 0 ||
    priorByJob.size > 0 ||
    hasAnyRequestAmount ||
    requests.length > 0;

  const netApprovedChangesCents = priorAuthorizedCents + completedChangesCents;
  const currentTotalCents = originalContractCents + netApprovedChangesCents;
  const projectedTotalCents = currentTotalCents + pendingChangesCents;

  return {
    hasContractData,
    originalContractCents,
    originalContractFormatted:
      contractByJob.size > 0 ? formatCents(originalContractCents) : "Not set",
    priorAuthorizedCents,
    priorAuthorizedFormatted: formatSignedCents(priorAuthorizedCents),
    completedChangesCents,
    completedChangesFormatted: formatSignedCents(completedChangesCents),
    completedCount,
    pendingChangesCents,
    pendingChangesFormatted: formatSignedCents(pendingChangesCents),
    pendingCount,
    netApprovedChangesCents,
    netApprovedChangesFormatted: formatSignedCents(netApprovedChangesCents),
    currentTotalCents,
    currentTotalFormatted: hasContractData
      ? formatCents(currentTotalCents)
      : "Not set",
    projectedTotalCents,
    projectedTotalFormatted: hasContractData
      ? formatCents(projectedTotalCents)
      : "Not set",
  };
}

export function buildCustomerTimeline(params: {
  workspaces: Workspace[];
  importedJobs: JobEntry[];
  requests: (ChangeRequest | RequestSummary)[];
}): CustomerTimelineEvent[] {
  const { workspaces, importedJobs, requests } = params;
  const events: CustomerTimelineEvent[] = [];

  // Determine starting baseline
  const financials = calculateCustomerFinancials(params);
  let runningTotal = financials.originalContractCents;

  // Find earliest date for contract origin
  const chronologicalRequests = [...requests].sort((a, b) =>
    (a.createdAt || a.updatedAt).localeCompare(b.createdAt || b.updatedAt),
  );

  const primaryJobNumber =
    workspaces[0]?.record.customer.jobNumber ||
    importedJobs[0]?.jobNumber ||
    chronologicalRequests[0]?.job?.jobNumber ||
    "";
  const primaryAddress =
    workspaces[0]?.record.customer.lossAddress ||
    importedJobs[0]?.address ||
    chronologicalRequests[0]?.job?.address ||
    "";

  const originDate =
    workspaces[0]?.record.checklist.startDate ||
    workspaces[0]?.record.insurance.dateInspected ||
    importedJobs[0]?.startDate ||
    importedJobs[0]?.dateInspected ||
    chronologicalRequests[0]?.createdAt ||
    workspaces[0]?.updatedAt ||
    importedJobs[0]?.updatedAt ||
    "";

  if (
    financials.originalContractCents > 0n ||
    workspaces.length > 0 ||
    importedJobs.length > 0
  ) {
    events.push({
      id: "origin-contract",
      kind: "contract_origin",
      date: originDate,
      title: primaryJobNumber
        ? `Original contract · ${primaryJobNumber}`
        : "Original contract baseline",
      subtitle: primaryAddress || "Initial restoration scope",
      description:
        financials.originalContractCents > 0n
          ? `Base contract amount established at ${financials.originalContractFormatted}.`
          : "Job linked to customer workspace.",
      jobNumber: primaryJobNumber,
      amountCents: financials.originalContractCents,
      amountFormatted: financials.originalContractFormatted,
      runningTotalCents: runningTotal,
      runningTotalFormatted: formatCents(runningTotal),
      workspaceId: workspaces[0]?.id,
    });
  }

  if (financials.priorAuthorizedCents !== 0n) {
    runningTotal += financials.priorAuthorizedCents;
    events.push({
      id: "prior-authorized-changes",
      kind: "prior_changes",
      date: originDate,
      title: primaryJobNumber
        ? `Previous authorized changes · ${primaryJobNumber}`
        : "Previous authorized changes",
      subtitle: "Prior contract adjustments on file",
      description: `Net previous authorized changes of ${financials.priorAuthorizedFormatted}.`,
      jobNumber: primaryJobNumber,
      amountCents: financials.priorAuthorizedCents,
      amountFormatted: financials.priorAuthorizedFormatted,
      runningTotalCents: runningTotal,
      runningTotalFormatted: formatCents(runningTotal),
    });
  }

  for (const req of chronologicalRequests) {
    const amountCents = extractRequestAmountCents(req);
    const amountLabel = extractRequestAmountLabel(req);
    const isCompleted = req.status === "completed";
    if (isCompleted && amountCents !== null) {
      runningTotal += amountCents;
    }
    const orderNum = req.job?.orderNumber || "Change order";
    const jobNum = req.job?.jobNumber || primaryJobNumber;
    const changesCount =
      "changesCount" in req
        ? req.changesCount
        : "requestedChanges" in req
          ? req.requestedChanges.length
          : 1;
    const desc =
      extractRequestDescription(req) ||
      `${changesCount} requested scope item(s)`;
    const reqType = "requestType" in req ? req.requestType : undefined;
    const credits = "customerCredits" in req ? req.customerCredits : undefined;

    events.push({
      id: `req-${req.id}`,
      kind: "change_order",
      date:
        ("submittedAt" in req && req.submittedAt) ||
        req.updatedAt ||
        req.createdAt,
      title: `${orderNum}${jobNum ? ` · ${jobNum}` : ""}`,
      subtitle:
        reqType === "insurance_supplement"
          ? "Insurance supplement"
          : credits
            ? "Customer change order (Credit)"
            : "Customer change order",
      description: desc,
      jobNumber: jobNum,
      orderNumber: req.job?.orderNumber,
      status: req.status,
      requestType: reqType,
      customerCredits: credits,
      estimatorName: req.estimatorName || undefined,
      amountCents,
      amountFormatted: amountLabel,
      runningTotalCents: isCompleted
        ? runningTotal
        : amountCents !== null
          ? runningTotal + amountCents
          : null,
      runningTotalFormatted: isCompleted
        ? formatCents(runningTotal)
        : amountCents !== null
          ? `${formatCents(runningTotal + amountCents)} (if approved)`
          : "Pending pricing",
      requestId: req.id,
      workspaceId: req.workspaceId,
    });
  }

  // Return newest first so most recent change orders are immediately visible at the top of the timeline
  return events.reverse();
}

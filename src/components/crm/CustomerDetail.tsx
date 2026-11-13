import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Briefcase,
  FileText,
  GitMerge,
  Link2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Tag,
  UserRound,
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  DollarSign,
  Clock3,
  TrendingUp,
} from "lucide-react";
import { createRequest } from "../../services/requests";
import {
  addNote,
  createTask,
  csvCustomerFallbackId,
  getLocalCustomer,
  linkWorkspaceToCustomer,
  listActivities,
  listCustomers,
  listTasks,
  logCommunication,
  openCustomer,
  setWorkspaceStage,
  subscribeCrm,
  toggleTask,
  normalizedNameTokens,
} from "../../crm";
import type {
  Activity,
  Customer,
  CustomerSummary,
  JobStage,
  NewCommunicationInput,
  NewTaskInput,
  Task,
} from "../../crm/types";
import {
  cachedWorkspaces,
  refreshWorkspaces,
  subscribeWorkspaces,
  saveWorkspaceLocally,
} from "../../services/workspaces";
import { createWorkspace, workspaceFromDirectory } from "../../workspaces/model";
import {
  cachedRequests,
  cachedJobDirectory,
  openRequest,
} from "../../services/storage";
import { customerNameKey } from "../../services/customerDirectory";
import {
  calculateCustomerFinancials,
  buildCustomerTimeline,
  extractRequestAmountLabel,
  extractRequestDescription,
  extractRequestAmountCents,
} from "../../services/customerFinancials";
import type {
  ChangeRequest,
  JobEntry,
  RequestStatus,
  RequestSummary,
} from "../../types";
import type { WorkspaceRow } from "../../workspaces/types";
import type { CustomerData } from "../../documents/types/jobData";
import ActivityTimeline from "./ActivityTimeline";
import CustomerForm from "./CustomerForm";
import TaskList from "./TaskList";
import "./crm.css";
import "./CustomerDetail.css";

const STAGES: JobStage[] = ["lead", "in_progress", "complete", "closed"];
const STAGE_LABELS: Record<JobStage, string> = {
  lead: "Lead",
  in_progress: "In progress",
  complete: "Complete",
  closed: "Closed",
};
const REQUEST_LABELS: Record<RequestStatus, string> = {
  submitted: "In queue",
  in_review: "In review",
  needs_information: "Needs info",
  completed: "Completed",
};

export type WorkspaceTabTarget =
  | "overview"
  | "details"
  | "documents"
  | "requests"
  | "intake";

export interface CustomerDetailProps {
  id: string;
  onBack: () => void;
  onOpenWorkspace?: (id: string, tab?: WorkspaceTabTarget) => void;
  onOpenRequest?: (id: string) => void;
  onNewRequest?: (seed: ChangeRequest) => void;
  embedded?: boolean;
  workspaceId?: string;
  onEditContact?: () => void;
  contactOverride?: CustomerData;
  requests?: (ChangeRequest | RequestSummary)[];
  jobs?: JobEntry[];
}

export default function CustomerDetail({
  id,
  onBack,
  onOpenWorkspace,
  onOpenRequest,
  onNewRequest,
  embedded = false,
  workspaceId,
  onEditContact,
  contactOverride,
  requests: propRequests,
  jobs: propJobs,
}: CustomerDetailProps) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [requests, setRequests] = useState<(ChangeRequest | RequestSummary)[]>(
    propRequests ?? cachedRequests(),
  );
  const [hydratedById, setHydratedById] = useState<
    Record<string, ChangeRequest>
  >(() => {
    const map: Record<string, ChangeRequest> = {};
    for (const item of cachedRequests()) {
      if (item?.id) map[item.id] = item;
    }
    return map;
  });
  const [coFilter, setCoFilter] = useState<"all" | "pending" | "completed">(
    "all",
  );
  const [formOpen, setFormOpen] = useState(false);
  const [mergeFocus, setMergeFocus] = useState(false);
  const [linkJobId, setLinkJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Pool all known jobs for this customer from propJobs and cached directory
  const allDirectoryJobs = useMemo(
    () => (propJobs && propJobs.length ? propJobs : cachedJobDirectory()),
    [propJobs],
  );

  // Synchronous fallback customer so opening any uploaded CSV customer or embedded workspace never renders a blank spinner
  const fallbackCustomer = useMemo<Customer | null>(() => {
    const now = new Date().toISOString();
    if (contactOverride && contactOverride.customerName?.trim()) {
      return {
        id,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        name: contactOverride.customerName.trim(),
        phone:
          contactOverride.mainPhone ||
          contactOverride.mobilePhone ||
          contactOverride.homePhone ||
          undefined,
        email: contactOverride.email || undefined,
        address:
          contactOverride.lossAddress ||
          contactOverride.mailingAddress ||
          undefined,
      };
    }
    const summaryMatch = customers.find((c) => c.id === id);
    if (summaryMatch) {
      return {
        id: summaryMatch.id,
        revision: summaryMatch.revision ?? 0,
        createdAt: summaryMatch.createdAt ?? summaryMatch.updatedAt,
        updatedAt: summaryMatch.updatedAt,
        name: summaryMatch.name,
        phone: summaryMatch.phone,
        email: summaryMatch.email,
        address: summaryMatch.address,
        cityStateZip: summaryMatch.cityStateZip,
        tags: summaryMatch.tags,
      };
    }
    const jobMatch = allDirectoryJobs.find(
      (job) =>
        csvCustomerFallbackId(job.customer, job.jobNumber) === id ||
        job.id === id,
    );
    if (jobMatch) {
      return {
        id,
        revision: 0,
        createdAt: jobMatch.updatedAt || now,
        updatedAt: jobMatch.updatedAt || now,
        name: jobMatch.customer.trim(),
        phone: jobMatch.customerPhone?.trim() || undefined,
        email: jobMatch.customerEmail?.trim() || undefined,
        address: jobMatch.address?.trim() || undefined,
      };
    }
    const wsMatch = workspaces.find(
      (r) => r.workspace.customerId === id || r.workspace.id === workspaceId,
    );
    if (wsMatch?.workspace.record.customer.customerName?.trim()) {
      const c = wsMatch.workspace.record.customer;
      return {
        id,
        revision: 0,
        createdAt: wsMatch.workspace.updatedAt || now,
        updatedAt: wsMatch.workspace.updatedAt || now,
        name: c.customerName.trim(),
        phone: c.mainPhone || c.mobilePhone || c.homePhone || undefined,
        email: c.email || undefined,
        address: c.lossAddress || c.mailingAddress || undefined,
      };
    }
    return null;
  }, [id, contactOverride, customers, allDirectoryJobs, workspaces, workspaceId]);

  const activeCustomer = customer ?? fallbackCustomer;

  const hasFallbackRef = useRef(false);
  hasFallbackRef.current = Boolean(fallbackCustomer);

  const loadCustomer = useCallback(
    async (localOnly = false) => {
      try {
        const local = await getLocalCustomer(id);
        if (local) {
          setCustomer(local);
          setError("");
        }
        if (localOnly) return;
        const next = await openCustomer(id);
        if (next) {
          setCustomer(next);
          setError("");
        } else if (!local && !hasFallbackRef.current) {
          setError(
            "This record's contact details are not available yet. Try again after syncing.",
          );
        }
      } catch (err) {
        if (!hasFallbackRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [id],
  );

  const loadActivities = useCallback(async () => {
    try {
      setActivities(await listActivities(id));
    } catch {
      // Timeline is non-critical.
    }
  }, [id]);

  const loadTasks = useCallback(async () => {
    try {
      setTasks(await listTasks(id));
    } catch {
      // Tasks are non-critical.
    }
  }, [id]);

  const loadCustomers = useCallback(async () => {
    try {
      setCustomers(
        await listCustomers({
          skipServerRefresh: true,
          directoryJobs: allDirectoryJobs,
        }),
      );
    } catch {
      // Merge picker just shows an empty list.
    }
  }, [allDirectoryJobs]);

  useEffect(() => {
    void loadCustomer(false);
    void loadActivities();
    void loadTasks();
    const unsubscribe = subscribeCrm(() => {
      void loadCustomer(true);
    });
    return unsubscribe;
  }, [loadCustomer, loadActivities, loadTasks]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  useEffect(() => {
    const read = async () => {
      setWorkspaces(await cachedWorkspaces());
    };
    void read();
    void refreshWorkspaces()
      .then((rows) => setWorkspaces(rows))
      .catch(() => undefined);
    return subscribeWorkspaces(() => void read());
  }, []);

  // Update requests whenever propRequests change or on mount
  useEffect(() => {
    if (propRequests && propRequests.length) {
      setRequests(propRequests);
    } else {
      setRequests(cachedRequests());
    }
  }, [propRequests, id]);

  const handleAddNote = useCallback(
    async (body: string) => {
      await addNote(id, body);
      await loadActivities();
    },
    [id, loadActivities],
  );

  const handleLogCommunication = useCallback(
    async (input: NewCommunicationInput) => {
      await logCommunication(id, input);
      await loadActivities();
    },
    [id, loadActivities],
  );

  const handleAddTask = useCallback(
    async (input: NewTaskInput) => {
      await createTask(id, input);
      await loadTasks();
    },
    [id, loadTasks],
  );

  const handleToggleTask = useCallback(
    async (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      await toggleTask(task);
      await loadTasks();
    },
    [tasks, loadTasks],
  );

  const changeStage = useCallback(
    async (targetWorkspaceId: string, stage: JobStage) => {
      setBusy(true);
      setError("");
      try {
        await setWorkspaceStage(targetWorkspaceId, stage);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const linkJob = useCallback(async () => {
    if (!linkJobId) return;
    setBusy(true);
    setError("");
    try {
      await linkWorkspaceToCustomer(linkJobId, id);
      setLinkJobId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [id, linkJobId]);

  const handleSaved = useCallback(async () => {
    setFormOpen(false);
    setMergeFocus(false);
    await loadCustomer();
    await loadCustomers();
  }, [loadCustomer, loadCustomers]);

  async function openImportedJob(
    entry: JobEntry,
    tab: WorkspaceTabTarget = "details",
  ) {
    if (!onOpenWorkspace || busy) return;
    setBusy(true);
    try {
      const existing = workspaces.find(
        (r) =>
          r.workspace.record.customer.jobNumber.trim().toUpperCase() ===
            entry.jobNumber.trim().toUpperCase() &&
          entry.jobNumber.trim() !== "",
      );
      if (existing) {
        onOpenWorkspace(existing.workspace.id, tab);
        return;
      }
      const workspace = workspaceFromDirectory(entry, id);
      await saveWorkspaceLocally(workspace);
      onOpenWorkspace(workspace.id, tab);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const linked = useMemo(
    () => workspaces.filter((row) => row.workspace.customerId === id),
    [workspaces, id],
  );
  const unlinked = useMemo(
    () => workspaces.filter((row) => row.workspace.customerId !== id),
    [workspaces, id],
  );
  const customerKey = activeCustomer
    ? customerNameKey(activeCustomer.name)
    : "";
  const customerTokenKey = activeCustomer
    ? normalizedNameTokens(activeCustomer.name)
    : "";

  const importedJobs = useMemo(
    () =>
      activeCustomer
        ? allDirectoryJobs.filter((job) => {
            const jKey = customerNameKey(job.customer);
            const jTokens = normalizedNameTokens(job.customer);
            const matchesName =
              (customerKey && jKey === customerKey) ||
              (customerTokenKey && jTokens === customerTokenKey);
            return (
              matchesName &&
              !linked.some(
                (row) =>
                  row.workspace.record.customer.jobNumber
                    .trim()
                    .toUpperCase() === job.jobNumber.trim().toUpperCase(),
              )
            );
          })
        : [],
    [activeCustomer, allDirectoryJobs, customerKey, customerTokenKey, linked],
  );

  async function openPrimaryJobWorkspace(tab: WorkspaceTabTarget = "details") {
    if (!onOpenWorkspace || busy || !activeCustomer) return;
    if (linked.length > 0) {
      onOpenWorkspace(linked[0].workspace.id, tab);
      return;
    }
    if (importedJobs.length > 0) {
      await openImportedJob(importedJobs[0], tab);
      return;
    }
    setBusy(true);
    try {
      const ws = createWorkspace();
      ws.customerId = activeCustomer.id;
      ws.record.customer.customerName = activeCustomer.name;
      ws.record.customer.mainPhone = activeCustomer.phone || "";
      ws.record.customer.email = activeCustomer.email || "";
      ws.record.customer.lossAddress = activeCustomer.address || "";
      await saveWorkspaceLocally(ws);
      onOpenWorkspace(ws.id, tab);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Match all change orders belonging to this customer or any of their jobs
  const linkedRequests = useMemo(() => {
    if (!activeCustomer) return [];
    const customerJobNumbers = new Set<string>();
    linked.forEach((row) => {
      const num = row.workspace.record.customer.jobNumber.trim().toUpperCase();
      if (num) customerJobNumbers.add(num);
    });
    importedJobs.forEach((job) => {
      const num = job.jobNumber.trim().toUpperCase();
      if (num) customerJobNumbers.add(num);
    });
    const linkedWorkspaceIds = new Set(linked.map((row) => row.workspace.id));
    if (workspaceId) linkedWorkspaceIds.add(workspaceId);

    return requests
      .filter((request) => {
        if (workspaceId && request.workspaceId === workspaceId) return true;
        if (request.customerId && request.customerId === id) return true;
        if (request.workspaceId && linkedWorkspaceIds.has(request.workspaceId))
          return true;
        const reqJobNum = (request.job?.jobNumber || "").trim().toUpperCase();
        if (reqJobNum && customerJobNumbers.has(reqJobNum)) return true;
        const reqCustomerKey = customerNameKey(request.job?.customer);
        if (customerKey && reqCustomerKey === customerKey) return true;
        if (customerTokenKey) {
          const reqTokens = normalizedNameTokens(request.job?.customer);
          if (reqTokens && reqTokens === customerTokenKey) return true;
        }
        return false;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [
    activeCustomer,
    linked,
    importedJobs,
    workspaceId,
    requests,
    id,
    customerKey,
    customerTokenKey,
  ]);

  // Hydrate full ChangeRequest records (amounts, originalContract, scope) for linked requests
  useEffect(() => {
    let active = true;
    const missing = linkedRequests.filter(
      (req) => !("requestedChanges" in req) && !hydratedById[req.id],
    );
    if (!missing.length) return;
    void Promise.all(
      missing.map(async (item) => {
        try {
          const full = await openRequest(item.id);
          return full;
        } catch {
          return null;
        }
      }),
    ).then((loaded) => {
      if (!active) return;
      const additions: Record<string, ChangeRequest> = {};
      let added = false;
      for (const item of loaded) {
        if (item) {
          additions[item.id] = item;
          added = true;
        }
      }
      if (added) {
        setHydratedById((prev) => ({ ...prev, ...additions }));
      }
    });
    return () => {
      active = false;
    };
  }, [linkedRequests, hydratedById]);

  const enrichedRequests = useMemo(
    () =>
      linkedRequests.map((req) =>
        "requestedChanges" in req ? req : (hydratedById[req.id] ?? req),
      ),
    [linkedRequests, hydratedById],
  );

  const financials = useMemo(
    () =>
      calculateCustomerFinancials({
        workspaces: linked.map((r) => r.workspace),
        importedJobs,
        requests: enrichedRequests,
      }),
    [linked, importedJobs, enrichedRequests],
  );

  const timelineEvents = useMemo(
    () =>
      buildCustomerTimeline({
        workspaces: linked.map((r) => r.workspace),
        importedJobs,
        requests: enrichedRequests,
      }),
    [linked, importedJobs, enrichedRequests],
  );

  const pendingRequests = useMemo(
    () => enrichedRequests.filter((r) => r.status !== "completed"),
    [enrichedRequests],
  );
  const completedRequests = useMemo(
    () => enrichedRequests.filter((r) => r.status === "completed"),
    [enrichedRequests],
  );
  const visibleRequests = useMemo(() => {
    if (coFilter === "pending") return pendingRequests;
    if (coFilter === "completed") return completedRequests;
    return enrichedRequests;
  }, [coFilter, pendingRequests, completedRequests, enrichedRequests]);

  if (!activeCustomer) {
    return (
      <div className="empty">
        {error ? (
          <>
            <h3>This customer could not be opened.</h3>
            <p>{error}</p>
            <div className="button-row">
              <button
                className="button primary"
                onClick={() => void loadCustomer()}
              >
                Try again
              </button>
              {!embedded && (
                <button className="button" onClick={onBack}>
                  Back to customers
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="spinner" />
            <p>Loading customer…</p>
          </>
        )}
      </div>
    );
  }

  const openTasks = tasks.filter((task) => task.status === "open");
  const activeJobs =
    linked.filter(
      (row) => !["complete", "closed"].includes(row.workspace.stage || "lead"),
    ).length + importedJobs.filter((job) => job.active).length;
  const initials = activeCustomer.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const updatedDate = new Date(activeCustomer.updatedAt);

  // Pull contact info from customer record, override, imported CSV jobs, or hydrated requests
  const primaryReqJob = enrichedRequests[0]?.job;
  const primaryCsvJob = importedJobs[0];
  const contact = {
    phone:
      contactOverride?.mainPhone ||
      contactOverride?.mobilePhone ||
      contactOverride?.homePhone ||
      activeCustomer.phone ||
      primaryCsvJob?.customerPhone ||
      (primaryReqJob && "customerPhone" in primaryReqJob
        ? primaryReqJob.customerPhone
        : ""),
    email:
      contactOverride?.email ||
      activeCustomer.email ||
      primaryCsvJob?.customerEmail ||
      (primaryReqJob && "customerEmail" in primaryReqJob
        ? primaryReqJob.customerEmail
        : ""),
    address:
      contactOverride?.lossAddress ||
      contactOverride?.mailingAddress ||
      activeCustomer.address ||
      primaryCsvJob?.address ||
      primaryReqJob?.address,
    cityStateZip: contactOverride?.lossAddress
      ? ""
      : contactOverride?.mailingAddress
        ? contactOverride.mailingCityStateZip
        : activeCustomer.cityStateZip,
  };

  const handleStartChangeOrder = () => {
    if (!onNewRequest) return;
    const seed = createRequest();
    seed.job.customer = activeCustomer.name;
    seed.job.customerPhone = contact.phone || "";
    seed.job.customerEmail = contact.email || "";
    seed.job.address = [contact.address, contact.cityStateZip]
      .filter(Boolean)
      .join(", ");
    seed.customerId = activeCustomer.id;
    const primaryWorkspace = linked[0]?.workspace;
    const primaryJob = importedJobs[0];
    if (primaryWorkspace) {
      seed.workspaceId = primaryWorkspace.id;
      seed.job.jobNumber = primaryWorkspace.record.customer.jobNumber || "";
      seed.job.projectManager =
        primaryWorkspace.record.team.projectManager || "";
      seed.job.branchContact = primaryWorkspace.record.team.estimator || "";
      seed.job.originalContract = primaryWorkspace.originalContract || "";
      if (primaryWorkspace.record.customer.lossAddress)
        seed.job.address = primaryWorkspace.record.customer.lossAddress;
    } else if (primaryJob) {
      seed.job.jobNumber = primaryJob.jobNumber;
      seed.job.projectManager = primaryJob.projectManager || "";
      seed.job.branchContact = primaryJob.estimator || "";
      seed.job.originalContract = primaryJob.contractAmount || "";
      if (primaryJob.address) seed.job.address = primaryJob.address;
      seed.jobDirectoryId = primaryJob.id;
    } else if (primaryReqJob) {
      seed.job.jobNumber = primaryReqJob.jobNumber || "";
      seed.job.projectManager = primaryReqJob.projectManager || "";
      if ("originalContract" in primaryReqJob && primaryReqJob.originalContract)
        seed.job.originalContract = primaryReqJob.originalContract;
    }
    onNewRequest(seed);
  };

  const renderRequestItem = (request: ChangeRequest | RequestSummary) => {
    const amountLabel = extractRequestAmountLabel(request);
    const amountCents = extractRequestAmountCents(request);
    const description =
      extractRequestDescription(request) || request.job.customer;
    const isCredit = amountCents !== null && amountCents < 0n;
    const isAddition = amountCents !== null && amountCents > 0n;
    return (
      <li key={request.id} className="crm-job customer-co-row">
        <div
          className="crm-job-main customer-co-clickable"
          role={onOpenRequest ? "button" : undefined}
          tabIndex={onOpenRequest ? 0 : undefined}
          onClick={() => onOpenRequest?.(request.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenRequest?.(request.id);
            }
          }}
        >
          <div className="customer-co-header">
            <span className="customer-job-number">
              {request.job.orderNumber ? `${request.job.orderNumber} · ` : ""}
              {request.job.jobNumber || "Change order"}
            </span>
            <span
              className={`customer-co-amount ${isCredit ? "is-credit" : isAddition ? "is-addition" : ""}`}
            >
              {amountLabel}
            </span>
          </div>
          <strong>{description.slice(0, 80)}</strong>
          <small>
            {[
              request.estimatorName
                ? `Estimator: ${request.estimatorName}`
                : request.job.projectManager
                  ? `PM: ${request.job.projectManager}`
                  : "",
              new Date(request.updatedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        <span className={`crm-badge customer-status status-${request.status}`}>
          {REQUEST_LABELS[request.status] ?? request.status}
        </span>
        {onOpenRequest && (
          <button
            className="customer-open-record customer-open-co-btn"
            type="button"
            aria-label={`Open change order ${request.job.jobNumber || request.id}`}
            onClick={() => onOpenRequest(request.id)}
          >
            <span className="customer-open-co-text">Open</span>
            <ArrowUpRight size={16} />
          </button>
        )}
      </li>
    );
  };

  return (
    <div className={`crm crm-detail${embedded ? " crm-detail-embedded" : ""}`}>
      {!embedded && (
        <>
          <div className="customer-breadcrumb">
            <button type="button" onClick={onBack}>
              <ArrowLeft size={15} />
              All customers
            </button>
            <span aria-hidden="true">/</span>
            <span>Customer, job &amp; documents</span>
          </div>
          <div className="crm-profile">
            <span className="crm-profile-avatar" aria-hidden="true">
              {initials || <UserRound size={28} />}
            </span>
            <div className="crm-profile-main">
              <p className="customer-eyebrow">
                Customer, job &amp; documents
                {primaryCsvJob?.jobNumber
                  ? ` · ${primaryCsvJob.jobNumber}`
                  : linked[0]?.workspace.record.customer.jobNumber
                    ? ` · ${linked[0].workspace.record.customer.jobNumber}`
                    : ""}
              </p>
              <h1>{activeCustomer.name || "Untitled customer"}</h1>
              <p className="customer-profile-caption">
                Current contract total, job details, production PDFs, pending
                &amp; completed change orders, and project timeline.
              </p>
              {activeCustomer.tags?.length ? (
                <div className="crm-tags">
                  {activeCustomer.tags.map((tag) => (
                    <span key={tag} className="crm-tag">
                      <Tag size={12} />
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="crm-profile-actions">
              {onOpenWorkspace && (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void openPrimaryJobWorkspace("documents")}
                  >
                    <FileText size={16} />
                    Documents &amp; PDFs
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void openPrimaryJobWorkspace("details")}
                  >
                    <Briefcase size={16} />
                    Job details
                  </button>
                </>
              )}
              {onNewRequest && (
                <button
                  type="button"
                  className="button primary"
                  onClick={handleStartChangeOrder}
                >
                  <Plus size={16} />
                  New change order
                </button>
              )}
              {contact.phone && (
                <a
                  className="button"
                  href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`}
                >
                  <Phone size={16} />
                  Call customer
                </a>
              )}
              {contact.email && (
                <a className="button" href={`mailto:${contact.email}`}>
                  <Mail size={16} />
                  Email
                </a>
              )}
              <button
                className="button"
                onClick={() => {
                  setMergeFocus(false);
                  setFormOpen(true);
                }}
              >
                <Pencil size={16} />
                Edit
              </button>
              <button
                className="button"
                onClick={() => {
                  setMergeFocus(true);
                  setFormOpen(true);
                }}
              >
                <GitMerge size={16} />
                Merge
              </button>
            </div>
          </div>

          <div
            className="customer-overview-stats customer-financial-bar"
            aria-label="Customer overview"
          >
            <div className="customer-stat-primary">
              <DollarSign size={20} />
              <span>
                <small>Current contract total</small>
                <strong>{financials.currentTotalFormatted}</strong>
                <small className="customer-stat-sub">
                  Original: {financials.originalContractFormatted}
                  {financials.netApprovedChangesCents !== 0n
                    ? ` · Approved changes: ${financials.netApprovedChangesFormatted}`
                    : ""}
                </small>
              </span>
            </div>
            <div>
              <CheckCircle2 size={18} />
              <span>
                <small>Completed change orders</small>
                <strong>{financials.completedCount}</strong>
                <small className="customer-stat-sub">
                  {financials.completedCount > 0
                    ? `Net: ${financials.completedChangesFormatted}`
                    : "None completed yet"}
                </small>
              </span>
            </div>
            <div>
              <Clock3 size={18} />
              <span>
                <small>Pending change orders</small>
                <strong>{financials.pendingCount}</strong>
                <small className="customer-stat-sub">
                  {financials.pendingCount > 0
                    ? `Pending: ${financials.pendingChangesFormatted}`
                    : "No pending requests"}
                </small>
              </span>
            </div>
            <div className="customer-last-updated">
              <Briefcase size={17} />
              <span>
                <strong>
                  {activeJobs} active {activeJobs === 1 ? "job" : "jobs"} ·{" "}
                  {openTasks.length} follow-ups
                </strong>
                <small>
                  {Number.isNaN(updatedDate.getTime())
                    ? "Details available below"
                    : `Updated ${updatedDate.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}`}
                </small>
              </span>
            </div>
          </div>
        </>
      )}

      {error ? (
        <div className="notice danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="customer-overview-layout">
        <div className="customer-overview-main">
          {embedded && financials.hasContractData && (
            <section
              className="crm-section customer-embedded-financials"
              aria-label="Contract summary"
            >
              <div className="customer-embedded-totals">
                <div>
                  <small>Original contract</small>
                  <strong>{financials.originalContractFormatted}</strong>
                </div>
                <div>
                  <small>Approved changes ({financials.completedCount})</small>
                  <strong>{financials.netApprovedChangesFormatted}</strong>
                </div>
                <div>
                  <small>Pending changes ({financials.pendingCount})</small>
                  <strong>{financials.pendingChangesFormatted}</strong>
                </div>
                <div className="is-current-total">
                  <small>Current contract total</small>
                  <strong>{financials.currentTotalFormatted}</strong>
                </div>
              </div>
            </section>
          )}

          <section className="crm-section" aria-label="Change orders">
            <div className="crm-section-head customer-co-section-head">
              <div className="flex items-center gap-2">
                <h2>
                  <FileText size={17} />
                  Change orders
                </h2>
                {enrichedRequests.length ? (
                  <span className="crm-badge">{enrichedRequests.length}</span>
                ) : null}
              </div>
              <div className="customer-co-controls">
                {enrichedRequests.length > 0 && (
                  <div
                    className="customer-co-tabs"
                    role="group"
                    aria-label="Filter change orders"
                  >
                    <button
                      type="button"
                      className={coFilter === "all" ? "is-active" : ""}
                      onClick={() => setCoFilter("all")}
                    >
                      All ({enrichedRequests.length})
                    </button>
                    <button
                      type="button"
                      className={coFilter === "pending" ? "is-active" : ""}
                      onClick={() => setCoFilter("pending")}
                    >
                      Pending ({pendingRequests.length})
                    </button>
                    <button
                      type="button"
                      className={coFilter === "completed" ? "is-active" : ""}
                      onClick={() => setCoFilter("completed")}
                    >
                      Completed ({completedRequests.length})
                    </button>
                  </div>
                )}
                {onNewRequest && (
                  <button
                    type="button"
                    className="button primary small"
                    onClick={handleStartChangeOrder}
                  >
                    <Plus size={15} />
                    New change order
                  </button>
                )}
              </div>
            </div>

            {visibleRequests.length ? (
              coFilter === "all" &&
              pendingRequests.length > 0 &&
              completedRequests.length > 0 ? (
                <div className="customer-co-groups">
                  <div className="customer-co-group">
                    <h3 className="customer-co-group-title">
                      Pending change orders ({pendingRequests.length})
                    </h3>
                    <ul className="crm-job-list">
                      {pendingRequests.map(renderRequestItem)}
                    </ul>
                  </div>
                  <div className="customer-co-group">
                    <h3 className="customer-co-group-title">
                      Completed change orders ({completedRequests.length})
                    </h3>
                    <ul className="crm-job-list">
                      {completedRequests.map(renderRequestItem)}
                    </ul>
                  </div>
                </div>
              ) : (
                <ul className="crm-job-list">
                  {visibleRequests.map(renderRequestItem)}
                </ul>
              )
            ) : (
              <div className="crm-empty-action">
                <p className="crm-empty">
                  {enrichedRequests.length
                    ? `No ${coFilter} change orders for this customer.`
                    : "No change orders recorded for this customer yet."}
                </p>
                {onNewRequest && !enrichedRequests.length && (
                  <button
                    type="button"
                    className="button primary small mt-2"
                    onClick={handleStartChangeOrder}
                  >
                    <Plus size={15} />
                    Create change order for {activeCustomer.name}
                  </button>
                )}
              </div>
            )}
          </section>

          {timelineEvents.length > 0 && (
            <section
              className="crm-section customer-contract-timeline"
              aria-label="Contract timeline"
            >
              <div className="crm-section-head">
                <div>
                  <h2>
                    <TrendingUp size={17} />
                    Contract &amp; change order timeline
                  </h2>
                  <p className="customer-section-sub">
                    Chronological history of contract baseline and processed
                    change orders with running totals.
                  </p>
                </div>
              </div>
              <ol className="customer-fin-timeline">
                {timelineEvents.map((event) => {
                  const isCredit =
                    event.amountCents !== null && event.amountCents < 0n;
                  const isAddition =
                    event.amountCents !== null && event.amountCents > 0n;
                  return (
                    <li
                      key={event.id}
                      className={`customer-fin-event kind-${event.kind} ${
                        event.status ? `status-${event.status}` : ""
                      }`}
                    >
                      <span
                        className="customer-fin-dot"
                        aria-hidden="true"
                      />
                      <div className="customer-fin-body">
                        <div className="customer-fin-top">
                          <div className="customer-fin-titles">
                            <strong>{event.title}</strong>
                            <span className="customer-fin-subtitle">
                              {event.subtitle}
                              {event.estimatorName
                                ? ` · ${event.estimatorName}`
                                : ""}
                            </span>
                          </div>
                          <div className="customer-fin-amounts">
                            <span
                              className={`customer-fin-delta ${
                                event.kind === "contract_origin"
                                  ? "is-origin"
                                  : isCredit
                                    ? "is-credit"
                                    : isAddition
                                      ? "is-addition"
                                      : ""
                              }`}
                            >
                              {event.amountFormatted}
                            </span>
                            {event.runningTotalFormatted && (
                              <small className="customer-fin-running">
                                Total: {event.runningTotalFormatted}
                              </small>
                            )}
                          </div>
                        </div>
                        <p className="customer-fin-desc">{event.description}</p>
                        <div className="customer-fin-meta">
                          <span>
                            {event.date
                              ? new Date(event.date).toLocaleDateString(
                                  "en-US",
                                  {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                  },
                                )
                              : "Date not recorded"}
                          </span>
                          {event.status && (
                            <span
                              className={`crm-badge customer-status status-${event.status}`}
                            >
                              {REQUEST_LABELS[event.status] ?? event.status}
                            </span>
                          )}
                          {event.requestId && onOpenRequest && (
                            <button
                              type="button"
                              className="text-button customer-fin-open"
                              onClick={() => onOpenRequest(event.requestId!)}
                            >
                              Open change order <ArrowUpRight size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {!embedded && (
            <section className="crm-section customer-jobs" aria-label="Jobs">
              <div className="crm-section-head">
                <h2>
                  <Briefcase size={17} />
                  Jobs, details &amp; production documents
                </h2>
                {onOpenWorkspace && (linked.length > 0 || importedJobs.length > 0) && (
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => void openPrimaryJobWorkspace("documents")}
                  >
                    <FileText size={14} />
                    Production PDFs
                  </button>
                )}
              </div>
              {linked.length || importedJobs.length ? (
                <ul className="crm-job-list">
                  {linked.map((row) => (
                    <li key={row.workspace.id} className="crm-job">
                      <div className="crm-job-main">
                        <span className="customer-job-number">
                          {row.workspace.record.customer.jobNumber ||
                            "Job in preparation"}
                        </span>
                        <strong>
                          {row.workspace.record.customer.lossAddress ||
                            row.workspace.record.customer.customerName ||
                            "Untitled job"}
                        </strong>
                        <small>
                          {row.workspace.record.team.projectManager
                            ? `Project manager · ${row.workspace.record.team.projectManager}`
                            : "Job workspace & production documents"}
                        </small>
                      </div>
                      <select
                        className="crm-job-stage"
                        aria-label={`Stage for ${row.workspace.record.customer.customerName || "job"}`}
                        value={row.workspace.stage ?? "lead"}
                        disabled={busy}
                        onChange={(event) =>
                          void changeStage(
                            row.workspace.id,
                            event.target.value as JobStage,
                          )
                        }
                      >
                        {STAGES.map((stage) => (
                          <option key={stage} value={stage}>
                            {STAGE_LABELS[stage]}
                          </option>
                        ))}
                      </select>
                      {onOpenWorkspace && (
                        <button
                          className="customer-open-record"
                          type="button"
                          aria-label={`Open job ${row.workspace.record.customer.jobNumber || row.workspace.record.customer.customerName}`}
                          onClick={() =>
                            onOpenWorkspace(row.workspace.id, "details")
                          }
                        >
                          <ArrowUpRight size={18} />
                        </button>
                      )}
                    </li>
                  ))}
                  {importedJobs.map((job) => (
                    <li className="crm-job" key={job.id}>
                      <div className="crm-job-main">
                        <span className="customer-job-number">
                          {job.jobNumber}
                        </span>
                        <strong>{job.address || job.customer}</strong>
                        <small>
                          {job.projectManager
                            ? `Project manager · ${job.projectManager}`
                            : "From uploaded CSV directory"}
                        </small>
                      </div>
                      <span
                        className={`crm-badge customer-status ${job.active ? "is-active" : ""}`}
                      >
                        {job.status || (job.active ? "Active" : "Inactive")}
                      </span>
                      {onOpenWorkspace && (
                        <button
                          className="customer-open-record"
                          type="button"
                          disabled={busy}
                          aria-label={`Open job ${job.jobNumber}`}
                          onClick={() => void openImportedJob(job, "details")}
                        >
                          <ArrowUpRight size={18} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="crm-empty">
                  No jobs linked to this customer yet.
                </p>
              )}

              <details className="customer-link-tools">
                <summary>
                  <Link2 size={14} />
                  Manage job connections
                </summary>
                <p>
                  Matching jobs connect automatically. Use this for a job
                  recorded under a different customer.
                </p>
                <div className="crm-link">
                  <div className="crm-field">
                    <label htmlFor="crm-link-job">Link a job</label>
                    <select
                      id="crm-link-job"
                      aria-label="Link a job to this customer"
                      value={linkJobId}
                      disabled={busy}
                      onChange={(event) => setLinkJobId(event.target.value)}
                    >
                      <option value="">Choose an unlinked job…</option>
                      {unlinked.map((row) => (
                        <option key={row.workspace.id} value={row.workspace.id}>
                          {row.workspace.record.customer.customerName ||
                            "Untitled job"}
                          {row.workspace.record.customer.jobNumber
                            ? ` · ${row.workspace.record.customer.jobNumber}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="button"
                    disabled={busy || !linkJobId}
                    onClick={() => void linkJob()}
                  >
                    <Link2 size={16} />
                    Link job
                  </button>
                </div>
              </details>
            </section>
          )}

          <ActivityTimeline
            activities={activities}
            onAddNote={handleAddNote}
            onLogCommunication={handleLogCommunication}
          />
        </div>
        <aside
          className="customer-overview-sidebar"
          aria-label="Customer details and follow-ups"
        >
          <section
            className="crm-section customer-contact"
            aria-label="Contact details"
          >
            <div className="crm-section-head">
              <h2>Contact details</h2>
              <UserRound size={17} aria-hidden="true" />
            </div>
            <dl>
              <div>
                <dt>
                  <Phone size={14} />
                  Phone
                </dt>
                <dd>
                  {contact.phone ? (
                    <a href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`}>
                      {contact.phone}
                      <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    <span className="customer-missing">No phone added</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  <Mail size={14} />
                  Email
                </dt>
                <dd>
                  {contact.email ? (
                    <a href={`mailto:${contact.email}`}>
                      {contact.email}
                      <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    <span className="customer-missing">No email added</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  <MapPin size={14} />
                  Address
                </dt>
                <dd>
                  {[contact.address, contact.cityStateZip]
                    .filter(Boolean)
                    .join(", ") || (
                    <span className="customer-missing">No address added</span>
                  )}
                </dd>
              </div>
            </dl>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                if (onEditContact) {
                  onEditContact();
                  return;
                }
                setMergeFocus(false);
                setFormOpen(true);
              }}
            >
              Update contact details
              <ArrowUpRight size={14} />
            </button>
          </section>
          <TaskList
            tasks={tasks}
            onAddTask={handleAddTask}
            onToggle={handleToggleTask}
          />
        </aside>
      </div>

      {formOpen ? (
        <CustomerForm
          mode="edit"
          initial={activeCustomer}
          customers={customers}
          mergeFocus={mergeFocus}
          onCancel={() => setFormOpen(false)}
          onSaved={handleSaved}
        />
      ) : null}
    </div>
  );
}

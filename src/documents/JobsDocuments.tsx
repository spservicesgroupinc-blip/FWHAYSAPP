import { useEffect, useState } from "react";
import { FileText, Plus, Search, Upload } from "lucide-react";
import type { ChangeRequest, JobEntry, RequestSummary } from "../types";
import type { WorkspaceRow } from "../workspaces/types";
import {
  createWorkspace,
  normalizeJobNumber,
  workspaceFromDirectory,
} from "../workspaces/model";
import {
  cachedWorkspaces,
  refreshWorkspaces,
  saveWorkspaceLocally,
  subscribeWorkspaces,
} from "../services/workspaces";
import { syncWorkspaces } from "../services/workspaces";
import { importWorkspaceLocally } from "../workspaces/importStore";
import {
  listCustomers,
  subscribeCrm,
  syncCustomersFromJobs,
  type CustomerSummary,
} from "../crm";
import {
  customerIdForPick,
  customerIdOfOption,
  customerOptions,
} from "../services/customerDirectory";
import JobWorkspace from "./JobWorkspace";
import { CustomerImportPage } from "./components/CustomerImportPage";
import WorkspaceMigration from "./WorkspaceMigration";
import { DirectoryJobPicker } from "./components/DirectoryJobPicker";
import "./workspace.css";
import "./documents.css";

export default function JobsDocuments({
  workspaceId,
  initialTab,
  initialTool,
  jobs,
  requests,
  onOpenWorkspace,
  onNewRequest,
  onOpenRequest,
  onBack,
}: {
  workspaceId?: string;
  initialTab?: "overview" | "details" | "documents" | "requests" | "intake";
  initialTool?: "migration" | "reference";
  jobs: JobEntry[];
  requests: RequestSummary[];
  onOpenWorkspace: (id: string) => void;
  onNewRequest: (request: ChangeRequest) => void;
  onOpenRequest: (id: string) => void;
  onBack: () => void;
}) {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<"jobs" | "migration" | "reference">("jobs");
  useEffect(() => setTool(initialTool || "jobs"), [initialTool]);
  useEffect(() => {
    let active = true;
    const read = () => {
      void listCustomers({ skipServerRefresh: true, directoryJobs: jobs })
        .then((value) => {
          if (active) setCustomers(value);
        })
        .catch(() => undefined);
    };
    read();
    void listCustomers({ skipServerRefresh: false, directoryJobs: jobs })
      .then((value) => {
        if (active) setCustomers(value);
      })
      .catch(() => undefined);
    const unsubscribe = subscribeCrm(read);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [jobs]);
  const activeJobs = jobs.filter(
    (job) => !(/^csv-job-[a-f0-9]{32}$/.test(job.id) && !job.active),
  );
  const pickerDirectory = [
    ...activeJobs,
    ...customerOptions(activeJobs, customers),
  ];
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const cached = await cachedWorkspaces();
        if (active) setRows(cached);
      } catch (value) {
        console.warn("Could not read cached workspaces:", value);
      }
    };
    void read();
    void refreshWorkspaces()
      .then(() => {
        if (active) setError("");
      })
      .catch((value) => {
        if (!active) return;
        const msg = value instanceof Error ? value.message : String(value);
        setError(
          msg.includes("Internal error") || msg.includes("UnknownError")
            ? "Could not sync workspaces. Using device storage fallback mode."
            : msg,
        );
      });
    const unsubscribe = subscribeWorkspaces(() => void read());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function create(entry?: JobEntry) {
    setBusy(true);
    setError("");
    try {
      if (entry) {
        const matches = rows.filter(
          (row) =>
            normalizeJobNumber(row.workspace.record.customer.jobNumber) ===
            normalizeJobNumber(entry.jobNumber),
        );
        if (entry.jobNumber.trim() && matches.length === 1) {
          onOpenWorkspace(matches[0].workspace.id);
          return;
        }
        if (entry.jobNumber.trim() && matches.length > 1)
          throw new Error(
            "More than one saved job uses this number. Open the correct saved job below.",
          );
      }
      const workspace = entry
        ? workspaceFromDirectory(entry)
        : createWorkspace();
      if (entry)
        workspace.customerId = customerIdForPick(
          entry,
          customers,
          entry.customer,
        );
      await saveWorkspaceLocally(workspace);
      // Opening a job from the directory registers its customer and links it.
      if (entry && !customerIdOfOption(entry.id))
        await syncCustomersFromJobs([entry], true).catch(() => undefined);
      onOpenWorkspace(workspace.id);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  if (workspaceId)
    return (
      <JobWorkspace
        key={workspaceId}
        id={workspaceId}
        initialTab={initialTab}
        requests={requests}
        jobs={pickerDirectory}
        customers={customers}
        onNewRequest={onNewRequest}
        onOpenRequest={onOpenRequest}
        onBack={onBack}
      />
    );
  const query = search.trim().toLowerCase();

  // Combine saved workspaces and imported CSV directory jobs into a unified list
  const savedJobNumbers = new Set(
    rows
      .map((r) => normalizeJobNumber(r.workspace.record.customer.jobNumber))
      .filter(Boolean),
  );

  const directoryOnlyItems = activeJobs
    .filter((job) => {
      const norm = normalizeJobNumber(job.jobNumber);
      return !norm || !savedJobNumbers.has(norm);
    })
    .map((job) => ({
      kind: "directory" as const,
      id: job.id,
      jobNumber: job.jobNumber,
      customerName: job.customer,
      address: job.address,
      status: job.status || (job.active ? "Active" : "Closed"),
      updatedAt: job.updatedAt,
      job,
    }));

  const savedItems = rows.map((r) => ({
    kind: "workspace" as const,
    id: r.workspace.id,
    jobNumber: r.workspace.record.customer.jobNumber,
    customerName: r.workspace.record.customer.customerName,
    address: r.workspace.record.customer.lossAddress,
    status: r.conflict
      ? "Conflicting edits need review"
      : r.error
        ? "Sync needs attention · device copy saved"
        : r.dirty || r.inFlight
          ? "Saved on device · sync queued"
          : "Saved to shared workspace",
    updatedAt: r.workspace.updatedAt,
    workspace: r.workspace,
    row: r,
  }));

  const allItems = [...savedItems, ...directoryOnlyItems];
  const visible = allItems
    .filter((item) =>
      [item.customerName, item.jobNumber, item.address]
        .join(" ")
        .toLowerCase()
        .includes(query),
    )
    .sort((a, b) => (a.customerName || "").localeCompare(b.customerName || ""));

  return (
    <div className="documents-workspace jobs-documents">
      <div className="workspace-title">
        <div>
          <p className="workspace-eyebrow">Shared job workspace</p>
          <h1>Jobs & Documents</h1>
          <p>
            Job details, production documents, and change requests together.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="#/jobs" className="button">
            <Upload size={16} />
            Import CSV
          </a>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void create()}
          >
            <Plus size={18} />
            New job
          </button>
        </div>
      </div>
      {tool !== "jobs" && (
        <div className="workspace-tools">
          <button className="button" onClick={() => setTool("jobs")}>
            Back to saved jobs
          </button>
        </div>
      )}

      {error && (
        <div className="notice danger" role="alert">
          <span>{error}</span>
          <button
            className="button small"
            onClick={() => {
              setError("");
              void refreshWorkspaces()
                .then(() => setError(""))
                .catch((value) => {
                  const msg = value instanceof Error ? value.message : String(value);
                  setError(
                    msg.includes("Internal error") || msg.includes("UnknownError")
                      ? "Could not sync workspaces. Using device storage fallback mode."
                      : msg,
                  );
                });
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {tool === "migration" ? (
        <WorkspaceMigration
          workspaces={rows.map((row) => row.workspace)}
          onImport={async (workspace) => {
            await importWorkspaceLocally(
              workspace,
              rows.find((row) => row.workspace.id === workspace.id)?.workspace,
            );
            setRows(await cachedWorkspaces());
            void syncWorkspaces().catch(() => undefined);
          }}
          onDone={() => setTool("jobs")}
        />
      ) : tool === "reference" ? (
        <CustomerImportPage canImport onOpenIntake={() => setTool("jobs")} />
      ) : (
        <>
          <label className="workspace-search">
            <Search size={18} />
            <input
              aria-label="Search saved jobs"
              placeholder="Search customer, job number, or address"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <section className="workspace-panel">
            <h2>
              Jobs &amp; documents <span className="workspace-count">{allItems.length}</span>
            </h2>
            {visible.length ? (
              visible.map((item) => (
                <button
                  className="workspace-list-row"
                  key={item.id}
                  onClick={() => {
                    if (item.kind === "workspace") {
                      onOpenWorkspace(item.id);
                    } else {
                      void create(item.job);
                    }
                  }}
                >
                  <FileText size={22} />
                  <span>
                    <strong>
                      {item.customerName || "Untitled job"}
                    </strong>
                    <small>
                      {[item.jobNumber, item.address]
                        .filter(Boolean)
                        .join(" · ") || "Job details in progress"}
                    </small>
                    <small>
                      {item.status}
                    </small>
                  </span>
                  <span>Open →</span>
                </button>
              ))
            ) : (
              <div className="p-4 text-center">
                <p className="text-slate-600 mb-3">
                  {allItems.length
                    ? "No jobs match your search."
                    : "No jobs uploaded yet. Upload your Dash Job Summary CSV to load customers, jobs, and documents together."}
                </p>
                {!allItems.length && (
                  <a href="#/jobs" className="button primary inline-flex items-center gap-2">
                    <Upload size={16} /> Upload Dash CSV
                  </a>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

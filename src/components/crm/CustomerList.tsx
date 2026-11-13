import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Briefcase,
  DollarSign,
  Mail,
  MapPin,
  Phone,
  Plus,
  Search,
  Upload,
  UserRound,
} from "lucide-react";
import {
  csvCustomerFallbackId,
  listCustomers,
  normalizedNameTokens,
  subscribeCrm,
} from "../../crm";
import { customerNameKey } from "../../crm/jobSync";
import { cachedJobDirectory } from "../../services/storage";
import type { CustomerSummary } from "../../crm/types";
import type { JobEntry } from "../../types";
import CustomerForm from "./CustomerForm";
import "./crm.css";

export interface CustomerListProps {
  onOpen: (id: string) => void;
  jobs?: JobEntry[];
}

function formatContractCurrency(raw: string | undefined): string {
  if (!raw) return "";
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num === 0) return "";
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export default function CustomerList({ onOpen, jobs }: CustomerListProps) {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");

  const activeJobs = useMemo(() => {
    const source = jobs && jobs.length ? jobs : cachedJobDirectory();
    return source.filter(
      (job) =>
        job &&
        customerNameKey(job.customer) &&
        !(/^csv-job-[a-f0-9]{32}$/.test(job.id) && !job.active),
    );
  }, [jobs]);

  const load = useCallback(
    async (skipServerRefresh = false) => {
      try {
        const rows = await listCustomers({
          skipServerRefresh,
          directoryJobs: activeJobs,
        });
        setCustomers(rows);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeJobs],
  );

  useEffect(() => {
    let active = true;
    const readImmediate = async () => {
      try {
        const localRows = await listCustomers({
          skipServerRefresh: true,
          directoryJobs: activeJobs,
        });
        if (active) {
          setCustomers(localRows);
          setError("");
        }
        const refreshedRows = await listCustomers({
          skipServerRefresh: false,
          directoryJobs: activeJobs,
        });
        if (active) {
          setCustomers(refreshedRows);
          setError("");
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void readImmediate();
    const unsubscribe = subscribeCrm(() => {
      void listCustomers({
        skipServerRefresh: true,
        directoryJobs: activeJobs,
      })
        .then((rows) => {
          if (active) setCustomers(rows);
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeJobs]);

  // Synchronous merge so the uploaded CSV customer list renders on the very first frame (never blank!)
  const enrichedCustomers = useMemo(() => {
    const jobsByName = new Map<string, JobEntry[]>();
    const jobsByTokens = new Map<string, JobEntry[]>();
    for (const job of activeJobs) {
      const nKey = customerNameKey(job.customer);
      if (nKey) {
        const list = jobsByName.get(nKey) ?? [];
        list.push(job);
        jobsByName.set(nKey, list);
      }
      const tKey = normalizedNameTokens(job.customer);
      if (tKey) {
        const list = jobsByTokens.get(tKey) ?? [];
        list.push(job);
        jobsByTokens.set(tKey, list);
      }
    }

    const representedNames = new Set<string>();
    const rows: (CustomerSummary & {
      jobNumbers: string[];
      projectManager?: string;
      contractFormatted?: string;
    })[] = [];

    for (const customer of customers) {
      const nKey = customerNameKey(customer.name);
      const tKey = normalizedNameTokens(customer.name);
      const matchedJobs =
        (nKey ? jobsByName.get(nKey) : undefined) ??
        (tKey ? jobsByTokens.get(tKey) : undefined) ??
        [];
      if (nKey) representedNames.add(nKey);
      if (tKey) representedNames.add(tKey);

      const primaryJob = matchedJobs[0];
      const jobNumbers = [
        ...new Set(
          matchedJobs.map((j) => j.jobNumber.trim()).filter(Boolean),
        ),
      ];
      const effectiveJobCount = Math.max(
        customer.jobCount,
        jobNumbers.length || matchedJobs.length,
      );

      // When an uploaded CSV job directory is present, skip stale 0-job rows from replaced CSVs
      if (
        activeJobs.length > 0 &&
        effectiveJobCount === 0 &&
        customer.openTaskCount === 0 &&
        customer.id.startsWith("csv-customer-")
      ) {
        continue;
      }

      rows.push({
        ...customer,
        phone: customer.phone || primaryJob?.customerPhone || undefined,
        email: customer.email || primaryJob?.customerEmail || undefined,
        address: customer.address || primaryJob?.address || undefined,
        jobCount: effectiveJobCount,
        jobNumbers,
        projectManager: primaryJob?.projectManager || undefined,
        contractFormatted: formatContractCurrency(primaryJob?.contractAmount),
      });
    }

    // Guarantee every uploaded CSV customer is visible even on frame 1 before async storage resolves
    for (const job of activeJobs) {
      const nKey = customerNameKey(job.customer);
      const tKey = normalizedNameTokens(job.customer);
      if (
        (nKey && representedNames.has(nKey)) ||
        (tKey && representedNames.has(tKey))
      ) {
        continue;
      }
      if (nKey) representedNames.add(nKey);
      if (tKey) representedNames.add(tKey);
      const matchedJobs =
        (nKey ? jobsByName.get(nKey) : undefined) ?? [job];
      const jobNumbers = [
        ...new Set(
          matchedJobs.map((j) => j.jobNumber.trim()).filter(Boolean),
        ),
      ];
      rows.push({
        id: csvCustomerFallbackId(job.customer, job.jobNumber),
        name: job.customer.trim(),
        phone: job.customerPhone?.trim() || undefined,
        email: job.customerEmail?.trim() || undefined,
        address: job.address?.trim() || undefined,
        jobCount: Math.max(1, jobNumbers.length),
        openTaskCount: 0,
        updatedAt: job.updatedAt || new Date().toISOString(),
        jobNumbers,
        projectManager: job.projectManager?.trim() || undefined,
        contractFormatted: formatContractCurrency(job.contractAmount),
      });
    }

    return rows;
  }, [customers, activeJobs]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const filtered = query
      ? enrichedCustomers.filter((c) =>
          `${c.name ?? ""} ${c.jobNumbers.join(" ")} ${c.phone ?? ""} ${c.email ?? ""} ${c.address ?? ""} ${c.projectManager ?? ""}`
            .toLowerCase()
            .includes(query),
        )
      : enrichedCustomers;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [enrichedCustomers, query]);

  const handleSaved = useCallback(async () => {
    setShowForm(false);
    await load(true);
  }, [load]);

  return (
    <div className="crm">
      <div className="crm-head">
        <div>
          <p className="eyebrow">Customers, jobs &amp; documents</p>
          <h1>Customers</h1>
          <p>
            {activeJobs.length > 0
              ? `${enrichedCustomers.length} active customers from your uploaded CSV — click any customer for jobs, production documents, and change orders.`
              : "Contacts, jobs, production documents, and change orders in one place."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="#/jobs" className="button">
            <Upload size={16} />
            Import CSV
          </a>
          <button className="button primary" onClick={() => setShowForm(true)}>
            <Plus size={18} />
            New customer
          </button>
        </div>
      </div>

      {error ? (
        <div className="notice danger" role="alert">
          {error}
        </div>
      ) : null}

      <label className="search crm-search">
        <Search size={17} />
        <input
          aria-label="Search customers"
          placeholder="Search customer name, job number, phone, email, or address"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      <div className="crm-list">
        {visible.length ? (
          visible.map((customer) => (
            <button
              key={customer.id}
              className="crm-card"
              onClick={() => onOpen(customer.id)}
            >
              <span className="crm-card-avatar" aria-hidden="true">
                <UserRound size={20} />
              </span>
              <span className="crm-card-main">
                <strong>{customer.name || "Untitled customer"}</strong>
                {customer.jobNumbers.length > 0 ? (
                  <small>
                    <Briefcase size={12} />
                    {customer.jobNumbers.join(", ")}
                    {customer.projectManager
                      ? ` · PM: ${customer.projectManager}`
                      : ""}
                  </small>
                ) : null}
                {customer.phone ? (
                  <small>
                    <Phone size={12} />
                    {customer.phone}
                  </small>
                ) : null}
                {customer.email ? (
                  <small>
                    <Mail size={12} />
                    {customer.email}
                  </small>
                ) : null}
                {customer.address ? (
                  <small>
                    <MapPin size={12} />
                    {customer.address}
                  </small>
                ) : null}
              </span>
              <span className="crm-card-stats">
                {customer.contractFormatted ? (
                  <span className="crm-badge">
                    <DollarSign size={12} />
                    {customer.contractFormatted}
                  </span>
                ) : null}
                <span className="crm-badge">
                  {customer.jobCount} {customer.jobCount === 1 ? "job" : "jobs"}
                </span>
                {customer.openTaskCount > 0 ? (
                  <span className="crm-badge crm-badge-attention">
                    {customer.openTaskCount} open
                  </span>
                ) : null}
              </span>
              <span className="crm-card-open" aria-hidden="true">
                Open →
              </span>
            </button>
          ))
        ) : (
          <div className="crm-empty-box p-6 text-center">
            <p className="crm-empty mb-3">
              {enrichedCustomers.length
                ? "No customers match your search."
                : "No customers in directory yet. Upload your Dash Job Summary CSV to automatically generate all customer records, jobs, and documents."}
            </p>
            {!enrichedCustomers.length && (
              <a
                href="#/jobs"
                className="button primary inline-flex items-center gap-2"
              >
                <Upload size={16} /> Upload Dash CSV
              </a>
            )}
          </div>
        )}
      </div>

      {showForm ? (
        <CustomerForm
          mode="create"
          onCancel={() => setShowForm(false)}
          onSaved={handleSaved}
        />
      ) : null}
    </div>
  );
}

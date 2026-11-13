import { MoreHorizontal, ArrowRight, Trash2, UserRound } from "lucide-react";
import type { RequestSummary } from "../types";

const labels: Record<string, string> = {
  submitted: "In queue",
  in_review: "In review",
  needs_information: "Needs info",
  completed: "Completed",
};

export default function RequestQueue({
  requests,
  onOpen,
  onOpenCustomer,
  onDelete,
}: {
  requests: RequestSummary[];
  onOpen: (id: string) => void;
  onOpenCustomer?: (request: RequestSummary) => void;
  onDelete: (request: RequestSummary) => void;
}) {
  return (
    <div className="request-list">
      <div className="queue-columns" aria-hidden="true">
        <span>Customer / job</span>
        <span>Status</span>
        <span>Estimator</span>
        <span>Files</span>
        <span>Updated</span>
        <span />
      </div>
      {requests.map((item) => (
        <div className="request-row" key={item.id}>
          <button
            className="request-open"
            aria-label={
              labels[item.status] +
              " " +
              (item.job.customer || "Untitled request") +
              " " +
              item.job.jobNumber
            }
            onClick={() => onOpen(item.id)}
          >
            <span className="request-row-main">
              <strong>{item.job.customer || "Untitled request"}</strong>
              <small>
                {item.job.jobNumber || "Job pending"} · {item.changesCount}{" "}
                {item.changesCount === 1 ? "change" : "changes"}
              </small>
              {item.status === "needs_information" && (
                <span className="request-row-action">
                  Add the requested information <ArrowRight size={13} />
                </span>
              )}
            </span>
            <span className={"request-status status-" + item.status}>
              {labels[item.status]}
            </span>
            <span className="queue-estimator">
              {item.estimatorName || "Unassigned"}
            </span>
            <span className="queue-files">
              {item.attachmentsCount} <span className="mobile-only">files</span>
            </span>
            <time dateTime={item.updatedAt}>
              {new Date(item.updatedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </time>
          </button>
          {onOpenCustomer && (
            <button
              type="button"
              className="button small"
              aria-label={`Customer page for ${item.job.customer || item.id}`}
              onClick={() => onOpenCustomer(item)}
            >
              <UserRound size={14} />
              Customer page
            </button>
          )}
          <details className="overflow-menu">
            <summary
              aria-label={"Request actions for " + (item.job.customer || item.id)}
            >
              <MoreHorizontal size={20} />
            </summary>
            <div>
              {onOpenCustomer && (
                <button
                  className="button"
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    onOpenCustomer(item);
                  }}
                >
                  <UserRound size={16} />
                  Customer home page
                </button>
              )}
              <button
                className="button danger"
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  onDelete(item);
                }}
              >
                <Trash2 size={16} />
                Delete request
              </button>
            </div>
          </details>
        </div>
      ))}
      {!requests.length && (
        <p className="shell-empty-filter">No requests match this view.</p>
      )}
    </div>
  );
}

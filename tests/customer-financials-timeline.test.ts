import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequest } from "../src/services/requests";
import {
  calculateCustomerFinancials,
  buildCustomerTimeline,
} from "../src/services/customerFinancials";
import {
  resolveOrCreateCustomerId,
  lookupTargetFromRequest,
} from "../src/crm/jobSync";
import { openCustomer } from "../src/crm";

test("calculateCustomerFinancials computes current total, completed changes, and pending changes accurately", () => {
  const completedReq = createRequest();
  completedReq.id = "req-biggs-1";
  completedReq.status = "completed";
  completedReq.customerCredits = true;
  completedReq.knownChangeAmount = "-4444.00";
  completedReq.estimatorName = "gg";
  completedReq.createdAt = "2026-11-12T10:00:00.000Z";
  completedReq.updatedAt = "2026-11-12T12:00:00.000Z";
  completedReq.job = {
    ...completedReq.job,
    customer: "Biggs Property Management-530 Home Ave.",
    jobNumber: "F-25-0374-R",
    orderNumber: "CO-01",
    originalContract: "735056.65",
    previousChanges: "2244.00",
  };

  const pendingReq = createRequest();
  pendingReq.id = "req-biggs-2";
  pendingReq.status = "in_review";
  pendingReq.knownChangeAmount = "+1500.00";
  pendingReq.createdAt = "2026-11-12T14:00:00.000Z";
  pendingReq.updatedAt = "2026-11-12T15:00:00.000Z";
  pendingReq.job = {
    ...pendingReq.job,
    customer: "Biggs Property Management-530 Home Ave.",
    jobNumber: "F-25-0374-R",
    orderNumber: "CO-02",
    originalContract: "735056.65",
    previousChanges: "-2200.00",
  };

  const summary = calculateCustomerFinancials({
    workspaces: [],
    importedJobs: [],
    requests: [completedReq, pendingReq],
  });

  // Original: $735,056.65
  // Prior authorized baseline from earliest request: +$2,244.00
  // Completed change orders: -$4,444.00
  // Net approved changes: +$2,244.00 - $4,444.00 = -$2,200.00
  // Current contract total: $735,056.65 - $2,200.00 = $732,856.65
  assert.equal(summary.originalContractFormatted, "$735,056.65");
  assert.equal(summary.priorAuthorizedFormatted, "+$2,244.00");
  assert.equal(summary.completedChangesFormatted, "-$4,444.00");
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.pendingChangesFormatted, "+$1,500.00");
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.currentTotalFormatted, "$732,856.65");
  assert.equal(summary.projectedTotalFormatted, "$734,356.65");

  const timeline = buildCustomerTimeline({
    workspaces: [],
    importedJobs: [],
    requests: [completedReq, pendingReq],
  });

  assert.equal(timeline.length, 4);
  // Newest first: CO-02 (pending), CO-01 (completed), Prior authorized changes, Original contract
  assert.equal(timeline[0].orderNumber, "CO-02");
  assert.equal(timeline[0].amountFormatted, "+$1,500.00");
  assert.equal(timeline[1].orderNumber, "CO-01");
  assert.equal(timeline[1].amountFormatted, "-$4,444.00");
  assert.equal(timeline[1].runningTotalFormatted, "$732,856.65");
});

test("resolveOrCreateCustomerId ensures any request opens its customer home page cleanly", async () => {
  const req = createRequest();
  req.id = "req-biggs";
  req.status = "completed";
  req.job.customer = "Biggs Property Management-530 Home Ave.";
  req.job.jobNumber = "F-25-0374-R";
  req.job.customerPhone = "260-223-0685";
  req.job.customerEmail = "vrobbins@rentbiggs.com";
  req.job.address = "530 Home Ave., Fort Wayne IN 46807";

  const customerId = await resolveOrCreateCustomerId(
    lookupTargetFromRequest(req),
  );
  assert.ok(customerId);

  const customer = await openCustomer(customerId);
  assert.ok(customer);
  assert.equal(customer?.name, "Biggs Property Management-530 Home Ave.");
  assert.equal(customer?.phone, "260-223-0685");
  assert.equal(customer?.email, "vrobbins@rentbiggs.com");

  // Calling again resolves the exact same customer ID
  const secondId = await resolveOrCreateCustomerId(
    lookupTargetFromRequest(req),
  );
  assert.equal(secondId, customerId);
});

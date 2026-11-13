import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequest } from "../src/services/requests";
import type { ChangeRequest } from "../src/types";
import { customerNameKey } from "../src/crm/jobSync";
import { normalizeJobNumber } from "../src/workspaces/model";

test("customer matches change orders by customerId, jobNumber, and customerName", () => {
  const customer = {
    id: "cust-1",
    name: "Strukamp Lynette",
    phone: "260-301-1213",
    email: "lstrukamp@hotmail.com",
    address: "521 Stratton Way, Decatur IN 46733",
  };

  const customerKey = customerNameKey(customer.name);
  const customerJobNumbers = new Set(["F-26-0282-R"]);
  const linkedWorkspaceIds = new Set(["ws-strukamp-1"]);

  const req1: ChangeRequest = {
    ...createRequest(),
    id: "req-1",
    customerId: "cust-1",
    job: { ...createRequest().job, customer: "Strukamp Lynette", jobNumber: "F-26-0282-R" },
  };

  const req2: ChangeRequest = {
    ...createRequest(),
    id: "req-2",
    customerId: undefined,
    job: { ...createRequest().job, customer: "Lynette Strukamp", jobNumber: "F-26-0282-R" },
  };

  const req3: ChangeRequest = {
    ...createRequest(),
    id: "req-3",
    customerId: undefined,
    workspaceId: "ws-strukamp-1",
    job: { ...createRequest().job, customer: "Strukamp, Lynette", jobNumber: "" },
  };

  const reqUnrelated: ChangeRequest = {
    ...createRequest(),
    id: "req-4",
    customerId: "cust-99",
    job: { ...createRequest().job, customer: "Unrelated Person", jobNumber: "F-99-9999-X" },
  };

  const allRequests = [req1, req2, req3, reqUnrelated];

  const matched = allRequests.filter((request) => {
    if (request.customerId && request.customerId === customer.id) return true;
    if (request.workspaceId && linkedWorkspaceIds.has(request.workspaceId)) return true;
    const reqJobNum = normalizeJobNumber(request.job?.jobNumber || "");
    if (reqJobNum && customerJobNumbers.has(reqJobNum)) return true;
    const reqCustomerKey = customerNameKey(request.job?.customer);
    if (customerKey && reqCustomerKey === customerKey) return true;
    if (customerKey && reqCustomerKey) {
      const norm1 = customerKey.replace(/[,.-]/g, "").split(/\s+/).sort().join(" ");
      const norm2 = reqCustomerKey.replace(/[,.-]/g, "").split(/\s+/).sort().join(" ");
      if (norm1 && norm1 === norm2) return true;
    }
    return false;
  });

  assert.equal(matched.length, 3);
  assert.deepEqual(matched.map((r) => r.id), ["req-1", "req-2", "req-3"]);
});

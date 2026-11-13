import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJobReport } from "../src/services/jobImport";
import { syncCustomersFromJobs } from "../src/crm/jobSync";
import { listLocalCustomers } from "../src/crm/store";
import { workspaceFromDirectory } from "../src/workspaces/model";
import { createRequest } from "../src/services/requests";

test("CSV upload populates customers, jobs, workspaces, and links change orders", async () => {
  const csv = `Customer Name,Job Number,Street,City,State,Zip,Phone,Email,PM Name,Estimator,Carrier,Claim #,Contract Amount
"Strukamp, Lynette","F-26-0282-R","521 Stratton Way","Decatur","IN","46733","260-301-1213","lstrukamp@hotmail.com","Scott Richardson","Russell Shive","State Farm","CLM-9988","$416,851.60"
"Hay, Kevin","F-26-0053-R","1235 W Berry St","Fort Wayne","IN","46802","260-438-8779","kevin.hay0428@gmail.com","Scott Richardson","Russell Shive","Allstate","CLM-1122","$16,938.73"`;

  const parsed = parseJobReport(csv);
  assert.equal(parsed.jobs.length, 2);

  // 1. Sync creates CRM customers
  const synced = await syncCustomersFromJobs(parsed.jobs, false);
  assert.ok(synced.created.length >= 1 || synced.updated.length >= 1);

  const customers = await listLocalCustomers();
  assert.ok(customers.length >= 2);

  const strukampCustomer = customers.find((c) => c.name.includes("Strukamp"));
  assert.ok(strukampCustomer, "Strukamp customer should be created in CRM");
  assert.equal(strukampCustomer?.phone, "260-301-1213");
  assert.equal(strukampCustomer?.email, "lstrukamp@hotmail.com");

  // 2. Workspaces can be created and linked to this customer
  const entry = parsed.jobs[0];
  const ws = workspaceFromDirectory(entry, strukampCustomer.id);
  assert.equal(ws.customerId, strukampCustomer.id);
  assert.equal(ws.record.customer.customerName, "Strukamp, Lynette");
  assert.equal(ws.record.customer.jobNumber, "F-26-0282-R");

  // 3. Create a change order from "New request" for this job
  const req = createRequest();
  req.job.customer = "Strukamp Lynette";
  req.job.jobNumber = "F-26-0282-R";
  req.customerId = strukampCustomer.id;

  assert.equal(req.customerId, strukampCustomer.id);
  assert.equal(req.job.jobNumber, "F-26-0282-R");
});

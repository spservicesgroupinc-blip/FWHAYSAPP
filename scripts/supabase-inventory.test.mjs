import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inventory } from './supabase-inventory.mjs';
import { buildImportPlan } from './supabase-import-plan.mjs';

const heads = {
  Requests: ['id', 'revision', 'createdAt', 'updatedAt', 'status', 'estimatorName', 'customer', 'jobNumber', 'projectManager', 'orderNumber', 'address', 'changesCount', 'attachmentsCount', 'dataFileId', 'previousDataFileId', 'folderId', 'workspaceId'],
  Jobs: ['id', 'jobNumber', 'customer', 'address', 'projectManager', 'estimator', 'status', 'customerPhone', 'customerEmail', 'active', 'updatedAt', 'contractAmount'],
  Workspaces: ['id', 'revision', 'updatedAt', 'dataFileId', 'previousDataFileId', 'folderId'],
  JobDocuments: ['id', 'workspaceId', 'name', 'kind', 'driveFileId', 'inputFingerprint', 'templateVersion', 'createdAt', 'mutationId', 'payloadHash'],
  Customers: ['id', 'name', 'phone', 'email', 'updatedAt', 'data'],
  CustomerActivities: ['id', 'customerId', 'at', 'mutationId', 'data'],
  Tasks: ['id', 'customerId', 'updatedAt', 'data'],
};
function fixture() {
  const sheets = Object.fromEntries(Object.entries(heads).map(([key, header]) => [key, [header]]));
  sheets.CustomerReference = [['data', 'metadata']];
  sheets.Workspaces.push(['w', 2, '', 'ws', '', '']);
  sheets.Requests.push(['r', 1, '', '', '', '', '', '', '', '', '', 0, 1, 'rs', '', '', 'w']);
  sheets.Customers.push(['c', '', '', '', '', JSON.stringify({ customer: { id: 'c' } })]);
  sheets.Tasks.push(['t', 'c', '', JSON.stringify({ task: { id: 't', customerId: 'c' } })]);
  sheets.CustomerActivities.push(['a', 'c', '', '', JSON.stringify({ id: 'a', customerId: 'c' })]);
  sheets.JobDocuments.push(['d', 'w', '', '', 'pdf', '', 1, '', '', '']);
  return { sheets, snapshots: { ws: { workspace: { id: 'w', revision: 2 } }, rs: { request: { id: 'r', revision: 1, attachments: [{ driveFileId: 'photo' }] } } }, files: { pdf: 'pdf.bin', photo: 'photo.bin' } };
}
test('checks source relationships, snapshots, and file hashes without leaking IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hays-inventory-'));
  try {
    await writeFile(join(dir, 'pdf.bin'), 'pdf');
    await writeFile(join(dir, 'photo.bin'), 'photo');
    const result = await inventory(fixture(), dir);
    assert.equal(result.ok, true);
    assert.equal(result.counts.referencedFiles, 2);
    assert.equal(Object.keys(result.fileChecksums).length, 2);
    assert.equal(JSON.stringify(result).includes('photo.bin'), false);
    const broken = fixture();
    broken.sheets.Tasks[1][1] = 'missing';
    broken.snapshots.ws.workspace.revision = 99;
    broken.files.pdf = '../outside';
    const rejected = await inventory(broken, dir);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.issues.some(x => x.includes('missing customer')));
    assert.ok(rejected.issues.some(x => x.includes('mismatched current snapshot')));
    assert.ok(rejected.issues.some(x => x.includes('unavailable or unsafe local file')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('rejects a missing required sheet and duplicate IDs', async () => {
  const source = fixture();
  delete source.sheets.Jobs;
  source.sheets.Customers.push(source.sheets.Customers[1]);
  const result = await inventory(source, tmpdir());
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('Jobs: missing sheet or header'));
  assert.ok(result.issues.includes('Customers: duplicate id'));
});
test('rejects nonempty rows without IDs and nonnumeric revisions', async () => {
  const source = fixture();
  source.sheets.Jobs.push(['', 'unexpected data']);
  source.snapshots.ws.workspace.revision = null;
  const result = await inventory(source, tmpdir());
  assert.ok(result.issues.includes('Jobs: nonempty row missing id'));
  assert.ok(result.issues.includes('Workspaces: invalid or mismatched current snapshot'));
});
test('offline dry run gives deterministic receipt and refuses a destination write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hays-plan-'));
  try {
    await writeFile(join(dir, 'pdf.bin'), 'pdf');
    await writeFile(join(dir, 'photo.bin'), 'photo');
    const a = await buildImportPlan(fixture(), dir);
    const b = await buildImportPlan(fixture(), dir);
    assert.equal(a.ready, false);
    assert.equal(a.mode, 'offline-dry-run');
    assert.equal(a.sourceDigest, b.sourceDigest);
    await writeFile(join(dir, 'photo.bin'), 'changed');
    const c = await buildImportPlan(fixture(), dir);
    assert.notEqual(a.sourceDigest, c.sourceDigest);
    assert.ok(a.blockers.some(x => x.includes('destination file mapping')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('source exporter pages without creating missing sheets', async () => {
  const code = await (await import('node:fs/promises')).readFile(new URL('./supabase-source-export.gs', import.meta.url), 'utf8');
  const data = [['id'], ['a'], ['b']];
  const sheet = { getLastRow: () => data.length, getLastColumn: () => 1, getRange: (row, _col, count) => ({ getValues: () => data.slice(row - 1, row - 1 + count) }) };
  const context = {
    Number, Date, JSON,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'source' }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => name === 'Jobs' ? sheet : null }) },
  };
  runInNewContext(code, context);
  const first = context.supabaseExportSheetPage('Jobs', 0, 2);
  const next = context.supabaseExportSheetPage('Jobs', first.nextOffset, 2);
  assert.equal(first.nextOffset, 2);
  assert.equal(next.nextOffset, null);
  assert.equal(next.rows[0][0], 'b');
  assert.equal(context.supabaseExportSheetPage('Requests', 0, 2).exists, false);
  assert.throws(() => context.supabaseExportSheetPage('Unexpected', 0, 1));
});

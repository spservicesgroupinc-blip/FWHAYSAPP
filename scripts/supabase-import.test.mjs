import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runImport } from './supabase-import.mjs';
import { runReconciliation } from './supabase-reconcile.mjs';

const execute = promisify(execFile);
const scripts = ['scripts/supabase-import.mjs', 'scripts/supabase-reconcile.mjs'];
const sheetHeaders = {
  Requests: ['id', 'revision', 'createdAt', 'updatedAt', 'status', 'estimatorName', 'customer', 'jobNumber', 'projectManager', 'orderNumber', 'address', 'changesCount', 'attachmentsCount', 'dataFileId', 'previousDataFileId', 'folderId', 'workspaceId'],
  Jobs: ['id', 'jobNumber', 'customer', 'address', 'projectManager', 'estimator', 'status', 'customerPhone', 'customerEmail', 'active', 'updatedAt', 'contractAmount'],
  Workspaces: ['id', 'revision', 'updatedAt', 'dataFileId', 'previousDataFileId', 'folderId'],
  JobDocuments: ['id', 'workspaceId', 'name', 'kind', 'driveFileId', 'inputFingerprint', 'templateVersion', 'createdAt', 'mutationId', 'payloadHash'],
  Customers: ['id', 'name', 'phone', 'email', 'updatedAt', 'data'],
  CustomerActivities: ['id', 'customerId', 'at', 'mutationId', 'data'],
  Tasks: ['id', 'customerId', 'updatedAt', 'data'],
  CustomerReference: ['data', 'metadata'],
};

test('valid empty source is reported blocked and never imported or reconciled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hays-migration-'));
  try {
    const file = join(dir, 'bundle.json');
    const bundle = { sheets: Object.fromEntries(Object.entries(sheetHeaders).map(([name, header]) => [name, [header]])), snapshots: {}, files: {} };
    const data = JSON.stringify(bundle);
    await writeFile(file, data);
    const imported = await runImport(file);
    const reconciled = await runReconciliation(file);
    assert.equal(imported.ready, false);
    assert.equal(imported.imported, false);
    assert.equal(imported.outcome, 'blocked');
    assert.equal(reconciled.ready, false);
    assert.equal(reconciled.reconciled, false);
    assert.equal(reconciled.outcome, 'blocked');
    assert.equal(imported.sourceDigest, reconciled.sourceDigest);
    assert.deepEqual(await readdir(dir), ['bundle.json']);
    assert.equal(await readFile(file, 'utf8'), data);
    for (const script of scripts) {
      await assert.rejects(execute(process.execPath, [script, file]), error => error.code === 1 && JSON.parse(error.stdout).outcome === 'blocked');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid source and credentials are refused without displaying credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hays-migration-'));
  try {
    const file = join(dir, 'invalid.json');
    await writeFile(file, JSON.stringify({ sheets: {}, snapshots: {}, files: {} }));
    assert.equal((await runImport(file)).outcome, 'blocked');
    assert.equal((await runReconciliation(file)).outcome, 'blocked');
    await assert.rejects(runImport(file, 'not-a-real-secret'), /not accepted/);
    await assert.rejects(runReconciliation(file, 'not-a-real-secret'), /not accepted/);
    for (const script of scripts) {
      await execute(process.execPath, ['--check', script]);
      await assert.rejects(execute(process.execPath, [script, file, 'https://example.invalid', 'not-a-real-secret']), error => error.code === 1 && !error.stderr.includes('not-a-real-secret') && error.stdout === '');
      await assert.rejects(execute(process.execPath, [script, join(dir, 'missing.json')]), error => error.code === 1);
    }
    assert.deepEqual(await readdir(dir), ['invalid.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

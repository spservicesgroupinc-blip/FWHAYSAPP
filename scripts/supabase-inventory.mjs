import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const headers = {
  Requests: ['id', 'revision', 'createdAt', 'updatedAt', 'status', 'estimatorName', 'customer', 'jobNumber', 'projectManager', 'orderNumber', 'address', 'changesCount', 'attachmentsCount', 'dataFileId', 'previousDataFileId', 'folderId', 'workspaceId'],
  Jobs: ['id', 'jobNumber', 'customer', 'address', 'projectManager', 'estimator', 'status', 'customerPhone', 'customerEmail', 'active', 'updatedAt', 'contractAmount'],
  Workspaces: ['id', 'revision', 'updatedAt', 'dataFileId', 'previousDataFileId', 'folderId'],
  JobDocuments: ['id', 'workspaceId', 'name', 'kind', 'driveFileId', 'inputFingerprint', 'templateVersion', 'createdAt', 'mutationId', 'payloadHash'],
  Customers: ['id', 'name', 'phone', 'email', 'updatedAt', 'data'],
  CustomerActivities: ['id', 'customerId', 'at', 'mutationId', 'data'],
  Tasks: ['id', 'customerId', 'updatedAt', 'data'],
};

// Validate a private, locally assembled source bundle without contacting either
// service. Never print record contents, names, IDs, or source paths.
export async function inventory(bundle, baseDir) {
  if (!bundle || typeof bundle !== 'object' || !bundle.sheets || !bundle.snapshots || !bundle.files) throw new Error('Invalid bundle shape');
  const issues = [];
  const counts = {};
  const ids = {};
  const rows = {};
  const usedFiles = new Set();
  const fileChecksums = {};
  for (const name of Object.keys(headers)) {
    const page = bundle.sheets[name];
    if (!Array.isArray(page) || !Array.isArray(page[0])) {
      issues.push(`${name}: missing sheet or header`);
      rows[name] = [];
      continue;
    }
    const header = page[0];
    if (headers[name].some((column, i) => header[i] !== column)) issues.push(`${name}: unexpected header layout`);
    rows[name] = [];
    for (const row of page.slice(1)) {
      if (!Array.isArray(row)) { issues.push(`${name}: invalid row`); continue; }
      if (!String(row[0] ?? '').trim()) {
        if (row.some(cell => cell !== '' && cell !== null && cell !== undefined)) issues.push(`${name}: nonempty row missing id`);
        continue;
      }
      rows[name].push(row);
    }
    ids[name] = new Set();
    counts[name] = rows[name].length;
    for (const row of rows[name]) {
      const id = String(row[0]);
      if (ids[name].has(id)) issues.push(`${name}: duplicate id`);
      ids[name].add(id);
    }
  }
  async function fileAvailable(fileId, label) {
    if (!fileId || typeof fileId !== 'string') { issues.push(`${label}: missing Drive file ID`); return; }
    usedFiles.add(fileId);
    const name = bundle.files[fileId];
    if (typeof name !== 'string' || isAbsolute(name)) { issues.push(`${label}: missing local file`); return; }
    try {
      const root = await realpath(baseDir);
      const target = await realpath(resolve(root, name));
      const rel = relative(root, target);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside bundle');
      if (!(await stat(target)).isFile()) throw new Error('not a file');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      // The hashed source ID allows checksum matching without printing Drive IDs.
      fileChecksums[createHash('sha256').update(fileId).digest('hex')] = hash.digest('hex');
    } catch { issues.push(`${label}: unavailable or unsafe local file`); }
  }
  for (const row of rows.Requests) {
    const snapshot = bundle.snapshots[String(row[13])];
    if (!snapshot?.request || String(snapshot.request.id) !== String(row[0]) || !Number.isInteger(snapshot.request.revision) || snapshot.request.revision !== Number(row[1])) { issues.push('Requests: invalid or mismatched current snapshot'); continue; }
    if (row[16] && !ids.Workspaces?.has(String(row[16]))) issues.push('Requests: missing workspace');
    if (!Array.isArray(snapshot.request.attachments)) issues.push('Requests: invalid attachment list');
    else for (const attachment of snapshot.request.attachments) await fileAvailable(attachment.driveFileId, 'Requests attachment');
  }
  for (const row of rows.Workspaces) {
    const snapshot = bundle.snapshots[String(row[3])];
    if (!snapshot?.workspace || String(snapshot.workspace.id) !== String(row[0]) || !Number.isInteger(snapshot.workspace.revision) || snapshot.workspace.revision !== Number(row[1])) issues.push('Workspaces: invalid or mismatched current snapshot');
  }
  for (const row of rows.JobDocuments) {
    if (!ids.Workspaces?.has(String(row[1]))) issues.push('JobDocuments: missing workspace');
    await fileAvailable(String(row[4] || ''), 'JobDocuments file');
  }
  for (const [name, dataIndex, entity] of [['Customers', 5, 'customer'], ['Tasks', 3, 'task'], ['CustomerActivities', 4, null]]) {
    for (const row of rows[name]) {
      try {
        const parsed = JSON.parse(String(row[dataIndex]));
        const item = entity ? parsed[entity] : parsed;
        if (!item || String(item.id) !== String(row[0])) throw new Error('invalid id');
        if (name !== 'Customers' && !ids.Customers?.has(String(row[1]))) issues.push(`${name}: missing customer`);
        if (name !== 'Customers' && String(item.customerId) !== String(row[1])) issues.push(`${name}: customer mismatch`);
      } catch { issues.push(`${name}: invalid or mismatched data`); }
    }
  }
  if (!Array.isArray(bundle.sheets.CustomerReference)) issues.push('CustomerReference: sheet not supplied; explicitly inspect whether it exists');
  else for (const row of bundle.sheets.CustomerReference.slice(1)) {
    try {
      if (row[0]) JSON.parse(String(row[0]));
      if (row[1]) JSON.parse(String(row[1]));
    } catch { issues.push('CustomerReference: invalid JSON'); }
  }
  counts.CustomerReference = Math.max(0, (bundle.sheets.CustomerReference?.length ?? 0) - 1);
  counts.referencedFiles = usedFiles.size;
  return { counts, fileChecksums, issues, ok: issues.length === 0 };
}

async function main() {
  const input = process.argv[2];
  if (!input || process.argv.length !== 3) throw new Error('Usage: node scripts/supabase-inventory.mjs <bundle.json>');
  const bundle = JSON.parse(await readFile(input, 'utf8'));
  const result = await inventory(bundle, dirname(resolve(input)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { process.stderr.write('Inventory failed: invalid or unreadable bundle.\n'); process.exitCode = 1; });

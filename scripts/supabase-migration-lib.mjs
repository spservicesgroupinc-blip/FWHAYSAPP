import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { inventory } from './supabase-inventory.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = (bundle, name) => bundle.sheets[name].slice(1).filter(row => String(row[0] ?? '').trim());
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value;
const tableNames = ['customers','workspaces','jobs','requests','job_documents','customer_activities','tasks','customer_reference'];
function record(payload, revision = payload.revision ?? 0) {
  if (!payload || typeof payload !== 'object' || !payload.id || !Number.isInteger(revision) || revision < 0) throw new Error('Invalid source record');
  const timestamp = payload.updatedAt || payload.createdAt || payload.at || '1970-01-01T00:00:00.000Z';
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid source timestamp');
  return { id: String(payload.id), payload, revision, updated_at: new Date(timestamp).toISOString() };
}

export async function prepareBundle(bundlePath) {
  const path = resolve(bundlePath);
  const bundle = JSON.parse(await readFile(path, 'utf8'));
  const base = await realpath(dirname(path));
  const checked = await inventory(bundle, base);
  if (!checked.ok) throw new Error('Source inventory failed');
  // Previous snapshots are part of rollback history, not optional decoration.
  for (const [name, index] of [['Requests',14],['Workspaces',4]]) {
    for (const row of rows(bundle, name)) if (row[index] && !bundle.snapshots[String(row[index])]) throw new Error('Historical snapshot missing');
  }
  for (const snapshot of Object.values(bundle.snapshots)) {
    if (snapshot.request && (!Array.isArray(snapshot.request.attachments) || snapshot.request.attachments.some(file => !bundle.files[file.driveFileId]))) throw new Error('Historical attachment bytes missing');
  }
  const tables = Object.fromEntries(tableNames.map(name => [name, []]));
  for (const row of rows(bundle,'Customers')) tables.customers.push(record(parsed(row[5]).customer));
  for (const row of rows(bundle,'Workspaces')) tables.workspaces.push(record(bundle.snapshots[String(row[3])].workspace));
  for (const row of rows(bundle,'Requests')) tables.requests.push(record(bundle.snapshots[String(row[13])].request));
  for (const row of rows(bundle,'Tasks')) tables.tasks.push(record(parsed(row[3]).task));
  for (const row of rows(bundle,'CustomerActivities')) tables.customer_activities.push(record(parsed(row[4])));
  const jobHeader = bundle.sheets.Jobs[0];
  for (const row of rows(bundle,'Jobs')) {
    const payload = Object.fromEntries(jobHeader.map((key, i) => [key, row[i] ?? '']));
    if (![true,false,'TRUE','FALSE','true','false'].includes(payload.active)) throw new Error('Invalid job active value');
    payload.active = payload.active === true || String(payload.active).toLowerCase() === 'true';
    tables.jobs.push(record(payload));
  }
  const docKeys = ['id','workspaceId','name','kind','driveFileId','inputFingerprint','templateVersion','createdAt'];
  for (const row of rows(bundle,'JobDocuments')) {
    const payload = Object.fromEntries(docKeys.map((key,i) => [key,row[i]]));
    payload.templateVersion = Number(payload.templateVersion);
    if (!Number.isInteger(payload.templateVersion)) throw new Error('Invalid document version');
    tables.job_documents.push(record(payload));
  }
  const referenceRows = rows(bundle,'CustomerReference');
  const metadata = referenceRows[0]?.[1] ? parsed(referenceRows[0][1]) : {};
  const reference = { id:'current', customers:referenceRows.map(row => parsed(row[0])), fileName:'', updatedAt:'', updatedBy:'', version:'', ...metadata };
  tables.customer_reference.push(record(reference));
  for (const records of Object.values(tables)) records.sort((a,b) => a.id.localeCompare(b.id));
  const files = [];
  const mimeTypes = new Map();
  for (const row of tables.requests) for (const attachment of row.payload.attachments) {
    if (attachment.mimeType) mimeTypes.set(attachment.driveFileId,attachment.mimeType);
  }
  for (const row of tables.job_documents) mimeTypes.set(row.payload.driveFileId,'application/pdf');
  const addFile = (id, bytes, mimeType) => {
    const sha256 = hash(bytes);
    files.push({ metadata:{ drive_file_id:id,bucket_id:'hays-private',object_path:`migration/${hash(id)}/${sha256}`,sha256,size:bytes.length,mime_type:mimeType }, bytes });
  };
  for (const [id,name] of Object.entries(bundle.files)) {
    if (typeof name !== 'string' || isAbsolute(name)) throw new Error('Unsafe file mapping');
    const target = await realpath(resolve(base,name));
    const rel = relative(base,target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Unsafe file mapping');
    addFile(id,await readFile(target),bundle.fileMimeTypes?.[id] || mimeTypes.get(id) || 'application/octet-stream');
  }
  for (const [id,snapshot] of Object.entries(bundle.snapshots)) {
    if (bundle.files[id]) throw new Error('Conflicting snapshot and file mapping');
    addFile(id,Buffer.from(JSON.stringify(snapshot)),'application/json');
  }
  files.sort((a,b) => a.metadata.drive_file_id.localeCompare(b.metadata.drive_file_id));
  const sourceDigest = hash(canonical({tables,files:files.map(file => file.metadata)}));
  return { tables,files,sourceDigest,counts:Object.fromEntries(Object.entries(tables).map(([k,v]) => [k,v.length])) };
}

function equal(left,right) { return canonical(left) === canonical(right); }
export async function importPrepared(plan, destination) {
  const report = { inserted:0, existing:0, files:0, sourceDigest:plan.sourceDigest };
  // Never overwrite: replay compares destination content, not a local checkpoint.
  // Each insert is individually durable; interruption resumes by rereading it.
  for (const file of plan.files) {
    const existing = await destination.getRow('migration_files',file.metadata.drive_file_id,'drive_file_id');
    if (existing && !equal(existing,file.metadata)) throw new Error('Destination file mapping diverged');
    const bytes = await destination.getFile(file.metadata.object_path);
    if (bytes && hash(bytes) !== file.metadata.sha256) throw new Error('Destination file bytes diverged');
    if (!bytes) await destination.insertFile(file.metadata.object_path,file.bytes,file.metadata.mime_type);
    const verified = await destination.getFile(file.metadata.object_path);
    if (!verified || hash(verified) !== file.metadata.sha256) throw new Error('Destination file verification failed');
    if (!existing) await destination.insertRow('migration_files',file.metadata);
    report.files++;
  }
  for (const [table,records] of Object.entries(plan.tables)) for (const row of records) {
    const existing = await destination.getRow(table,row.id);
    if (existing) {
      if (!equal(existing,row)) throw new Error('Destination record diverged');
      report.existing++;
    } else {
      await destination.insertRow(table,row);
      const verified = await destination.getRow(table,row.id);
      if (!equal(verified,row)) throw new Error('Destination record verification failed');
      report.inserted++;
    }
  }
  return report;
}

export async function reconcilePrepared(plan,destination) {
  const issues=[];
  for (const [table,records] of Object.entries(plan.tables)) {
    const actual = await destination.listRows(table);
    if (actual.length !== records.length || !equal([...actual].sort((a,b)=>a.id.localeCompare(b.id)),records)) issues.push(`${table}: records differ`);
  }
  const actualMappings = await destination.listRows('migration_files');
  const expectedMappings=plan.files.map(file=>file.metadata);
  if (!equal([...actualMappings].sort((a,b)=>a.drive_file_id.localeCompare(b.drive_file_id)),expectedMappings)) issues.push('migration_files: mappings differ');
  for (const file of plan.files) {
    const bytes=await destination.getFile(file.metadata.object_path);
    if (!bytes || hash(bytes)!==file.metadata.sha256) issues.push('Storage: missing or mismatched bytes');
  }
  return { reconciled:issues.length===0,sourceDigest:plan.sourceDigest,counts:plan.counts,issues };
}

export async function createDestination(env=process.env) {
  const url=env.SUPABASE_URL, secret=env.SUPABASE_SECRET_KEY;
  if (!url || !secret || !env.SUPABASE_EXPECTED_PROJECT_REF || new URL(url).hostname !== `${env.SUPABASE_EXPECTED_PROJECT_REF}.supabase.co`) throw new Error('Explicit Supabase project and server credentials required');
  if (!secret.startsWith('sb_secret_')) {
    let role; try { role=JSON.parse(Buffer.from(secret.split('.')[1],'base64url')).role; } catch {}
    if (role!=='service_role') throw new Error('Server credentials required');
  }
  const {createClient}=await import('@supabase/supabase-js');
  const client=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
  return destinationFromClient(client);
}
export function destinationFromClient(client) {
  const fields=table=>table==='migration_files'?'drive_file_id,bucket_id,object_path,sha256,size,mime_type':'id,payload,revision,updated_at';
  const normalize = row => row && row.updated_at ? {...row,updated_at:new Date(row.updated_at).toISOString()} : row;
  return {
    async getRow(table,id,key='id') { const {data,error}=await client.from(table).select(fields(table)).eq(key,id).maybeSingle(); if(error) throw new Error('Destination read failed'); return normalize(data); },
    async insertRow(table,row) { const {error}=await client.from(table).insert(row); if(error) throw new Error('Destination insert failed; resume after inspection'); },
    async listRows(table) { const result=[];const key=table==='migration_files'?'drive_file_id':'id';let after; for(;;) { let query=client.from(table).select(fields(table)).order(key).limit(250);if(after)query=query.gt(key,after);const {data,error}=await query;if(error)throw new Error('Destination inventory failed');result.push(...data.map(normalize));if(data.length<250)return result;after=data.at(-1)[key]; } },
    async getFile(path) { const {data,error}=await client.storage.from('hays-private').download(path);if(error){if(String(error.statusCode)==='404'||String(error.statusCode)==='400'&&/not found/i.test(error.message))return null;throw new Error('Destination file read failed');} return Buffer.from(await data.arrayBuffer()); },
    async insertFile(path,bytes,mimeType) { const {error}=await client.storage.from('hays-private').upload(path,bytes,{contentType:mimeType,upsert:false});if(error)throw new Error('Destination upload failed; resume after inspection'); },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runImport } from './supabase-import.mjs';
import { runReconciliation } from './supabase-reconcile.mjs';
import { prepareBundle } from './supabase-migration-lib.mjs';
const execute=promisify(execFile);
const heads={Requests:['id','revision','createdAt','updatedAt','status','estimatorName','customer','jobNumber','projectManager','orderNumber','address','changesCount','attachmentsCount','dataFileId','previousDataFileId','folderId','workspaceId'],Jobs:['id','jobNumber','customer','address','projectManager','estimator','status','customerPhone','customerEmail','active','updatedAt','contractAmount'],Workspaces:['id','revision','updatedAt','dataFileId','previousDataFileId','folderId'],JobDocuments:['id','workspaceId','name','kind','driveFileId','inputFingerprint','templateVersion','createdAt','mutationId','payloadHash'],Customers:['id','name','phone','email','updatedAt','data'],CustomerActivities:['id','customerId','at','mutationId','data'],Tasks:['id','customerId','updatedAt','data'],CustomerReference:['CustomerJson','ImportJson']};
async function source() {
 const dir=await mkdtemp(join(tmpdir(),'hays-migrate-'));
 const sheets=Object.fromEntries(Object.entries(heads).map(([name,head])=>[name,[head]]));
 const at='2026-11-01T00:00:00.000Z';
 const customer={id:'c',revision:4,name:'Example',createdAt:at,updatedAt:at};
 sheets.Customers.push(['c','','','','',JSON.stringify({customer,mutations:{}})]);
 sheets.Workspaces.push(['w',9,at,'ws','previous','']);
 sheets.Requests.push(['r',3,at,at,'completed','','','','','','',1,1,'rs','','','w']);
 sheets.Jobs.push(['j','F-1','Example','','','','Active','','','TRUE',at,'123.45']);
 sheets.Tasks.push(['t','c',at,JSON.stringify({task:{id:'t',customerId:'c',revision:2,title:'Example',status:'open',createdAt:at}})]);
 sheets.CustomerActivities.push(['a','c',at,'original-operation',JSON.stringify({id:'a',customerId:'c',at,kind:'note',direction:'system',body:'Example'})]);
 sheets.CustomerReference.push([JSON.stringify({customerName:'Example',jobNumber:'F-1',contractPrice:123.45}),JSON.stringify({updatedAt:at,version:'v'})]);
 const snapshots={ws:{workspace:{id:'w',revision:9,updatedAt:at,customerId:'c',originalContract:'123.45'}},previous:{workspace:{id:'w',revision:8}},rs:{request:{id:'r',revision:3,updatedAt:at,status:'completed',workspaceId:'w',attachments:[{id:'attachment',driveFileId:'pdf',mimeType:'application/pdf'}],job:{originalContract:'123.45'},knownChangeAmount:'-2.10'}}};
 await writeFile(join(dir,'source.pdf'),Buffer.from('%PDF-example'));
 const bundle={sheets,snapshots,files:{pdf:'source.pdf'}};
 const path=join(dir,'bundle.json');await writeFile(path,JSON.stringify(bundle));return {dir,path,bundle};
}
function destination(){
 const tables=new Map(),files=new Map();let writes=0;
 return {tables,files,get writes(){return writes;},
 async getRow(table,id,key='id'){return structuredClone(tables.get(table)?.find(row=>row[key]===id)||null);},
 async insertRow(table,row){let records=tables.get(table)||[];let key=table==='migration_files'?'drive_file_id':'id';if(records.some(r=>r[key]===row[key]))throw Error('duplicate');records.push(structuredClone(row));tables.set(table,records);writes++;},
 async listRows(table){return structuredClone(tables.get(table)||[]);},
 async getFile(path){return files.get(path)||null;},
 async insertFile(path,bytes){assert.ok(!files.has(path));files.set(path,Buffer.from(bytes));writes++;}};
}
test('real mapping retains IDs, revisions, money, booleans, historical snapshots and bytes',async()=>{
 const f=await source();try{
 const plan=await prepareBundle(f.path);assert.equal(plan.counts.requests,1);assert.equal(plan.files.length,4);assert.equal(plan.tables.jobs[0].payload.active,true);assert.equal(plan.tables.requests[0].revision,3);assert.equal(plan.tables.requests[0].payload.knownChangeAmount,'-2.10');assert.equal(plan.tables.workspaces[0].payload.originalContract,'123.45');
 const dry=await runImport(f.path);assert.equal(dry.imported,false);
 const dest=destination();await assert.rejects(runImport(f.path,{apply:true,destination:dest,expectedDigest:'wrong'}));assert.equal(dest.writes,0);
 const result=await runImport(f.path,{apply:true,destination:dest,expectedDigest:dry.sourceDigest});assert.equal(result.imported,true);
 const writes=dest.writes;const replay=await runImport(f.path,{apply:true,destination:dest,expectedDigest:dry.sourceDigest});assert.equal(dest.writes,writes);assert.ok(replay.existing>0);
 assert.equal((await runReconciliation(f.path,{destination:dest})).reconciled,true);
 dest.tables.get('requests')[0].payload.knownChangeAmount='999';assert.equal((await runReconciliation(f.path,{destination:dest})).reconciled,false);await assert.rejects(runImport(f.path,{apply:true,destination:dest,expectedDigest:dry.sourceDigest}),/diverged/);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('interrupted inserts resume by destination verification without skipping remaining table rows',async()=>{
 const f=await source();try{
 const dest=destination(), original=dest.insertRow;let fail=true;
 dest.insertRow=async(table,row)=>{if(table==='requests'&&fail){fail=false;throw Error('lost connection');}return original(table,row);};
 const dry=await runImport(f.path);await assert.rejects(runImport(f.path,{apply:true,destination:dest,expectedDigest:dry.sourceDigest}));
 await runImport(f.path,{apply:true,destination:dest,expectedDigest:dry.sourceDigest});assert.equal((await runReconciliation(f.path,{destination:dest})).reconciled,true);
 dest.tables.get('jobs').push({...dest.tables.get('jobs')[0],id:'extra'});assert.equal((await runReconciliation(f.path,{destination:dest})).reconciled,false);
 const firstPath=dest.files.keys().next().value;dest.files.set(firstPath,Buffer.from('corrupt'));assert.equal((await runReconciliation(f.path,{destination:dest})).reconciled,false);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('missing history, unsafe paths and command-line credentials fail without leaking secrets',async()=>{
 const f=await source();try{
 await assert.rejects(runImport(f.path,'not-a-real-secret'),/not accepted/);
 for(const script of ['scripts/supabase-import.mjs','scripts/supabase-reconcile.mjs']){await execute(process.execPath,['--check',script]);await assert.rejects(execute(process.execPath,[script,f.path,'not-a-real-secret']),e=>e.code===1&&!e.stderr.includes('not-a-real-secret'));}
 delete f.bundle.snapshots.previous;await writeFile(f.path,JSON.stringify(f.bundle));await assert.rejects(prepareBundle(f.path),/Historical/);
 f.bundle.snapshots.previous={workspace:{id:'w',revision:8}};f.bundle.files.extra='../outside';await writeFile(f.path,JSON.stringify(f.bundle));await assert.rejects(prepareBundle(f.path));
 }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('lost upload and insert acknowledgments resume without duplicate or overwritten data',async()=>{
 const f=await source();try{
 const dest=destination(),upload=dest.insertFile,insert=dest.insertRow;let loseUpload=true,loseInsert=true;
 dest.insertFile=async(...args)=>{await upload(...args);if(loseUpload){loseUpload=false;throw Error('lost upload response');}};
 dest.insertRow=async(...args)=>{await insert(...args);if(args[0]==='requests'&&loseInsert){loseInsert=false;throw Error('lost insert response');}};
 const dry=await runImport(f.path),options={apply:true,destination:dest,expectedDigest:dry.sourceDigest};
 await assert.rejects(runImport(f.path,options));await assert.rejects(runImport(f.path,options));await runImport(f.path,options);
 assert.equal((await runReconciliation(f.path,{destination:dest})).reconciled,true);assert.equal(dest.tables.get('requests').length,1);
 f.bundle.snapshots.rs.request.knownChangeAmount='-3.10';await writeFile(f.path,JSON.stringify(f.bundle));await assert.rejects(runImport(f.path,options),/digest/);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('PostgREST timestamp representations normalize; permission errors are never treated as missing files',async()=>{
 const {destinationFromClient}=await import('./supabase-migration-lib.mjs');
 let fileError={statusCode:'404',message:'Object not found'};
 const row={id:'one',payload:{id:'one'},revision:1,updated_at:'2026-11-01T00:00:00+00:00'};
 const query={select(){return this;},eq(){return this;},async maybeSingle(){return {data:row,error:null};}};
 const client={from(){return query;},storage:{from(){return {async download(){return {data:null,error:fileError};}};}}};
 const dest=destinationFromClient(client);assert.equal((await dest.getRow('requests','one')).updated_at,'2026-11-01T00:00:00.000Z');assert.equal(await dest.getFile('path'),null);
 fileError={statusCode:'403',message:'Access denied'};await assert.rejects(dest.getFile('path'),/read failed/);
 fileError={statusCode:'400',message:'Malformed authentication'};await assert.rejects(dest.getFile('path'),/read failed/);
 fileError={statusCode:'500',message:'Object not found'};await assert.rejects(dest.getFile('path'),/read failed/);
});

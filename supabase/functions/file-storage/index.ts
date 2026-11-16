import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { MAX_BYTES, validIdentity, verifyBytes } from './validation.ts';

// Only this service can write or read Storage. Never forward caller-provided
// identity or service keys into the trusted actor argument.
Deno.serve(async (req: Request) => {
  const origin=req.headers.get('origin');
  const allowed=(Deno.env.get('FILE_ALLOWED_ORIGINS')??'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s=>s.trim()).filter(Boolean);
  const headers: Record<string,string>={'Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,x-file-ticket','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Expose-Headers':'x-file-receipt'};
  if (origin && !allowed.includes(origin)) return new Response('Origin denied',{status:403,headers});
  if(origin) headers['Access-Control-Allow-Origin']=origin;
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers});
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json'}});
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  try {
    const url=Deno.env.get('SUPABASE_URL')!;
    const service=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    const token=req.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if(!token) return json({error:'Sign in required'},401);
    const {data:auth,error:authError}=await service.auth.getUser(token);
    if(authError || !auth.user) return json({error:'Sign in required'},401);
    const actor=auth.user.id;
    const action=new URL(req.url).searchParams.get('action');
    const rpc=async (op:string,identity:unknown=null,ticket:string|null=null)=>{
      const {data,error}=await service.rpc('file_service',{p_actor:actor,p_action:op,p_identity:identity,p_ticket:ticket});
      if(error) throw error;
      return data;
    };
    if(action==='reserve') {
      if(Number(req.headers.get('content-length'))>8192) return json({error:'Identity too large'},413);
      const identity=JSON.parse(new TextDecoder().decode(await boundedBytes(req,8192)));
      if(!validIdentity(identity)) return json({error:'Invalid file identity'},400);
      const row=await rpc('reserve',identity);
      return json(row.complete?{state:'complete',receipt:row.identity}:{state:'upload',ticket:row.ticket,identity:row.identity});
    }
    if(action==='upload') {
      const ticket=req.headers.get('x-file-ticket');
      if(!ticket || !/^[0-9a-f-]{36}$/i.test(ticket)) return json({error:'Invalid ticket'},400);
      const row=await rpc('upload',null,ticket);
      if(Number(req.headers.get('content-length'))>MAX_BYTES) return json({error:'File too large'},413);
      const bytes=new Uint8Array(await boundedBytes(req,MAX_BYTES));
      await verifyBytes(bytes,row.identity);
      const bucket=service.storage.from('hays-private');
      const {error}=await bucket.upload(row.object_path,bytes,{upsert:false,contentType:row.identity.mimeType});
      if(error) {
        // A lost first response or concurrent identical retry may find the
        // immutable object. Verify it, never replace it or blindly acknowledge.
        const existing=await bucket.download(row.object_path);
        if(existing.error || !existing.data) throw error;
        await verifyBytes(new Uint8Array(await existing.data.arrayBuffer()),row.identity);
      }
      return json({ok:true});
    }
    if(action==='finalize') {
      const {ticket}=JSON.parse(new TextDecoder().decode(await boundedBytes(req,8192)));
      const row=await rpc('upload',null,ticket);
      const {data,error}=await service.storage.from('hays-private').download(row.object_path);
      if(error || !data) throw new Error('Object unavailable');
      await verifyBytes(new Uint8Array(await data.arrayBuffer()),row.identity);
      // Commit rechecks current membership and writable parent. No browser can
      // mutate the row or object before or after verification.
      const saved=await rpc('finalize',null,ticket);
      return json(saved.identity);
    }
    if(action==='download') {
      const {parentType,parentId,fileId}=JSON.parse(new TextDecoder().decode(await boundedBytes(req,8192)));
      const {data:files,error}=await service.from('private_files').select('ticket').eq('parent_type',parentType).eq('parent_id',parentId).eq('file_id',fileId).maybeSingle();
      if(error || !files) return json({error:'File unavailable'},404);
      const row=await rpc('download',null,files.ticket);
      const {data,error:readError}=await service.storage.from('hays-private').download(row.object_path);
      if(readError || !data) return json({error:'File unavailable'},404);
      await verifyBytes(new Uint8Array(await data.arrayBuffer()),row.identity);
      // Reauthorize after the object transfer too, before returning bytes.
      await rpc('download',null,files.ticket);
      return new Response(data,{headers:{...headers,'Content-Type':row.identity.mimeType,'x-file-receipt':encodeURIComponent(JSON.stringify(row.identity))}});
    }
    if(action==='legacyDownload') {
      const {parentType,parentId,driveFileId}=JSON.parse(new TextDecoder().decode(await boundedBytes(req,8192)));
      const args={p_actor:actor,p_parent_type:parentType,p_parent_id:parentId,p_drive_file_id:driveFileId};
      const first=await service.rpc('legacy_file_service',args);
      if(first.error) throw first.error;
      const row=first.data;
      const {data,error}=await service.storage.from(row.bucket_id).download(row.object_path);
      if(error || !data) throw new Error('Object unavailable');
      await verifyBytes(new Uint8Array(await data.arrayBuffer()),{size:Number(row.size),sha256:row.sha256,mimeType:row.mime_type});
      const recheck=await service.rpc('legacy_file_service',args);
      if(recheck.error) throw recheck.error;
      return new Response(data,{headers:{...headers,'Content-Type':row.mime_type}});
    }
    return json({error:'Unknown action'},400);
  } catch(error) {
    const code=(error as {code?:string})?.code;
    const status=code==='42501'?403:code==='P0002'?404:code==='22023'?409:400;
    return json({error:'File operation could not be confirmed. Retain the same file and retry identifier.'},status);
  }
});

async function boundedBytes(req:Request,limit:number):Promise<Uint8Array> {
  if(!req.body) throw new Error('Missing body');
  const reader=req.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
  for(;;) { const {done,value}=await reader.read(); if(done) break; total+=value.length; if(total>limit){await reader.cancel();throw new Error('File too large');} chunks.push(value); }
  const bytes=new Uint8Array(total); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;} return bytes;
}

import { validIdentity, verifyBytes } from './validation.ts';
const bytes=new TextEncoder().encode('%PDF-1.7\ntest');
const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
const identity={parentType:'request',parentId:'r',fileId:'f',mutationId:'m',name:'test.pdf',kind:'document',mimeType:'application/pdf',size:bytes.length,sha256};
Deno.test('server verifies type signature, size and exact bytes',async()=>{
  if(!validIdentity(identity)) throw new Error('Valid identity rejected');
  await verifyBytes(bytes,identity);
  for(const changed of [{...identity,sha256:'0'.repeat(64)},{...identity,size:bytes.length+1},{...identity,mimeType:'image/png'}]) {
    let denied=false;try{await verifyBytes(bytes,changed);}catch{denied=true;}if(!denied)throw new Error('Corrupt file accepted');
  }
});
Deno.test('identity requires type-specific metadata and limits',()=>{
  for(const changed of [{...identity,size:0},{...identity,parentType:'other'},{...identity,parentType:'workspace'},{...identity,kind:'evil'},{...identity,sha256:'invalid'}]) {
    if(validIdentity(changed))throw new Error('Invalid identity accepted');
  }
});

export const MAX_BYTES = 15 * 1024 * 1024;
export async function verifyBytes(bytes: Uint8Array, identity: Record<string, unknown>): Promise<void> {
  if (bytes.length < 1 || bytes.length > MAX_BYTES || bytes.length !== identity.size) throw new Error('Invalid file size');
  const has = (s: number[], offset=0) => s.every((v,i)=>bytes[i+offset]===v);
  const mime = identity.mimeType;
  const valid = mime==='application/pdf' ? has([37,80,68,70,45]) : mime==='image/jpeg' ? has([255,216,255]) : mime==='image/png' ? has([137,80,78,71,13,10,26,10]) : mime==='image/webp' && has([82,73,70,70]) && has([87,69,66,80],8);
  if (!valid) throw new Error('Invalid file signature');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),v=>v.toString(16).padStart(2,'0')).join('');
  if (hash!==identity.sha256) throw new Error('File hash mismatch');
}

export function validIdentity(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const x=value as Record<string,unknown>;
  if (!['request','workspace'].includes(String(x.parentType)) || !['application/pdf','image/jpeg','image/png','image/webp'].includes(String(x.mimeType))) return false;
  if (!['parentId','fileId','mutationId','name','kind'].every(k=>typeof x[k]==='string' && String(x[k]).trim().length>0 && String(x[k]).length<=300)) return false;
  if (!Number.isInteger(x.size) || Number(x.size)<1 || Number(x.size)>MAX_BYTES || typeof x.sha256!=='string' || !/^[a-f0-9]{64}$/.test(x.sha256)) return false;
  if (x.parentType==='request') return ['estimate','quote','photo','document'].includes(String(x.kind));
  return x.mimeType==='application/pdf' && typeof x.inputFingerprint==='string' && !!x.inputFingerprint && Number.isInteger(x.templateVersion) && Number(x.templateVersion)>0;
}

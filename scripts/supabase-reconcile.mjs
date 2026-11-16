import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBundle,createDestination,reconcilePrepared } from './supabase-migration-lib.mjs';

export async function runReconciliation(bundlePath,options={}) {
  if (!options||typeof options!=='object'||Object.keys(options).some(key=>key!=='destination')) throw new Error('Unsupported options; credentials are not accepted');
  const plan=await prepareBundle(bundlePath);
  return reconcilePrepared(plan,options.destination||await createDestination());
}
async function main(){
  if(process.argv.length!==3||process.argv[2].startsWith('-'))throw new Error('Usage');
  const result=await runReconciliation(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  if(!result.reconciled)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('Reconciliation failed. Source validation or authenticated destination read failed.\n');process.exitCode=1;});

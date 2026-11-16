import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareBundle,createDestination,importPrepared } from './supabase-migration-lib.mjs';

export async function runImport(bundlePath, options={}) {
  if (!options || typeof options!=='object' || Object.keys(options).some(key=>!['apply','destination','expectedDigest'].includes(key))) throw new Error('Unsupported options; credentials are not accepted');
  const plan=await prepareBundle(bundlePath);
  if (!options.apply) return {mode:'dry-run',imported:false,sourceDigest:plan.sourceDigest,counts:plan.counts,files:plan.files.length};
  if (options.expectedDigest!==plan.sourceDigest) throw new Error('Source digest confirmation required');
  const destination=options.destination||await createDestination();
  return {...await importPrepared(plan,destination),imported:true};
}
async function main() {
  const args=process.argv.slice(2);
  if (args.length<1||args.length>2||args[0].startsWith('-')||(args[1]&&args[1]!=='--apply')) throw new Error('Usage');
  const result=await runImport(args[0],{apply:args[1]==='--apply',expectedDigest:process.env.SUPABASE_IMPORT_SOURCE_DIGEST});
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{process.stderr.write('Import failed. Validate the source bundle, project configuration and destination state. No existing records are overwritten.\n');process.exitCode=1;});

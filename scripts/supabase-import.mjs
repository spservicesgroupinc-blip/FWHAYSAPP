import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildImportPlan } from './supabase-import-plan.mjs';

// Deliberately offline: the source inventory is useful for rehearsal, but no
// destination mapping, uploader, or import transaction has been verified.
export async function runImport(bundlePath, ...extra) {
  if (extra.length) throw new Error('Destination options and credentials are not accepted.');
  const path = resolve(bundlePath);
  const bundle = JSON.parse(await readFile(path, 'utf8'));
  const plan = await buildImportPlan(bundle, dirname(path));
  return { ...plan, imported: false, outcome: 'blocked' };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
    process.stderr.write('Usage: node scripts/supabase-import.mjs <bundle.json>\nOffline validation only; importing is disabled. Do not supply credentials.\n');
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runImport(process.argv[2]), null, 2)}\n`);
  } catch {
    process.stderr.write('Import blocked: source bundle is invalid or unreadable.\n');
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

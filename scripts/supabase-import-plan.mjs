import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventory } from './supabase-inventory.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// A deterministic rehearsal receipt for a validated source bundle. A matching
// receipt proves only that the exact source bundle and checked files were used.
// The plan is ready for import once the destination is verified and the
// --apply flag is passed to supabase-import.mjs.
export async function buildImportPlan(bundle, baseDir) {
  const checked = await inventory(bundle, baseDir);
  if (!checked.ok) return { ready: false, issues: checked.issues, counts: checked.counts };
  const digest = createHash('sha256').update(canonical({ sheets: bundle.sheets, snapshots: bundle.snapshots, fileChecksums: checked.fileChecksums })).digest('hex');
  return {
    ready: true,
    mode: 'offline-dry-run',
    sourceDigest: digest,
    counts: checked.counts,
    fileChecksums: checked.fileChecksums,
    blockers: [],
    note: 'Pass --apply to supabase-import.mjs with SUPABASE_IMPORT_SOURCE_DIGEST set to perform the actual import.',
  };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/supabase-import-plan.mjs <bundle.json>');
  const path = resolve(process.argv[2]);
  const bundle = JSON.parse(await readFile(path, 'utf8'));
  const plan = await buildImportPlan(bundle, dirname(path));
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  // The plan is always blocked until an importer and destination are verified.
  process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { process.stderr.write('Dry run failed: invalid or unreadable bundle.\n'); process.exitCode = 1; });

// Node test runner: executes every scripts/tests/*.test.ts and *.sim.ts (optional substring filter). Track P0.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRegistered } from './tests/harness';

const filter = process.argv[2] ?? '';
const dir = path.resolve(process.cwd(), 'scripts/tests');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => (f.endsWith('.test.ts') || f.endsWith('.sim.ts')) && f.includes(filter)).sort()
  : [];

let passed = 0;
let failed = 0;
const startAll = performance.now();
for (const f of files) {
  console.log(`\n# ${f}`);
  try {
    await import(pathToFileURL(path.join(dir, f)).href);
  } catch (err) {
    failed++;
    console.log(`  FAIL (import) ${f}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    continue;
  }
  const r = await runRegistered();
  passed += r.passed;
  failed += r.failed;
}
const total = (performance.now() - startAll).toFixed(0);
if (files.length === 0) console.log('no test files matched');
console.log(`\n${passed} passed, ${failed} failed, ${files.length} file(s), ${total} ms`);
process.exit(failed > 0 ? 1 : 0);

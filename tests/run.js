#!/usr/bin/env node
// Portable test entry: Node 20 has no --test globs and Node 22 dropped directory args.
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// OPENBOT_ORCA_TEST_UNIT_DIR: another unit dir (fixtures).
const unit = process.env.OPENBOT_ORCA_TEST_UNIT_DIR || join(here, 'unit');
// --plan prints the batches as JSON and runs nothing (used by run-serial-43.test.js).
const planOnly = process.argv[2] === '--plan';
const filter = process.argv[planOnly ? 3 : 2];
const files = readdirSync(unit)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !filter || name.includes(filter))
  .sort()
  .map((name) => join(unit, name));
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}
// removed: the Windows claim-race serial batch is kept as an empty list (plan-orca-openbot §3).
const SERIAL = new Set([]);
const serial = (file) => SERIAL.has(file.split(/[\\/]/).pop());
const batches = [['parallel', files.filter((f) => !serial(f))], ['serial', files.filter(serial)]].filter(([, batch]) => batch.length > 0);
if (planOnly) {
  process.stdout.write(JSON.stringify(batches.map(([, batch]) => batch)) + '\n');
  process.exit(0);
}
// Tests must not inherit the host pane's identity or config: drop ORCA_* and the legacy
// OPENBOT_HERDR_* variables (they would override OPENBOT_ORCA_* through the fallback).
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:ORCA_|OPENBOT_HERDR_|HERDR_)/.test(name)));
// Sandbox every home/state root before any code loads, so code that ignores
// OPENBOT_ORCA_STATE_DIR still never writes to the real profile.
const sandbox = mkdtempSync(join(tmpdir(), 'hgb-test-'));
Object.assign(env, { OPENBOT_ORCA_TEST_SANDBOX: sandbox,
  HOME: join(sandbox, 'home'), XDG_STATE_HOME: join(sandbox, 'state'), XDG_CONFIG_HOME: join(sandbox, 'config'),
  OPENBOT_ORCA_STATE_DIR: join(sandbox, 'openbot-state') });
// A leaked handle or a wait that never resolves ends as a named failure, not a silent hang.
const perTestTimeoutMs = Number(process.env.OPENBOT_ORCA_TEST_TIMEOUT_MS) || 120000;
// Every batch runs even after a failure, so one run reports all failures; any
// failing batch makes the run exit non-zero and is named in the summary.
const summary = [];
for (const [name, batch] of batches) {
  const result = spawnSync(process.execPath, ['--test', `--test-timeout=${perTestTimeoutMs}`, ...batch], { stdio: 'inherit', env });
  summary.push({ name, files: batch.length, status: result.status ?? 1 });
}
rmSync(sandbox, { recursive: true, force: true });
for (const b of summary) console.log(`# batch ${b.name}: ${b.files} file(s) exit ${b.status}`);
const failed = summary.filter((b) => b.status !== 0);
for (const b of failed) console.log(`# FAILED batch: ${b.name}`);
process.exit(failed.length ? failed[0].status : 0);

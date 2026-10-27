#!/usr/bin/env node
/**
 * Every end-to-end run: tools/e2e.mjs and each suite in tools/e2e/suites/, a few at a time (each is a process with
 * its own engine, repositories and page). Prints each run's output as it finishes; exits 1 when any failed.
 *
 *   node tools/e2e/run-all.mjs [regex]     only the suites whose file names match (the main run is "main")
 *   E2E_JOBS=3                             how many run side by side
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pick = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const runs = [
  { name: 'main', file: path.join(here, '..', 'e2e.mjs') },
  ...readdirSync(path.join(here, 'suites'))
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => ({ name: f.replace(/\.mjs$/, ''), file: path.join(here, 'suites', f) })),
].filter((r) => !pick || pick.test(r.name));
const jobs = Math.max(1, Number(process.env.E2E_JOBS ?? 3));

const failed = [];
let next = 0;
async function worker() {
  while (next < runs.length) {
    const r = runs[next++];
    const t0 = Date.now();
    const out = await new Promise((resolve) => {
      let buf = '';
      const child = spawn(process.execPath, [r.file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      child.stdout.on('data', (b) => (buf += b));
      child.stderr.on('data', (b) => (buf += b));
      child.on('close', (code) => resolve({ code, buf }));
    });
    console.log(`\n=== ${r.name} (${Math.round((Date.now() - t0) / 1000)} s) ===\n${out.buf.trimEnd()}`);
    if (out.code !== 0) failed.push(r.name);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, runs.length) }, worker));
if (failed.length) {
  console.log(`\nfailed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${runs.length} e2e runs passed`);

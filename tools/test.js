#!/usr/bin/env node
/**
 * tools/test.js — runs the behavioural harnesses.
 *
 * WHY THESE EXIST
 *   The backend is Google Apps Script and only truly runs inside Google. The
 *   real behavioural suite is backend/Tests.gs, which needs a live Spreadsheet
 *   and Drive, so it cannot run on a laptop or in CI.
 *
 *   These harnesses fill that gap. Each loads the real .gs or frontend files
 *   into a Node vm with in-memory fakes for SpreadsheetApp, DriveApp,
 *   CacheService, PropertiesService and LockService (or a fake DOM for the
 *   frontend), and exercises real behaviour: purse arithmetic, lock ordering,
 *   duplicate detection, XSS escaping, paging maths.
 *
 *   They were written alongside the code they test and preserved here because
 *   they are the only way to catch a regression without deploying.
 *
 * WHAT THEY ARE NOT
 *   Not a substitute for backend/Tests.gs against a TEST sheet, and not a
 *   substitute for the real concurrency test against a deployed URL
 *   (KNOWN-ISSUES.md item 8). The fakes are faithful about the things that have
 *   bitten us — signed bytes, Date coercion, lock semantics — but they are still
 *   fakes.
 *
 * USAGE
 *   node tools/test.js              run everything
 *   node tools/test.js auction      run harnesses matching "auction"
 *   npm run test:behaviour
 *
 * Exit code is non-zero if any harness fails.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = path.join(__dirname, 'harness');

// Every harness resolves the .gs files relative to the process cwd, so they all
// run from backend/. The frontend ones reach up to ../frontend from there.
const CWD = path.join(ROOT, 'backend');

const filter = process.argv[2] || '';

function collect(dir, group) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filter || (group + '/' + f).includes(filter))
    .sort()
    .map((f) => ({ group, name: f.replace('.test.js', ''), file: path.join(dir, f) }));
}

const suites = [
  ...collect(path.join(HARNESS, 'backend'), 'backend'),
  ...collect(path.join(HARNESS, 'frontend'), 'frontend')
];

if (!suites.length) {
  console.log(filter ? `No harness matches "${filter}".` : 'No harnesses found.');
  process.exit(1);
}

console.log(`Behavioural harnesses (${suites.length})\n`);

let failed = 0;
let totalPassed = 0;
const results = [];

for (const s of suites) {
  const label = (s.group + '/' + s.name).padEnd(28);
  let out = '';
  let ok = true;
  const started = Date.now();
  try {
    out = execFileSync(process.execPath, [s.file], {
      cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
    });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const ms = Date.now() - started;

  // Harnesses were written by different agents and report in their own words.
  // Rather than force a format on files that already work, read every shape.
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/i)
         || out.match(/(\d+)\s*\/\s*(\d+)\s+passed/i)
         || out.match(/(\d+)\s*\/\s*(\d+)\s+assertions?/i);
  let summary;
  if (m && /passed,\s*\d+\s+failed/i.test(m[0])) {
    const passed = Number(m[1]); const fails = Number(m[2]);
    if (fails > 0) ok = false;
    totalPassed += passed;
    summary = `${passed} passed, ${fails} failed`;
  } else if (m && /\/\s*\d+\s+passed/i.test(m[0])) {
    // "63/63 passed" — anything short of the total is a failure.
    const passed = Number(m[1]); const total = Number(m[2]);
    if (passed < total) ok = false;
    totalPassed += passed;
    summary = `${passed}/${total} passed`;
  } else if (/ALL .*PASSED|all pass/i.test(out)) {
    const n = out.match(/ALL (\d+)/i);
    if (n) totalPassed += Number(n[1]);
    summary = n ? `${n[1]} scenarios passed` : 'passed';
  } else if (m) {
    totalPassed += Number(m[1]);
    summary = `${m[1]}/${m[2]} assertions`;
  } else {
    summary = ok ? 'completed (no summary line)' : 'FAILED';
  }

  if (!ok) failed++;
  results.push({ s, ok, out, summary });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${summary}  (${ms}ms)`);
}

// Only dump output for failures — a green run should stay readable.
for (const r of results) {
  if (r.ok) continue;
  console.log(`\n${'='.repeat(60)}\n${r.s.group}/${r.s.name}\n${'='.repeat(60)}`);
  console.log(r.out.split('\n').slice(-40).join('\n'));
}

console.log('\n' + '-'.repeat(60));
if (failed) {
  console.log(`${suites.length - failed}/${suites.length} harnesses passed, ${failed} FAILED`);
  process.exit(1);
}
console.log(`${suites.length}/${suites.length} harnesses passed, ~${totalPassed} assertions`);
console.log('\nStill required before the tournament:');
console.log('  1. backend/Tests.gs from the Apps Script editor, against a TEST sheet');
console.log('  2. the real concurrency test against a deployed URL (KNOWN-ISSUES.md item 8)');

#!/usr/bin/env node
// Collects every *.test.js under hooks/ and test/ and runs them with the
// built-in node test runner. Also runs any standalone self-contained test
// runner (a script that isn't written against node:test but exits non-zero
// on failure) listed in STANDALONE_RUNNERS below. Exits 0 with a message
// when nothing is found yet (e.g. on a fresh main before the first guard PR
// lands), so CI does not fail on an empty tree.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Test files that don't use node:test — each is its own in-process runner
// that prints a pass/fail summary and exits non-zero on any failure. Listed
// explicitly (not auto-discovered) so a new standalone runner is a
// deliberate addition here, not something the glob below picks up by
// accident.
const STANDALONE_RUNNERS = ['hooks/test-bash-classifier-bait-guard.js'];

function findTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(dir, f));
}

const root = path.join(__dirname, '..');
const files = [
  ...findTestFiles(path.join(root, 'hooks')),
  ...findTestFiles(path.join(root, 'test')),
];
const standaloneFiles = STANDALONE_RUNNERS.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));

if (files.length === 0 && standaloneFiles.length === 0) {
  console.log('run-tests: no test files found yet; nothing to run.');
  process.exit(0);
}

if (files.length > 0) {
  console.log(`run-tests: running ${files.length} node:test file(s).`);
  execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
}

for (const f of standaloneFiles) {
  console.log(`run-tests: running standalone runner ${path.relative(root, f)}.`);
  execFileSync(process.execPath, [f], { stdio: 'inherit' });
}

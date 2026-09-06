#!/usr/bin/env node
// Collects every *.test.js under hooks/ and test/ and runs them with the
// built-in node test runner. Exits 0 with a message when no test files
// exist yet (e.g. on a fresh main before the first guard PR lands), so CI
// does not fail on an empty tree.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

if (files.length === 0) {
  console.log('run-tests: no *.test.js files found yet; nothing to run.');
  process.exit(0);
}

console.log(`run-tests: running ${files.length} test file(s).`);
execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });

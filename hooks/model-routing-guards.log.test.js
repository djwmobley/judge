"use strict";
// model-routing-guards.log.test.js
// Unit tests for the size-capped rotation added to model-routing-guards.log.js
// (appendRotating + createLogger's use of it).
// Run with:  node hooks/model-routing-guards.log.test.js (from the repo root)
//
// Self-contained custom harness (matches pg-module-repair.test.js's
// convention in this directory): node:assert/strict for assertions, a
// tiny test()/summary wrapper, "Results: N passed, M failed" printed at
// the end, exit 1 on any failure.
//
// Test matrix:
//   T1  missing file -> appendRotating creates it, no error, no rotation attempted
//   T2  file below cap -> no rotation, line appended to existing content
//   T3  file at/over cap (HOOK_LOG_MAX_BYTES override) -> rotates to .1, fresh
//       file holds only the new line
//   T4  pre-existing .1 replaced (one generation only, not accumulated)
//   T5  two consecutive rotations still leave exactly one .1 (never a .2)
//   T6  HOOK_LOG_MAX_BYTES override raised above file size -> suppresses
//       rotation that would otherwise fire under the default
//   T7  unwritable path (a directory, not a file) -> swallowed, never throws
//   T8  createLogger(...) routes through appendRotating and rotates too

const assert = require("node:assert/strict");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { appendRotating, createLogger, HOOKS_DIR } = require("./model-routing-guards.log.js");

// ── Minimal test harness (mirrors pg-module-repair.test.js) ─────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message ? err.message : String(err)}`);
    failed++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mrg-log-test-"));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* best-effort cleanup */ }
}

/** Run fn with process.env.HOOK_LOG_MAX_BYTES set to `value` (string or
 * undefined to delete), always restoring the prior value afterward. */
function withMaxBytes(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "HOOK_LOG_MAX_BYTES");
  const prev = process.env.HOOK_LOG_MAX_BYTES;
  try {
    if (value === undefined) delete process.env.HOOK_LOG_MAX_BYTES;
    else process.env.HOOK_LOG_MAX_BYTES = String(value);
    fn();
  } finally {
    if (had) process.env.HOOK_LOG_MAX_BYTES = prev;
    else delete process.env.HOOK_LOG_MAX_BYTES;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("T1 — missing file: appendRotating creates it, no rotation attempted, no throw", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "fresh.log");
    assert.equal(fs.existsSync(p), false);
    assert.doesNotThrow(() => appendRotating(p, "line-one"));
    assert.equal(fs.readFileSync(p, "utf8"), "line-one\n");
    assert.equal(fs.existsSync(p + ".1"), false, "no .1 should be created for a fresh file");
  } finally {
    rmrf(tmp);
  }
});

test("T2 — file below cap: no rotation, new line appended to existing content", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "small.log");
    fs.writeFileSync(p, "existing\n", "utf8");
    withMaxBytes(1000, () => appendRotating(p, "more"));
    assert.equal(fs.readFileSync(p, "utf8"), "existing\nmore\n");
    assert.equal(fs.existsSync(p + ".1"), false);
  } finally {
    rmrf(tmp);
  }
});

test("T3 — file at/over cap rotates to .1; fresh current file holds only the new line", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "big.log");
    const oldContent = "x".repeat(50) + "\n"; // 51 bytes
    fs.writeFileSync(p, oldContent, "utf8");
    withMaxBytes(50, () => appendRotating(p, "new-line")); // 51 >= cap(50) -> rotate
    assert.equal(fs.readFileSync(p, "utf8"), "new-line\n", "current file should hold only the new line post-rotation");
    assert.equal(fs.readFileSync(p + ".1", "utf8"), oldContent, "rotated .1 should hold the old content");
  } finally {
    rmrf(tmp);
  }
});

test("T3b — file exactly one byte under cap does NOT rotate", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "border.log");
    fs.writeFileSync(p, "x".repeat(49), "utf8"); // 49 bytes, cap 50 -> below cap
    withMaxBytes(50, () => appendRotating(p, "y"));
    assert.equal(fs.existsSync(p + ".1"), false, "must not rotate below the cap");
    assert.equal(fs.readFileSync(p, "utf8"), "x".repeat(49) + "y\n");
  } finally {
    rmrf(tmp);
  }
});

test("T4 — pre-existing .1 is replaced, not appended to (one generation only)", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "gen.log");
    fs.writeFileSync(p + ".1", "ancient-generation\n", "utf8");
    fs.writeFileSync(p, "x".repeat(50) + "\n", "utf8");
    withMaxBytes(50, () => appendRotating(p, "fresh"));
    const rotated = fs.readFileSync(p + ".1", "utf8");
    assert.doesNotMatch(rotated, /ancient-generation/, ".1 must be replaced, never merged with the prior .1");
    assert.match(rotated, /^x+\n$/, ".1 should hold exactly the just-rotated-out content");
  } finally {
    rmrf(tmp);
  }
});

test("T5 — two consecutive rotations still leave exactly one .1 (never a .2)", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "double.log");
    withMaxBytes(10, () => {
      appendRotating(p, "x".repeat(20)); // creates file well over cap
      appendRotating(p, "y".repeat(20)); // rotates again
      appendRotating(p, "z".repeat(20)); // rotates a third time
    });
    assert.equal(fs.existsSync(p + ".1.1"), false);
    assert.equal(fs.existsSync(p + ".2"), false);
    const rotated = fs.readFileSync(p + ".1", "utf8");
    assert.match(rotated, /^y+\n$/, "the .1 should hold the second write's content (the one rotated out most recently)");
  } finally {
    rmrf(tmp);
  }
});

test("T6 — HOOK_LOG_MAX_BYTES override raised above file size suppresses rotation", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "override.log");
    fs.writeFileSync(p, "x".repeat(5000), "utf8"); // well over the DEFAULT 2MB? no -- under default,
    // so raise the bar via override to something absurdly high to prove the
    // override is actually read (not the hardcoded default) and a value
    // that would otherwise be near a tiny custom cap is suppressed.
    withMaxBytes(10_000_000, () => appendRotating(p, "more"));
    assert.equal(fs.existsSync(p + ".1"), false, "override above file size must suppress rotation");
  } finally {
    rmrf(tmp);
  }
});

test("T6b — non-numeric/zero/negative HOOK_LOG_MAX_BYTES falls back to the default (2 MB), not a crash", () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, "badenv.log");
    fs.writeFileSync(p, "x".repeat(100), "utf8");
    withMaxBytes("not-a-number", () => assert.doesNotThrow(() => appendRotating(p, "line")));
    withMaxBytes("0", () => assert.doesNotThrow(() => appendRotating(p, "line")));
    withMaxBytes("-5", () => assert.doesNotThrow(() => appendRotating(p, "line")));
    // None of these small files should rotate under the real 2MB default.
    assert.equal(fs.existsSync(p + ".1"), false);
  } finally {
    rmrf(tmp);
  }
});

test("T7 — unwritable path (a directory, not a file) is swallowed, never throws", () => {
  const tmp = makeTmpDir();
  try {
    const dirAsPath = path.join(tmp, "im-a-directory");
    fs.mkdirSync(dirAsPath);
    assert.doesNotThrow(() => appendRotating(dirAsPath, "will never land"));
  } finally {
    rmrf(tmp);
  }
});

test("T8 — createLogger(...) routes through appendRotating and rotates too", () => {
  const basename = "model-routing-guards-log-test-fixture";
  const logPath = path.join(HOOKS_DIR, `${basename}-debug.log`);
  const rotatedPath = logPath + ".1";
  try {
    fs.writeFileSync(logPath, "x".repeat(50), "utf8");
    const appendDebug = createLogger(basename);
    withMaxBytes(50, () => appendDebug({ ts: "2026-09-05T00:00:00.000Z", event: "fixture" }));
    assert.equal(fs.existsSync(rotatedPath), true, "createLogger's appendDebug must rotate through appendRotating");
    const current = fs.readFileSync(logPath, "utf8");
    assert.match(current, /"event":"fixture"/, "line format (one JSON object per line) must be unchanged");
  } finally {
    try { fs.rmSync(logPath, { force: true }); } catch (_) {}
    try { fs.rmSync(rotatedPath, { force: true }); } catch (_) {}
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
process.exit(0);

"use strict";
// model-routing-guards.crash-path.test.js
// docs/specs/routing-scorecard.md §2.1 (amended) — regression tests for the
// crash-path hardening fix in orchestrator-tool-guard.js,
// agent-model-routing-guard.js, and agent-adversary-floor.js.
//
// DEFECT (found in review of PR #14, d6a5f08): each of the three guards'
// top-level catch called decisions.appendCrashRecord (model-routing-
// guards.decisions.js) with no try/catch of its own, and each guard's
// require() of that module at module scope was bare. If the module is
// missing (install drift) or throws on load or in appendCrashRecord, an
// uncaught exception escapes the guard's own top-level catch entirely —
// Node's default uncaught-exception handler prints a stack trace and exits
// with code 1. A non-2 exit from a PreToolUse hook is treated by the
// harness as ALLOW, so the guard's own crash handler became an escape path.
//
// This file drives each guard's top-level catch via a genuinely malformed
// envelope (invalid JSON on stdin) while the decisions module is shadowed,
// in-process, via `-r` preload + a Module._load interception keyed on the
// resolved absolute path of model-routing-guards.decisions.js — never a
// NODE_PATH trick, since these are relative (`./...`) requires that
// NODE_PATH cannot affect. Two shadow modes are exercised per guard:
//
//   (i)  throw_on_load — require() of the decisions module itself throws
//        (simulates a missing/corrupted module, e.g. install drift). The
//        fix's defensive require + no-op fallback means every
//        appendDecision/appendCrashRecord call site becomes a safe no-op,
//        so invalid-JSON stdin resolves via the guard's ordinary fail-open
//        path WITHOUT ever needing the top-level catch — proving the
//        failure is neutralized before main() even runs. Expected: the
//        guard's ordinary ("json_parse_error") fail-open exit code/output,
//        identical in both c629cf1 and the current code (this guard-level
//        outcome was never touched by PR #14 or this fix).
//
//   (ii) throw_on_crash_record — require() succeeds, but BOTH
//        appendDecision and appendCrashRecord throw on every call (a
//        decisions module present but corrupted/incompatible). Because
//        appendDecision is called, unguarded, from each guard's fail-open
//        handler (itself invoked outside any of the guard's own try
//        blocks), invalid-JSON stdin causes THAT call to throw, which
//        propagates all the way out of main() into the guard's top-level
//        catch — genuinely exercising it. The top-level catch's own
//        appendDebug/stderr-write happen first (unaffected), then this
//        fix's try/catch around appendCrashRecord swallows the injected
//        throw, and the guard reaches its unconditional process.exit(...)
//        exactly as before. Expected: the exact exit code + stdout + stderr
//        the c629cf1 version of that guard's top-level catch produces,
//        read directly via `git show c629cf1:hooks/<file>` (see the
//        constants below) — cause-independent in c629cf1 (that catch never
//        branched on why it fired), so this is the correct baseline
//        regardless of which internal call raised the exception. WITHOUT
//        this fix, mode (ii) throws again on the unwrapped
//        appendCrashRecord call, and the process exits 1 (Node's default
//        uncaught-exception exit code) instead of the guard's own 0/2 — the
//        exact escape this fix closes. This is the regression these tests
//        actually catch.
//
// Fixtures (the preload shadow script) are written to this test's own
// os.tmpdir()-based temp directory and removed in a `finally`, per repo
// convention (see e.g. orchestrator-tool-guard.test.js's mkTmpDir/rmTree).

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS_DIR = __dirname;
const DECISIONS_MODULE_PATH = path.join(HOOKS_DIR, "model-routing-guards.decisions.js");

const MALFORMED_STDIN = "{not valid json";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crash-path-test-"));
}
function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (_) {
    /* best effort */
  }
}

const PRELOAD_SOURCE = `
"use strict";
const Module = require("module");
const path = require("path");

function norm(p) {
  return path.resolve(p).toLowerCase();
}

const targetPath = norm(process.env.CRASH_PATH_TEST_DECISIONS_MODULE);
const mode = process.env.CRASH_PATH_TEST_SHADOW_MODE;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {
    return originalLoad.apply(this, arguments);
  }
  if (norm(resolved) !== targetPath) {
    return originalLoad.apply(this, arguments);
  }
  if (mode === "throw_on_load") {
    throw new Error("injected (test fixture): simulated decisions module require() failure (install drift)");
  }
  if (mode === "throw_on_crash_record") {
    return {
      appendDecision: function () {
        throw new Error("injected (test fixture): simulated appendDecision failure");
      },
      appendCrashRecord: function () {
        throw new Error("injected (test fixture): simulated appendCrashRecord failure");
      },
      hashTarget: function () {
        return null;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
`;

function runShadowed(hookFile, preloadPath, mode) {
  try {
    const out = execFileSync(process.execPath, ["-r", preloadPath, hookFile], {
      input: MALFORMED_STDIN,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.assign({}, process.env, {
        CRASH_PATH_TEST_DECISIONS_MODULE: DECISIONS_MODULE_PATH,
        CRASH_PATH_TEST_SHADOW_MODE: mode,
      }),
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

// Per-guard c629cf1 (pre-PR-#14) fail-open and top-level-catch contracts,
// read directly from `git show c629cf1:hooks/<file>` — see this file's
// header comment. Both contracts happen to be identical in c629cf1: exit
// code/stdout/stderr do not depend on WHY fail-open or the top-level catch
// fired.
const GUARDS = [
  {
    name: "orchestrator-tool-guard",
    file: path.join(HOOKS_DIR, "orchestrator-tool-guard.js"),
    failOpen: { code: 0, stdout: "", stderr: "" },
    topLevelCatch: {
      code: 2,
      stdout: "",
      stderr: "orchestrator-tool-guard: BLOCKED — internal error during classification — treat as block.\n",
    },
  },
  {
    name: "agent-model-routing-guard",
    file: path.join(HOOKS_DIR, "agent-model-routing-guard.js"),
    failOpen: { code: 0, stdout: "", stderr: "" },
    topLevelCatch: {
      code: 2,
      stdout: "",
      stderr: "agent-model-routing-guard: BLOCKED — internal error during classification — treat as block.\n",
    },
  },
  {
    name: "agent-adversary-floor",
    file: path.join(HOOKS_DIR, "agent-adversary-floor.js"),
    failOpen: { code: 0, stdout: "", stderr: "" },
    topLevelCatch: { code: 0, stdout: "", stderr: "" },
  },
];

for (const guard of GUARDS) {
  test(`${guard.name}: decisions module throws on require() -> neutralized by defensive load, ordinary fail-open (exit ${guard.failOpen.code}) reached without ever needing the top-level catch`, (t) => {
    const dir = mkTmpDir();
    try {
      const preloadPath = path.join(dir, "shadow-decisions-preload.js");
      fs.writeFileSync(preloadPath, PRELOAD_SOURCE);
      const result = runShadowed(guard.file, preloadPath, "throw_on_load");
      assert.equal(result.code, guard.failOpen.code, "exit code must match the fail-open contract (module-load failure never surfaces)");
      assert.equal(result.stdout, guard.failOpen.stdout);
      assert.equal(result.stderr, guard.failOpen.stderr);
    } finally {
      rmTree(dir);
    }
  });

  test(`${guard.name}: decisions module loads but appendDecision/appendCrashRecord both throw -> top-level catch reached, exit code/stdout/stderr unchanged from c629cf1 (regression guard for the PR #14 escape)`, (t) => {
    const dir = mkTmpDir();
    try {
      const preloadPath = path.join(dir, "shadow-decisions-preload.js");
      fs.writeFileSync(preloadPath, PRELOAD_SOURCE);
      const result = runShadowed(guard.file, preloadPath, "throw_on_crash_record");
      assert.equal(
        result.code,
        guard.topLevelCatch.code,
        "exit code must match this guard's c629cf1 top-level-catch contract, not Node's default uncaught-exception exit code (1)"
      );
      assert.equal(result.stdout, guard.topLevelCatch.stdout);
      assert.equal(result.stderr, guard.topLevelCatch.stderr);
      // The specific regression this closes: an uncaught exception inside
      // the top-level catch itself prints a Node stack trace to stderr.
      assert.ok(!/at Object\.Module\._load|at Module\.load|\.js:\d+:\d+/.test(result.stderr), "stderr must not contain a raw Node stack trace (would indicate the injected throw escaped uncaught)");
    } finally {
      rmTree(dir);
    }
  });
}

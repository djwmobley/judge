"use strict";
// hook-state-write-guard.test.js
// Tests for the hook-state-write-guard PreToolUse hook
// (docs/specs/hook-state-write-guard.md §2.2 / §4 test outline).
// Run with: node hooks/hook-state-write-guard.test.js (from the repo root)
//
// Style matches shell-write-guard.test.js: node:test + node:assert, named
// tests, a "Results: N passed, M failed" summary line, exit 1 on failure.
// Most tests call the exported `classify()` directly (pure function, no fs
// I/O); a small subprocess round-trip set confirms exit codes / stderr
// content for the standalone hook-mode entrypoint.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOK_PATH = path.join(__dirname, "hook-state-write-guard.js");
const { classify, isProtectedStatePath, STATE_DIR_NORMALIZED } = require(HOOK_PATH);
const { STATE_DIR } = require(path.join(__dirname, "model-routing-guards.state.js"));

const HOOKS_DIR = path.dirname(STATE_DIR); // ".../judge/hooks"

let __passed = 0,
  __failed = 0;
function t(name, fn) {
  test(name, async () => {
    try {
      await fn();
      __passed++;
    } catch (e) {
      __failed++;
      throw e;
    }
  });
}
process.on("exit", () => {
  console.log(`Results: ${__passed} passed, ${__failed} failed`);
  if (__failed > 0) process.exitCode = 1;
});

function runHook(payload) {
  let exitCode = 0,
    stderr = "";
  try {
    execFileSync("node", [HOOK_PATH], { input: JSON.stringify(payload), encoding: "utf8", timeout: 10000 });
  } catch (err) {
    exitCode = err.status != null ? err.status : 1;
    stderr = err.stderr ? String(err.stderr) : "";
  }
  return { exitCode, stderr };
}

// ── classify() unit tests — spec §2.2 total classification, branches 1-5 ──

t("write_inside_state_dir_denied", () => {
  const r = classify("Write", { file_path: path.join(STATE_DIR, "stop-stale-worktrees-guard.abc.json") }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("write_inside_state_dir_backslash_denied", () => {
  const target = STATE_DIR + "\\x.json"; // Windows-style separator (native on this platform anyway).
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("write_state_dir_dotdot_traversal_denied", () => {
  const target = path.join(STATE_DIR, "..", "state", "x.json");
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("write_state_dir_case_variant_denied", () => {
  const mixedCaseDir = STATE_DIR.replace(/state$/i, "STATE");
  const r = classify("Write", { file_path: path.join(mixedCaseDir, "x.json") }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
});

t("write_relative_path_into_state_dir_denied", () => {
  const r = classify("Edit", { file_path: "state/x.json" }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("notebookedit_notebook_path_inside_state_dir_denied", () => {
  const r = classify("NotebookEdit", { notebook_path: path.join(STATE_DIR, "x.ipynb") }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
});

t("multiedit_inside_state_dir_denied", () => {
  const r = classify("MultiEdit", { file_path: path.join(STATE_DIR, "x.json") }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
});

t("write_sibling_dir_name_prefix_allowed", () => {
  const target = path.join(HOOKS_DIR, "state-backup", "x.json");
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "allow", JSON.stringify(r));
});

t("write_outside_state_dir_allowed", () => {
  const r = classify("Write", { file_path: path.join(HOOKS_DIR, "README.md") }, HOOKS_DIR);
  assert.equal(r.decision, "allow", JSON.stringify(r));
  assert.equal(r.branch, 2);
});

t("write_missing_file_path_param_denied", () => {
  const r = classify("Write", {}, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 4);
});

t("write_empty_file_path_denied", () => {
  const r = classify("Write", { file_path: "" }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 4);
});

// ── A2: relative path + missing/empty cwd -> deny (branch 5) ──────────────

t("write_relative_path_missing_cwd_denied", () => {
  const r = classify("Write", { file_path: "state/x.json" }, null);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("write_relative_path_empty_cwd_denied", () => {
  const r = classify("Write", { file_path: "state/x.json" }, "");
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("write_relative_path_undefined_cwd_denied", () => {
  const r = classify("Write", { file_path: "state/x.json" }, undefined);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 5);
});

// ── A1: extended-length/device UNC prefix stripping ────────────────────────

t("write_extended_length_unc_prefix_into_state_dir_denied", () => {
  const target = "\\\\?\\" + STATE_DIR + "\\x.json";
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("write_device_namespace_prefix_into_state_dir_denied", () => {
  const target = "\\\\.\\" + STATE_DIR + "\\x.json";
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

// ── A1: segment-bounded /hooks/state/ over-block rule ──────────────────────

t("write_other_project_hooks_state_segment_denied", () => {
  // Resolves OUTSIDE this repo's own STATE_DIR entirely, but the
  // segment-bounded /hooks/state/ rule fires anyway — deliberate
  // over-block (spec §2.2 rule 2).
  const target = path.join(os.tmpdir(), "some-other-checkout", "hooks", "state", "x.json");
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("write_hooks_statement_sibling_allowed", () => {
  // "statement" starts with "state" lexically but is not the "state"
  // segment — segment-bounded match must not fire here.
  const target = path.join(HOOKS_DIR, "statement", "x.json");
  const r = classify("Write", { file_path: target }, HOOKS_DIR);
  assert.equal(r.decision, "allow", JSON.stringify(r));
});

t("read_tool_never_matched", () => {
  const r = classify("Read", { file_path: path.join(STATE_DIR, "x.json") }, HOOKS_DIR);
  assert.equal(r.decision, "allow", JSON.stringify(r));
  assert.equal(r.branch, 1);
});

// ── isProtectedStatePath: direct predicate sanity ──────────────────────────

t("isProtectedStatePath: STATE_DIR itself is protected", () => {
  assert.equal(isProtectedStatePath(STATE_DIR_NORMALIZED), true);
});

t("isProtectedStatePath: unrelated path is not protected", () => {
  assert.equal(isProtectedStatePath(path.join(HOOKS_DIR, "shell-write-guard.js").toLowerCase().replace(/\\/g, "/")), false);
});

// ── Subprocess round-trip: exit codes / stderr for the standalone hook ────

t("subprocess: write inside STATE_DIR -> exit 2, message names the protected directory", () => {
  const { exitCode, stderr } = runHook({
    tool_name: "Write",
    tool_input: { file_path: path.join(STATE_DIR, "forged.json") },
    cwd: HOOKS_DIR,
  });
  assert.equal(exitCode, 2);
  assert.match(stderr, /protected state/i);
});

t("subprocess: write outside STATE_DIR -> exit 0", () => {
  const { exitCode } = runHook({
    tool_name: "Write",
    tool_input: { file_path: path.join(HOOKS_DIR, "README.md") },
    cwd: HOOKS_DIR,
  });
  assert.equal(exitCode, 0);
});

t("subprocess: NotebookEdit notebook_path inside STATE_DIR -> exit 2", () => {
  const { exitCode } = runHook({
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: path.join(STATE_DIR, "x.ipynb") },
    cwd: HOOKS_DIR,
  });
  assert.equal(exitCode, 2);
});

t("subprocess: Read tool (not matched by this hook at all) -> exit 0", () => {
  const { exitCode } = runHook({
    tool_name: "Read",
    tool_input: { file_path: path.join(STATE_DIR, "x.json") },
    cwd: HOOKS_DIR,
  });
  assert.equal(exitCode, 0);
});

t("subprocess: missing tool_input entirely -> exit 2 (branch 4, friction default)", () => {
  const { exitCode } = runHook({ tool_name: "Write", cwd: HOOKS_DIR });
  assert.equal(exitCode, 2);
});

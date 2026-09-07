"use strict";
// hook-state-write-guard.js
// PreToolUse hook — denies Write/Edit/NotebookEdit/MultiEdit writes whose
// target resolves inside the guard framework's own STATE_DIR (spec
// docs/specs/hook-state-write-guard.md §2.2 — Layer 1). Closes the
// forgeable-state-file gap (docs/specs/stop-guard-bounded-reblock.md §2
// item 3 / §6 / §9 BR-01): an agent with ordinary Write/Edit access can
// otherwise forge the Stop guard's own strike-counter accounting state
// directly, forcing a premature yield.
//
// ── TOTAL CLASSIFICATION (every PreToolUse call this hook's matcher can
//    ever receive lands in exactly one branch) — spec §2.2 ────────────────
//   1. tool_name not one of the four gated tools             -> allow
//   2. path param present, resolves outside STATE_DIR and
//      does not match the /hooks/state/-segment rule below   -> allow
//   3. path param present, resolves inside STATE_DIR OR
//      matches the /hooks/state/-segment over-block rule     -> DENY
//   4. path param missing/non-string/empty-after-trim/
//      resolution throws (malformed absolute/relative shape) -> DENY
//   5. path param present, relative (not path.isAbsolute),
//      AND stdin cwd missing/not a string/empty after trim   -> DENY
// A write we cannot positively classify as outside STATE_DIR is DENIED,
// never silently allowed — friction over escape, the opposite default
// from most of this repo's fail-open guards, deliberate here because
// there is no legitimate reason for an agent's own tool call to write
// inside the guard's own accounting state. No override exists for this
// hook, by design (spec §2.2).
//
// ── Containment check (spec §2.2, rules 1 and 2) ────────────────────────
// After normalizeForCompare (path.resolve -> backslash->forward slash ->
// full lowercase; MSYS /c/... rewrite) runs, a leading extended-length/
// device UNC prefix (`//?/` or `//./`, the post-rewrite shape of `\\?\`
// and `\\.\`) is stripped, and any residual repeated `/` or `/./`
// segments are collapsed. DENY if EITHER:
//   1. the resulting string === normalized STATE_DIR, or starts with
//      normalized STATE_DIR + "/"; OR
//   2. the resulting string contains the segment-bounded sequence
//      "/hooks/state/" anywhere, or ends with "/hooks/state" — this is
//      deliberately broader than rule 1: it over-blocks any other
//      project's own hooks/state directory and any UNC spelling that
//      doesn't fully canonicalize to STATE_DIR's own drive-letter form.
//      Friction over escape.
//
// Reuse provenance: normalizeForCompare is required directly from
// worktree-isolation-guard.js (exported) — the same normalization engine
// shell-write-guard.js's own PROTECTED_PATH rule reuses. STATE_DIR is
// required directly from model-routing-guards.state.js (exported) —
// single source of truth, tracks whichever copy is actually running (a
// repo checkout's own hooks/state vs an installed ~/.claude/hooks/state
// tree).
//
// ── Declared blind spots (see docs/specs/hook-state-write-guard.md §6) ──
//   - A junction/symlink/reparse point in an allowed directory whose
//     target resolves into STATE_DIR: normalizeForCompare is lexical only
//     (path.resolve + string rewriting), it never calls fs.realpathSync,
//     so a write through such a reparse point is not detected here.
//   - Writes via any tool this hook's matcher doesn't cover (an MCP
//     filesystem server, etc.) are invisible to this hook entirely.

const fs = require("fs");
const path = require("path");
const { STATE_DIR } = require("./model-routing-guards.state.js");
const { normalizeForCompare } = require("./worktree-isolation-guard.js");

const PATH_PARAM_BY_TOOL = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

const GATED_TOOLS = new Set(Object.keys(PATH_PARAM_BY_TOOL));

/**
 * Strip a leading extended-length/device UNC prefix (`//?/` or `//./`) —
 * normalizeForCompare's own backslash->forward-slash rewrite already turns
 * `\\?\` and `\\.\` into this shape. Defensive string normalization, not a
 * parser (spec §2.2/A1).
 */
function stripExtendedPrefix(normalized) {
  return normalized.replace(/^\/\/[?.]\//, "/");
}

/**
 * Collapse repeated `/` and `/./` segments. `path.resolve` already
 * collapses these before `normalizeForCompare` runs, but the
 * extended-prefix strip above can introduce a fresh leading `//`; this is
 * a pure, cheap string operation run defensively regardless.
 */
function collapseSlashes(normalized) {
  return normalized.replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/");
}

function finalizeNormalized(normalized) {
  return collapseSlashes(stripExtendedPrefix(normalized));
}

const STATE_DIR_NORMALIZED = finalizeNormalized(normalizeForCompare(STATE_DIR));

/**
 * True if `normalized` (already run through normalizeForCompare) is
 * contained in STATE_DIR, OR matches the segment-bounded `/hooks/state/`
 * over-block rule (spec §2.2 containment check, rules 1 and 2 above).
 */
function isProtectedStatePath(normalized) {
  if (!normalized) return false;
  const n = finalizeNormalized(normalized);
  if (n === STATE_DIR_NORMALIZED || n.startsWith(STATE_DIR_NORMALIZED + "/")) return true;
  if (n.includes("/hooks/state/") || n.endsWith("/hooks/state")) return true;
  return false;
}

/**
 * classify(toolName, toolInput, cwd) -> { branch, decision, reason, target }
 * Pure function — the total classification from spec §2.2, branches 1-5.
 * `decision` is "allow" or "deny". `cwd` is the hook's own stdin `cwd`
 * field (a string, or null/undefined/empty when absent).
 */
function classify(toolName, toolInput, cwd) {
  if (!GATED_TOOLS.has(toolName)) {
    return { branch: 1, decision: "allow", reason: "tool-not-gated", target: null };
  }

  const paramName = PATH_PARAM_BY_TOOL[toolName];
  const raw = toolInput ? toolInput[paramName] : undefined;

  if (typeof raw !== "string" || raw.trim() === "") {
    return { branch: 4, decision: "deny", reason: "missing-or-empty-path-param", target: null };
  }

  const isAbs = path.isAbsolute(raw);
  if (!isAbs && (typeof cwd !== "string" || cwd.trim() === "")) {
    return { branch: 5, decision: "deny", reason: "relative-path-missing-cwd", target: raw };
  }

  let abs;
  try {
    abs = isAbs ? raw : path.resolve(cwd, raw);
  } catch (_) {
    return { branch: 4, decision: "deny", reason: "path-resolve-failed", target: raw };
  }

  let normalized;
  try {
    normalized = normalizeForCompare(abs);
  } catch (_) {
    normalized = null;
  }
  if (!normalized) {
    return { branch: 4, decision: "deny", reason: "normalize-failed", target: raw };
  }

  if (isProtectedStatePath(normalized)) {
    return { branch: 3, decision: "deny", reason: "protected-state-dir", target: normalized };
  }

  return { branch: 2, decision: "allow", reason: "outside-state-dir", target: normalized };
}

module.exports = {
  PATH_PARAM_BY_TOOL,
  GATED_TOOLS,
  STATE_DIR_NORMALIZED,
  stripExtendedPrefix,
  collapseSlashes,
  isProtectedStatePath,
  classify,
};

// ── Standalone hook mode ────────────────────────────────────────────────

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    process.exit(0); // Malformed harness-level invocation, not agent-controlled — fail open, matches repo convention.
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const tool_name = parsed.tool_name || "";
  const tool_input = parsed.tool_input || {};
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : null;

  let result;
  try {
    result = classify(tool_name, tool_input, cwd);
  } catch (_) {
    // Internal error classifying a real tool call — friction-over-escape
    // default: deny rather than silently allow a write this hook failed
    // to classify (mirrors branch 4's own rationale, spec §2.2).
    result = { branch: 4, decision: "deny", reason: "internal-error-fail-closed", target: null };
  }

  if (result.decision === "allow") process.exit(0);

  process.stderr.write(
    `hook-state-write-guard: BLOCKED (branch ${result.branch}) — reason: ${result.reason}.\n` +
      (result.target ? `Target: ${result.target}.\n` : "") +
      `This tool call would write inside the guard framework's own protected state ` +
      `directory (${STATE_DIR}) or a directory matching its reserved hooks/state layout.\n` +
      `There is no legitimate reason for an agent's own tool call to write there; no override exists for this hook.\n`
  );
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    process.exit(2); // Top-level failure on a real invocation — deny, not allow (spec §2.2 friction-over-escape).
  }
}

"use strict";
// model-routing-guards.rules.js
// Hook 2's per-tool classification rules (spec §4): Read, Bash/PowerShell
// (ORCHESTRATOR_DIRECT), Write, Edit. Pure functions — no logging side
// effects here; each result carries enough detail (session-fallback-used,
// state-corrupt) for the caller (orchestrator-tool-guard.js) to emit the
// matching debug-log lines itself. Kept separate from the hook entry file
// so both stay under the file-size gate and each rule is independently
// unit-testable.

const { stripNormalize, isBlankAfterStrip } = require("./model-routing-guards.unicode.js");
const paths = require("./model-routing-guards.paths.js");
const state = require("./model-routing-guards.state.js");

const OVERSIZED_THRESHOLD = 100000;
const ORCHESTRATOR_DIRECT_TOKEN = "ORCHESTRATOR_DIRECT ";
const READ_CAP = 2;
const EDIT_CAP = 3;

function isOversized(value) {
  return typeof value === "string" && value.length > OVERSIZED_THRESHOLD;
}

function pathFailureDetail(reason) {
  switch (reason) {
    case "file_path_invalid_shape":
      return "file_path must be a non-empty string.";
    case "realpath_failed":
      return "realpath resolution threw an exception while resolving file_path.";
    case "no_existing_ancestor":
      return "no existing ancestor directory found while resolving file_path.";
    default:
      return "file_path could not be resolved.";
  }
}

// ── Read row (A9 pages bypass closed; A7/A8 session tally) ─────────────────
function evaluateRead(toolInput, sessionIdRaw) {
  const filePathRaw = toolInput.file_path;
  if (isOversized(filePathRaw)) {
    return { allow: false, findings: [{ id: "oversized_field", detail: `file_path exceeds ${OVERSIZED_THRESHOLD} characters.` }] };
  }
  if (typeof filePathRaw !== "string" || isBlankAfterStrip(filePathRaw)) {
    return { allow: false, findings: [{ id: "file_path_invalid_shape", detail: "file_path must be a non-empty string." }] };
  }
  if (Object.prototype.hasOwnProperty.call(toolInput, "pages")) {
    return {
      allow: false,
      findings: [{ id: "pdf_pages_field_present", detail: "a PDF page range is categorically outside ≤ 5 lines scope, regardless of limit." }],
    };
  }
  const limit = toolInput.limit;
  const limitOk = typeof limit === "number" && Number.isFinite(limit) && Number.isInteger(limit) && limit >= 1 && limit <= 5;
  if (!limitOk) {
    return { allow: false, findings: [{ id: "limit_out_of_range", detail: "limit must be an integer in [1,5]; delegate to the mechanical tier for a larger read." }] };
  }

  const resolvedPath = paths.normalizeReadPathForTally(filePathRaw);
  const { key, usedFallback } = state.resolveSessionKey(sessionIdRaw);
  // Ledger design (fixes the TOCTOU race — see model-routing-guards.state.js
  // header): append THIS invocation's own record first, THEN count. The
  // count therefore always includes this call, so the comparison below is
  // "count > cap", not "count >= cap".
  state.appendLedgerRecord(key, "Read", resolvedPath, process.pid);
  const { count, malformed } = state.readLedgerCount(key, "Read", resolvedPath);
  const logNotes = sessionLogNotes(usedFallback, key, "Read", malformed, state.ledgerPathForKey(key));
  const cap = READ_CAP;

  if (count > cap) {
    return {
      allow: false,
      findings: [{
        id: "read_session_cap_exceeded",
        detail: `${count} Reads recorded in the ledger for this file this session (cap ${cap}); delegate to a mechanical-tier subagent instead of further orchestrator Read calls.`,
      }],
      resolvedPath,
      logNotes,
    };
  }
  return { allow: true, findings: [], resolvedPath, tally_reads: count, logNotes };
}

// ── ORCHESTRATOR_DIRECT rule (Bash/PowerShell, shared verbatim) ────────────
function evaluateShellCommand(commandRaw) {
  if (isOversized(commandRaw)) {
    return { allow: false, findings: [{ id: "oversized_field", detail: `command exceeds ${OVERSIZED_THRESHOLD} characters.` }] };
  }
  if (typeof commandRaw !== "string") {
    return { allow: false, findings: [{ id: "command_invalid_shape", detail: "command must be a string." }] };
  }
  const stripped = stripNormalize(commandRaw);
  if (stripped.trim() === "") {
    return { allow: false, findings: [{ id: "command_empty", detail: "command is empty or whitespace-only after normalization." }] };
  }
  if (stripped.startsWith(ORCHESTRATOR_DIRECT_TOKEN)) {
    return { allow: true, findings: [], orchestratorDirect: true };
  }
  return {
    allow: false,
    findings: [{
      id: "orchestrator_shell_blocked",
      detail:
        "orchestrator shell is blocked by Model Routing rule; delegate to a drafting-tier or mechanical-tier subagent, or use the mcp__handoff__* tools for handoff operations; explicit override: prefix with ORCHESTRATOR_DIRECT (logged)",
    }],
  };
}

// ── Write rule (A3/A4/A21) ──────────────────────────────────────────────────
function evaluateWrite(toolInput) {
  const filePathRaw = toolInput.file_path;
  if (isOversized(filePathRaw)) {
    return { allow: false, findings: [{ id: "oversized_field", detail: `file_path exceeds ${OVERSIZED_THRESHOLD} characters.` }] };
  }
  const resolved = paths.resolveFilePathFull(filePathRaw);
  if (!resolved.ok) {
    return { allow: false, findings: [{ id: resolved.reason, detail: pathFailureDetail(resolved.reason) }] };
  }
  if (!paths.isUnderRoot(resolved.realPath, paths.SANDBOX_ROOT)) {
    return {
      allow: false,
      findings: [{ id: "outside_sandbox_root", detail: "Write must resolve (after realpath) inside AppData/Local/Temp — the drafting tier drafts, not the orchestrator directly." }],
    };
  }
  return { allow: true, findings: [], resolvedPath: resolved.realPath };
}

// ── Edit rule (B1 governance path; A5/A6 diff-size; A7/A8 session tally) ───
function evaluateEdit(toolInput, sessionIdRaw) {
  const filePathRaw = toolInput.file_path;
  if (isOversized(filePathRaw)) {
    return { allow: false, findings: [{ id: "oversized_field", detail: `file_path exceeds ${OVERSIZED_THRESHOLD} characters.` }] };
  }
  const resolved = paths.resolveFilePathFull(filePathRaw);
  if (!resolved.ok) {
    return { allow: false, findings: [{ id: resolved.reason, detail: pathFailureDetail(resolved.reason) }] };
  }
  const inGovernance = paths.isUnderRoot(resolved.realPath, paths.GOVERNANCE_ROOT);
  const isMemoryException = paths.MEMORY_EXCEPTION_RE.test(resolved.realPath);
  if (inGovernance && !isMemoryException) {
    return {
      allow: false,
      findings: [{
        id: "governance_path_forbidden",
        detail:
          "Edit is blocked on Claude Code configuration/hook files under .claude — delegate a config change to a drafting-tier subagent, or hand-edit it yourself; memory pointer files under .claude/projects/*/memory/*.md are the one carved-out exception.",
      }],
    };
  }

  if (Object.prototype.hasOwnProperty.call(toolInput, "replace_all")) {
    const replaceAll = toolInput.replace_all;
    if (replaceAll === true) {
      return { allow: false, findings: [{ id: "replace_all_forbidden", detail: "replace_all:true is forbidden — a whole-file rewrite is not a bounded draft." }] };
    }
    if (typeof replaceAll !== "boolean") {
      return { allow: false, findings: [{ id: "replace_all_invalid_shape", detail: "replace_all must be a boolean." }] };
    }
  }

  const newStringRaw = toolInput.new_string;
  if (isOversized(newStringRaw)) {
    return { allow: false, findings: [{ id: "oversized_field", detail: `new_string exceeds ${OVERSIZED_THRESHOLD} characters.` }] };
  }
  if (typeof newStringRaw !== "string") {
    return { allow: false, findings: [{ id: "new_string_invalid_shape", detail: "new_string must be a string." }] };
  }
  if (newStringRaw.length > 160) {
    return { allow: false, findings: [{ id: "new_string_too_long", detail: "new_string must be ≤ 160 characters — delegate a larger diff to a drafting-tier subagent." }] };
  }

  const oldStringRaw = toolInput.old_string;
  if (isOversized(oldStringRaw)) {
    return { allow: false, findings: [{ id: "oversized_field", detail: `old_string exceeds ${OVERSIZED_THRESHOLD} characters.` }] };
  }
  if (typeof oldStringRaw !== "string") {
    return { allow: false, findings: [{ id: "old_string_invalid_shape", detail: "old_string must be a string." }] };
  }
  if (oldStringRaw.length > 160) {
    return { allow: false, findings: [{ id: "old_string_too_long", detail: "old_string must be ≤ 160 characters — delegate a larger diff to a drafting-tier subagent." }] };
  }

  const { key, usedFallback } = state.resolveSessionKey(sessionIdRaw);
  // Ledger design — see the matching comment in evaluateRead above and
  // model-routing-guards.state.js's header for the TOCTOU-race rationale.
  state.appendLedgerRecord(key, "Edit", resolved.realPath, process.pid);
  const { count, malformed } = state.readLedgerCount(key, "Edit", resolved.realPath);
  const logNotes = sessionLogNotes(usedFallback, key, "Edit", malformed, state.ledgerPathForKey(key));
  const cap = EDIT_CAP;

  if (count > cap) {
    return {
      allow: false,
      findings: [{
        id: "edit_session_cap_exceeded",
        detail: `${count} Edits recorded in the ledger for this file this session (cap ${cap}); delegate the remaining changes to a drafting-tier subagent instead of further orchestrator Edit calls.`,
      }],
      resolvedPath: resolved.realPath,
      logNotes,
    };
  }
  return { allow: true, findings: [], resolvedPath: resolved.realPath, tally_edits: count, logNotes };
}

/** Collect the log-only notes (session_id_fallback_used / state_file_absent_or_corrupt)
 * a Read/Edit evaluation produced, for the caller to append. `malformed` is
 * a single boolean — logged ONCE per invocation, never once per bad line
 * (the ledger reader already collapses per-line malformity into one flag). */
function sessionLogNotes(usedFallback, key, toolName, malformed, ledgerPath) {
  const notes = [];
  if (usedFallback) {
    notes.push({ event: "session_id_fallback_used", resolved_key: key, tool_name: toolName });
  }
  if (malformed) {
    notes.push({ event: "state_file_absent_or_corrupt", path: ledgerPath, error: "malformed ledger line(s) skipped" });
  }
  return notes;
}

module.exports = { evaluateRead, evaluateShellCommand, evaluateWrite, evaluateEdit, pathFailureDetail };

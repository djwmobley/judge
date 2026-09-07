"use strict";
// model-routing-guards.decisions.js
// docs/specs/routing-scorecard.md §2 — a shared, append-only decision ledger
// the three PreToolUse model-routing guards (orchestrator-tool-guard.js,
// agent-model-routing-guard.js, agent-adversary-floor.js) append one line to
// at every exit point, purely for reporting. Never consulted for a gating
// decision anywhere in this repo, and never able to change one — see
// "Never changes control flow" below. Sibling module to
// model-routing-guards.state.js/.log.js, reusing both rather than
// reimplementing their primitives (§2.1).
//
// Every fs/state call below is a namespaced property access (`fs.openSync`,
// `state.cleanupOldStateFiles`, never a destructured local) so a test can
// substitute node:test's `t.mock.method()` on the shared `fs` or
// `model-routing-guards.state.js` module objects without this file needing
// an injected-dependency parameter of its own — the same technique this
// repo's other suites use for their own subject modules (see
// hooks/model-routing-guards.decisions.test.js).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const state = require("./model-routing-guards.state.js");
const { STATE_DIR, sanitizeForFilename } = state;
const { isBlankAfterStrip } = require("./model-routing-guards.unicode.js");

const LEDGER_PREFIX = "routing-decisions.";
const LEDGER_SUFFIX = ".jsonl";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// R2: a file touched within the last 60 seconds is never swept — matches
// agent-tier-ledger.js's own SWEEP_MIN_AGE_MS precedent (that file's line
// 72) exactly, rather than inventing a second convention for the same
// guard family.
const SWEEP_MIN_AGE_MS = 60 * 1000;

/** First 8 hex characters of sha256(rawKey) — the filename disambiguator
 * (owner ruling R3) for two distinct raw session ids that sanitizeForFilename
 * happens to collapse to the identical sanitized string. */
function h8(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey)).digest("hex").slice(0, 8);
}

/** <STATE_DIR>/routing-decisions.<sanitized key>.<h8>.jsonl — §2.1.
 * Calls state.resolveSessionKey via property access (not a destructured
 * local) so a test can substitute it with t.mock.method() to isolate a
 * single test's "global fallback" bucket from every other test/process
 * sharing this machine's real global-YYYY-MM-DD file, without this module
 * needing an injected-dependency parameter of its own. */
function ledgerPathForSessionIdRaw(sessionIdRaw, now) {
  const { key } = state.resolveSessionKey(sessionIdRaw, now);
  const sanitized = sanitizeForFilename(key);
  return path.join(STATE_DIR, `${LEDGER_PREFIX}${sanitized}.${h8(key)}${LEDGER_SUFFIX}`);
}

/** 7-day sweep, run before every append (never after) — §2.1's "Sweep"
 * bullet. Delegates to the shared cleanupOldStateFiles, which is itself
 * fail-soft internally; the outer try/catch here is defensive insurance,
 * not load-bearing. */
function sweepStaleDecisions() {
  state.cleanupOldStateFiles(SEVEN_DAYS_MS, LEDGER_PREFIX, LEDGER_SUFFIX, SWEEP_MIN_AGE_MS);
}

/**
 * Build the fixed-allowlist record §2.2 defines, applying every §2.3
 * default explicitly. Reads exactly the allowlisted keys off `record` (or
 * off `{}` when `record` is not a plain object) — this is the redaction
 * mechanism: a call site that accidentally attaches `record.prompt`,
 * `record.message`, or `record.command` never reaches disk, because
 * JSON.stringify is never called on `record` itself, only on this fresh
 * object.
 */
function buildRecord(record, now) {
  const r = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  return {
    v: 1,
    ts: now.toISOString(),
    guard: typeof r.guard === "string" ? r.guard : "unknown",
    guard_version: typeof r.guard_version === "string" ? r.guard_version : null,
    event: typeof r.event === "string" ? r.event : "unknown",
    session_id: typeof r.session_id === "string" ? r.session_id : null,
    agent_id: typeof r.agent_id === "string" ? r.agent_id : null,
    caller: r.caller === "orchestrator" || r.caller === "subagent" || r.caller === "unknown" ? r.caller : "unknown",
    tool_name: typeof r.tool_name === "string" ? r.tool_name : null,
    subagent_type: typeof r.subagent_type === "string" ? r.subagent_type : null,
    tier: typeof r.tier === "string" ? r.tier : null,
    model: typeof r.model === "string" ? r.model : null,
    tool_use_id: typeof r.tool_use_id === "string" ? r.tool_use_id : null,
    target_hash: typeof r.target_hash === "string" ? r.target_hash : null,
    finding_ids: Array.isArray(r.finding_ids) ? r.finding_ids : [],
    via: typeof r.via === "string" ? r.via : null,
    reason: typeof r.reason === "string" ? r.reason : null,
    pid: process.pid,
  };
}

/** A single fs.openSync(path, "a") + one fs.writeSync of the whole
 * serialized line, fs.closeSync in a finally — the identical atomic-append
 * primitive agent-tier-ledger.js's appendLine and
 * model-routing-guards.state.js's appendLedgerRecord already use. */
function writeLine(p, line) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append one decision-ledger record. Never throws, has no return value
 * callers need to check — every call site in the three guards calls this
 * as a bare statement, immediately before that exit point's existing
 * process.exit(...), with no surrounding try/catch needed. Every failure
 * mode (sweep failure, mkdirSync/openSync/writeSync/closeSync throwing, a
 * malformed `record` of the wrong type) is caught here and swallowed.
 */
function appendDecision(record) {
  try {
    sweepStaleDecisions();
  } catch (_) {
    // sweepStaleDecisions -> cleanupOldStateFiles is already fail-soft
    // internally; this is defensive insurance, not load-bearing.
  }
  try {
    const now = new Date();
    const built = buildRecord(record, now);
    const p = ledgerPathForSessionIdRaw(built.session_id, now);
    writeLine(p, JSON.stringify(built) + "\n");
  } catch (_) {
    // Never blocks the caller's control flow — see module header.
  }
}

/**
 * Best-effort crash-record routing for a guard's top-level catch (owner
 * ruling R1, §2.1). `rawStdinBuffer` is the raw stdin string captured in
 * module-level scope before main() runs (or undefined if the read itself
 * never completed). Performs its own JSON.parse attempt, solely to extract
 * `session_id` — no other field of that best-effort parse is read or
 * logged — then appends exactly one record via appendDecision. Never
 * throws; called as a single bare statement from a guard's top-level catch.
 */
function appendCrashRecord(rawStdinBuffer, guard, guardVersion) {
  try {
    let sessionId = null;
    if (typeof rawStdinBuffer === "string" && rawStdinBuffer.length > 0) {
      try {
        const parsed = JSON.parse(rawStdinBuffer);
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof parsed.session_id === "string" &&
          !isBlankAfterStrip(parsed.session_id)
        ) {
          sessionId = parsed.session_id;
        }
      } catch (_) {
        sessionId = null;
      }
    }

    if (sessionId) {
      appendDecision({
        guard,
        guard_version: guardVersion,
        event: "block",
        session_id: sessionId,
        finding_ids: ["top_level_exception"],
      });
    } else {
      appendDecision({
        guard,
        guard_version: guardVersion,
        event: "guard_crash",
        session_id: null,
        finding_ids: ["top_level_exception"],
      });
    }
  } catch (_) {
    // Never throws — a guard's top-level catch calls this as a bare
    // statement with no surrounding try/catch of its own.
  }
}

/**
 * §2.2's target_hash recipe, shared by all three call sites: first 12 hex
 * characters of sha256(target) — never the raw path/command/subagent_type
 * itself. `null` for a non-string/empty target (no natural single-string
 * target at this exit point).
 */
function hashTarget(target) {
  if (typeof target !== "string" || target === "") return null;
  return crypto.createHash("sha256").update(target).digest("hex").slice(0, 12);
}

module.exports = {
  LEDGER_PREFIX,
  LEDGER_SUFFIX,
  SEVEN_DAYS_MS,
  SWEEP_MIN_AGE_MS,
  ledgerPathForSessionIdRaw,
  sweepStaleDecisions,
  appendDecision,
  appendCrashRecord,
  hashTarget,
};

"use strict";
// model-routing-guards.state.js
// Session-scoped Edit/Read tally state I/O for Hook 2 (spec §4
// "Session-tally rule" + "State I/O") — MONOTONIC APPEND LEDGER design.
//
// Superseded-design note: the original read-modify-write JSON tally (load
// -> check -> increment -> atomic rename) was cross-process TOCTOU-racy —
// tmp-file-then-rename only makes the individual WRITE atomic, never the
// read-check-increment SEQUENCE spanning two separate OS processes.
// Independent review (model-routing-guards.review.md, Blocking §1)
// reproduced 10 concurrent Edit calls (cap 3) letting 4-6 through in every
// one of 10 stress rounds — a live, reliably-reproducible escape, since
// Claude Code dispatches independent tool calls in parallel by design.
//
// Fixed by replacing read-modify-write with an append-only ledger: each
// invocation FIRST appends exactly one record for itself (a single
// O_APPEND writeSync of the whole line — fs.openSync(path, "a") +
// fs.writeSync, the atomic unit POSIX/NTFS append semantics guarantee for
// one write() this small), THEN reads the WHOLE ledger and counts records
// matching its own kind+path. Because the invocation's own record is
// appended before it reads, the k-th appender always observes >= k
// records — the count can never UNDERcount, so more than `cap` records can
// never be classified as "within cap" by any invocation. Under contention,
// extra invocations may be OVER-blocked (two appends can both land before
// either read, so both readers see N+1 and both may block when a strictly
// serial ordering would only have blocked one) — that is friction, the
// correct failure direction per this operator's own canon, never a silent
// escape. There is no temp-file/rename path in this file at all anymore —
// one code path, not two.

const fs = require("fs");
const path = require("path");
const { isBlankAfterStrip } = require("./model-routing-guards.unicode.js");

const STATE_DIR = path.join(__dirname, "state");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_PREFIX = "orchestrator-tool-guard.";
const LEDGER_SUFFIX = ".ledger";

/** Filesystem-safe filename component for an arbitrary session-id key. */
function sanitizeForFilename(key) {
  return String(key).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function ledgerPathForKey(key) {
  return path.join(STATE_DIR, `${LEDGER_PREFIX}${sanitizeForFilename(key)}${LEDGER_SUFFIX}`);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * <key> = stdin.session_id (verbatim string) if present and a non-empty
 * string after stripNormalize; else the literal "global-YYYY-MM-DD" (today,
 * local time, zero-padded) — friction over escape: an unattributable event
 * still gets SOME session-shaped ledger rather than silently bypassing the
 * cap. `now` is injectable for deterministic unit tests.
 */
function resolveSessionKey(sessionIdRaw, now) {
  if (typeof sessionIdRaw === "string" && !isBlankAfterStrip(sessionIdRaw)) {
    return { key: sessionIdRaw, usedFallback: false };
  }
  const d = now || new Date();
  const key = `global-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { key, usedFallback: true };
}

/**
 * Append exactly one record for THIS invocation:
 * "<kind>\t<resolvedPath>\t<isoTimestamp>\t<pid>\n" — a single
 * fs.writeSync on an O_APPEND-opened fd. Must be called BEFORE
 * readLedgerCount for the same invocation (that ordering is what makes the
 * k-th appender always observe >= k records).
 */
function appendLedgerRecord(key, kind, resolvedPath, pid, now) {
  const p = ledgerPathForKey(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ts = (now || new Date()).toISOString();
  const line = `${kind}\t${resolvedPath}\t${ts}\t${pid}\n`;
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return { path: p, line };
}

/**
 * Read the WHOLE ledger for `key` and count records whose kind+resolvedPath
 * exactly match. Missing file -> count 0, not corrupt. Malformed lines
 * (wrong tab-field count, or any empty field) are skipped and reported via
 * `malformed: true` — the caller logs this ONCE per invocation, never once
 * per bad line.
 */
function readLedgerCount(key, kind, resolvedPath) {
  const p = ledgerPathForKey(key);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (_) {
    return { count: 0, malformed: false, path: p };
  }
  let count = 0;
  let malformed = false;
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    if (parts.length !== 4 || parts.some((f) => f === "")) {
      malformed = true;
      continue;
    }
    const [recKind, recPath] = parts;
    if (recKind === kind && recPath === resolvedPath) count += 1;
  }
  return { count, malformed, path: p };
}

/**
 * Opportunistically remove any orchestrator-tool-guard.*.ledger file whose
 * mtime is older than maxAgeMs (default 7 days) — same prefix-guarded
 * deletion as the prior JSON-tally design, now matched against the ledger
 * extension. Wrapped try/catch at every level — any failure here is
 * otherwise ignored, never blocks the current call.
 */
function cleanupOldStateFiles(maxAgeMs) {
  const maxAge = typeof maxAgeMs === "number" ? maxAgeMs : SEVEN_DAYS_MS;
  try {
    if (!fs.existsSync(STATE_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.startsWith(LEDGER_PREFIX) || !f.endsWith(LEDGER_SUFFIX)) continue;
      const full = path.join(STATE_DIR, f);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAge) fs.unlinkSync(full);
      } catch (_) {
        // Per-file failure: ignore, keep scanning the rest.
      }
    }
  } catch (_) {
    // Never blocks the current call.
  }
}

module.exports = {
  STATE_DIR,
  SEVEN_DAYS_MS,
  sanitizeForFilename,
  ledgerPathForKey,
  resolveSessionKey,
  appendLedgerRecord,
  readLedgerCount,
  cleanupOldStateFiles,
};

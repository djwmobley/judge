"use strict";
// model-routing-guards.log.js
// Shared debug-log helper for both model-routing-guards hooks. Same
// convention as every existing hook in this directory: one JSON object per
// line, path.join(__dirname, "<hook-basename>-debug.log"), try/catch-wrapped
// so a log failure never blocks (spec §6).
//
// Also exports appendRotating(filePath, line) — a generic size-capped
// rotating appender any hook in this directory can call directly, so hooks
// that inline their own DEBUG_LOG + appendFileSync can swap to it one-for-one
// without changing their log path or line format.

const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** Reads HOOK_LOG_MAX_BYTES from env on every call (not cached) so tests can
 * override it per-case. Falls back to DEFAULT_MAX_BYTES on anything that
 * isn't a finite positive number. */
function getMaxBytes() {
  const envVal = process.env.HOOK_LOG_MAX_BYTES;
  if (envVal !== undefined && envVal !== "") {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BYTES;
}

/**
 * If `filePath` currently exists and is >= maxBytes, rename it to
 * "<filePath>.1" (replacing any existing .1 — one generation only), then
 * return. Safe when filePath does not exist (nothing to rotate). Safe when
 * the rename races another process (e.g. concurrent hook invocations both
 * rotating the same file, or the file disappearing between stat and
 * rename) — any error here is caught and swallowed; the worst case is the
 * next append lands on a not-yet-rotated file and rotation is retried on a
 * later call.
 */
function rotateIfNeeded(filePath, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return; // does not exist yet — nothing to rotate.
  }
  if (!stat || stat.size < maxBytes) return;
  try {
    const rotated = `${filePath}.1`;
    // fs.renameSync replaces an existing destination on both POSIX and
    // Windows (Node uses MoveFileExW with MOVEFILE_REPLACE_EXISTING), so
    // this is a single atomic "one generation only" rotation with no
    // separate unlink step.
    fs.renameSync(filePath, rotated);
  } catch (_) {
    // Lost a race, or some other rename failure. Never throw out of a log
    // call over this — continue and let the append below recreate the file.
  }
}

/**
 * Append `line` (one log line, WITHOUT its trailing newline) to `filePath`,
 * rotating first if the file has reached the size cap (default 2 MB,
 * overridable via env HOOK_LOG_MAX_BYTES). Never throws: every failure
 * mode (stat error, rotate error, write error — including an unwritable
 * path) is caught and swallowed, because a hook's decision path must never
 * be affected by logging.
 */
function appendRotating(filePath, line) {
  try {
    rotateIfNeeded(filePath, getMaxBytes());
  } catch (_) {
    // Defensive: rotateIfNeeded already swallows its own errors.
  }
  try {
    fs.appendFileSync(filePath, line + "\n", "utf8");
  } catch (_) {
    // Never crash on debug log failure.
  }
}

/**
 * Returns an appendDebug(obj) function bound to
 * "<hookBasename>-debug.log" in this directory. `obj` should already carry
 * `ts` (ISO 8601) and `event`; this function does not add fields.
 */
function createLogger(hookBasename) {
  const logPath = path.join(HOOKS_DIR, `${hookBasename}-debug.log`);
  return function appendDebug(obj) {
    appendRotating(logPath, JSON.stringify(obj));
  };
}

module.exports = { createLogger, HOOKS_DIR, appendRotating };

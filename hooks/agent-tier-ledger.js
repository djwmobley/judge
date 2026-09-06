"use strict";
// agent-tier-ledger.js
// Per-agent tier ledger (judge PR 2, owner decision D3, amended) — a small,
// metadata-only, append-only record of which tier a spawned `Agent`
// dispatch actually ran under, so a later `SendMessage` to that recipient
// can be checked against reality instead of trusting a self-reported
// declaration. Sibling module to agent-model-routing-guard.js, which is
// the only file that imports this one; this module has no CLI entry point
// of its own.
//
// CAPTURE IS SPLIT ACROSS TWO HOOK EVENTS, joined on `tool_use_id`:
//   - A "pending" record is appended at PreToolUse, the moment an Agent
//     dispatch is ALLOWED (never for a blocked one) — it carries
//     everything the guard already validated from `tool_input`: the raw
//     model literal, the resolved tier, subagent_type, description, and
//     the top-level session_id.
//   - An "id" record is appended at PostToolUse (or, best-effort, from a
//     SubagentStart handler — see agent-model-routing-guard.js), once the
//     spawned agent's id (and, if available, display name) is known from
//     `tool_response`. `rules_version` is computed here too — the guard's
//     own version constant plus a hash of the local-policy file's bytes AT
//     THIS MOMENT (PostToolUse), a distinct read from whatever PreToolUse
//     read enforced the dispatch itself (owner decision A3; the narrow gap
//     this opens is documented in the PR description and hooks/README.md,
//     not closed by this file).
// A reader joins the two record kinds on tool_use_id into the 9-field
// metadata-only shape the spec requires (agent id, display name, raw model
// literal, resolved tier, subagent_type, description, session_id,
// timestamp, rules_version) and reduces to the last record per agent id.
//
// NEVER stores a prompt body, a message body, or any tool result — this is
// a hard rule (see agent-model-routing-guard.js's header comment and
// hooks/README.md), not a size-tuning choice.
//
// Storage: hooks/state/agent-tier-ledger.<sanitized session_id>.jsonl, one
// JSON object per line, appended via a single O_APPEND writeSync per
// record (no read-modify-write) — same TOCTOU rationale documented in
// model-routing-guards.state.js's header comment. Capture writes only to
// the CURRENT session's own file; lookup reads and merges every
// agent-tier-ledger.*.jsonl file in the state directory (owner decision A4)
// so a recipient spawned earlier, or by another session on the same
// machine, is still visible.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { STATE_DIR, sanitizeForFilename, resolveSessionKey, cleanupOldStateFiles } = require("./model-routing-guards.state.js");
const { stripNormalize, isBlankAfterStrip } = require("./model-routing-guards.unicode.js");
const { localPolicyPath, VALID_TIERS } = require("./lib/local-policy.js");

const LEDGER_PREFIX = "agent-tier-ledger.";
const LEDGER_SUFFIX = ".jsonl";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// A6: never unlink a ledger file touched in the last 60 seconds — a
// concurrent process may still be mid-append to it. The residual race
// narrower than this window is an accepted, documented limitation, not
// something this file closes.
const SWEEP_MIN_AGE_MS = 60 * 1000;

const AGENT_ID_FROM_TEXT_RE = /\bagentId:\s*([a-z0-9]{8,})/i;

// ─── Session key / path helpers ──────────────────────────────────────────

/** Same two-step key derivation Hook 2's ledger already uses. */
function resolveLedgerSessionKey(sessionIdRaw, now) {
  return sanitizeForFilename(resolveSessionKey(sessionIdRaw, now).key);
}

function ledgerPathForSessionKey(sessionKey) {
  return path.join(STATE_DIR, `${LEDGER_PREFIX}${sessionKey}${LEDGER_SUFFIX}`);
}

function listLedgerFiles() {
  try {
    if (!fs.existsSync(STATE_DIR)) return [];
    return fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.startsWith(LEDGER_PREFIX) && f.endsWith(LEDGER_SUFFIX))
      .map((f) => path.join(STATE_DIR, f));
  } catch (_) {
    return [];
  }
}

/** 7-day sweep, run before every append (never after) — see A6 above. */
function sweepStaleLedgers() {
  cleanupOldStateFiles(SEVEN_DAYS_MS, LEDGER_PREFIX, LEDGER_SUFFIX, SWEEP_MIN_AGE_MS);
}

// ─── rules_version ────────────────────────────────────────────────────────

/**
 * `${guardVersion}:${hash12}` where hash12 is the first 12 hex characters
 * of a sha256 digest of the local-policy file's raw bytes AT THIS MOMENT,
 * or the literal "nopolicy" if no local-policy file exists. Computed once,
 * at PostToolUse capture time (owner decision A3) — never at PreToolUse.
 */
function computeRulesVersion(guardVersion) {
  let hashPart;
  try {
    const bytes = fs.readFileSync(localPolicyPath());
    hashPart = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  } catch (_) {
    hashPart = "nopolicy";
  }
  return `${guardVersion}:${hashPart}`;
}

// ─── Append (capture) ─────────────────────────────────────────────────────

function appendLine(sessionKey, obj) {
  const p = ledgerPathForSessionKey(sessionKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify(obj) + "\n";
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return p;
}

/**
 * PreToolUse capture — called ONLY when an Agent dispatch has already been
 * classified `allow`. Never stores prompt/message bodies.
 */
function appendPendingRecord(sessionKey, fields) {
  sweepStaleLedgers();
  return appendLine(sessionKey, {
    kind: "pending",
    tool_use_id: fields.tool_use_id,
    model: typeof fields.model === "string" ? fields.model : null,
    tier: fields.tier,
    subagent_type: typeof fields.subagent_type === "string" ? fields.subagent_type : null,
    description: typeof fields.description === "string" ? fields.description : null,
    session_id: typeof fields.session_id === "string" ? fields.session_id : null,
    ts: fields.ts,
  });
}

/**
 * PostToolUse (or SubagentStart, best-effort) capture — joins onto the
 * pending record with the same tool_use_id once the reader runs.
 */
function appendIdRecord(sessionKey, fields) {
  sweepStaleLedgers();
  return appendLine(sessionKey, {
    kind: "id",
    tool_use_id: fields.tool_use_id,
    agent_id: fields.agent_id,
    name: typeof fields.name === "string" ? fields.name : null,
    rules_version: fields.rules_version,
    ts: fields.ts,
  });
}

// ─── Resolving the agent id / display name from an unverified payload ────
// The exact field path of the spawned agent's id inside the Agent tool's
// PostToolUse `tool_response` is UNVERIFIED as of this PR (see
// hooks/README.md's "Capture verification pending" section). Tried, in
// order: `tool_response.agentId`, `.agent_id`, `.id`, then — for a string
// response, or any `content`/`text`/`result` string field — the regex
// /\bagentId:\s*([a-z0-9]{8,})/i.

function resolveAgentIdFromToolResponse(toolResponse) {
  if (toolResponse && typeof toolResponse === "object" && !Array.isArray(toolResponse)) {
    if (typeof toolResponse.agentId === "string" && toolResponse.agentId !== "") {
      return { agentId: toolResponse.agentId, source: "agentId" };
    }
    if (typeof toolResponse.agent_id === "string" && toolResponse.agent_id !== "") {
      return { agentId: toolResponse.agent_id, source: "agent_id" };
    }
    if (typeof toolResponse.id === "string" && toolResponse.id !== "") {
      return { agentId: toolResponse.id, source: "id" };
    }
    for (const field of ["content", "text", "result"]) {
      const val = toolResponse[field];
      if (typeof val === "string") {
        const m = AGENT_ID_FROM_TEXT_RE.exec(val);
        if (m) return { agentId: m[1], source: `regex:${field}` };
      }
    }
    return null;
  }
  if (typeof toolResponse === "string") {
    const m = AGENT_ID_FROM_TEXT_RE.exec(toolResponse);
    if (m) return { agentId: m[1], source: "regex:string" };
  }
  return null;
}

function resolveDisplayNameFromToolResponse(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) return null;
  for (const field of ["name", "display_name", "agentName", "agent_name"]) {
    if (typeof toolResponse[field] === "string" && toolResponse[field] !== "") return toolResponse[field];
  }
  return null;
}

/** Top-level keys of `value`, for the "record nothing, log once" debug line. */
function topLevelKeys(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.keys(value);
  if (Array.isArray(value)) return ["(array)"];
  return [];
}

function summarizeUnresolved(toolResponse) {
  const asString = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
  return {
    top_level_keys: topLevelKeys(toolResponse),
    first_300_chars: typeof asString === "string" ? asString.slice(0, 300) : null,
  };
}

// ─── "Once per session" markers (capture debug logging) ───────────────────
// Each hook invocation is a fresh process, so "once per session" needs a
// persistent marker rather than an in-memory flag. A zero-byte marker file
// under STATE_DIR, named by session key + purpose, is enough — it is swept
// by the same 7-day sweep as the ledger files it sits alongside (same
// prefix family), so it never accumulates forever.

function markerPath(sessionKey, purpose) {
  return path.join(STATE_DIR, `${LEDGER_PREFIX}${sessionKey}.${purpose}.once`);
}

function markOnceAndCheck(sessionKey, purpose) {
  const p = markerPath(sessionKey, purpose);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "", { flag: "wx" }); // fails if it already exists.
    return true; // first time this session.
  } catch (_) {
    return false; // already marked (or a filesystem error — either way, don't log again).
  }
}

// ─── Reading + joining ──────────────────────────────────────────────────

/**
 * Read every agent-tier-ledger.*.jsonl file in the state directory.
 * Returns { pending: Map<tool_use_id, record>, ids: Map<tool_use_id, record>,
 * malformed: boolean } — a malformed line (bad JSON, non-object, or missing
 * a field required for its own `kind`) is skipped; `malformed` is set at
 * most once per call regardless of how many bad lines were found (the
 * caller logs it once, never once per line).
 */
function readAllRecords() {
  const pending = new Map();
  const ids = new Map();
  let malformed = false;

  for (const file of listLedgerFiles()) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      malformed = true;
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        malformed = true;
        continue;
      }
      if (!obj || typeof obj !== "object") {
        malformed = true;
        continue;
      }
      if (obj.kind === "pending") {
        if (typeof obj.tool_use_id !== "string" || obj.tool_use_id === "" || typeof obj.tier !== "string") {
          malformed = true;
          continue;
        }
        pending.set(obj.tool_use_id, obj);
      } else if (obj.kind === "id") {
        if (
          typeof obj.tool_use_id !== "string" ||
          obj.tool_use_id === "" ||
          typeof obj.agent_id !== "string" ||
          obj.agent_id === ""
        ) {
          malformed = true;
          continue;
        }
        ids.set(obj.tool_use_id, obj);
      } else {
        malformed = true;
      }
    }
  }

  return { pending, ids, malformed };
}

/**
 * Join pending+id records on tool_use_id into the 9-field metadata-only
 * shape, then reduce to the LAST record per agent id (a later append
 * supersedes an earlier one for the same id — file/read order, not
 * timestamp comparison).
 */
function buildJoinedRecordsByAgentId() {
  const { pending, ids, malformed } = readAllRecords();
  const byAgentId = new Map();
  for (const [toolUseId, idRec] of ids) {
    const pendingRec = pending.get(toolUseId);
    if (!pendingRec) continue; // no matching allowed-dispatch record for this id capture.
    const joined = {
      agent_id: idRec.agent_id,
      name: idRec.name === undefined ? null : idRec.name,
      model: pendingRec.model,
      tier: pendingRec.tier,
      subagent_type: pendingRec.subagent_type,
      description: pendingRec.description,
      session_id: pendingRec.session_id,
      ts: idRec.ts,
      rules_version: idRec.rules_version,
    };
    byAgentId.set(joined.agent_id, joined);
  }
  return { byAgentId, malformed };
}

// ─── Lookup / total classification of `to` ───────────────────────────────

/**
 * Total classification of a SendMessage `to` value against the merged
 * ledger (owner decision D3, amended). Returns one of:
 *   { kind: "recipient_invalid" }
 *   { kind: "unknown", malformed }
 *   { kind: "ambiguous", malformed }
 *   { kind: "ledger_record_tier_invalid", record, malformed }
 *   { kind: "resolved", tier, record, malformed }
 */
function classifyRecipient(toRaw) {
  if (typeof toRaw !== "string" || isBlankAfterStrip(toRaw)) {
    return { kind: "recipient_invalid" };
  }
  const trimmed = toRaw.trim();
  const { byAgentId, malformed } = buildJoinedRecordsByAgentId();
  const records = Array.from(byAgentId.values());

  let matches = records.filter((r) => r.agent_id === trimmed);
  if (matches.length === 0) {
    matches = records.filter((r) => typeof r.name === "string" && r.name === trimmed);
  }
  if (matches.length === 0) {
    const normTo = stripNormalize(trimmed).trim();
    matches = records.filter((r) => typeof r.name === "string" && stripNormalize(r.name).trim() === normTo);
  }

  if (matches.length === 0) return { kind: "unknown", malformed };

  const tiers = new Set(matches.map((m) => m.tier));
  if (tiers.size > 1) return { kind: "ambiguous", malformed };

  const tier = matches[0].tier;
  if (!VALID_TIERS.has(tier)) {
    return { kind: "ledger_record_tier_invalid", record: matches[0], malformed };
  }
  return { kind: "resolved", tier, record: matches[0], malformed };
}

module.exports = {
  LEDGER_PREFIX,
  LEDGER_SUFFIX,
  SEVEN_DAYS_MS,
  SWEEP_MIN_AGE_MS,
  resolveLedgerSessionKey,
  ledgerPathForSessionKey,
  listLedgerFiles,
  sweepStaleLedgers,
  computeRulesVersion,
  appendPendingRecord,
  appendIdRecord,
  resolveAgentIdFromToolResponse,
  resolveDisplayNameFromToolResponse,
  summarizeUnresolved,
  markOnceAndCheck,
  readAllRecords,
  buildJoinedRecordsByAgentId,
  classifyRecipient,
};

"use strict";
// agent-model-routing-guard.js
// Hook 1 (PreToolUse, matcher "Agent|SendMessage") — enforces the Model
// Routing rule's `model` value/absence contract on EVERY caller,
// orchestrator and subagent alike. No agent_id bypass. Every real
// model-family literal lives ONLY in the operator's own
// `~/.claude/hooks/local-policy.json` under the `model_tiers` key
// (hooks/lib/local-policy.js); this file, its tests, and its README
// section speak only tier language ("planning" / "drafting" / "mechanical")
// — see hooks/README.md.
//
// Absent `model`, or a `model` that does not resolve (via `model_tiers`,
// after a strip+fold+lowercase pipeline) to a configured tier, blocks
// unconditionally — there is no "undeclared" allow branch, ever, for any
// subagent_type or prompt text. The planning-tier row's prose-or-
// EXEMPT_TYPES OR-clause only ever fires once `model` has already resolved
// to the "planning" tier — it is a carve-out on the prose-REQUIREMENT
// question, never on the declaration question above.
//
// Fail-open is narrow (like the source this was ported from): only
// stdin-read failure, JSON.parse failure, or a non-object parsed payload
// fail open. A missing/empty tool_name, or any internal exception after a
// successful parse, is a named BLOCK — never fail-open.
//
// subagent_type "fork" (stripNormalize'd + trimmed, case-sensitive) is
// blocked before any model-literal branching: a fork always runs on the
// parent session model, so a declared `model` on it is inert and the top
// tier would run inside a subagent — this check short-circuits every other
// finding, floor included, and cannot be evaded by an invisible/format
// code point (e.g. U+200B) smuggled into subagent_type.
//
// TWO separate subagent_type keys, stripped differently by direction (see
// stripInvisible's doc comment in model-routing-guards.unicode.js): the
// fork gate uses stripNormalize's full Cf/Cc/M strip (fail-safe toward a
// BLOCK), while the EXEMPT_TYPES allow-list lookup uses stripInvisible's
// Cf/Cc-only strip with every mark and case left untouched (an M-stripped
// compare there would let a combining-mark-decorated impostor falsely
// normalize into a real exempt name and be granted an exemption).
//
// REPORT CAP / PLAN-ONLY / RECIPIENT TIER lines (owner decisions D2, A7,
// A8, A9): each must appear as a bare standalone line — optional leading
// whitespace only, no blockquote marker, no list marker, not inside a
// fenced code block (CommonMark fence-open/close matching, tilde and
// backtick tracked separately, an unclosed fence running to end of text).
// Text is normalized first: CRLF/lone-CR -> LF, then each physical line has
// stripInvisible (Cf/Cc only, no marks, no case-fold) applied before the
// regex runs, so two lines differing only in invisible characters count as
// two separate matches, not one. Zero qualifying lines blocks; two or more
// also blocks, with a distinct "_ambiguous" finding, rather than accepting
// the first or last.
//
// KNOWN BLIND SPOT (documented, not a bug — carried from the source this
// was ported from): a homoglyph (different-codepoint, visually-identical
// character) is not stripped by either normalization function and will not
// match "fork" / an EXEMPT_TYPES name / any of the three bare-line markers.
//
// This file also answers SubagentStart events for the per-agent tier
// ledger (agent-tier-ledger.js, owner decision D3) — see hooks/README.md's
// "Capture verified" section for the verified top-level `agent_id` field
// path this depends on (a PostToolUse (Agent) registration also existed
// through PR 2 as an unverified fallback; it was removed 2026-09-06 once
// live verification showed SubagentStart alone accounted for every
// captured id). This path never blocks; it only captures metadata for a
// later SendMessage lookup.

const fs = require("fs");
const { stripNormalize, stripInvisible, isBlankAfterStrip } = require("./model-routing-guards.unicode.js");
const { resolveExemptTypes } = require("./model-routing-guards.exempt.js");
const { createLogger } = require("./model-routing-guards.log.js");
const { loadLocalPolicy, foldModelTierToken } = require("./lib/local-policy.js");
const ledger = require("./agent-tier-ledger.js");

// docs/specs/routing-scorecard.md §2.1 / R9 — the decisions module is
// loaded defensively, and EVERY call into it — not just require() itself —
// is routed through the three safe wrappers below (logDecision/safeHash/
// safeCrash). Each wrapper (i) checks typeof === "function" before
// calling, (ii) wraps the call in try/catch, (iii) returns a harmless
// default (undefined for logDecision/safeCrash, null for safeHash) on ANY
// failure — require() throwing, a loaded module whose export is present
// but not a function (install drift replacing a function with an
// object/undefined — the case a bare require()-guard alone does not
// cover), or a function that throws when called. No call site in this file
// calls decisions.appendDecision/appendCrashRecord/hashTarget directly;
// every one goes through logDecision/safeCrash/safeHash. This guard's
// decision logic never reads a wrapper's return value in a way that
// changes its outcome (logDecision/safeCrash are called only for their
// side effect; safeHash's `null` default is a value the record schema
// already treats as "no target", never a branch condition) — so a
// decisions-module failure, in any of the shapes above, can never change
// this guard's exit code or stdout/stderr on any path, crash path
// included.
let decisions;
try {
  decisions = require("./model-routing-guards.decisions.js");
} catch (_) {
  decisions = {};
}

// Each wrapper captures the module's function reference into a local
// before calling it (never a direct decisions.appendDecision-style
// call in this file's own source outside this block) — both so a
// non-function export is caught by the typeof check below and so a later
// global find/replace of the (un-wrapped) call pattern elsewhere in this
// file can never accidentally rewrite these three definitions themselves.
function logDecision(record) {
  try {
    const fn = decisions.appendDecision;
    if (typeof fn === "function") {
      fn(record);
    }
  } catch (_) {
    // See header comment above.
  }
}

function safeHash(target) {
  try {
    const fn = decisions.hashTarget;
    if (typeof fn === "function") {
      return fn(target);
    }
  } catch (_) {
    // fall through to the harmless default below.
  }
  return null;
}

function safeCrash(rawStdinBufferArg, guard, guardVersion) {
  try {
    const fn = decisions.appendCrashRecord;
    if (typeof fn === "function") {
      fn(rawStdinBufferArg, guard, guardVersion);
    }
  } catch (_) {
    // See header comment above.
  }
}

const appendDebug = createLogger("agent-model-routing-guard");

// Bumped whenever this file's own enforcement logic changes in a way that
// should invalidate an old ledger record's rules_version comparison later.
const GUARD_VERSION = "1";

// docs/specs/routing-scorecard.md §2.5 — this guard applies its rules "to
// every caller, orchestrator and subagent alike" and never branches on
// agent_id for gating; this classification exists ONLY for the decision
// ledger's `caller` field. Duplicated (not imported) from
// orchestrator-tool-guard.js's identical one-line-body function per §2.5's
// own hedge: importing would create a cross-guard runtime dependency that
// does not exist today, which the spec prefers to avoid given the
// function's triviality.
function classifyCaller(agentIdRaw) {
  if (typeof agentIdRaw !== "string") return "orchestrator"; // absent or non-string
  if (isBlankAfterStrip(agentIdRaw)) return "orchestrator"; // empty/whitespace/invisible
  return "subagent";
}

function decisionRecord(fields) {
  return Object.assign({ guard: "agent-model-routing-guard", guard_version: GUARD_VERSION }, fields);
}

// docs/specs/routing-scorecard.md §2.1 R1 — raw stdin captured into
// module-level (outer-scope) scope BEFORE main() runs, so the top-level
// catch (previously blind to the raw request) can recover session_id.
// Changes only WHEN the read happens, not what is read or how any
// block/allow/fail_open outcome is decided.
//
// Called from main() itself (below), not from the `require.main === module`
// block alone: this file has TWO installed entry points —
// agent-model-routing-guard.js's own direct PreToolUse registration, and
// agent-model-routing-guard-subagentstart.js's `require(...).main()` shim
// for SubagentStart (owner decision D3) — and the shim's `module` object is
// itself, not this file, so `require.main === module` is always false when
// entered via the shim. A prior revision called captureStdin() only inside
// that require.main block, which left rawStdinBuffer permanently
// `undefined` on every SubagentStart dispatch: main() would then
// JSON.parse(undefined) (stringifies to the non-JSON text "undefined"),
// fail open with a bogus "json_parse_error" for every single subagent
// spawn, and never reach handleSubagentStart() at all — silently breaking
// the tier-ledger id capture this shim exists for, on 100% of dispatches,
// with no test catching it (every existing end-to-end test in
// agent-model-routing-guard.test.js spawns this file directly, never the
// shim). Calling captureStdin() unconditionally at the top of main() — the
// original, pre-regression shape — fixes both entry points at once and
// needs no shim-side change. stdinCaptured guards against a second call
// re-reading (or hanging on) an already-drained fd 0 if main() is ever
// invoked twice in one process.
let rawStdinBuffer;
let stdinReadFailed = false;
let stdinCaptured = false;

function captureStdin() {
  if (stdinCaptured) return;
  stdinCaptured = true;
  try {
    rawStdinBuffer = fs.readFileSync(0, "utf8");
  } catch (_) {
    stdinReadFailed = true;
  }
}

const OVERSIZED_THRESHOLD = 100000;

// ─── Bare-standalone-line matching (D2, A7, A8, A9) ───────────────────────

const PLAN_ONLY_BODY_SOURCE = "PLAN-ONLY: no writes, no edits, no shell; return a plan only\\.?";
const REPORT_CAP_BODY_SOURCE = "REPORT CAP: (\\d{1,3}) words";
const RECIPIENT_TIER_BODY_SOURCE = "RECIPIENT TIER: (planning|drafting|mechanical)\\.?";

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Strips one or more leading CommonMark blockquote markers ("> " / ">")
 * so fence-open/close detection can look inside a block quote — a fence
 * that appears inside a blockquote is still a fence for this purpose. */
function stripBlockquoteMarkers(line) {
  let content = line;
  let wasBlockquote = false;
  for (;;) {
    const m = content.match(/^ {0,3}>[ \t]?/);
    if (!m) break;
    content = content.slice(m[0].length);
    wasBlockquote = true;
  }
  return { content, wasBlockquote };
}

/**
 * CommonMark fence tracking: a fence opens on a line (blockquote markers
 * stripped first) with up to 3 leading spaces followed by 3+ identical
 * backtick or tilde characters and an optional info string; it closes only
 * on a later line with the SAME fence character, a run at least as long as
 * the opener's, and nothing else but whitespace; an unclosed fence runs to
 * the end of the text. Returns a boolean array (same length as `lines`)
 * that is true for every line that is part of a fence (opener, body, and
 * closer alike) and therefore excluded from bare-line matching.
 */
function computeFenceMask(lines) {
  const inFence = new Array(lines.length).fill(false);
  let fenceChar = null;
  let fenceLen = 0;
  let open = false;

  for (let i = 0; i < lines.length; i++) {
    const { content } = stripBlockquoteMarkers(lines[i]);
    if (!open) {
      const m = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (m) {
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        open = true;
        inFence[i] = true;
      }
      continue;
    }
    inFence[i] = true;
    const runMatch = content.match(fenceChar === "`" ? /^ {0,3}(`+)\s*$/ : /^ {0,3}(~+)\s*$/);
    if (runMatch && runMatch[1].length >= fenceLen) {
      open = false;
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return inFence;
}

/**
 * Scan `text` for bare standalone lines matching `^bodySource$` (with
 * `flags`, minus "g"/"m" which this function manages itself): CRLF/lone-CR
 * normalized to LF first (A8), then per-line stripInvisible (A8) before the
 * regex test, skipping any line inside a fence (A7), any line carrying a
 * blockquote marker, and any line carrying a list marker (D2). Returns
 * every qualifying match — the caller decides what 0 / 1 / 2+ means.
 */
function findBareLineMatches(text, bodySource, flags) {
  const normalized = normalizeLineEndings(typeof text === "string" ? text : "");
  const lines = normalized.split("\n");
  const fenceMask = computeFenceMask(lines);
  const bodyFlags = (flags || "").replace(/[gm]/g, "");
  const fullRe = new RegExp("^" + bodySource + "$", bodyFlags);
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const rawLine = lines[i];
    if (/^[ \t]*>/.test(rawLine)) continue; // blockquote marker, any depth.
    if (/^[ \t]*([-*+]|\d+[.)])[ \t]/.test(rawLine)) continue; // list marker.
    const stripped = stripInvisible(rawLine);
    const leadingWsMatch = stripped.match(/^[ \t]*/);
    const afterLeadingWs = stripped.slice(leadingWsMatch ? leadingWsMatch[0].length : 0);
    const m = afterLeadingWs.match(fullRe);
    if (m) matches.push({ lineIndex: i, match: m });
  }
  return matches;
}

function isOversized(value) {
  return typeof value === "string" && value.length > OVERSIZED_THRESHOLD;
}

// ─── model_tiers resolution ────────────────────────────────────────────

/** Fold the dispatch's `model` value through the identical pipeline used
 * for `model_tiers` keys, then look it up. Returns null if the model is
 * absent/non-string, empty-after-fold, or not a configured entry — all of
 * which are the SAME finding (model_missing_or_invalid), never distinct. */
function resolveTierForModel(rawModel, modelTiers) {
  const folded = foldModelTierToken(rawModel);
  if (folded === null || folded === "") return null;
  if (!Object.prototype.hasOwnProperty.call(modelTiers, folded)) return null;
  return modelTiers[folded];
}

// ─── Findings / block-message plumbing (unchanged shape from the source) ──

function failOpen(reason, extra) {
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "fail_open", reason }, extra || {}));
  // §2.5: caller is "unknown" at every fail_open triggered before agent_id
  // has been parsed at all — true for all three fail_open reasons this
  // guard can produce.
  logDecision(
    decisionRecord({ event: "fail_open", session_id: null, agent_id: null, caller: "unknown", tool_name: null, reason })
  );
  process.exit(0);
}

function buildBlockMessage(findings, toolName) {
  let msg = `agent-model-routing-guard: BLOCKED — ${toolName} dispatch failed ${findings.length} check(s):\n`;
  findings.forEach((f, i) => {
    msg += `  ${i + 1}. [${f.id}] ${f.detail}\n`;
  });
  msg += "Fix the dispatch to satisfy every finding above, then retry.\n";
  return msg;
}

function block(findings, toolName, extra, ctx) {
  const findingIds = findings.map((f) => f.id);
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "block", tool_name: toolName, finding_ids: findingIds }, extra || {}));
  logDecision(
    decisionRecord(Object.assign({ event: "block", tool_name: toolName, finding_ids: findingIds }, ctx || {}))
  );
  process.stderr.write(buildBlockMessage(findings, toolName));
  process.exit(2);
}

function allow(toolName, extra, ctx) {
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "allow", tool_name: toolName }, extra || {}));
  logDecision(decisionRecord(Object.assign({ event: "allow", tool_name: toolName }, ctx || {})));
  process.exit(0);
}

// ─── Step B(Agent) ─────────────────────────────────────────────────────

function evaluateAgent(toolInput, modelTiers) {
  const findings = [];
  const modelRaw = toolInput.model;
  const subagentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined;
  const blockKey = typeof subagentType === "string" ? stripNormalize(subagentType).trim() : undefined;
  const allowKey = typeof subagentType === "string" ? stripInvisible(subagentType).trim() : undefined;
  const promptRaw = toolInput.prompt;
  const promptIsString = typeof promptRaw === "string";
  const promptOversized = isOversized(promptRaw);

  if (blockKey === "fork") {
    findings.push({
      id: "fork_subagent_forbidden",
      detail:
        'subagent_type "fork" runs on the parent session model; the top tier never runs inside a subagent and a declared model on a fork is inert. Dispatch a fresh agent with an explicit model instead.',
    });
    return { ok: false, findings, subagentType, model: modelRaw, tier: null };
  }

  const tier = resolveTierForModel(modelRaw, modelTiers);
  let modelOk = false;

  if (tier === null) {
    findings.push({
      id: "model_missing_or_invalid",
      detail:
        "model must resolve, via the operator's configured model_tiers, to exactly one of planning/drafting/mechanical — absent, wrong type, empty-after-fold, or any unconfigured value blocks unconditionally (Model Routing rule, no exceptions).",
    });
  } else if (tier === "drafting" || tier === "mechanical") {
    modelOk = true;
  } else {
    // planning tier.
    if (promptOversized) {
      findings.push({
        id: "oversized_field",
        detail: `prompt field exceeds ${OVERSIZED_THRESHOLD} characters; treated as failing without running the bare-line checks.`,
      });
    } else {
      const promptText = promptIsString ? promptRaw : "";
      const planOnlyMatches = findBareLineMatches(promptText, PLAN_ONLY_BODY_SOURCE, "");
      const exempt = resolveExemptTypes();
      if (exempt.drift) {
        appendDebug({ ts: new Date().toISOString(), event: "exempt_types_drift", required: exempt.required });
      }
      const exemptOk = allowKey !== undefined && exempt.exemptTypes.indexOf(allowKey) !== -1;

      if (planOnlyMatches.length >= 2) {
        findings.push({
          id: "plan_only_ambiguous",
          detail: "two or more standalone PLAN-ONLY lines found; exactly one is required, never a first-or-last pick.",
        });
      } else if (planOnlyMatches.length === 1 || exemptOk) {
        modelOk = true;
      } else {
        findings.push({
          id: "planning_prose_missing",
          detail:
            'planning-tier dispatch requires a standalone "PLAN-ONLY: no writes, no edits, no shell; return a plan only." line in the prompt, or subagent_type must be a structurally read-only EXEMPT_TYPES member.',
        });
      }
    }
  }

  const capResult = evaluateReportCapFloor(promptRaw, promptIsString, promptOversized, findings);

  return { ok: modelOk && capResult, findings, subagentType, model: modelRaw, tier };
}

/**
 * Step B(SendMessage). Model rules apply only via the per-agent tier
 * ledger's resolution of `to` (owner decision D3) — a ledger record always
 * overrides a declared RECIPIENT TIER line.
 */
function evaluateSendMessage(toolInput) {
  const findings = [];
  const messageRaw = toolInput.message;
  const messageIsString = typeof messageRaw === "string";
  const messageOversized = isOversized(messageRaw);
  const toRaw = toolInput.to;

  if (messageOversized) {
    findings.push({
      id: "oversized_field",
      detail: `field exceeds ${OVERSIZED_THRESHOLD} characters; treated as failing without running the bare-line checks.`,
    });
    return { ok: false, findings };
  }

  const messageText = messageIsString ? messageRaw : "";
  const classification = ledger.classifyRecipient(toRaw);
  appendDebug({ ts: new Date().toISOString(), event: "recipient_classification", kind: classification.kind });

  let classificationOk = true;
  let requiresPlanOnly = false;

  if (classification.kind === "recipient_invalid") {
    findings.push({
      id: "recipient_invalid",
      detail: 'SendMessage "to" must be a non-blank, non-invisible string identifying a real recipient.',
    });
    classificationOk = false;
  } else if (classification.kind === "ledger_record_tier_invalid") {
    findings.push({
      id: "ledger_record_tier_invalid",
      detail: "the resolved ledger record's tier is present but is not one of planning/drafting/mechanical — treated as corrupted, block.",
    });
    classificationOk = false;
  } else if (classification.kind === "resolved") {
    if (classification.tier === "planning") requiresPlanOnly = true;
  } else {
    // "ambiguous" or "unknown" — the unknown branch (D3): a declared
    // RECIPIENT TIER line is required, exactly once, bare-standalone.
    const tierMatches = findBareLineMatches(messageText, RECIPIENT_TIER_BODY_SOURCE, "i");
    if (tierMatches.length >= 2) {
      findings.push({
        id: "recipient_tier_ambiguous",
        detail: "two or more standalone RECIPIENT TIER lines found; exactly one is required.",
      });
      classificationOk = false;
    } else if (tierMatches.length === 0) {
      findings.push({
        id: "recipient_tier_unknown",
        detail:
          'no ledger record resolves this recipient unambiguously, and no standalone "RECIPIENT TIER: planning|drafting|mechanical" line declares one.',
      });
      classificationOk = false;
    } else {
      const declaredTier = tierMatches[0].match[1].toLowerCase();
      if (declaredTier === "planning") requiresPlanOnly = true;
    }
  }

  let planOnlyOk = true;
  if (requiresPlanOnly) {
    const planMatches = findBareLineMatches(messageText, PLAN_ONLY_BODY_SOURCE, "");
    if (planMatches.length >= 2) {
      findings.push({
        id: "plan_only_ambiguous",
        detail: "two or more standalone PLAN-ONLY lines found; exactly one is required, never a first-or-last pick.",
      });
      planOnlyOk = false;
    } else if (planMatches.length === 0) {
      findings.push({
        id: "planning_prose_missing",
        detail: 'the resolved/declared tier is planning, which requires a standalone PLAN-ONLY line in the message.',
      });
      planOnlyOk = false;
    }
  }

  const capOk = evaluateReportCapFloor(messageRaw, messageIsString, false, findings);
  return { ok: classificationOk && planOnlyOk && capOk, findings };
}

/** Shared Floor evaluation for both Agent (prompt) and SendMessage
 * (message). Pushes at most one finding among oversized_field /
 * report_cap_missing_or_invalid / report_cap_ambiguous. */
function evaluateReportCapFloor(fieldRaw, isString, oversized, findings) {
  if (oversized) {
    if (!findings.some((f) => f.id === "oversized_field")) {
      findings.push({
        id: "oversized_field",
        detail: `field exceeds ${OVERSIZED_THRESHOLD} characters; treated as failing without running the bare-line checks.`,
      });
    }
    return false;
  }
  const text = isString ? fieldRaw : "";
  const capMatches = findBareLineMatches(text, REPORT_CAP_BODY_SOURCE, "");

  if (capMatches.length >= 2) {
    findings.push({
      id: "report_cap_ambiguous",
      detail: "two or more standalone REPORT CAP lines found; exactly one is required, never a first-or-last pick.",
    });
    return false;
  }
  if (capMatches.length === 0) {
    findings.push({
      id: "report_cap_missing_or_invalid",
      detail: 'dispatch requires a standalone "REPORT CAP: N words" line (1 <= N <= 500).',
    });
    return false;
  }
  const n = parseInt(capMatches[0].match[1], 10);
  if (n < 1 || n > 500) {
    findings.push({
      id: "report_cap_missing_or_invalid",
      detail: 'dispatch requires a standalone "REPORT CAP: N words" line (1 <= N <= 500).',
    });
    return false;
  }
  return true;
}

// ─── SubagentStart — verified sole id-capture path ────────────────────────
// Through PR 2 this ran alongside a PostToolUse (Agent) registration that
// carried an unverified tool_response-based fallback id-resolution chain.
// Live verification on 2026-09-06 (6/6 dispatches in one session) showed
// this handler's top-level `agent_id` + `tool_use_id` fields resolving
// every dispatch, with zero PostToolUse-sourced "id" records and zero
// `ledger_capture_unresolved` debug lines — see hooks/README.md's
// "Capture verified" section. The PostToolUse registration was removed as
// dead weight rather than kept as an unexercised fallback. This handler
// remains best-effort in the sense that a harness version whose
// SubagentStart payload lacks `agent_id`/`tool_use_id` simply records
// nothing for that dispatch (falls to the "unknown recipient" branch at
// SendMessage time, same as before) — it just no longer has a second,
// independently-sourced path backing it up.

function handleSubagentStart(parsed) {
  try {
    const sessionKey = ledger.resolveLedgerSessionKey(parsed.session_id);
    if (ledger.markOnceAndCheck(sessionKey, "subagentstart-payload")) {
      appendDebug({
        ts: new Date().toISOString(),
        event: "subagent_start_payload_keys",
        top_level_keys: Object.keys(parsed || {}),
      });
    }
    const toolUseId = typeof parsed.tool_use_id === "string" && parsed.tool_use_id !== "" ? parsed.tool_use_id : null;
    const agentId = typeof parsed.agent_id === "string" && parsed.agent_id !== "" ? parsed.agent_id : null;
    if (toolUseId && agentId) {
      ledger.appendIdRecord(sessionKey, {
        tool_use_id: toolUseId,
        agent_id: agentId,
        name: ledger.resolveDisplayNameFromToolResponse(parsed),
        rules_version: ledger.computeRulesVersion(GUARD_VERSION),
        ts: new Date().toISOString(),
      });
    }
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
}

// ─── PreToolUse main() ────────────────────────────────────────────────────

function main() {
  captureStdin();
  if (stdinReadFailed) {
    failOpen("stdin_read_error");
    return;
  }
  const raw = rawStdinBuffer;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    failOpen("json_parse_error");
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    failOpen("parsed_not_object");
    return;
  }

  const hookEventName = typeof parsed.hook_event_name === "string" ? parsed.hook_event_name : "PreToolUse";

  if (hookEventName === "SubagentStart") {
    // docs/specs/routing-scorecard.md §3.2 carve-out — a metadata-capture
    // path for the per-agent tier ledger, never a routing decision; no
    // appendDecision call here, by design.
    handleSubagentStart(parsed);
    return;
  }

  const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : "";
  const toolInput = parsed.tool_input && typeof parsed.tool_input === "object" ? parsed.tool_input : {};
  const localPolicy = loadLocalPolicy();
  const sessionIdForDecision = typeof parsed.session_id === "string" ? parsed.session_id : null;
  const agentIdForDecision = typeof parsed.agent_id === "string" ? parsed.agent_id : null;
  const toolUseIdForDecision = typeof parsed.tool_use_id === "string" && parsed.tool_use_id !== "" ? parsed.tool_use_id : null;
  const caller = classifyCaller(parsed.agent_id);

  try {
    if (toolName === "Agent") {
      const result = evaluateAgent(toolInput, localPolicy.model_tiers);
      const ctx = {
        session_id: sessionIdForDecision,
        agent_id: agentIdForDecision,
        caller,
        tool_use_id: toolUseIdForDecision,
        subagent_type: result.subagentType,
        model: result.model,
        tier: result.tier,
        target_hash: safeHash(typeof result.subagentType === "string" ? result.subagentType : null),
      };
      if (result.ok) {
        try {
          const toolUseId = typeof parsed.tool_use_id === "string" && parsed.tool_use_id !== "" ? parsed.tool_use_id : null;
          if (toolUseId) {
            const sessionKey = ledger.resolveLedgerSessionKey(parsed.session_id);
            ledger.appendPendingRecord(sessionKey, {
              tool_use_id: toolUseId,
              model: result.model,
              tier: result.tier,
              subagent_type: result.subagentType,
              description: typeof toolInput.description === "string" ? toolInput.description : null,
              session_id: typeof parsed.session_id === "string" ? parsed.session_id : null,
              ts: new Date().toISOString(),
            });
          }
        } catch (_) {
          // Ledger capture failure must never block an otherwise-allowed dispatch.
        }
        allow(toolName, { subagent_type: result.subagentType, model: result.model, tier: result.tier }, ctx);
      } else {
        block(result.findings, toolName, { subagent_type: result.subagentType, model: result.model }, ctx);
      }
      return;
    }

    if (toolName === "SendMessage") {
      const result = evaluateSendMessage(toolInput);
      const ctx = {
        session_id: sessionIdForDecision,
        agent_id: agentIdForDecision,
        caller,
        tool_use_id: toolUseIdForDecision,
      };
      if (result.ok) {
        allow(toolName, {}, ctx);
      } else {
        block(result.findings, toolName, {}, ctx);
      }
      return;
    }

    // Defensive branch: anything else (including a missing/empty tool_name
    // after a successful parse) hits this block, NOT fail-open.
    block(
      [{ id: "unexpected_tool_name", detail: `unexpected tool_name "${toolName}" reached this hook (matcher should be Agent|SendMessage only).` }],
      toolName || "(missing)",
      {},
      { session_id: sessionIdForDecision, agent_id: agentIdForDecision, caller, tool_use_id: toolUseIdForDecision }
    );
  } catch (internalErr) {
    appendDebug({
      ts: new Date().toISOString(),
      event: "block",
      tool_name: toolName,
      finding_ids: ["internal_exception"],
      message: String((internalErr && internalErr.message) || internalErr),
    });
    logDecision(
      decisionRecord({
        event: "block",
        tool_name: toolName,
        finding_ids: ["internal_exception"],
        session_id: sessionIdForDecision,
        agent_id: agentIdForDecision,
        caller,
        tool_use_id: toolUseIdForDecision,
      })
    );
    process.stderr.write("agent-model-routing-guard: BLOCKED — internal error during classification — treat as block.\n");
    process.exit(2);
  }
}

if (require.main === module) {
  // captureStdin() is no longer called here: main() calls it itself now
  // (see the comment above its definition) so both installed entry points
  // — this direct invocation and agent-model-routing-guard-subagentstart.js's
  // require(...).main() shim — capture stdin exactly once, in the same
  // place, regardless of which one runs.
  try {
    main();
  } catch (topErr) {
    try {
      appendDebug({
        ts: new Date().toISOString(),
        event: "block",
        finding_ids: ["top_level_exception"],
        message: String((topErr && topErr.message) || topErr),
      });
      process.stderr.write("agent-model-routing-guard: BLOCKED — internal error during classification — treat as block.\n");
    } catch (_) {}
    // §2.1 R1 — best-effort session recovery from the raw stdin captured
    // before main() ran. safeCrash() (see the wrapper block near the top
    // of this file) already never throws — a missing module, a
    // non-function export, or a throwing appendCrashRecord are all
    // absorbed there — so no further try/catch is needed at this, the
    // guard's last line of defense before its own exit code below, which
    // is decided independently of whether this call did anything at all.
    safeCrash(rawStdinBuffer, "agent-model-routing-guard", GUARD_VERSION);
    process.exit(2);
  }
}

module.exports = {
  GUARD_VERSION,
  main,
  evaluateAgent,
  evaluateSendMessage,
  resolveTierForModel,
  findBareLineMatches,
  computeFenceMask,
  stripBlockquoteMarkers,
  normalizeLineEndings,
  handleSubagentStart,
  isBlankAfterStrip,
};

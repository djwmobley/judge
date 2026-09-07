#!/usr/bin/env node
"use strict";
// routing-scorecard.js
// docs/specs/routing-scorecard.md §5 — read-only reporting CLI over the
// decision ledger hooks/model-routing-guards.decisions.js writes (§2).
// Never writes to STATE_DIR, never calls appendDecision, never deletes or
// rotates a ledger file — sweeping stays exclusively appendDecision's job.
//
// Usage:
//   node scripts/routing-scorecard.js [--window Nd] [--since ISO] [--until ISO]
//     [--session <id>] [--per-session|--aggregate] [--json|--text]
//     [--state-dir <path>] [--fail-on-threshold]

const fs = require("fs");
const path = require("path");

const decisionsModule = require("../hooks/model-routing-guards.decisions.js");
const DEFAULT_STATE_DIR = decisionsModule.STATE_DIR;
const LEDGER_PREFIX = decisionsModule.LEDGER_PREFIX; // "routing-decisions."
const LEDGER_SUFFIX = decisionsModule.LEDGER_SUFFIX; // ".jsonl"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── §3 total event enumeration, per guard ─────────────────────────────────

const GUARD_EVENTS = {
  "orchestrator-tool-guard": new Set(["fail_open", "exempt_subagent", "block", "allow", "orchestrator_direct_shell", "guard_crash"]),
  "agent-model-routing-guard": new Set(["fail_open", "block", "allow", "guard_crash"]),
  "agent-adversary-floor": new Set([
    "fail_open",
    "allow_exempt_type",
    "block",
    "allow",
    "allow_sendmessage_not_workassignment",
    "allow_out_of_scope_tool_name",
    "guard_crash",
  ]),
};
const KNOWN_GUARDS = new Set(Object.keys(GUARD_EVENTS));

// §4.3's allow-shaped pairing set (win-resolving candidates).
const ALLOW_SHAPED_FOR_PAIRING = new Set([
  "allow",
  "exempt_subagent",
  "allow_exempt_type",
  "orchestrator_direct_shell",
  "allow_sendmessage_not_workassignment",
  "allow_out_of_scope_tool_name",
]);
// §4.8's by_design_allow set — orchestrator_direct_shell is deliberately
// excluded (it is escape-only, per §4.6, never by_design_allow).
const BY_DESIGN_ALLOW_EVENTS = new Set([
  "allow",
  "exempt_subagent",
  "allow_exempt_type",
  "allow_sendmessage_not_workassignment",
  "allow_out_of_scope_tool_name",
]);

const GLOBAL_FALLBACK_KEY_RE = /^global-\d{4}-\d{2}-\d{2}$/;
const LEDGER_FILENAME_RE = /^routing-decisions\.(.+)\.([0-9a-f]{8})\.jsonl$/;

// ═══════════════════════════════════════════════════════════════════════════
// Arg parsing
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const flags = {
    window: "7d",
    since: null,
    until: null,
    session: null,
    perSession: false,
    json: false,
    stateDir: null,
    failOnThreshold: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--window":
        flags.window = argv[++i];
        break;
      case "--since":
        flags.since = argv[++i];
        break;
      case "--until":
        flags.until = argv[++i];
        break;
      case "--session":
        flags.session = argv[++i];
        break;
      case "--per-session":
        flags.perSession = true;
        break;
      case "--aggregate":
        flags.perSession = false;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--text":
        flags.json = false;
        break;
      case "--state-dir":
        flags.stateDir = argv[++i];
        break;
      case "--fail-on-threshold":
        flags.failOnThreshold = true;
        break;
      default:
        // Unknown flags are ignored rather than fatal — this is a
        // read-only diagnostic tool, not a strict CLI contract.
        break;
    }
  }
  return flags;
}

/** Resolve the [sinceMs, untilMs) report window from flags. */
function resolveWindow(flags, nowMs) {
  const until = flags.until ? Date.parse(flags.until) : nowMs;
  let since;
  if (flags.since) {
    since = Date.parse(flags.since);
  } else {
    const m = /^(\d+)d$/.exec(flags.window || "7d");
    const days = m ? parseInt(m[1], 10) : 7;
    since = until - days * 24 * 60 * 60 * 1000;
  }
  return { sinceMs: since, untilMs: until };
}

// ═══════════════════════════════════════════════════════════════════════════
// Reading + normalizing the ledger (§5.2)
// ═══════════════════════════════════════════════════════════════════════════

/** Apply the §2.3 defaults table on read, per §5.2. `raw` is already a
 * parsed JSON value; a non-object (including arrays) is treated by the
 * caller as malformed, never reaching this function. */
function normalizeRecord(raw) {
  const r = raw;
  return {
    v: typeof r.v === "number" ? r.v : 1,
    ts: typeof r.ts === "string" ? r.ts : null,
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
    pid: typeof r.pid === "number" ? r.pid : null,
  };
}

function listLedgerFiles(stateDir) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (_) {
    return [];
  }
  return names.filter((f) => f.startsWith(LEDGER_PREFIX) && f.endsWith(LEDGER_SUFFIX)).map((f) => path.join(stateDir, f));
}

/**
 * Read every routing-decisions.*.jsonl file under `stateDir`. Returns
 * `{ records, malformedCount }` where `records` includes BOTH well-formed
 * normalized records (tagged `sourceIsGlobalFile`, `readOrder`) and
 * malformed placeholder entries (`{ malformed: true, sourceIsGlobalFile,
 * readOrder }`) for a line that is not valid JSON or parses to a
 * non-object (§5.2). A malformed line, and a well-formed line whose `ts`
 * cannot be parsed as a date, can never be positioned in real time, so
 * BOTH are treated as always-in-window (never dropped, per §4.10 "always
 * counted; never dropped") rather than silently excluded by the window
 * filter applied to every other record — see this file's own §7.2 note in
 * the test suite for why a `ts`-less well-formed object is grouped with
 * malformed lines for windowing purposes even though §5.2's literal
 * malformed definition (JSON-parse failure / non-object) does not itself
 * name it.
 */
function readAllRecords(stateDir) {
  let readOrder = 0;
  const records = [];
  let malformedCount = 0;

  for (const file of listLedgerFiles(stateDir)) {
    const base = path.basename(file);
    const m = LEDGER_FILENAME_RE.exec(base);
    const sanitizedKey = m ? m[1] : "";
    const sourceIsGlobalFile = GLOBAL_FALLBACK_KEY_RE.test(sanitizedKey);

    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed;
      let parseOk = true;
      try {
        parsed = JSON.parse(line);
      } catch (_) {
        parseOk = false;
      }
      if (!parseOk || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformedCount++;
        records.push({ malformed: true, sourceIsGlobalFile, readOrder: readOrder++, tsMs: null, alwaysInWindow: true });
        continue;
      }
      const rec = normalizeRecord(parsed);
      const tsMs = rec.ts ? Date.parse(rec.ts) : NaN;
      const tsValid = Number.isFinite(tsMs);
      records.push(
        Object.assign({ malformed: false, sourceIsGlobalFile, readOrder: readOrder++, tsMs: tsValid ? tsMs : null, alwaysInWindow: !tsValid }, rec)
      );
    }
  }
  return { records, malformedCount };
}

function inWindow(rec, sinceMs, untilMs) {
  if (rec.alwaysInWindow) return true;
  return rec.tsMs >= sinceMs && rec.tsMs < untilMs;
}

// ═══════════════════════════════════════════════════════════════════════════
// Classification (§4)
// ═══════════════════════════════════════════════════════════════════════════

function isHealthFailure(rec) {
  if (rec.malformed) return false; // malformed lines are their own bucket (§4.10), not health_failure.
  return rec.event === "guard_crash" || rec.sourceIsGlobalFile === true;
}

function isKnownEnumeration(rec) {
  if (!KNOWN_GUARDS.has(rec.guard)) return false;
  return GUARD_EVENTS[rec.guard].has(rec.event);
}

function pairingKeyOf(rec) {
  if (rec.tool_name === "Agent" || rec.tool_name === "SendMessage") return rec.subagent_type;
  return rec.target_hash;
}

function buildTupleKey(rec) {
  const sortedFindings = (rec.finding_ids || []).slice().sort().join(",");
  return `${rec.guard} ${rec.tool_name} ${rec.target_hash} ${sortedFindings}`;
}

function streamKeyOf(rec) {
  const sid = rec.session_id === null ? " nosession" : rec.session_id;
  const partition = rec.agent_id !== null && rec.agent_id !== undefined ? rec.agent_id : rec.caller;
  return `${sid} ${partition}`;
}

/** §4.2/§4.3 — build block runs per stream over the SORTED per-stream
 * sequence (ts ascending, readOrder tie-break). Returns
 * { wonRuns, lostRuns, blockRecordCount }; mutates each consumed
 * allow-shaped record with `__consumedAsWinResolver = true`. */
function buildRuns(scoreableRecords) {
  const byStream = new Map();
  for (const rec of scoreableRecords) {
    const key = streamKeyOf(rec);
    if (!byStream.has(key)) byStream.set(key, []);
    byStream.get(key).push(rec);
  }

  const wonRuns = [];
  const lostRuns = [];
  let blockRecordCount = 0;

  for (const streamRecords of byStream.values()) {
    streamRecords.sort((a, b) => {
      if (a.tsMs !== b.tsMs) return (a.tsMs || 0) - (b.tsMs || 0);
      return a.readOrder - b.readOrder;
    });

    const openByTupleKey = new Map();
    let seq = 0;
    for (const rec of streamRecords) {
      if (rec.event === "block") {
        blockRecordCount++;
        const tupleKey = buildTupleKey(rec);
        let run = openByTupleKey.get(tupleKey);
        if (!run) {
          run = {
            guard: rec.guard,
            tool_name: rec.tool_name,
            target_hash: rec.target_hash,
            pairingKey: pairingKeyOf(rec),
            records: [],
            startSeq: seq,
          };
          openByTupleKey.set(tupleKey, run);
        }
        run.records.push(rec);
      } else if (ALLOW_SHAPED_FOR_PAIRING.has(rec.event)) {
        const pk = pairingKeyOf(rec);
        let best = null;
        let bestTupleKey = null;
        for (const [tupleKey, run] of openByTupleKey.entries()) {
          if (run.guard === rec.guard && run.pairingKey === pk) {
            if (!best || run.startSeq < best.startSeq) {
              best = run;
              bestTupleKey = tupleKey;
            }
          }
        }
        if (best) {
          openByTupleKey.delete(bestTupleKey);
          wonRuns.push(best);
          rec.__consumedAsWinResolver = true;
        }
      }
      seq++;
    }
    for (const run of openByTupleKey.values()) lostRuns.push(run);
  }

  return { wonRuns, lostRuns, blockRecordCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// Report computation
// ═══════════════════════════════════════════════════════════════════════════

function rate(numerator, denominator) {
  if (denominator === 0) return { value: null, denominator: 0 };
  return { value: numerator / denominator, denominator };
}

/**
 * Compute the full report shape over `windowRecords` (already
 * window-filtered, and — for --session — already session-filtered).
 * `totalDecisions` is the count of ALL records in scope (including
 * malformed) — matches the header's `decisions: <count>` line.
 */
function computeReport(windowRecords, totalDecisions, malformedCount) {
  const healthFailureRecords = [];
  const unknownRecords = [];
  const scoreable = [];

  for (const rec of windowRecords) {
    if (rec.malformed) {
      unknownRecords.push(rec);
      continue;
    }
    if (isHealthFailure(rec)) {
      healthFailureRecords.push(rec);
      continue;
    }
    if (!isKnownEnumeration(rec)) {
      unknownRecords.push(rec);
      continue;
    }
    scoreable.push(rec);
  }

  const { wonRuns, lostRuns, blockRecordCount } = buildRuns(scoreable);
  const totalRuns = wonRuns.length + lostRuns.length;
  const frictionBlocks = wonRuns.concat(lostRuns).reduce((sum, r) => sum + Math.max(0, r.records.length - 1), 0);
  const frictionRuns = wonRuns.concat(lostRuns).filter((r) => r.records.length >= 2).length;

  const escapeRecords = scoreable.filter((r) => r.event === "fail_open" || r.event === "orchestrator_direct_shell");
  const byDesignAllowRecords = scoreable.filter((r) => BY_DESIGN_ALLOW_EVENTS.has(r.event) && !r.__consumedAsWinResolver);
  const failOpenRecords = scoreable.filter((r) => r.event === "fail_open");
  const writeEditDirectBlocks = scoreable.filter((r) => r.event === "block" && (r.tool_name === "Write" || r.tool_name === "Edit"));
  const orchestratorDirectShellRecords = scoreable.filter((r) => r.event === "orchestrator_direct_shell");

  // Per-guard breakdown.
  const perGuard = {};
  for (const g of Object.keys(GUARD_EVENTS)) {
    perGuard[g] = { allow: 0, block: 0, by_design_allow: 0, escape: 0, health_failure: 0, unknown: 0 };
  }
  const ensureGuardBucket = (g) => {
    if (!perGuard[g]) perGuard[g] = { allow: 0, block: 0, by_design_allow: 0, escape: 0, health_failure: 0, unknown: 0 };
    return perGuard[g];
  };
  for (const rec of scoreable) {
    const bucket = ensureGuardBucket(rec.guard);
    if (rec.event === "allow") bucket.allow++;
    else if (rec.event === "block") bucket.block++;
    if (BY_DESIGN_ALLOW_EVENTS.has(rec.event) && !rec.__consumedAsWinResolver) bucket.by_design_allow++;
    if (rec.event === "fail_open" || rec.event === "orchestrator_direct_shell") bucket.escape++;
  }
  for (const rec of healthFailureRecords) {
    ensureGuardBucket(rec.guard).health_failure++;
  }
  for (const rec of unknownRecords) {
    if (rec.malformed) continue; // no guard to attribute a malformed line to.
    ensureGuardBucket(rec.guard).unknown++;
  }

  // Top finding_ids.
  const findingCounts = new Map();
  for (const rec of scoreable) {
    for (const id of rec.finding_ids || []) {
      findingCounts.set(id, (findingCounts.get(id) || 0) + 1);
    }
  }
  const topFindingIds = Array.from(findingCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([id, count]) => ({ id, count }));

  const escapeEvents = escapeRecords
    .slice()
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0) || a.readOrder - b.readOrder)
    .map((r) => ({ ts: r.ts, guard: r.guard, event: r.event, reason: r.reason, session_id: r.session_id }));

  const crashRecords = healthFailureRecords
    .slice()
    .sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0) || a.readOrder - b.readOrder)
    .map((r) => ({ ts: r.ts, guard: r.guard, event: r.event, reason: r.reason, session_id: r.session_id === null ? "unattributed" : r.session_id }));

  const winRate = rate(wonRuns.length, totalRuns);
  const frictionRate = rate(frictionBlocks, blockRecordCount);
  const escapeRate = rate(escapeRecords.length, totalDecisions);
  const failOpenRate = rate(failOpenRecords.length, totalDecisions);

  const sessions = new Set();
  for (const rec of windowRecords) {
    if (!rec.malformed && typeof rec.session_id === "string" && rec.session_id !== "") sessions.add(rec.session_id);
  }

  return {
    totalDecisions,
    malformedCount,
    sessionsCount: sessions.size,
    healthFailureCount: healthFailureRecords.length,
    unknownCount: unknownRecords.length,
    blockRecordCount,
    totalRuns,
    wonRuns: wonRuns.length,
    lostRuns: lostRuns.length,
    frictionRuns,
    frictionBlocks,
    winRate,
    frictionRate,
    escapeRate,
    failOpenRate,
    escapeCount: escapeRecords.length,
    failOpenCount: failOpenRecords.length,
    byDesignAllowCount: byDesignAllowRecords.length,
    perGuard,
    topFindingIds,
    escapeEvents,
    crashRecords,
    writeEditDirectBlockCount: writeEditDirectBlocks.length,
    orchestratorDirectShellCount: orchestratorDirectShellRecords.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Signals (§4.11)
// ═══════════════════════════════════════════════════════════════════════════

function verdictOfRate(value, thresholds) {
  // thresholds: { pass: (v)=>bool, watch: (v)=>bool } — fail is the else.
  if (value === null) return "n/a";
  if (thresholds.pass(value)) return "PASS";
  if (thresholds.watch && thresholds.watch(value)) return "WATCH";
  return "FAIL";
}

function trendClassify(currentCount, priorCount) {
  if (currentCount <= priorCount) return "ok";
  if (priorCount === 0) return "fail"; // increase from zero — cannot be within 10%.
  const pct = (currentCount - priorCount) / priorCount;
  return pct <= 0.1 ? "watch" : "fail";
}

/**
 * Compute the 5 signals and the aggregate verdict. `report` is the current
 * window's computeReport() result; `priorReport` is the same shape for the
 * prior equal-length window (or null when unavailable/inapplicable —
 * trend components fall back to n/a per owner ruling R7).
 */
function computeSignals(report, priorReport, isSessionScoped) {
  // §4.11/§5.3 owner ruling R8 — 0 decisions in window short-circuits to
  // NO-DATA before any per-signal denominator is evaluated at all: every
  // signal is n/a, none counts toward "N of 5 signals evaluated".
  if (report.totalDecisions === 0) {
    const naSignals = [
      { n: 1, name: "escape rate", rating: "n/a", value: null, denominator: 0, threshold: "<2%", evaluated: false },
      { n: 2, name: "win rate", rating: "n/a", value: null, denominator: 0, threshold: ">=70%", evaluated: false },
      { n: 3, name: "friction rate", rating: "n/a", value: null, denominator: 0, threshold: "<=15%", evaluated: false },
      { n: 4, name: "orchestrator-direct trend", rating: "n/a", value: null, denominator: 0, threshold: "non-increasing", evaluated: false },
      { n: 5, name: "health", rating: "n/a", value: null, denominator: 0, threshold: "fail_open<=0.5%, malformed==0", evaluated: false, malformed_count: report.malformedCount },
    ];
    return { signals: naSignals, signalsEvaluated: 0, verdict: "NO-DATA" };
  }

  const signals = [];
  const trendEligible = !isSessionScoped && report.sessionsCount >= 2 && priorReport !== null;

  // Signal 1 — escape rate.
  {
    const denom = report.totalDecisions;
    if (denom === 0) {
      signals.push({ n: 1, name: "escape rate", rating: "n/a", value: null, denominator: 0, threshold: "<2%", evaluated: false });
    } else {
      const currentRate = report.escapeCount / denom;
      const priorDenom = priorReport ? priorReport.totalDecisions : 0;
      const trendComputable = trendEligible && priorDenom > 0;
      let rating;
      let trendNote = "n/a";
      if (!trendComputable) {
        rating = currentRate < 0.02 ? "PASS" : "FAIL";
      } else {
        const priorRate = priorReport.escapeCount / priorDenom;
        const falling = currentRate < priorRate;
        trendNote = falling ? "falling" : "not falling";
        if (currentRate < 0.02 && falling) rating = "PASS";
        else if (currentRate < 0.02 && !falling) rating = "WATCH";
        else rating = "FAIL";
      }
      signals.push({
        n: 1,
        name: "escape rate",
        rating,
        value: currentRate,
        denominator: denom,
        threshold: "<2%",
        trend: trendNote,
        evaluated: true,
      });
    }
  }

  // Signal 2 — win rate.
  {
    const denom = report.totalRuns;
    if (denom === 0) {
      signals.push({ n: 2, name: "win rate", rating: "n/a", value: null, denominator: 0, threshold: ">=70%", evaluated: false });
    } else {
      const v = report.wonRuns / denom;
      const rating = v >= 0.7 ? "PASS" : v >= 0.5 ? "WATCH" : "FAIL";
      signals.push({ n: 2, name: "win rate", rating, value: v, denominator: denom, threshold: ">=70%", evaluated: true });
    }
  }

  // Signal 3 — friction rate.
  {
    const denom = report.blockRecordCount;
    if (denom === 0) {
      signals.push({ n: 3, name: "friction rate", rating: "n/a", value: null, denominator: 0, threshold: "<=15%", evaluated: false });
    } else {
      const v = report.frictionBlocks / denom;
      const rating = v <= 0.15 ? "PASS" : v <= 0.25 ? "WATCH" : "FAIL";
      signals.push({ n: 3, name: "friction rate", rating, value: v, denominator: denom, threshold: "<=15%", evaluated: true });
    }
  }

  // Signal 4 — orchestrator-direct trend.
  {
    if (!trendEligible) {
      signals.push({ n: 4, name: "orchestrator-direct trend", rating: "n/a", value: null, denominator: 0, threshold: "non-increasing", evaluated: false });
    } else {
      const t1 = trendClassify(report.writeEditDirectBlockCount, priorReport.writeEditDirectBlockCount);
      const t2 = trendClassify(report.orchestratorDirectShellCount, priorReport.orchestratorDirectShellCount);
      let rating;
      if (t1 === "fail" || t2 === "fail") rating = "FAIL";
      else if (t1 === "watch" || t2 === "watch") rating = "WATCH";
      else rating = "PASS";
      signals.push({
        n: 4,
        name: "orchestrator-direct trend",
        rating,
        value: null,
        denominator: null,
        threshold: "non-increasing",
        evaluated: true,
      });
    }
  }

  // Signal 5 — health.
  {
    const denom = report.totalDecisions;
    const failOpenRate = denom === 0 ? null : report.failOpenCount / denom;
    const failOpenOk = denom === 0 ? true : failOpenRate <= 0.005;
    const malformedOk = report.malformedCount === 0;
    const rating = failOpenOk && malformedOk ? "PASS" : "FAIL";
    signals.push({
      n: 5,
      name: "health",
      rating,
      value: failOpenRate,
      denominator: denom,
      threshold: "fail_open<=0.5%, malformed==0",
      evaluated: true,
      malformed_count: report.malformedCount,
    });
  }

  const evaluated = signals.filter((s) => s.evaluated);
  let verdict;
  if (evaluated.some((s) => s.rating === "FAIL")) {
    verdict = "FAIL";
  } else if (evaluated.some((s) => s.rating === "WATCH")) {
    verdict = "WATCH";
  } else {
    verdict = "PASS";
  }

  return { signals, signalsEvaluated: evaluated.length, verdict };
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

function pct(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}
function pct1(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatText(windowLabel, report, signalsResult, sessionLabel) {
  const lines = [];
  lines.push(`routing-scorecard — window: ${windowLabel}`);
  const sessLine = sessionLabel ? `session: ${sessionLabel}` : `sessions: ${report.sessionsCount}`;
  lines.push(`${sessLine}   decisions: ${report.totalDecisions} (${report.malformedCount} malformed)`);
  lines.push("");

  if (report.totalDecisions === 0) {
    lines.push(`Verdict: NO-DATA (0 decisions in window)`);
    return lines.join("\n");
  }

  lines.push("Health");
  const s5 = signalsResult.signals[4];
  lines.push(
    `  fail_open rate:      ${pct(report.failOpenRate.value)}  (${report.failOpenCount} / ${report.failOpenRate.denominator} decisions, threshold <=0.50%)   [${s5.rating}]`
  );
  lines.push(`  malformed lines:     ${report.malformedCount}      (threshold ==0)                         [${report.malformedCount === 0 ? "PASS" : "FAIL"}]`);
  lines.push(`  health_failure:      ${report.healthFailureCount}      (crash records + global-fallback records — never scored as a block run, win, loss, or friction; see §4.7)`);
  lines.push("");

  lines.push("Wins / Losses / Friction");
  const s2 = signalsResult.signals[1];
  const s3 = signalsResult.signals[2];
  lines.push(`  block records:  ${report.blockRecordCount}`);
  lines.push(`  runs:            ${report.totalRuns}`);
  lines.push(`  won runs:        ${report.wonRuns}  (${pct1(report.winRate.value)} of runs, threshold >=70%)                [${s2.rating}]`);
  lines.push(`  lost runs:       ${report.lostRuns}`);
  lines.push(`  friction_runs:    ${report.frictionRuns}`);
  lines.push(`  friction_blocks:  ${report.frictionBlocks}  (${pct1(report.frictionRate.value)} of block records, threshold <=15%)      [${s3.rating}]`);
  lines.push("");

  lines.push("Per-guard breakdown");
  for (const guard of Object.keys(report.perGuard)) {
    const b = report.perGuard[guard];
    lines.push(`  ${guard}  allow:${b.allow}  block:${b.block}  by_design_allow:${b.by_design_allow}  escape:${b.escape}  health_failure:${b.health_failure}  unknown:${b.unknown}`);
  }
  lines.push("");

  lines.push("Top finding_ids");
  if (report.topFindingIds.length === 0) {
    lines.push("  (none)");
  } else {
    report.topFindingIds.forEach((f, i) => lines.push(`  ${i + 1}. ${f.id}  ${f.count}x`));
  }
  lines.push("");

  const shownEscapes = report.escapeEvents.slice(0, 20);
  const moreEscapes = report.escapeEvents.length - shownEscapes.length;
  lines.push(`Escape events (up to 20 shown, ${moreEscapes} more not shown)`);
  if (shownEscapes.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of shownEscapes) {
      lines.push(`  ${e.ts}  ${e.guard}  ${e.event}  ${e.reason}  session:${e.session_id}`);
    }
  }
  lines.push("");

  const shownCrash = report.crashRecords.slice(0, 20);
  const moreCrash = report.crashRecords.length - shownCrash.length;
  lines.push(`Crash records (guard_crash + global-fallback, up to 20 shown, ${moreCrash} more not shown)`);
  if (shownCrash.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of shownCrash) {
      lines.push(`  ${c.ts}  ${c.guard}  ${c.event}  ${c.reason}  session:${c.session_id}`);
    }
  }
  lines.push("");

  lines.push(`Verdict: ${signalsResult.verdict}  (${signalsResult.signalsEvaluated} of 5 signals evaluated)`);
  for (const s of signalsResult.signals) {
    if (s.n === 1) {
      lines.push(`  1. escape rate: ${s.rating === "n/a" ? "n/a" : `${pct(s.value)} (threshold ${s.threshold}, trend ${s.trend || "n/a"}) [${s.rating}]`}`);
    } else if (s.n === 2) {
      lines.push(`  2. win rate: ${s.rating === "n/a" ? "n/a" : `${pct(s.value)} (threshold ${s.threshold}) [${s.rating}]`}`);
    } else if (s.n === 3) {
      lines.push(`  3. friction rate: ${s.rating === "n/a" ? "n/a" : `${pct(s.value)} (threshold ${s.threshold}) [${s.rating}]`}`);
    } else if (s.n === 4) {
      lines.push(`  4. orchestrator-direct trend: ${s.rating === "n/a" ? "n/a" : `[${s.rating}]`}`);
    } else if (s.n === 5) {
      lines.push(`  5. health: ${pct(s.value)} fail_open (${s.malformed_count} malformed) [${s.rating}]`);
    }
  }

  return lines.join("\n");
}

function reportToJson(windowLabel, since, until, report, signalsResult, sessionLabel) {
  return {
    window: { label: windowLabel, since, until },
    session: sessionLabel || null,
    sessions: report.sessionsCount,
    decisions: report.totalDecisions,
    malformed: report.malformedCount,
    health: {
      fail_open_rate: report.failOpenRate.value,
      fail_open_rate_denominator: report.failOpenRate.denominator,
      malformed_count: report.malformedCount,
      health_failure_count: report.healthFailureCount,
    },
    runs_wins_losses_friction: {
      block_records: report.blockRecordCount,
      runs: report.totalRuns,
      won_runs: report.wonRuns,
      lost_runs: report.lostRuns,
      friction_runs: report.frictionRuns,
      friction_blocks: report.frictionBlocks,
      win_rate: report.winRate.value,
      win_rate_denominator: report.winRate.denominator,
      friction_rate: report.frictionRate.value,
      friction_rate_denominator: report.frictionRate.denominator,
    },
    per_guard: report.perGuard,
    top_finding_ids: report.topFindingIds,
    escape_events: report.escapeEvents,
    crash_records: report.crashRecords,
    signals_evaluated: signalsResult.signalsEvaluated,
    signals: signalsResult.signals,
    verdict: signalsResult.verdict,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════════

function filterRecords(allRecords, sinceMs, untilMs, sessionFilter) {
  return allRecords.filter((rec) => {
    if (!inWindow(rec, sinceMs, untilMs)) return false;
    if (sessionFilter) {
      if (rec.malformed) return false; // unattributable — can never match a specific session.
      return rec.session_id === sessionFilter;
    }
    return true;
  });
}

function countMalformed(records) {
  return records.filter((r) => r.malformed).length;
}

function run(argv, opts) {
  opts = opts || {};
  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const flags = parseArgs(argv);
  const stateDir = flags.stateDir || opts.defaultStateDir || DEFAULT_STATE_DIR;
  const { sinceMs, untilMs } = resolveWindow(flags, nowMs);

  const { records: allRecords } = readAllRecords(stateDir);

  const windowRecords = filterRecords(allRecords, sinceMs, untilMs, flags.session);
  const report = computeReport(windowRecords, windowRecords.length, countMalformed(windowRecords));

  const windowLengthMs = untilMs - sinceMs;
  const priorSinceMs = sinceMs - windowLengthMs;
  const priorUntilMs = sinceMs;
  let priorReport = null;
  if (!flags.session) {
    const priorRecords = filterRecords(allRecords, priorSinceMs, priorUntilMs, null);
    priorReport = computeReport(priorRecords, priorRecords.length, countMalformed(priorRecords));
  }

  const signalsResult = computeSignals(report, priorReport, !!flags.session);

  const windowDaysLabel = Math.round(windowLengthMs / (24 * 60 * 60 * 1000));
  const windowLabel = `${new Date(sinceMs).toISOString()} .. ${new Date(untilMs).toISOString()} (${windowDaysLabel}d)`;

  const outputs = [];

  if (flags.perSession && !flags.session) {
    const sessionIds = Array.from(
      new Set(windowRecords.filter((r) => !r.malformed && typeof r.session_id === "string" && r.session_id !== "").map((r) => r.session_id))
    ).sort();
    for (const sid of sessionIds) {
      const sessRecords = windowRecords.filter((r) => !r.malformed && r.session_id === sid);
      const sessReport = computeReport(sessRecords, sessRecords.length, countMalformed(sessRecords));
      const sessSignals = computeSignals(sessReport, null, true);
      outputs.push({ sessionLabel: sid, report: sessReport, signalsResult: sessSignals });
    }
  } else {
    outputs.push({ sessionLabel: flags.session || null, report, signalsResult });
  }

  let text;
  let jsonObj;
  if (flags.json) {
    if (outputs.length === 1) {
      jsonObj = reportToJson(windowLabel, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString(), outputs[0].report, outputs[0].signalsResult, outputs[0].sessionLabel);
    } else {
      jsonObj = {
        window: { label: windowLabel, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
        per_session: outputs.map((o) =>
          reportToJson(windowLabel, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString(), o.report, o.signalsResult, o.sessionLabel)
        ),
      };
    }
    text = JSON.stringify(jsonObj, null, 2);
  } else {
    text = outputs
      .map((o) => {
        const header = o.sessionLabel && outputs.length > 1 ? `Session: ${o.sessionLabel}\n` : "";
        return header + formatText(windowLabel, o.report, o.signalsResult, o.sessionLabel);
      })
      .join("\n\n");
  }

  const overallVerdict = outputs.length === 1 ? outputs[0].signalsResult.verdict : null;
  return { text, verdict: overallVerdict, outputs };
}

function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const { text, outputs } = run(argv);
  console.log(text);
  if (flags.failOnThreshold) {
    const anyFail = outputs.some((o) => o.signalsResult.verdict === "FAIL");
    if (anyFail) process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  resolveWindow,
  normalizeRecord,
  listLedgerFiles,
  readAllRecords,
  inWindow,
  isHealthFailure,
  isKnownEnumeration,
  buildTupleKey,
  pairingKeyOf,
  streamKeyOf,
  buildRuns,
  computeReport,
  computeSignals,
  formatText,
  reportToJson,
  filterRecords,
  run,
  GUARD_EVENTS,
  ALLOW_SHAPED_FOR_PAIRING,
  BY_DESIGN_ALLOW_EVENTS,
};

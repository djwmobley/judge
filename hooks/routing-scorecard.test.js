"use strict";
// routing-scorecard.test.js
// node:test suite for scripts/routing-scorecard.js (docs/specs/
// routing-scorecard.md §7.2). Lives in hooks/ rather than scripts/ or
// test/ — see docs/specs/routing-scorecard.md §7.2's own "Placement
// decision" note: scripts/run-tests.js's hooks/ discovery rule is
// `*.test.js` (matched here), keeping this file co-located with
// hooks/model-routing-guards.decisions.test.js, which it depends on as a
// fixture-shape reference, without adding a scripts/-scanning rule to the
// runner for the sake of one file.
//
// Fixtures are written directly as routing-decisions.*.jsonl files (not
// via appendDecision) so each test has full, deterministic control over
// `ts`/`session_id`/`agent_id`/target_hash shapes — the reader
// (scripts/routing-scorecard.js) never validates the `h8` filename
// component against a real hash, only the filename SHAPE, so a fixture's
// h8 need not be cryptographically genuine.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const sc = require("../scripts/routing-scorecard.js");
const decisionsModule = require("../hooks/model-routing-guards.decisions.js");

const SCRIPT = path.join(__dirname, "..", "scripts", "routing-scorecard.js");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsc-test-"));
}
function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (_) {}
}

let fileCounter = 0;
function fullRecord(partial) {
  return Object.assign(
    {
      v: 1,
      ts: new Date().toISOString(),
      guard: "orchestrator-tool-guard",
      guard_version: "1",
      event: "allow",
      session_id: null,
      agent_id: null,
      caller: "orchestrator",
      tool_name: null,
      subagent_type: null,
      tier: null,
      model: null,
      tool_use_id: null,
      target_hash: null,
      finding_ids: [],
      via: null,
      reason: null,
      pid: 1234,
    },
    partial
  );
}

/** Writes one routing-decisions.*.jsonl fixture file. `filenameKey` is the
 * sanitized-key filename component (e.g. a session id, or a literal
 * "global-YYYY-MM-DD" to simulate a health_failure fallback file). */
function writeLedgerFile(dir, filenameKey, records, h8) {
  fileCounter++;
  const hash = h8 || String(fileCounter).padStart(8, "0");
  const p = path.join(dir, `routing-decisions.${filenameKey}.${hash}.jsonl`);
  const lines = records.map((r) => JSON.stringify(fullRecord(r))).join("\n") + "\n";
  // fsync explicitly (not just writeFileSync) — this sandbox's temp
  // filesystem has shown a narrow visibility race where a file written by
  // one synchronous call is not yet visible to an immediately-following
  // fs.readdirSync/readFileSync from the same process; fsync closes that
  // gap deterministically rather than adding a retry/sleep to the reader.
  const fd = fs.openSync(p, "w");
  try {
    fs.writeSync(fd, lines);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  waitForFileVisible(p, lines);
  return p;
}

function isoMinutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

/** Same fsync-before-close durability as writeLedgerFile, for a fixture
 * file whose exact raw line content (e.g. deliberately malformed JSON)
 * writeLedgerFile's own fullRecord()-shaped serialization can't produce. */
function writeRawFile(p, content) {
  const fd = fs.openSync(p, "w");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  waitForFileVisible(p, content);
}

/** Busy-poll (no sleep — disk I/O this small resolves in well under a
 * millisecond once truly flushed) until a fresh fs.readFileSync of `p`
 * returns exactly `expectedContent`, or `timeoutMs` elapses. This sandbox's
 * temp filesystem has shown a narrow, intermittent visibility race — a
 * file fsync'd and closed in one synchronous call is not always
 * immediately visible, with matching content, to an fs.readdirSync +
 * fs.readFileSync pair issued moments later from the same process — not
 * reproducible against any single fixture in isolation, only across a
 * longer-running suite. This closes that gap at the write site,
 * deterministically, rather than adding retry logic to the reader under
 * test (scripts/routing-scorecard.js), which must stay a plain, one-shot
 * synchronous read to match every other reader in this repo.
 */
function waitForFileVisible(p, expectedContent, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  for (;;) {
    try {
      if (fs.readFileSync(p, "utf8") === expectedContent) return;
    } catch (_) {
      /* not yet visible — keep polling until the deadline. */
    }
    if (Date.now() > deadline) return; // give up; the caller's own assertions will surface the problem.
  }
}

// ══════════════════════════════════════════════════════════════════════════
// window_filtering
// ══════════════════════════════════════════════════════════════════════════

test("window_filtering: records with ts outside [--since, --until) are excluded from every count", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "allow", ts: isoMinutesAgo(500) }, // well before window
      { session_id: "s1", event: "allow", ts: isoMinutesAgo(30) }, // inside window
      { session_id: "s1", event: "allow", ts: isoMinutesAgo(-30) }, // in the future, after window
    ]);
    const since = isoMinutesAgo(60);
    const until = isoMinutesAgo(0);
    const { outputs } = sc.run(["--since", since, "--until", until, "--state-dir", dir]);
    assert.equal(outputs[0].report.totalDecisions, 1);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// run_pairing_* (owner ruling R4)
// ══════════════════════════════════════════════════════════════════════════

test("run_pairing_single_block_allow: one block + matching allow -> 1 run, 1 won, 0 loss, 0 friction", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "abc123", finding_ids: ["x"], ts: isoMinutesAgo(10) },
      { session_id: "s1", event: "allow", tool_name: "Edit", target_hash: "abc123", ts: isoMinutesAgo(5) },
    ]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.totalRuns, 1);
    assert.equal(r.wonRuns, 1);
    assert.equal(r.lostRuns, 0);
    assert.equal(r.frictionBlocks, 0);
    assert.equal(r.frictionRuns, 0);
  } finally {
    rmTree(dir);
  }
});

test("run_pairing_three_blocks_then_allow: 3 same-tuple blocks then 1 allow -> 1 run, 1 won, friction_blocks 2, friction_runs 1, 0 loss", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "abc123", finding_ids: ["x"], ts: isoMinutesAgo(30) },
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "abc123", finding_ids: ["x"], ts: isoMinutesAgo(20) },
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "abc123", finding_ids: ["x"], ts: isoMinutesAgo(10) },
      { session_id: "s1", event: "allow", tool_name: "Edit", target_hash: "abc123", ts: isoMinutesAgo(5) },
    ]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.totalRuns, 1);
    assert.equal(r.wonRuns, 1);
    assert.equal(r.lostRuns, 0);
    assert.equal(r.frictionBlocks, 2);
    assert.equal(r.frictionRuns, 1);
    assert.equal(r.blockRecordCount, 3);
  } finally {
    rmTree(dir);
  }
});

test("run_pairing_two_open_runs_one_allow: two distinct-key runs, one allow matches only one -> that one wins, the other stays lost", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "targetA", finding_ids: ["x"], ts: isoMinutesAgo(30) },
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "targetB", finding_ids: ["x"], ts: isoMinutesAgo(25) },
      { session_id: "s1", event: "allow", tool_name: "Edit", target_hash: "targetA", ts: isoMinutesAgo(5) },
    ]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.totalRuns, 2);
    assert.equal(r.wonRuns, 1);
    assert.equal(r.lostRuns, 1);
  } finally {
    rmTree(dir);
  }
});

test("run_pairing_never_resolved: a block run with no qualifying allow -> 1 lost run, 0 won, regardless of length", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "abc123", finding_ids: ["x"], ts: isoMinutesAgo(30) },
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "abc123", finding_ids: ["x"], ts: isoMinutesAgo(20) },
    ]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.totalRuns, 1);
    assert.equal(r.wonRuns, 0);
    assert.equal(r.lostRuns, 1);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// stream_separation_interleaved_agent_ids (owner ruling R5)
// ══════════════════════════════════════════════════════════════════════════

test("stream_separation_interleaved_agent_ids: distinct agent_ids resolve independently; null agent_id collapses into one stream and false-pairs", () => {
  const dirWithIds = mkTmpDir();
  const dirNullIds = mkTmpDir();
  try {
    // Same target_hash for both "agents" so a collapsed stream can
    // false-pair them; with agent_id populated, each is its own stream.
    const base = [
      { agent_id: "a1", event: "block", tool_name: "Edit", target_hash: "shared", finding_ids: ["x"], ts: isoMinutesAgo(40) },
      { agent_id: "a2", event: "block", tool_name: "Edit", target_hash: "shared", finding_ids: ["x"], ts: isoMinutesAgo(30) },
      { agent_id: "a1", event: "allow", tool_name: "Edit", target_hash: "shared", ts: isoMinutesAgo(20) },
      { agent_id: "a2", event: "allow", tool_name: "Edit", target_hash: "shared", ts: isoMinutesAgo(10) },
    ];
    writeLedgerFile(dirWithIds, "s1", base.map((r) => Object.assign({ session_id: "s1" }, r)));
    writeLedgerFile(
      dirNullIds,
      "s1",
      base.map((r) => Object.assign({ session_id: "s1" }, r, { agent_id: null, caller: "subagent" }))
    );

    const withIds = sc.run(["--state-dir", dirWithIds]).outputs[0].report;
    assert.equal(withIds.totalRuns, 2);
    assert.equal(withIds.wonRuns, 2);
    assert.equal(withIds.frictionBlocks, 0);

    const nullIds = sc.run(["--state-dir", dirNullIds]).outputs[0].report;
    // Collapsed into one stream: both blocks merge into ONE run (same
    // tuple), the first allow closes it (won, but length 2 -> 1 friction
    // block), and the second allow has nothing left to resolve (by_design_allow).
    assert.equal(nullIds.totalRuns, 1);
    assert.equal(nullIds.wonRuns, 1);
    assert.equal(nullIds.frictionBlocks, 1);
    assert.equal(nullIds.frictionRuns, 1);
    assert.notEqual(nullIds.wonRuns, withIds.wonRuns, "pinning: agent_id-populated and agent_id-null must NOT produce the same result");
  } finally {
    rmTree(dirWithIds);
    rmTree(dirNullIds);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// malformed_tolerance
// ══════════════════════════════════════════════════════════════════════════

test("malformed_tolerance: one corrupt JSON line + one unenumerated event -> both land in unknown, rest scores normally", () => {
  const dir = mkTmpDir();
  try {
    const p = path.join(dir, "routing-decisions.s1.aaaaaaaa.jsonl");
    const lines = [
      "not valid json {{{",
      JSON.stringify(fullRecord({ session_id: "s1", guard: "orchestrator-tool-guard", event: "totally_bogus_event" })),
      JSON.stringify(fullRecord({ session_id: "s1", event: "allow" })),
      JSON.stringify(fullRecord({ session_id: "s1", event: "allow" })),
    ];
    writeRawFile(p, lines.join("\n") + "\n");
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.malformedCount, 1);
    assert.equal(r.unknownCount, 2);
    assert.equal(r.totalDecisions, 4);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// filename_hash_and_record_grouping (owner ruling R3)
// ══════════════════════════════════════════════════════════════════════════

test("filename_hash_and_record_grouping: two files, same sanitized prefix, different h8 -> grouped by session_id field, never merged by filename", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "collidekey", [{ session_id: "sessA", event: "allow" }], "aaaaaaaa");
    writeLedgerFile(dir, "collidekey", [{ session_id: "sessB", event: "allow" }], "bbbbbbbb");

    const agg = sc.run(["--state-dir", dir]).outputs[0].report;
    assert.equal(agg.totalDecisions, 2);
    assert.equal(agg.sessionsCount, 2);

    const perSession = sc.run(["--state-dir", dir, "--per-session"]).outputs;
    assert.equal(perSession.length, 2);
    const labels = perSession.map((o) => o.sessionLabel).sort();
    assert.deepEqual(labels, ["sessA", "sessB"]);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// json_text_parity
// ══════════════════════════════════════════════════════════════════════════

test("json_text_parity: --json numeric fields match --text rendering, including n/a and NO-DATA", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "block", tool_name: "Edit", target_hash: "t1", finding_ids: ["x"] },
      { session_id: "s1", event: "allow", tool_name: "Edit", target_hash: "t1" },
      { session_id: "s1", event: "fail_open", reason: "stdin_read_error" },
    ]);
    const { outputs: jsonOutputs, text: jsonText } = sc.run(["--state-dir", dir, "--json"]);
    const { text: plainText } = sc.run(["--state-dir", dir, "--text"]);
    const parsed = JSON.parse(jsonText);

    assert.equal(parsed.decisions, jsonOutputs[0].report.totalDecisions);
    assert.match(plainText, new RegExp(`decisions: ${parsed.decisions} `));
    assert.equal(parsed.verdict, jsonOutputs[0].signalsResult.verdict);
    assert.match(plainText, new RegExp(`Verdict: ${parsed.verdict}`));
    assert.equal(parsed.runs_wins_losses_friction.won_runs, jsonOutputs[0].report.wonRuns);

    // NO-DATA shape.
    const emptyDir = mkTmpDir();
    try {
      const { outputs: emptyOutputs, text: emptyJsonText } = sc.run(["--state-dir", emptyDir, "--json"]);
      const emptyParsed = JSON.parse(emptyJsonText);
      assert.equal(emptyParsed.verdict, "NO-DATA");
      assert.equal(emptyOutputs[0].signalsResult.verdict, "NO-DATA");
    } finally {
      rmTree(emptyDir);
    }
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// threshold_verdicts
// ══════════════════════════════════════════════════════════════════════════

test("threshold_verdicts: signal 1 (escape rate) FAIL at >=2%, PASS below 2% (single-session, threshold-only)", () => {
  const dirFail = mkTmpDir();
  const dirPass = mkTmpDir();
  try {
    const recsFail = [];
    for (let i = 0; i < 97; i++) recsFail.push({ session_id: "s1", event: "allow" });
    for (let i = 0; i < 3; i++) recsFail.push({ session_id: "s1", event: "fail_open", reason: "internal_exception" });
    writeLedgerFile(dirFail, "s1", recsFail); // 3/100 = 3% >= 2%

    const recsPass = [];
    for (let i = 0; i < 99; i++) recsPass.push({ session_id: "s1", event: "allow" });
    recsPass.push({ session_id: "s1", event: "fail_open", reason: "internal_exception" });
    writeLedgerFile(dirPass, "s1", recsPass); // 1/100 = 1% < 2%

    const failSignal = sc.run(["--state-dir", dirFail]).outputs[0].signalsResult.signals[0];
    const passSignal = sc.run(["--state-dir", dirPass]).outputs[0].signalsResult.signals[0];
    assert.equal(failSignal.rating, "FAIL");
    assert.equal(passSignal.rating, "PASS");
  } finally {
    rmTree(dirFail);
    rmTree(dirPass);
  }
});

test("threshold_verdicts: signal 2 (win rate) PASS >=70%, WATCH in [50,70), FAIL <50%", () => {
  const dirs = { pass: mkTmpDir(), watch: mkTmpDir(), fail: mkTmpDir() };
  try {
    function buildRuns(wonCount, lostCount) {
      const recs = [];
      for (let i = 0; i < wonCount; i++) {
        recs.push({ session_id: "s1", event: "block", tool_name: "Edit", target_hash: `w${i}`, finding_ids: ["x"] });
        recs.push({ session_id: "s1", event: "allow", tool_name: "Edit", target_hash: `w${i}` });
      }
      for (let i = 0; i < lostCount; i++) {
        recs.push({ session_id: "s1", event: "block", tool_name: "Edit", target_hash: `l${i}`, finding_ids: ["x"] });
      }
      return recs;
    }
    writeLedgerFile(dirs.pass, "s1", buildRuns(8, 2)); // 80%
    writeLedgerFile(dirs.watch, "s1", buildRuns(6, 4)); // 60%
    writeLedgerFile(dirs.fail, "s1", buildRuns(3, 7)); // 30%

    assert.equal(sc.run(["--state-dir", dirs.pass]).outputs[0].signalsResult.signals[1].rating, "PASS");
    assert.equal(sc.run(["--state-dir", dirs.watch]).outputs[0].signalsResult.signals[1].rating, "WATCH");
    assert.equal(sc.run(["--state-dir", dirs.fail]).outputs[0].signalsResult.signals[1].rating, "FAIL");
  } finally {
    Object.values(dirs).forEach(rmTree);
  }
});

test("threshold_verdicts: signal 3 (friction rate) PASS <=15%, WATCH in (15,25], FAIL >25%", () => {
  const dirs = { pass: mkTmpDir(), watch: mkTmpDir(), fail: mkTmpDir() };
  try {
    // 20 block records total, N friction blocks (blocks beyond the 1st per run).
    function buildFriction(frictionBlocks) {
      const recs = [];
      // one big run supplying (frictionBlocks + 1) blocks, then pad with
      // singleton lost runs to reach exactly 20 block records total.
      for (let i = 0; i < frictionBlocks + 1; i++) {
        recs.push({ session_id: "s1", event: "block", tool_name: "Edit", target_hash: "big", finding_ids: ["x"] });
      }
      const remaining = 20 - (frictionBlocks + 1);
      for (let i = 0; i < remaining; i++) {
        recs.push({ session_id: "s1", event: "block", tool_name: "Edit", target_hash: `solo${i}`, finding_ids: ["x"] });
      }
      return recs;
    }
    writeLedgerFile(dirs.pass, "s1", buildFriction(2)); // 2/20 = 10%
    writeLedgerFile(dirs.watch, "s1", buildFriction(4)); // 4/20 = 20%
    writeLedgerFile(dirs.fail, "s1", buildFriction(6)); // 6/20 = 30%

    assert.equal(sc.run(["--state-dir", dirs.pass]).outputs[0].signalsResult.signals[2].rating, "PASS");
    assert.equal(sc.run(["--state-dir", dirs.watch]).outputs[0].signalsResult.signals[2].rating, "WATCH");
    assert.equal(sc.run(["--state-dir", dirs.fail]).outputs[0].signalsResult.signals[2].rating, "FAIL");
  } finally {
    Object.values(dirs).forEach(rmTree);
  }
});

test("threshold_verdicts: signal 4 (orchestrator-direct trend) PASS/WATCH/FAIL across two sessions with prior-window data", () => {
  const dirs = { pass: mkTmpDir(), watch: mkTmpDir(), fail: mkTmpDir() };
  try {
    function buildTrend(currentCount, priorCount) {
      const recs = [];
      // Two distinct sessions in the CURRENT window (trend eligibility).
      for (let i = 0; i < currentCount; i++) {
        recs.push({ session_id: "s1", event: "orchestrator_direct_shell", tool_name: "Bash", ts: isoMinutesAgo(30) });
      }
      recs.push({ session_id: "s2", event: "allow", ts: isoMinutesAgo(20) });
      for (let i = 0; i < priorCount; i++) {
        recs.push({ session_id: "s1", event: "orchestrator_direct_shell", tool_name: "Bash", ts: isoMinutesAgo(60 * 24 * 10) }); // well before the 7d window (prior window)
      }
      return recs;
    }
    writeLedgerFile(dirs.pass, "s1", buildTrend(1, 5)); // 1 <= 5: non-increasing -> PASS
    writeLedgerFile(dirs.watch, "s1", buildTrend(11, 10)); // 11 vs 10: +10% -> WATCH
    writeLedgerFile(dirs.fail, "s1", buildTrend(20, 10)); // 20 vs 10: +100% -> FAIL

    for (const [key, expected] of [
      ["pass", "PASS"],
      ["watch", "WATCH"],
      ["fail", "FAIL"],
    ]) {
      const { outputs } = sc.run(["--window", "7d", "--state-dir", dirs[key]]);
      const s4 = outputs[0].signalsResult.signals[3];
      assert.equal(s4.evaluated, true, `${key}: signal 4 must be evaluated (>=2 sessions, prior data present)`);
      assert.equal(s4.rating, expected, `${key}: expected ${expected}, got ${s4.rating}`);
    }
  } finally {
    Object.values(dirs).forEach(rmTree);
  }
});

test("threshold_verdicts: signal 5 (health) PASS when fail_open<=0.5% and malformed==0; FAIL otherwise", () => {
  const dirPass = mkTmpDir();
  const dirFail = mkTmpDir();
  try {
    const recsPass = [];
    for (let i = 0; i < 999; i++) recsPass.push({ session_id: "s1", event: "allow" });
    recsPass.push({ session_id: "s1", event: "fail_open", reason: "internal_exception" }); // 1/1000 = 0.1%
    writeLedgerFile(dirPass, "s1", recsPass);

    const recsFail = [];
    for (let i = 0; i < 90; i++) recsFail.push({ session_id: "s1", event: "allow" });
    for (let i = 0; i < 10; i++) recsFail.push({ session_id: "s1", event: "fail_open", reason: "internal_exception" }); // 10%
    writeLedgerFile(dirFail, "s1", recsFail);

    assert.equal(sc.run(["--state-dir", dirPass]).outputs[0].signalsResult.signals[4].rating, "PASS");
    assert.equal(sc.run(["--state-dir", dirFail]).outputs[0].signalsResult.signals[4].rating, "FAIL");
  } finally {
    rmTree(dirPass);
    rmTree(dirFail);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// no_data_verdict (owner ruling R8)
// ══════════════════════════════════════════════════════════════════════════

test("no_data_verdict: a window with 0 decisions -> NO-DATA, no signal evaluated, 0 of 5 evaluated", () => {
  const dir = mkTmpDir();
  try {
    const { outputs } = sc.run(["--state-dir", dir]);
    assert.equal(outputs[0].signalsResult.verdict, "NO-DATA");
    assert.equal(outputs[0].signalsResult.signalsEvaluated, 0);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// zero_denominator_rates_are_na (owner ruling R8)
// ══════════════════════════════════════════════════════════════════════════

test("zero_denominator_rates_are_na: decisions present but 0 block records -> win/friction rate n/a, excluded from verdict", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "allow" },
      { session_id: "s1", event: "exempt_subagent" },
    ]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const signals = outputs[0].signalsResult.signals;
    assert.equal(signals[1].rating, "n/a"); // win rate
    assert.equal(signals[2].rating, "n/a"); // friction rate
    assert.equal(signals[1].evaluated, false);
    assert.equal(signals[2].evaluated, false);
    assert.notEqual(outputs[0].signalsResult.verdict, "NO-DATA", "decisions are present; must not be NO-DATA");
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// trend_na_under_session (owner ruling R7)
// ══════════════════════════════════════════════════════════════════════════

test("trend_na_under_session: --session -> signal 4 n/a and excluded; signal 1 still rates on threshold alone; >=2 sessions computes trend normally", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", event: "allow" },
      { session_id: "s1", event: "allow" },
      { session_id: "s1", event: "fail_open", reason: "internal_exception" },
      { session_id: "s2", event: "allow" },
    ]);

    const sessionScoped = sc.run(["--state-dir", dir, "--session", "s1"]).outputs[0].signalsResult;
    const s4 = sessionScoped.signals[3];
    assert.equal(s4.rating, "n/a");
    assert.equal(s4.evaluated, false);
    const s1 = sessionScoped.signals[0];
    assert.notEqual(s1.rating, "n/a", "signal 1 must still rate on its threshold alone under --session");

    // A second fixture with exactly 2 distinct sessions AND prior-window
    // data confirms signal 4 computes normally once >=2 sessions are met.
    const dir2 = mkTmpDir();
    try {
      writeLedgerFile(dir2, "multi", [
        { session_id: "sA", event: "orchestrator_direct_shell", tool_name: "Bash", ts: isoMinutesAgo(30) },
        { session_id: "sB", event: "allow", ts: isoMinutesAgo(20) },
        { session_id: "sA", event: "orchestrator_direct_shell", tool_name: "Bash", ts: isoMinutesAgo(60 * 24 * 10) },
        { session_id: "sA", event: "orchestrator_direct_shell", tool_name: "Bash", ts: isoMinutesAgo(60 * 24 * 10) },
      ]);
      const { outputs } = sc.run(["--window", "7d", "--state-dir", dir2]);
      assert.equal(outputs[0].signalsResult.signals[3].evaluated, true);
    } finally {
      rmTree(dir2);
    }
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// unknown_bucket_reporting
// ══════════════════════════════════════════════════════════════════════════

test("unknown_bucket_reporting: fabricated event on a real guard -> counted in unknown, never dropped or merged into by_design_allow", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [{ session_id: "s1", guard: "orchestrator-tool-guard", event: "totally_new_event" }]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.unknownCount, 1);
    assert.equal(r.byDesignAllowCount, 0);
    assert.equal(r.perGuard["orchestrator-tool-guard"].unknown, 1);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// per_session_vs_aggregate
// ══════════════════════════════════════════════════════════════════════════

test("per_session_vs_aggregate: two sessions with differing counts -> per-session separates, aggregate sums, totals never disagree", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "sessA", [
      { session_id: "sessA", event: "allow" },
      { session_id: "sessA", event: "allow" },
      { session_id: "sessA", event: "block", tool_name: "Edit", target_hash: "t1", finding_ids: ["x"] },
    ]);
    writeLedgerFile(dir, "sessB", [{ session_id: "sessB", event: "allow" }]);

    const agg = sc.run(["--state-dir", dir]).outputs[0].report;
    assert.equal(agg.totalDecisions, 4);

    const perSession = sc.run(["--state-dir", dir, "--per-session"]).outputs;
    assert.equal(perSession.length, 2);
    const sum = perSession.reduce((s, o) => s + o.report.totalDecisions, 0);
    assert.equal(sum, agg.totalDecisions);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// fail_on_threshold_exit_code
// ══════════════════════════════════════════════════════════════════════════

test("fail_on_threshold_exit_code: exits 0 without the flag on FAIL, exits 1 with it; PASS always exits 0", () => {
  const dirFail = mkTmpDir();
  const dirPass = mkTmpDir();
  try {
    const recsFail = [];
    for (let i = 0; i < 90; i++) recsFail.push({ session_id: "s1", event: "allow" });
    for (let i = 0; i < 10; i++) recsFail.push({ session_id: "s1", event: "fail_open", reason: "internal_exception" });
    writeLedgerFile(dirFail, "s1", recsFail);
    writeLedgerFile(dirPass, "s1", [{ session_id: "s1", event: "allow" }]);

    const run1 = spawnScorecard(["--state-dir", dirFail]);
    assert.equal(run1.status, 0);
    const run2 = spawnScorecard(["--state-dir", dirFail, "--fail-on-threshold"]);
    assert.equal(run2.status, 1);
    const run3 = spawnScorecard(["--state-dir", dirPass, "--fail-on-threshold"]);
    assert.equal(run3.status, 0);
  } finally {
    rmTree(dirFail);
    rmTree(dirPass);
  }
});

function spawnScorecard(args) {
  const res = require("child_process").spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ══════════════════════════════════════════════════════════════════════════
// state_dir_override
// ══════════════════════════════════════════════════════════════════════════

test("state_dir_override: --state-dir reads only the alternate directory, ignoring the default STATE_DIR", () => {
  const altDir = mkTmpDir();
  try {
    writeLedgerFile(altDir, "alt-session", [{ session_id: "alt-session", event: "allow" }]);
    const out = execFileSync(process.execPath, [SCRIPT, "--state-dir", altDir, "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decisions, 1);
  } finally {
    rmTree(altDir);
  }
});

// Regression for the reported defect: `node scripts/routing-scorecard.js`
// run with no `--state-dir` flag reported "sessions 0, decisions 0,
// NO-DATA" even with a fully populated real STATE_DIR on disk, because
// hooks/model-routing-guards.decisions.js never re-exported STATE_DIR from
// model-routing-guards.state.js — decisionsModule.STATE_DIR was
// `undefined`, so scripts/routing-scorecard.js:18's
// `DEFAULT_STATE_DIR = decisionsModule.STATE_DIR` was also `undefined`,
// and listLedgerFiles()'s fs.readdirSync(undefined) fails inside its own
// fail-soft try/catch, silently returning zero files every time — no
// matter how populated the real ledger writer's own directory was.
test("default_state_dir_matches_decisions_module: routing-scorecard's default STATE_DIR is the exact directory hooks/model-routing-guards.decisions.js writes the ledger to (not undefined, not a re-derived duplicate path)", () => {
  assert.equal(typeof decisionsModule.STATE_DIR, "string");
  assert.ok(decisionsModule.STATE_DIR.length > 0, "decisionsModule.STATE_DIR must not be empty");
  assert.equal(
    sc.DEFAULT_STATE_DIR,
    decisionsModule.STATE_DIR,
    "scripts/routing-scorecard.js's DEFAULT_STATE_DIR must equal hooks/model-routing-guards.decisions.js's own STATE_DIR — same module instance (Node's require cache resolves both relative requires to the identical absolute path), so this can only fail if the export is missing or shadowed again"
  );
});

// Regression: production ledger filenames come in two shapes —
// "routing-decisions.<sanitized session id>.<h8>.jsonl" (per-session) and
// "routing-decisions.global-YYYY-MM-DD.<h8>.jsonl" (the session_id: null
// fallback bucket, e.g. every fail_open logged before a session id is
// parsed). Both must be discovered and counted by the reader with no
// --state-dir override needed beyond pointing at the directory they live
// in — this pins LEDGER_FILENAME_RE/GLOBAL_FALLBACK_KEY_RE against the
// exact real-world filenames (a UUID-shaped session id with dashes, and
// the literal "global-YYYY-MM-DD" key) rather than only the synthetic
// short keys ("alt-session", "s1", etc.) most of this file's other tests
// use.
test("production_filename_shapes_are_counted: both the per-session and global-fallback filename shapes are read and counted", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(
      dir,
      "02bd416a-13de-40b1-aabe-79f707e2e0ad",
      [
        { session_id: "02bd416a-13de-40b1-aabe-79f707e2e0ad", guard: "orchestrator-tool-guard", event: "exempt_subagent", tool_name: "Bash" },
      ],
      "039e8e55"
    );
    writeLedgerFile(
      dir,
      "global-2026-09-07",
      [{ session_id: null, guard: "agent-model-routing-guard", event: "fail_open", reason: "json_parse_error" }],
      "0834c41f"
    );
    const { outputs } = sc.run(["--state-dir", dir, "--window", "1d"]);
    const r = outputs[0].report;
    assert.equal(r.totalDecisions, 2, "both filename shapes must be counted toward decisions");
    assert.equal(r.sessionsCount, 1, "only the per-session file's session_id counts toward sessions — the global file's is null");
    assert.equal(r.healthFailureCount, 1, "the global-fallback record classifies health_failure, per isHealthFailure()");
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// escape_classification_matches_design
// ══════════════════════════════════════════════════════════════════════════

test("escape_classification_matches_design: adversary-floor policy fail_open + orchestrator_direct_shell count as escape; block with internal_exception finding does not", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [
      { session_id: "s1", guard: "agent-adversary-floor", event: "fail_open", reason: "internal_exception" },
      { session_id: "s1", guard: "orchestrator-tool-guard", event: "orchestrator_direct_shell", tool_name: "Bash" },
      { session_id: "s1", guard: "orchestrator-tool-guard", event: "block", finding_ids: ["internal_exception"] },
      { session_id: "s1", guard: "agent-model-routing-guard", event: "block", finding_ids: ["internal_exception"] },
    ]);
    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.escapeCount, 2);
  } finally {
    rmTree(dir);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// crash_record_classification (owner ruling R1)
// ══════════════════════════════════════════════════════════════════════════

test("crash_record_classification: guard_crash and global-fallback fail_open both classify health_failure, never escape/win/loss/friction", () => {
  const dir = mkTmpDir();
  try {
    writeLedgerFile(dir, "s1", [{ session_id: "s1", event: "guard_crash", finding_ids: ["top_level_exception"] }]);
    writeLedgerFile(dir, "global-2020-01-01", [{ session_id: null, event: "fail_open", reason: "stdin_read_error" }]);

    const { outputs } = sc.run(["--state-dir", dir]);
    const r = outputs[0].report;
    assert.equal(r.healthFailureCount, 2);
    assert.equal(r.escapeCount, 0, "the global-fallback fail_open must NOT count toward escape, per §4.6's health_failure carve-out");
    assert.equal(r.totalRuns, 0);
  } finally {
    rmTree(dir);
  }
});

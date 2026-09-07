"use strict";
// agent-adversary-floor.test.js
// Unit + integration tests for the agent-adversary-floor PreToolUse hook.
// Run with:  node hooks/agent-adversary-floor.test.js (from the repo root)
//
// Uses node:test + node:assert (Node v18+ built-ins; Node v22 available here).
// Follows the conventions of no-punt-guard.test.js: unit tests against the
// exported pure functions, then subprocess integration tests against the
// hook's stdin/exit-code/stderr contract.
//
// Test matrix:
//
//   Unit tests (isExemptType / hasCompletenessSignal):
//   U1-U5   each exempt type -> isExemptType true
//   U6      unknown type -> isExemptType false
//   U7      no clause, no marker -> hasCompletenessSignal ok:false
//   U8-U19  each blind-spot pattern class + word-boundary variants -> ok:true
//   U20     marker with reason -> ok:true via "marker"
//   U21     marker with empty reason -> ok:false
//   U22     marker with whitespace-only reason -> ok:false
//   U23     non-string input -> ok:false (defensive)
//
//   Hook integration tests (stdin/exit-code/stderr subprocess):
//   H1   write-capable spawn, no clause, no marker -> BLOCK (exit 2)
//   H2   write-capable spawn with "blind spot" clause -> ALLOW (exit 0)
//   H3   write-capable spawn with "adversarial" (stem) -> ALLOW
//   H4   write-capable spawn with "can't detect" -> ALLOW
//   H5   write-capable spawn with "pass-but-should" -> ALLOW
//   H6   exemption marker with reason -> ALLOW
//   H7   exemption marker with empty reason -> BLOCK
//   H8   exemption marker with whitespace-only reason -> BLOCK
//   H9-H13 each exempt agent type, NO clause -> ALLOW unconditionally
//   H14  unknown/future agent type ("some-future-agent"), no clause -> BLOCK
//   H15  missing subagent_type -> treated general-purpose -> BLOCK (no clause)
//   H16  missing subagent_type WITH clause -> ALLOW
//   H17  malformed stdin JSON -> ALLOW (fail-open), debug log line written
//   H18  prompt field missing -> ALLOW (fail-open)
//   H19  prompt field non-string (number) -> ALLOW (fail-open)
//   H20  non-Agent/non-SendMessage tool_name (e.g. "Write") -> ALLOW untouched
//   H21  SendMessage, non-empty message, no clause -> BLOCK
//   H22  SendMessage, non-empty message, with clause -> ALLOW
//   H23  SendMessage, empty message -> ALLOW (not plausibly a work-assignment)
//   H24  SendMessage, whitespace-only message -> ALLOW
//   H25  SendMessage, missing message field -> ALLOW (fail-open path)
//   H26  SendMessage, with exemption marker -> ALLOW
//   H27  empty stdin -> ALLOW (fail-open)

const { test, after }  = require("node:test");
const assert           = require("node:assert/strict");
const fs               = require("fs");
const os               = require("os");
const path             = require("path");
const { execFileSync } = require("child_process");

// Redirect every state/ledger file this file's own in-process `require(HOOK_PATH)`
// AND every subprocess runHook() spawns write into a per-test-file temp
// directory instead of this repo's own gitignored hooks/state. Must be set
// before the first `require("./model-routing-guards.state.js")` — reached
// transitively via `require(HOOK_PATH)` below, since
// hooks/agent-adversary-floor.js itself calls appendDecision — because
// state.js reads MODEL_ROUTING_STATE_DIR once, at module-load time.
// Without this: this file never sets `session_id` on any fixture payload
// (every runHook() call below omits it), so every appendDecision call here
// fell to the shared `global-YYYY-MM-DD` fallback file (§2.1) — the same
// file every OTHER process on this machine also appends to — and this file
// had no cleanup of any kind for it.
const STATE_DIR_OVERRIDE = fs.mkdtempSync(path.join(os.tmpdir(), "aaf-state-"));
process.env.MODEL_ROUTING_STATE_DIR = STATE_DIR_OVERRIDE;
after(() => {
  try {
    fs.rmSync(STATE_DIR_OVERRIDE, { recursive: true, force: true, maxRetries: 3 });
  } catch (_) {
    // best effort
  }
});

const HOOK_PATH  = path.join(__dirname, "agent-adversary-floor.js");
const DEBUG_LOG  = path.join(__dirname, "agent-adversary-floor-debug.log");

const {
  EXEMPT_TYPES,
  isExemptType,
  hasCompletenessSignal,
} = require(HOOK_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the hook as a subprocess with the given JSON-serializable payload (or
 * raw string, if isRaw) on stdin. Returns { exitCode, stdout, stderr }.
 */
function runHook(payload, isRaw) {
  const input = isRaw ? payload : JSON.stringify(payload);
  let exitCode = 0;
  let stdout   = "";
  let stderr   = "";
  try {
    stdout = execFileSync("node", [HOOK_PATH], {
      input,
      encoding: "utf8",
      timeout:  10000,
    });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stdout   = err.stdout ? String(err.stdout) : "";
    stderr   = err.stderr ? String(err.stderr) : "";
  }
  return { exitCode, stdout, stderr };
}

function agentPayload(subagentType, prompt) {
  const tool_input = { prompt };
  if (subagentType !== undefined) tool_input.subagent_type = subagentType;
  return { tool_name: "Agent", tool_input };
}

function sendMessagePayload(message) {
  const tool_input = { to: "researcher" };
  if (message !== undefined) tool_input.message = message;
  return { tool_name: "SendMessage", tool_input };
}

const COMPLIANT_CLAUSE =
  "Report what this check canNOT detect, and construct at least one input that passes but shouldn't.";

// ---------------------------------------------------------------------------
// Unit tests: isExemptType
// ---------------------------------------------------------------------------

for (const t of EXEMPT_TYPES) {
  test(`U-exempt: "${t}" -> isExemptType true`, () => {
    assert.equal(isExemptType(t), true);
  });
}

test("U6: unknown type -> isExemptType false", () => {
  assert.equal(isExemptType("some-future-agent"), false);
  assert.equal(isExemptType("general-purpose"), false);
});

// ---------------------------------------------------------------------------
// Unit tests: hasCompletenessSignal
// ---------------------------------------------------------------------------

test("U7: no clause, no marker -> ok:false", () => {
  const r = hasCompletenessSignal("Please write a validator for file extensions.");
  assert.equal(r.ok, false);
});

const PATTERN_VARIANTS = [
  ["blind spot",           "Report any blind spot in this matcher."],
  ["blind-spot",           "Report any blind-spot in this matcher."],
  ["cannot detect",        "State clearly what this cannot detect."],
  ["can not detect",       "State clearly what this can not detect."],
  ["can't detect",         "State clearly what this can't detect."],
  ["pass but should",      "Find an input that would pass but should fail."],
  ["passes but should",    "Find an input that passes but should fail."],
  ["pass-but-should",      "Enumerate pass-but-should cases."],
  ["what can this NOT",    "Tell me: what can this NOT catch?"],
  ["fails to fire",        "Identify where this check fails to fire."],
  ["construct inputs that","Construct inputs that defeat this matcher."],
  ["adversary",            "Think like an adversary before writing this."],
  ["adversarial",          "Do an adversarial pass over the spec first."],
  ["adversarially",        "Reason adversarially about edge cases."],
];

for (const [label, text] of PATTERN_VARIANTS) {
  test(`U8+: pattern variant "${label}" -> ok:true`, () => {
    const r = hasCompletenessSignal(text);
    assert.equal(r.ok, true, `expected ok:true for "${text}"; got ${JSON.stringify(r)}`);
    assert.equal(r.via, "pattern");
  });
}

test("U20: exemption marker with reason -> ok:true via marker", () => {
  const r = hasCompletenessSignal("Write the validator. [adversary-exempt: read-only report, no gate logic]");
  assert.equal(r.ok, true);
  assert.equal(r.via, "marker");
});

test("U21: exemption marker with empty reason -> ok:false", () => {
  const r = hasCompletenessSignal("Write the validator. [adversary-exempt: ]");
  assert.equal(r.ok, false);
});

test("U21b: exemption marker with zero-char reason -> ok:false", () => {
  const r = hasCompletenessSignal("Write the validator. [adversary-exempt:]");
  assert.equal(r.ok, false);
});

test("U22: exemption marker with whitespace-only reason -> ok:false", () => {
  const r = hasCompletenessSignal("Write the validator. [adversary-exempt:    ]");
  assert.equal(r.ok, false);
});

test("U23: non-string input -> ok:false", () => {
  assert.equal(hasCompletenessSignal(42).ok, false);
  assert.equal(hasCompletenessSignal(undefined).ok, false);
  assert.equal(hasCompletenessSignal(null).ok, false);
});

// ---------------------------------------------------------------------------
// Hook integration tests
// ---------------------------------------------------------------------------

test("H1: write-capable spawn, no clause, no marker -> BLOCK", () => {
  const { exitCode, stderr } = runHook(agentPayload("general-purpose", "Write a validator for allowed file extensions."));
  assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.ok(stderr.includes("BLOCKED"), `expected BLOCKED in stderr; got ${stderr}`);
  assert.ok(stderr.includes("[adversary-exempt:"), "expected exemption-form example in stderr");
});

test("H2: write-capable spawn with blind-spot clause -> ALLOW", () => {
  const { exitCode, stderr } = runHook(agentPayload("general-purpose", "Write a validator. " + COMPLIANT_CLAUSE));
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}; stderr=${stderr}`);
});

test("H3: write-capable spawn with adversarial stem -> ALLOW", () => {
  const { exitCode } = runHook(agentPayload("general-purpose", "Take an adversarial pass at this spec before authoring."));
  assert.equal(exitCode, 0);
});

test("H4: write-capable spawn with can't detect -> ALLOW", () => {
  const { exitCode } = runHook(agentPayload("general-purpose", "Report what this can't detect once done."));
  assert.equal(exitCode, 0);
});

test("H5: write-capable spawn with pass-but-should -> ALLOW", () => {
  const { exitCode } = runHook(agentPayload("general-purpose", "Enumerate pass-but-should cases before submitting."));
  assert.equal(exitCode, 0);
});

test("H6: exemption marker with reason -> ALLOW", () => {
  const { exitCode } = runHook(agentPayload("general-purpose", "Format the report only. [adversary-exempt: read-only, no validation logic]"));
  assert.equal(exitCode, 0);
});

test("H7: exemption marker with empty reason -> BLOCK", () => {
  const { exitCode, stderr } = runHook(agentPayload("general-purpose", "Format the report only. [adversary-exempt: ]"));
  assert.equal(exitCode, 2);
  assert.ok(stderr.includes("BLOCKED"));
});

test("H8: exemption marker with whitespace-only reason -> BLOCK", () => {
  const { exitCode } = runHook(agentPayload("general-purpose", "Format the report only. [adversary-exempt:     ]"));
  assert.equal(exitCode, 2);
});

for (const t of EXEMPT_TYPES) {
  test(`H-exempt: type "${t}", no clause -> ALLOW unconditionally`, () => {
    const { exitCode } = runHook(agentPayload(t, "Find where the validator lives and summarize it."));
    assert.equal(exitCode, 0, `expected exit 0 for exempt type ${t}`);
  });
}

test("H14: unknown/future agent type, no clause -> BLOCK", () => {
  const { exitCode, stderr } = runHook(agentPayload("some-future-agent", "Write a new parser for the config file."));
  assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.ok(stderr.includes("some-future-agent"));
});

test("H15: missing subagent_type -> treated general-purpose -> BLOCK", () => {
  const { exitCode, stderr } = runHook(agentPayload(undefined, "Write a new parser for the config file."));
  assert.equal(exitCode, 2);
  assert.ok(stderr.includes("general-purpose"));
});

test("H16: missing subagent_type WITH clause -> ALLOW", () => {
  const { exitCode } = runHook(agentPayload(undefined, "Write a new parser. " + COMPLIANT_CLAUSE));
  assert.equal(exitCode, 0);
});

test("H17: malformed stdin JSON -> ALLOW (fail-open), debug log line written", () => {
  const before = fs.existsSync(DEBUG_LOG) ? fs.statSync(DEBUG_LOG).size : 0;
  const { exitCode, stderr } = runHook("NOT VALID JSON !!!", true);
  assert.equal(exitCode, 0, `expected exit 0 on malformed stdin, got ${exitCode}`);
  assert.equal(stderr, "", "expected no stderr on fail-open");
  const after = fs.statSync(DEBUG_LOG).size;
  assert.ok(after > before, "expected debug log to have grown on malformed-stdin fail-open");
  const lines = fs.readFileSync(DEBUG_LOG, "utf8").trim().split(/\r?\n/);
  const last  = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.event, "fail_open");
  assert.equal(last.reason, "json_parse_error");
});

test("H18: prompt field missing -> ALLOW (fail-open)", () => {
  const payload = { tool_name: "Agent", tool_input: { subagent_type: "general-purpose" } };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}; stderr=${stderr}`);
});

test("H19: prompt field non-string (number) -> ALLOW (fail-open)", () => {
  const payload = { tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: 12345 } };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0);
});

test("H20: non-Agent/non-SendMessage tool_name -> ALLOW untouched", () => {
  const payload = { tool_name: "Write", tool_input: { file_path: "C:\\foo\\bar.txt", content: "hi" } };
  const { exitCode, stdout, stderr } = runHook(payload);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("H21: SendMessage, non-empty message, no clause -> BLOCK", () => {
  const { exitCode, stderr } = runHook(sendMessagePayload("Go implement the new extension allow-list validator."));
  assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.ok(stderr.includes("SendMessage"));
});

test("H22: SendMessage, non-empty message, with clause -> ALLOW", () => {
  const { exitCode } = runHook(sendMessagePayload("Go implement the validator. " + COMPLIANT_CLAUSE));
  assert.equal(exitCode, 0);
});

test("H23: SendMessage, empty message -> ALLOW (not plausibly a work-assignment)", () => {
  const { exitCode } = runHook(sendMessagePayload(""));
  assert.equal(exitCode, 0);
});

test("H24: SendMessage, whitespace-only message -> ALLOW", () => {
  const { exitCode } = runHook(sendMessagePayload("   \n  "));
  assert.equal(exitCode, 0);
});

test("H25: SendMessage, missing message field -> ALLOW (fail-open path)", () => {
  const payload = { tool_name: "SendMessage", tool_input: { to: "researcher" } };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0);
});

test("H26: SendMessage, with exemption marker -> ALLOW", () => {
  const { exitCode } = runHook(sendMessagePayload("Status check only. [adversary-exempt: read-only status ping]"));
  assert.equal(exitCode, 0);
});

test("H27: empty stdin -> ALLOW (fail-open)", () => {
  const { exitCode, stderr } = runHook("", true);
  assert.equal(exitCode, 0, `expected exit 0 on empty stdin, got ${exitCode}`);
  assert.equal(stderr, "");
});

// ══════════════════════════════════════════════════════════════════════════
// fixture_isolation — regression for the 393-file routing-decisions.*.jsonl
// leftover-fixture defect (see the MODEL_ROUTING_STATE_DIR override block
// near the top of this file). This file never sets a `session_id` on any
// payload, so every appendDecision call it triggers falls to the shared
// `global-YYYY-MM-DD` fallback file — the highest-risk case, since that
// filename is shared with every other process on the machine and this file
// previously had no cleanup for it at all.
// ══════════════════════════════════════════════════════════════════════════

test("fixture_isolation: this file's own fixture-writing helper (runHook) never leaves a routing-decisions.*.jsonl file in the REAL (non-overridden) hooks/state", () => {
  // Deliberately re-derives the real STATE_DIR the same __dirname-relative
  // way model-routing-guards.state.js computes its own default — with
  // MODEL_ROUTING_STATE_DIR set for this whole file, requiring that module
  // directly would return STATE_DIR_OVERRIDE, which is exactly the
  // isolation under test here, not the thing to assert against.
  const realStateDir = path.join(__dirname, "state");
  const routingDecisionsFiles = (dir) =>
    fs.existsSync(dir) ? new Set(fs.readdirSync(dir).filter((f) => f.startsWith("routing-decisions."))) : new Set();
  const before = routingDecisionsFiles(realStateDir);

  const { exitCode } = runHook(agentPayload("general-purpose", "no clause, no marker"));
  assert.equal(exitCode, 2, "expected the write-capable spawn to BLOCK (this still appends a decision record)");

  const after = routingDecisionsFiles(realStateDir);
  const newFiles = [...after].filter((f) => !before.has(f));
  assert.deepEqual(
    newFiles,
    [],
    `expected no new routing-decisions.*.jsonl fixture in the real hooks/state, found: ${newFiles.join(", ")}`
  );
});

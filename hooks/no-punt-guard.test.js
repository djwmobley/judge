"use strict";
// no-punt-guard.test.js
// Unit tests for the no-punt-guard Stop hook.
// Run with:  node hooks/no-punt-guard.test.js (from the repo root)
//
// Uses node:test + node:assert (Node v18+ built-ins; Node v22 available here).
//
// Fixtures use the REAL production transcript row shape:
//   { type: "assistant"|"user"|..., isSidechain: bool,
//     message: { id, role, content: [blocks] }, uuid, parentUuid, ... }
// NOT the flat { role, content } shape -- that shape never occurs in
// production and is intentionally unsupported (see "other row types ignored"
// below and the LEGACY tests, which prove flat rows are inert).
//
// Test matrix:
//
//   Unit tests (findPuntMatches) -- pattern matching only, shape-independent:
//   U1  punt message with "housekeeping" + "your call" -> blocks (both labels matched)
//   U2  clean completion message -> allows (no match)
//   U3  innocent "optional" with no punt-context nouns -> allows (precision check)
//   U4  "optional" near "follow-up" -> blocks (ctx_re fires)
//   U5  "next session" -> blocks
//   U6  "feel free to" -> blocks
//   U7  "if you'd like" -> blocks
//   U8  "you might want to" -> blocks
//   U9  "loose ends" -> blocks
//   U10 "I'll come back to that later" -> blocks
//   U11 "I can fix this" (no time qualifier) -> allows (precision check)
//   U12 "leaving it open" -> blocks
//   U13 "left it for later" -> blocks
//   U14 "not done" -> blocks
//   U15 "did not force" / "didn't force" -> blocks
//   U-A1..A4 / U-B1..B3: tightened-pattern allow/block precision cases
//
//   Direct unit tests (extractLastAssistantText) -- real-shaped fixtures:
//   T1  text at message.content (single-row assistant turn) -> returns text
//   T2  multi-row turn (thinking + tool_use + text, same message.id) -> concatenated
//   T3  trailing tool_use-only turn -> returns null (NOT the earlier turn's text)
//   T4  isSidechain row ignored even when last -> falls back to earlier real turn
//   T5  other row types (system/user/summary/etc.) ignored -> falls back correctly
//   T6  unparsable JSON line ignored -> falls back correctly
//   T7  legacy flat {role,content} shape is NOT recognized -> inert / ignored
//   T8  empty/missing transcript -> null
//
//   Hook integration tests (stdin/stdout subprocess):
//   H1  punt closing message (transcript) -> hook prints decision:block, reason names labels
//   H2  clean closing message (transcript) -> hook produces no stdout (allows)
//   H3  stop_hook_active: true with punt message -> allows (loop guard wins)
//   H4  malformed stdin JSON -> allows (fail-open)
//   H5  missing transcript_path (null) -> allows (fail-open)
//   H6  transcript file does not exist -> allows (fail-open)
//   H7  empty stdin -> allows (fail-open)
//   H8  transcript with only user messages (no assistant turn) -> allows (fail-open)
//   H9  transcript with multi-row assistant turn, punt text -> blocks
//   H10 stdin last_assistant_message (punt) wins over clean transcript -> blocks
//   H11 stdin last_assistant_message (clean) wins over punt transcript -> allows
//   H12 stdin last_assistant_message: "" (empty string) falls back to transcript -> blocks
//   H13 stdin last_assistant_message: "   " (spaces only) falls back to transcript -> blocks
//   H14 stdin last_assistant_message: "\t\n" (tab/newline only) falls back to transcript -> blocks
//   H15 stdin last_assistant_message: NBSP only (U+00A0) falls back to transcript -> blocks (NBSP is JS \s whitespace)
//   H16 stdin last_assistant_message: zero-width chars only (U+200B, U+2060) falls back to transcript -> blocks
//   H17 stdin last_assistant_message: NBSP + genuine punt text -> source=stdin (blocks on the stdin content, not the clean transcript)

const { test }        = require("node:test");
const assert          = require("node:assert/strict");
const fs              = require("fs");
const os              = require("os");
const path            = require("path");
const { execFileSync } = require("child_process");

const HOOK_PATH = path.join(__dirname, "no-punt-guard.js");
const { findPuntMatches, extractLastAssistantText } = require(HOOK_PATH);

// ---------------------------------------------------------------------------
// Helpers -- real production transcript row shape
// ---------------------------------------------------------------------------

let uidCounter = 0;
function nextUuid() {
  uidCounter += 1;
  return "uuid-" + Date.now() + "-" + uidCounter;
}

function textBlock(text)              { return { type: "text", text: text }; }
function thinkingBlock(text)          { return { type: "thinking", thinking: text }; }
function toolUseBlock(name, input)    { return { type: "tool_use", id: nextUuid(), name: name, input: input || {} }; }

/**
 * One production-shaped row. `content` is an array of blocks (or a plain
 * string, which the production format also allows for message.content).
 */
function row(type, role, messageId, content, opts) {
  opts = opts || {};
  return {
    type: type,
    isSidechain: opts.isSidechain === true,
    message: { id: messageId, role: role, content: content },
    uuid: nextUuid(),
    parentUuid: opts.parentUuid || null,
  };
}

function assistantRow(messageId, content, opts) {
  return row("assistant", "assistant", messageId, content, opts);
}

function userRow(messageId, content, opts) {
  return row("user", "user", messageId, content, opts);
}

/** A row type this function has never heard of -- must land in "other". */
function unknownRow(kind, messageId) {
  return {
    type: kind,
    isSidechain: false,
    uuid: nextUuid(),
    parentUuid: null,
    payload: { note: "unrecognized row type: " + kind },
  };
}

/** The legacy flat shape -- NOT recognized/supported by this hook. */
function legacyFlatRow(text) {
  return { role: "assistant", content: text };
}

function writeTempTranscript(rows) {
  const tmpFile = path.join(
    os.tmpdir(),
    "no-punt-test-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".jsonl"
  );
  const lines = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
  fs.writeFileSync(tmpFile, lines.join("\n") + "\n", "utf8");
  return tmpFile;
}

/**
 * Run the hook as a subprocess with the given JSON payload on stdin.
 * Returns { exitCode, stdout, stderr }.
 */
function runHook(payload) {
  let exitCode = 0;
  let stdout   = "";
  let stderr   = "";
  try {
    stdout = execFileSync("node", [HOOK_PATH], {
      input:    JSON.stringify(payload),
      encoding: "utf8",
      timeout:  10000,
    });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stdout   = (err.stdout) ? String(err.stdout) : "";
    stderr   = (err.stderr) ? String(err.stderr) : "";
  }
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Unit tests: findPuntMatches
// ---------------------------------------------------------------------------

test("U1: punt message with housekeeping + your call -> blocks both labels", () => {
  const text = "There are two optional housekeeping items here, your call whether to do them.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(matches.length >= 2, `expected >= 2 matches, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.includes("housekeeping")), "expected 'housekeeping' label");
  assert.ok(labels.some((l) => l === "your call"),          "expected 'your call' label");
});

test("U2: clean completion message -> allows (no match)", () => {
  const text = "Done. All three rows retired and verified. CI is green.";
  const matches = findPuntMatches(text);
  assert.equal(matches.length, 0, `expected 0 matches, got ${JSON.stringify(matches)}`);
});

test("U3: innocent optional (flag is optional in the schema) -> allows", () => {
  const text = "The --verbose flag is optional in the schema. You can omit it.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.startsWith("optional")),
    `"optional" pattern should NOT fire for innocent usage; got ${JSON.stringify(labels)}`
  );
});

test("U4: optional near follow-up -> blocks", () => {
  const text = "There is an optional follow-up step to run the linter.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    labels.some((l) => l.startsWith("optional")),
    `"optional" pattern SHOULD fire near "follow-up"; got ${JSON.stringify(labels)}`
  );
});

test("U5: next session -> blocks", () => {
  const text = "We can address the remaining tests next session.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("session")), `expected session label; got ${JSON.stringify(labels)}`);
});

test("U6: feel free to (non-exempt phrase) -> blocks", () => {
  const text = "Feel free to run the migration at your convenience.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("feel free")), `expected 'feel free to' label; got ${JSON.stringify(labels)}`);
});

test("U7: if you'd like + offer-to-act context -> blocks", () => {
  const text = "If you'd like, I can revisit the schema changes.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("if you'd like")), `expected "if you'd like" label; got ${JSON.stringify(labels)}`);
});

test("U8: you might want to -> blocks", () => {
  const text = "You might want to clean up the old migration files.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("may/might")), `expected may/might label; got ${JSON.stringify(labels)}`);
});

test("U9: loose ends -> blocks", () => {
  const text = "There are a few loose ends remaining from this sprint.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l === "loose ends"), `expected 'loose ends' label; got ${JSON.stringify(labels)}`);
});

test("U10: I'll come back to that later -> blocks", () => {
  const text = "I'll come back to that later when we have more context.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("later")), `expected 'later' label; got ${JSON.stringify(labels)}`);
});

test("U11: I can fix this (no time qualifier) -> allows (precision check)", () => {
  const text = "I can fix this if you point me at the right file.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.includes("later")),
    `"I can fix this" WITHOUT time qualifier should NOT fire; got ${JSON.stringify(labels)}`
  );
});

test("U12: leaving it open -> blocks", () => {
  const text = "I am leaving it open for now pending your decision.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("leaving")), `expected leaving label; got ${JSON.stringify(labels)}`);
});

test("U13: left it for later -> blocks", () => {
  const text = "I left it for later since it was not blocking the release.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("left")), `expected 'left' label; got ${JSON.stringify(labels)}`);
});

test("U14: 'not done' no longer fires (done removed to avoid factual-reporting FP) -> allows", () => {
  const text = "The migration is not done yet, skipping for now.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.includes("not done")),
    `"not done" should NOT fire after removing 'done' from the pattern; got ${JSON.stringify(labels)}`
  );
});

test("U15a: did not force -> blocks", () => {
  const text = "I did not force the schema change since it was marked optional.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("did not force")), `expected 'did not force' label; got ${JSON.stringify(labels)}`);
});

test("U15b: didn't force -> blocks", () => {
  const text = "I didn't force the cleanup as it seemed risky.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes("did not force")), `expected 'did not force' (didn't) label; got ${JSON.stringify(labels)}`);
});

test("U-A1: bare housekeeping in completion sentence -> allows (no undone-work marker nearby)", () => {
  const text = "Done — all housekeeping items committed and verified.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.includes("housekeeping")),
    `"housekeeping" should NOT fire in a plain completion sentence; got ${JSON.stringify(labels)}`
  );
});

test("U-A2: 'if you'd like to see the diff' (no offer-to-act) -> allows", () => {
  const text = "If you'd like to see the full diff, it's in PR #120.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.includes("if you'd like")),
    `"if you'd like to see..." without offer-to-act should NOT fire; got ${JSON.stringify(labels)}`
  );
});

test("U-A3: 'feel free to ask' -> allows (exempt courtesy phrase)", () => {
  const text = "Feel free to ask if anything is unclear.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.includes("feel free")),
    `"feel free to ask" should NOT fire; got ${JSON.stringify(labels)}`
  );
});

test("U-A4: 'that step is not done separately because it\\'s already covered' -> allows", () => {
  const text = "That step is not done separately because it's already covered.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    !labels.some((l) => l.includes("not done")),
    `factual "not done" reporting should NOT fire; got ${JSON.stringify(labels)}`
  );
});

test("U-B1: 'two optional housekeeping items remain' -> blocks (undone-work marker present)", () => {
  const text = "Two optional housekeeping items remain — your call.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    labels.some((l) => l.includes("housekeeping")),
    `"housekeeping" SHOULD fire when undone-work marker is nearby; got ${JSON.stringify(labels)}`
  );
});

test("U-B2: 'if you'd like, I can also wire the second hook' -> blocks (offer-to-act present)", () => {
  const text = "If you'd like, I can also wire the second hook.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    labels.some((l) => l.includes("if you'd like")),
    `"if you'd like, I can also..." SHOULD fire; got ${JSON.stringify(labels)}`
  );
});

test("U-B3: 'feel free to run the remaining migration yourself later' -> blocks", () => {
  const text = "Feel free to run the remaining migration yourself later.";
  const matches = findPuntMatches(text);
  const labels  = matches.map((m) => m.label);
  assert.ok(
    labels.some((l) => l.includes("feel free")),
    `"feel free to run..." SHOULD fire; got ${JSON.stringify(labels)}`
  );
});

// ---------------------------------------------------------------------------
// Direct unit tests: extractLastAssistantText (real production row shape)
// ---------------------------------------------------------------------------

test("T1: text at message.content (single-row assistant turn) -> returns text", () => {
  const tp = writeTempTranscript([
    userRow("u1", [textBlock("Please do X.")]),
    assistantRow("a1", [textBlock("Done. X is complete.")]),
  ]);
  try {
    assert.equal(extractLastAssistantText(tp), "Done. X is complete.");
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T2: multi-row turn (thinking + tool_use + text, same message.id) -> concatenated", () => {
  const tp = writeTempTranscript([
    userRow("u1", [textBlock("Run the build.")]),
    assistantRow("a1", [thinkingBlock("Let me check the build output.")]),
    assistantRow("a1", [toolUseBlock("Bash", { command: "npm test" })]),
    assistantRow("a1", [textBlock("Build passed. All tests green.")]),
  ]);
  try {
    assert.equal(extractLastAssistantText(tp), "Build passed. All tests green.");
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T3: trailing tool_use-only turn -> returns null (NOT the earlier turn's text)", () => {
  const tp = writeTempTranscript([
    assistantRow("a1", [textBlock("Two optional housekeeping items remain, your call.")]),
    userRow("u2", [textBlock("Go ahead and run the tool.")]),
    assistantRow("a2", [toolUseBlock("Bash", { command: "npm run lint" })]),
  ]);
  try {
    assert.equal(
      extractLastAssistantText(tp),
      null,
      "trailing no-text assistant turn must return null, not fall back to the earlier turn's text"
    );
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T4: isSidechain row ignored even when last -> falls back to earlier real turn", () => {
  const tp = writeTempTranscript([
    assistantRow("a1", [textBlock("Done. Migration complete.")]),
    assistantRow("side1", [textBlock("Subagent scratch output, not the real closing turn.")], { isSidechain: true }),
  ]);
  try {
    assert.equal(extractLastAssistantText(tp), "Done. Migration complete.");
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T5: other row types (system/summary/etc.) ignored -> falls back correctly", () => {
  const tp = writeTempTranscript([
    assistantRow("a1", [textBlock("Done. All housekeeping items committed and verified.")]),
    unknownRow("summary", "s1"),
    unknownRow("queue-operation", "q1"),
    unknownRow("file-history-snapshot", "f1"),
  ]);
  try {
    assert.equal(
      extractLastAssistantText(tp),
      "Done. All housekeeping items committed and verified."
    );
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T6: unparsable JSON line ignored -> falls back correctly", () => {
  const tp = writeTempTranscript([
    assistantRow("a1", [textBlock("Done. Build passed.")]),
    "NOT VALID JSON !!!",
  ]);
  try {
    assert.equal(extractLastAssistantText(tp), "Done. Build passed.");
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T7: legacy flat {role,content} shape is NOT recognized -> inert / ignored", () => {
  const tp = writeTempTranscript([
    assistantRow("a1", [textBlock("Done. Real turn text.")]),
    legacyFlatRow("There are loose ends here, your call."),
  ]);
  try {
    // The legacy row is a valid-JSON, non-assistant-recognized row (no `type`,
    // no `message` wrapper) -- it must be treated as "other" and ignored, not
    // mistaken for the last assistant turn.
    assert.equal(extractLastAssistantText(tp), "Done. Real turn text.");
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

test("T8: empty/missing transcript -> null", () => {
  assert.equal(extractLastAssistantText(null), null);
  assert.equal(extractLastAssistantText("C:\\nonexistent\\transcript-xyz.jsonl"), null);
  const tp = writeTempTranscript([]);
  try {
    assert.equal(extractLastAssistantText(tp), null);
  } finally { try { fs.unlinkSync(tp); } catch (_) {} }
});

// ---------------------------------------------------------------------------
// Hook integration tests (subprocess invocations)
// ---------------------------------------------------------------------------

test("H1: punt closing message (transcript) -> hook prints decision:block, reason names labels", () => {
  const transcriptPath = writeTempTranscript([
    userRow("u1", [textBlock("Please do X.")]),
    assistantRow("a1", [textBlock("There are two optional housekeeping items, your call.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({ transcript_path: transcriptPath, stop_hook_active: false });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "expected non-empty stdout (block output)");
    let decision;
    try { decision = JSON.parse(stdout.trim()); } catch (_) {
      assert.fail("stdout is not valid JSON: " + stdout);
    }
    assert.equal(decision.decision, "block", `expected decision:block, got ${JSON.stringify(decision)}`);
    assert.ok(typeof decision.reason === "string" && decision.reason.length > 0, "expected non-empty reason");
    const expectedLabels = ["housekeeping", "your call"];
    const reasonLower = decision.reason.toLowerCase();
    assert.ok(
      expectedLabels.some((l) => reasonLower.includes(l.toLowerCase())),
      `reason should name a matched label; got: ${decision.reason}`
    );
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H2: clean closing message (transcript) -> hook produces no stdout (allows)", () => {
  const transcriptPath = writeTempTranscript([
    userRow("u1", [textBlock("Run the build.")]),
    assistantRow("a1", [textBlock("Done. Build passed. All 42 tests green.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({ transcript_path: transcriptPath, stop_hook_active: false });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.equal(stdout.trim(), "", `expected empty stdout (allow), got: ${JSON.stringify(stdout)}`);
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H3: stop_hook_active:true with punt message -> allows (loop guard wins)", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({ transcript_path: transcriptPath, stop_hook_active: true });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.equal(stdout.trim(), "", "expected empty stdout when stop_hook_active is true");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H4: malformed stdin JSON -> allows (fail-open)", () => {
  let exitCode = 0;
  let stdout   = "";
  try {
    stdout = execFileSync("node", [HOOK_PATH], {
      input:    "NOT VALID JSON !!!",
      encoding: "utf8",
      timeout:  8000,
    });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stdout   = err.stdout ? String(err.stdout) : "";
  }
  assert.equal(exitCode, 0, `expected exit 0 on malformed stdin, got ${exitCode}`);
  assert.equal(stdout.trim(), "", "expected empty stdout on malformed stdin");
});

test("H5: missing transcript_path (null) -> allows (fail-open)", () => {
  const { exitCode, stdout } = runHook({ transcript_path: null, stop_hook_active: false });
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
  assert.equal(stdout.trim(), "", "expected empty stdout when transcript_path is null");
});

test("H6: transcript file does not exist -> allows (fail-open)", () => {
  const { exitCode, stdout } = runHook({
    transcript_path: "/nonexistent/path/to/transcript-99999.jsonl",
    stop_hook_active: false,
  });
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
  assert.equal(stdout.trim(), "", "expected empty stdout when transcript file missing");
});

test("H7: empty stdin -> allows (fail-open)", () => {
  let exitCode = 0;
  let stdout   = "";
  try {
    stdout = execFileSync("node", [HOOK_PATH], {
      input:    "",
      encoding: "utf8",
      timeout:  8000,
    });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stdout   = err.stdout ? String(err.stdout) : "";
  }
  assert.equal(exitCode, 0, `expected exit 0 on empty stdin, got ${exitCode}`);
  assert.equal(stdout.trim(), "", "expected empty stdout on empty stdin");
});

test("H8: transcript with only user messages -> allows (fail-open)", () => {
  const transcriptPath = writeTempTranscript([
    userRow("u1", [textBlock("Do the thing.")]),
    userRow("u2", [textBlock("Actually never mind.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({ transcript_path: transcriptPath, stop_hook_active: false });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.equal(stdout.trim(), "", "expected empty stdout when no assistant messages");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H9: transcript with multi-row assistant turn, punt text -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    userRow("u1", [textBlock("Run the migration.")]),
    assistantRow("a1", [thinkingBlock("I should run this now.")]),
    assistantRow("a1", [toolUseBlock("Bash", { command: "npm run migrate" })]),
    assistantRow("a1", [textBlock("The migration is left for later. Feel free to run it next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({ transcript_path: transcriptPath, stop_hook_active: false });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "expected block output for multi-row punt turn");
    let decision;
    try { decision = JSON.parse(stdout.trim()); } catch (_) {
      assert.fail("stdout is not valid JSON: " + stdout);
    }
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H10: stdin last_assistant_message (punt) wins over clean transcript -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("Done. Everything is complete and verified.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "There are a few loose ends, your call on those.",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "expected block output driven by stdin last_assistant_message");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H11: stdin last_assistant_message (clean) wins over punt transcript -> allows", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "Done. Build passed. All tests green.",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.equal(stdout.trim(), "", "expected empty stdout: clean stdin text should override punt transcript text");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H12: stdin last_assistant_message: '' (empty string) falls back to transcript -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "empty-string last_assistant_message must fall back to transcript parsing");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H13: stdin last_assistant_message: spaces only falls back to transcript -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "   ",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "whitespace-only last_assistant_message must fall back to transcript parsing");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H14: stdin last_assistant_message: tab/newline only falls back to transcript -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "\t\n",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "tab/newline-only last_assistant_message must fall back to transcript parsing");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H15: stdin last_assistant_message: NBSP only falls back to transcript -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "\u00A0",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "NBSP-only last_assistant_message must fall back to transcript parsing");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H16: stdin last_assistant_message: zero-width chars only falls back to transcript -> blocks", () => {
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("There are loose ends, your call on whether to fix them next session.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "\u200B\u2060",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "zero-width-only last_assistant_message must fall back to transcript parsing");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

test("H17: stdin last_assistant_message: NBSP + genuine punt text -> source=stdin, blocks on the stdin content", () => {
  // Transcript is CLEAN; stdin (after a leading NBSP) is genuinely punt-like
  // (the same punt text reused throughout H11-H16's transcript fixtures).
  // A leading NBSP must not disqualify the real text that follows it, and
  // the block decision proves the STDIN text drove classification -- if the
  // transcript had won instead, this would allow.
  const transcriptPath = writeTempTranscript([
    assistantRow("a1", [textBlock("Done. Everything is complete and verified.")]),
  ]);
  try {
    const { exitCode, stdout } = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
      last_assistant_message: "\u00A0There are loose ends, your call on whether to fix them next session.",
    });
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.ok(stdout.trim().length > 0, "NBSP-prefixed genuine punt text must be classified as stdin text and block");
    const decision = JSON.parse(stdout.trim());
    assert.equal(decision.decision, "block");
  } finally {
    try { fs.unlinkSync(transcriptPath); } catch (_) {}
  }
});

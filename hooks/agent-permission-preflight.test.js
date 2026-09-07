"use strict";
// agent-permission-preflight.test.js
// Unit + integration tests for the agent-permission-preflight PreToolUse
// hook. Run with: node hooks/agent-permission-preflight.test.js (from the repo root)
//
// Follows the conventions of agent-adversary-floor.test.js: unit tests
// against exported pure functions, then subprocess integration tests
// against the hook's stdin/exit-code/stderr contract. All fixtures are
// hermetic — each test that needs settings-layer control constructs its own
// temp cwd (and, where the user-layer matters, a temp HOME/USERPROFILE) so
// nothing here depends on this machine's real ~/.claude/settings.json
// content.
//
// Test matrix (mirrors the task's "AT LEAST" list, each item traceable):
//   T1  clean compliant prompt with marker -> ALLOW
//   T2  canon boilerplate PROHIBITS force-push/PowerShell in prose (no
//       fence, no directive cue) -> ALLOW (the P-1 false-positive
//       regression — most important test in this file)
//   T3  fenced `git push --force` -> BLOCK, names lint-a
//   T4  `Run: git push -f origin main` directive cue -> BLOCK, names lint-a
//   T5  line-wrapped force-push inside a fence -> BLOCK, names lint-a
//   T6  `$ sudo rm -rf /` inside a fence, deny list contains an rm-rf
//       pattern -> BLOCK, names BOTH lint-d and lint-g
//   T7  missing marker (otherwise clean) -> BLOCK, names marker-floor
//   T8  Explore-type Agent dispatch, no marker -> ALLOW (structurally exempt)
//   T9  SendMessage payload with fenced force-push -> BLOCK, names lint-a
//   T10 malformed settings.local.json in a temp cwd fixture -> BLOCK, names
//       settings-unparsable with the exact path
//   T11 missing cwd-layer settings files entirely, baseline satisfied only
//       by a temp user-layer (~/.claude/settings.json) -> ALLOW
//   T12 marker present AND fenced force-push present -> STILL BLOCKS
//       (P-2 regression: marker never suppresses a lint)
//   T13 stray `-f` in `curl -f` inside a fence, no "git push" anywhere ->
//       ALLOW (P-6 overreach regression)
//
// No-backgrounding floor: REINSTATED, mode-gated to the full-check branch
// (see the hook's "PERMISSION-MODE-AWARE RELAXATION" header section).
// hasNoBackgroundClause's own unit tests (U-NB1..U-NB5 below) are unchanged;
// R7a/R7b/R7c below cover the reinstated finding's mode-gating specifically.
//
// Permission-mode-aware relaxation (bypassPermissions) — R1..R8, mirrors the
// task's "AT LEAST" list:
//   R1  Agent + bypassPermissions + no isolation + marker-less clean text ->
//       ALLOWED (relaxed branch; also proves settings-bare-bash is skipped)
//   R2  identical dispatch but tool_name SendMessage -> BLOCKED on
//       marker-floor (SendMessage is never relaxed, A1)
//   R3  same Agent dispatch but with an isolation key present -> BLOCKED on
//       marker-floor (full checks, A3); R3b covers an empty-string isolation
//       value specifically (presence, not truthiness)
//   R4  fenced force-push under bypassPermissions -> BLOCKED on lint-a even
//       in the relaxed branch (item 3: lint-a is never skipped)
//   R5  wrong-case 'BypassPermissions' (R5a) and leading-whitespace
//       ' bypassPermissions' (R5b) both land in full checks (strict ===)
//   R6  settings-unparsable still BLOCKS under bypassPermissions (A2, never
//       demoted in either branch)
//   R7  no-background-floor mode-gating: fires in full checks with no
//       prohibition (R7a), doesn't fire in full checks with a prohibition
//       clause present (R7b), and doesn't fire in the relaxed branch at all
//       even without a clause (R7c)
// U-RD1..U-RD6: isRelaxedDispatch's own total-classification table (every
// documented permission_mode value, missing/non-string values, casing and
// whitespace variants, non-Agent tool names, and isolation-key presence).
// U-EVAL1..U-EVAL5: evaluateDispatchWithCwd's new trailing `options`
// parameter, exercised directly (not via subprocess) — backward
// compatibility when omitted, the exact 3-finding skip set under
// {relaxed:true}, and that every other check (including settings-unparsable
// passthrough) still fires regardless of the flag.
//
// Plus supporting unit tests for the pure functions and a final smoke run
// against a realistic captured-shape payload built from the sibling hook's
// documented input shape.

const { test }         = require("node:test");
const assert           = require("node:assert/strict");
const fs               = require("fs");
const os               = require("os");
const path             = require("path");
const { execFileSync, spawnSync } = require("child_process");

const HOOK_PATH = path.join(__dirname, "agent-permission-preflight.js");
const DEBUG_LOG = path.join(__dirname, "agent-permission-preflight-debug.log");

const {
  isExemptType,
  MARKER_RE,
  hasNoBackgroundClause,
  isRelaxedDispatch,
  scanGitPushForce,
  scanInteractiveGit,
  scanSettingsEdit,
  scanSudo,
  scanDenyListPatterns,
  globPatternToRegex,
  genericSpans,
  loadMergedSettings,
  evaluateDispatchWithCwd,
  buildSandboxRoots,
  isWithinSandbox,
  resolvePathForSandboxCompare,
} = require(HOOK_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runHook(payload, opts) {
  opts = opts || {};
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const env = Object.assign({}, process.env);
  if (opts.home) {
    env.HOME = opts.home;
    env.USERPROFILE = opts.home;
  }
  // spawnSync (not execFileSync) — execFileSync only surfaces stderr via its
  // thrown-error path (nonzero exit), silently discarding stderr on a clean
  // exit 0. This hook's fail-open path (P-9) deliberately writes a
  // non-blocking stderr note on exit 0, so the test harness MUST capture
  // stderr unconditionally, not just on failure.
  const result = spawnSync("node", [HOOK_PATH], {
    input,
    encoding: "utf8",
    timeout: 10000,
    env,
  });
  return {
    exitCode: result.status != null ? result.status : 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// `extra` (optional, 4th arg on both helpers below) carries the new
// mode-relaxation fields without disturbing any existing positional call
// site in this file: { permission_mode, isolation }. `isolation` is only
// meaningful on the Agent helper (SendMessage has no subagent_type/
// isolation concept in this hook's model). A key is added to tool_input
// ONLY when `extra.isolation` is explicitly provided, so omitting it never
// accidentally satisfies (or fails) the "isolation key present at all"
// classifier condition.
function agentPayload(subagentType, prompt, cwd, extra) {
  const tool_input = { prompt };
  if (subagentType !== undefined) tool_input.subagent_type = subagentType;
  if (extra && Object.prototype.hasOwnProperty.call(extra, "isolation")) {
    tool_input.isolation = extra.isolation;
  }
  const p = { tool_name: "Agent", tool_input };
  if (cwd) p.cwd = cwd;
  if (extra && extra.permission_mode !== undefined) p.permission_mode = extra.permission_mode;
  return p;
}

function sendMessagePayload(message, cwd, extra) {
  const p = { tool_name: "SendMessage", tool_input: { to: "researcher", message } };
  if (cwd) p.cwd = cwd;
  if (extra && extra.permission_mode !== undefined) p.permission_mode = extra.permission_mode;
  return p;
}

function mkTempCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
}

function writeSettings(dir, obj, local) {
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, local ? "settings.local.json" : "settings.json");
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  return file;
}

const CLEAN_ALLOW_SETTINGS = { permissions: { allow: ["Bash", "Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "PowerShell"] } };

const MARKER = "PERMISSION-SAFE operation — zero-dialog constraints apply.";

// Carries the marker AND the reinstated no-background prohibition (item 4)
// so pre-existing tests built on this shared constant keep their original
// ALLOW outcome now that the no-background-floor finding is back and active
// in the full-check branch.
const COMPLIANT_CLEAN_PROMPT =
  `${MARKER}\nWrite a small helper function and add a unit test for it. ` +
  `Never use background task execution (run_in_background) in this dispatch. ` +
  `Report what this work canNOT detect.`;

// ---------------------------------------------------------------------------
// Unit tests: pure functions
// ---------------------------------------------------------------------------

test("U1: isExemptType true for Explore, false for unknown", () => {
  assert.equal(isExemptType("Explore"), true);
  assert.equal(isExemptType("general-purpose"), false);
  assert.equal(isExemptType("some-future-agent"), false);
});

test("U2: MARKER_RE matches all three documented forms, case-insensitively", () => {
  assert.equal(MARKER_RE.test("this is zero-dialog work"), true);
  assert.equal(MARKER_RE.test("PERMISSION-SAFE operation"), true);
  assert.equal(MARKER_RE.test("permission-safe mode"), true);
  assert.equal(MARKER_RE.test("nothing relevant here"), false);
});

test("U3: scanGitPushForce fires on fenced --force, not on bare mention", () => {
  const fenced = ["git push --force origin main"];
  assert.equal(scanGitPushForce(fenced).fired, true);
});

test("U4: scanGitPushForce does NOT fire on curl -f with no git push nearby", () => {
  const spans = ["curl -f https://example.com/health"];
  assert.equal(scanGitPushForce(spans).fired, false);
});

test("U5: scanGitPushForce fires on standalone -f within window", () => {
  const spans = ["git push -f origin main"];
  assert.equal(scanGitPushForce(spans).fired, true);
});

test("U6: scanInteractiveGit fires on rebase -i and add -p, not on bare git add", () => {
  assert.equal(scanInteractiveGit(["git rebase -i HEAD~3"]).fired, true);
  assert.equal(scanInteractiveGit(["git add -p"]).fired, true);
  assert.equal(scanInteractiveGit(["git add file.txt"]).fired, false);
});

test("U7: scanSettingsEdit fires on prose (no fence needed) in either order", () => {
  assert.equal(scanSettingsEdit("please edit settings.json for me").fired, true);
  assert.equal(scanSettingsEdit("settings.local.json is the file you should modify").fired, true);
  // A bare mention with NO edit/modify/write verb nearby does not fire —
  // the hazard is the verb+file pairing, not the filename alone.
  assert.equal(scanSettingsEdit("settings.json is read-only, do not touch it").fired, false);
});

test("U8: scanSudo fires within a span", () => {
  assert.equal(scanSudo(["sudo rm -rf /"]).fired, true);
  assert.equal(scanSudo(["no hazard here"]).fired, false);
});

test("U9: globPatternToRegex converts Tool(pattern) form and matches", () => {
  const re = globPatternToRegex("Bash(rm -rf *)");
  assert.ok(re);
  assert.equal(re.test("sudo rm -rf /"), true);
  assert.equal(re.test("totally unrelated text"), false);
});

test("U10: genericSpans extracts fenced, inline-backtick, cue-window, and sigil-line content", () => {
  const text = [
    "prose before",
    "```",
    "git push --force",
    "```",
    "Use: git rebase -i HEAD~1",
    "$ echo hello",
    "prose after mentioning git push --force in plain English should still show up as a span only via cue/sigil/fence, never bare",
  ].join("\n");
  const spans = genericSpans(text);
  assert.ok(spans.some((s) => /git push --force/.test(s)));
  assert.ok(spans.some((s) => /git rebase -i/.test(s)));
  assert.ok(spans.some((s) => /echo hello/.test(s)));
});

test("U11: loadMergedSettings unions allow/deny across present layers and treats missing as empty", () => {
  const dir = mkTempCwd("preflight-u11");
  writeSettings(dir, { permissions: { allow: ["Bash"], deny: ["Bash(rm -rf *)"] } }, false);
  const home = mkTempCwd("preflight-u11-home");
  writeSettings(home, { permissions: { allow: ["PowerShell"] } }, false);
  const origHome = os.homedir;
  try {
    // Monkeypatch not reliable across module boundary for os.homedir(); this
    // unit test instead verifies the pure merge behavior directly using the
    // cwd-layer paths only (the subprocess integration tests below cover
    // the full three-layer + HOME-override path end-to-end).
    const merged = loadMergedSettings(dir);
    assert.ok(merged.allow.indexOf("Bash") !== -1);
    assert.ok(merged.deny.indexOf("Bash(rm -rf *)") !== -1);
  } finally {
    void origHome;
  }
});

// ---------------------------------------------------------------------------
// G1-G6: lint-g / globPatternToRegex hardened spec B (2026-08-24, "rd-glob"
// fix). See the hook's "Lint (g)" comment block for the full total-
// classification this closes.
// ---------------------------------------------------------------------------

test("G1: deny PowerShell(rd *), span 'node scripts/verify.js --standard strict' -> no finding (repro-2 pin)", () => {
  const findings = scanDenyListPatterns(
    ["node scripts/verify.js --standard strict"],
    ["PowerShell(rd *)"]
  );
  assert.deepEqual(findings, [], `expected no findings, got ${JSON.stringify(findings)}`);
});

test("G2: deny PowerShell(rd *), span 'rd /s /q build\\\\out' -> fires", () => {
  const findings = scanDenyListPatterns(
    ["rd /s /q build\\out"],
    ["PowerShell(rd *)"]
  );
  assert.ok(findings.some((f) => f.id === "lint-g-deny-list"), `expected lint-g-deny-list, got ${JSON.stringify(findings)}`);
});

test("G3: deny Bash(rm -r *) — 'npm run format -- --write' no finding; 'cd x; rm -r dist' fires (mid-line boundary)", () => {
  const clean = scanDenyListPatterns(["npm run format -- --write"], ["Bash(rm -r *)"]);
  assert.deepEqual(clean, [], `expected no findings for the clean span, got ${JSON.stringify(clean)}`);

  const hazard = scanDenyListPatterns(["cd x; rm -r dist"], ["Bash(rm -r *)"]);
  assert.ok(hazard.some((f) => f.id === "lint-g-deny-list"), `expected lint-g-deny-list, got ${JSON.stringify(hazard)}`);
});

test("G4: deny Bash(rm -rf *), span 'rm   -rf /tmp/x' (extra whitespace) -> fires", () => {
  const findings = scanDenyListPatterns(["rm   -rf /tmp/x"], ["Bash(rm -rf *)"]);
  assert.ok(findings.some((f) => f.id === "lint-g-deny-list"), `expected lint-g-deny-list, got ${JSON.stringify(findings)}`);
});

test("G5: unparsable deny entry 'Bash()' -> deny-entry-unverifiable finding", () => {
  const findings = scanDenyListPatterns(["anything at all"], ["Bash()"]);
  assert.ok(
    findings.some((f) => f.id === "deny-entry-unverifiable" && f.detail.includes("Bash()")),
    `expected deny-entry-unverifiable naming the entry, got ${JSON.stringify(findings)}`
  );
});

test("G6: end-to-end full repro-2 payload vs fixture settings with PowerShell(rd *) -> exit 0", () => {
  const dir = mkTempCwd("preflight-g6");
  writeSettings(dir, {
    permissions: { allow: ["Bash", "Bash(*)", "PowerShell"], deny: ["PowerShell(rd *)"] },
  }, true);
  const prompt =
    "ZERO-DIALOG dispatch. Never create background tasks (run_in_background is forbidden).\n\n" +
    "Run:\n```\nnode scripts/verify.js --standard strict\n```\n\n" +
    "Report results. MANDATORY: include a blind-spot section stating what your verification canNOT detect.";
  const res = runHook(
    agentPayload("general-purpose", prompt, dir, { permission_mode: "bypassPermissions", isolation: "worktree" })
  );
  assert.equal(res.exitCode, 0, "stdout/stderr: " + res.stdout + res.stderr);
});

// ---------------------------------------------------------------------------
// T1: clean compliant prompt with marker -> ALLOW
// ---------------------------------------------------------------------------

test("T1: clean compliant prompt with marker -> ALLOW", () => {
  const dir = mkTempCwd("preflight-t1");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(agentPayload("general-purpose", COMPLIANT_CLEAN_PROMPT, dir));
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

// ---------------------------------------------------------------------------
// T2: THE most important test — canon boilerplate PROHIBITS hazards in
// prose; must not be treated as an instruction to perform them.
// ---------------------------------------------------------------------------

test("T2: prose prohibitions ('never force-push', 'NEVER call the PowerShell tool') -> ALLOW", () => {
  const dir = mkTempCwd("preflight-t2");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\n` +
    `Zero-dialog constraints: all shell via Bash tool; never force-push under any circumstances; ` +
    `NEVER call the PowerShell tool for any reason; do not use sudo; never rebase interactively; ` +
    `never use background task execution (run_in_background).\n` +
    `Implement the feature and write tests. Report what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

// ---------------------------------------------------------------------------
// T3: fenced `git push --force` -> BLOCK, names lint-a
// ---------------------------------------------------------------------------

test("T3: fenced git push --force -> BLOCK, names lint-a", () => {
  const dir = mkTempCwd("preflight-t3");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\nRun the following:\n\`\`\`\ngit push --force origin feature-branch\n\`\`\`\n` +
    `Report what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
});

// ---------------------------------------------------------------------------
// T4: `Run: git push -f origin main` directive cue -> BLOCK
// ---------------------------------------------------------------------------

test("T4: directive-cue 'Run: git push -f origin main' -> BLOCK, names lint-a", () => {
  const dir = mkTempCwd("preflight-t4");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\nRun: git push -f origin main\nReport what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
});

// ---------------------------------------------------------------------------
// T5: line-wrapped force-push inside a fence -> BLOCK
// ---------------------------------------------------------------------------

test("T5: line-wrapped force-push in fence -> BLOCK, names lint-a", () => {
  const dir = mkTempCwd("preflight-t5");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\n\`\`\`\ngit push \\\n  --force origin main\n\`\`\`\nReport what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
});

// ---------------------------------------------------------------------------
// T6: `$ sudo rm -rf /` in fence, deny list has an rm-rf pattern ->
// BLOCK naming BOTH lint-d and lint-g
// ---------------------------------------------------------------------------

test("T6: fenced sudo rm -rf with deny-list rm-rf rule -> BLOCK, names lint-d AND lint-g", () => {
  const dir = mkTempCwd("preflight-t6");
  writeSettings(dir, {
    permissions: {
      allow: ["Bash", "Bash(*)", "PowerShell"],
      deny: ["Bash(rm -rf *)"],
    },
  }, true);
  const prompt =
    `${MARKER}\n\`\`\`\n$ sudo rm -rf /\n\`\`\`\nReport what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-d-sudo/);
  assert.match(res.stderr, /lint-g-deny-list/);
});

// ---------------------------------------------------------------------------
// T7: missing marker -> BLOCK, names marker-floor
// ---------------------------------------------------------------------------

test("T7: missing marker, otherwise clean -> BLOCK, names marker-floor", () => {
  const dir = mkTempCwd("preflight-t7");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt = `Implement the feature and write tests. Report what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

// ---------------------------------------------------------------------------
// T8: Explore-type dispatch, no marker -> ALLOW (structurally exempt)
// ---------------------------------------------------------------------------

test("T8: Explore-type Agent dispatch with no marker -> ALLOW (exempt)", () => {
  const dir = mkTempCwd("preflight-t8");
  // Deliberately NO settings written at all — exempt types must skip the
  // settings-baseline check entirely too.
  const prompt = `Find every file that references the config loader. No marker, no clause.`;
  const res = runHook(agentPayload("Explore", prompt, dir));
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

// ---------------------------------------------------------------------------
// T9: SendMessage payload with fenced force-push -> BLOCK
// ---------------------------------------------------------------------------

test("T9: SendMessage with fenced git push --force -> BLOCK, names lint-a", () => {
  const dir = mkTempCwd("preflight-t9");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const message =
    `${MARKER}\n\`\`\`\ngit push --force origin main\n\`\`\`\nReport what this canNOT detect.`;
  const res = runHook(sendMessagePayload(message, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
});

// ---------------------------------------------------------------------------
// T10: malformed settings.local.json -> BLOCK, names settings-unparsable
// with the exact path
// ---------------------------------------------------------------------------

test("T10: malformed settings.local.json -> BLOCK, names settings-unparsable with path", () => {
  const dir = mkTempCwd("preflight-t10");
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const badFile = path.join(claudeDir, "settings.local.json");
  fs.writeFileSync(badFile, "{ this is not valid JSON ][", "utf8");
  const res = runHook(agentPayload("general-purpose", COMPLIANT_CLEAN_PROMPT, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /settings-unparsable/);
  // Path must be named exactly (normalize slashes for the assertion since
  // Windows paths in the message use whatever path.join produced).
  const normalizedBadFile = badFile.replace(/\\/g, "/");
  const normalizedStderr = res.stderr.replace(/\\/g, "/");
  assert.ok(normalizedStderr.includes(normalizedBadFile), "stderr should name the exact unparsable path");
  assert.match(res.stderr, /fix it in the MAIN checkout/);
});

// ---------------------------------------------------------------------------
// T11: missing cwd-layer settings entirely, baseline satisfied only by a
// temp user-layer (~/.claude/settings.json) -> ALLOW
// ---------------------------------------------------------------------------

test("T11: no cwd-layer settings, baseline from user layer only -> ALLOW", () => {
  const dir = mkTempCwd("preflight-t11-cwd"); // no .claude dir created here at all
  const home = mkTempCwd("preflight-t11-home");
  writeSettings(home, CLEAN_ALLOW_SETTINGS, false);
  const res = runHook(agentPayload("general-purpose", COMPLIANT_CLEAN_PROMPT, dir), { home });
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

// ---------------------------------------------------------------------------
// T12: marker present AND fenced force-push present -> STILL BLOCKS
// (P-2 regression: marker never suppresses a lint)
// ---------------------------------------------------------------------------

test("T12: marker present + fenced force-push -> STILL BLOCKS (P-2)", () => {
  const dir = mkTempCwd("preflight-t12");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\n\`\`\`\ngit push --force origin main\n\`\`\`\nReport what this canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
  assert.doesNotMatch(res.stderr, /marker-floor/); // marker itself is present and satisfied
});

// ---------------------------------------------------------------------------
// T13: stray -f in `curl -f` inside a fence, no git push anywhere -> ALLOW
// (P-6 overreach regression)
// ---------------------------------------------------------------------------

test("T13: stray -f in curl -f inside a fence, no git push -> ALLOW (P-6)", () => {
  const dir = mkTempCwd("preflight-t13");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\nRun the following:\n\`\`\`\ncurl -f https://example.com/healthz\n\`\`\`\n` +
    `Never use background task execution (run_in_background) in this dispatch. ` +
    `Report what this work canNOT detect.`;
  const res = runHook(agentPayload("general-purpose", prompt, dir));
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

// ---------------------------------------------------------------------------
// Permission-mode-aware relaxation (bypassPermissions) — R1..R8 plus
// supporting unit coverage of isRelaxedDispatch and evaluateDispatchWithCwd's
// new trailing `options` parameter. See the hook's header section
// "PERMISSION-MODE-AWARE RELAXATION" for the full rule these tests exercise.
// ---------------------------------------------------------------------------

const NO_MARKER_CLEAN_PROMPT =
  `Implement the feature and write tests. Report what this work canNOT detect.`;

test("R1: Agent + bypassPermissions + no isolation key + marker-less clean text -> ALLOWED (relaxed branch)", () => {
  const dir = mkTempCwd("preflight-r1");
  // Deliberately NO bare "Bash" in the merged allow — proves settings-bare-
  // bash is really skipped in the relaxed branch, not merely satisfied by
  // coincidence.
  writeSettings(dir, { permissions: { allow: ["Bash(*)", "PowerShell"] } }, true);
  const home = mkTempCwd("preflight-r1-home"); // no settings.json written -> empty layer
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, { permission_mode: "bypassPermissions" }),
    { home }
  );
  assert.equal(res.exitCode, 0, "stdout/stderr: " + res.stdout + res.stderr);
});

// R2 (UPDATED, hardened spec C-1, 2026-08-24): SendMessage now RELAXES under
// bypassPermissions (the retired "A1 — SendMessage never relaxed" premise is
// superseded — see the hook's header "SENDMESSAGE RELAXATION (C-1)"
// section). This test's ORIGINAL purpose — proving the full-check branch
// still blocks a marker-less SendMessage dispatch on marker-floor — is now
// pinned by explicitly requesting the "default" mode (which still forces
// full checks, C-3), rather than "bypassPermissions" (which would now be
// the relaxed branch and correctly ALLOW — that outcome is covered by R8
// below, the direct repro-3 pin).
test("R2: identical dispatch under mode 'default' -> BLOCKED on marker-floor (full checks; C-3)", () => {
  const dir = mkTempCwd("preflight-r2");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    sendMessagePayload(NO_MARKER_CLEAN_PROMPT, dir, { permission_mode: "default" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

test("R3: same Agent dispatch with isolation 'worktree' -> ALLOWED (relaxed; A3 amended 2026-08-24: worktree inherits the session's bypass mode)", () => {
  const dir = mkTempCwd("preflight-r3");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, {
      permission_mode: "bypassPermissions",
      isolation: "worktree",
    })
  );
  assert.equal(res.exitCode, 0, "stdout/stderr: " + res.stdout + res.stderr);
});

test("R3c: isolation 'remote' still forces full checks -> BLOCKED on marker-floor (non-worktree isolation, A3)", () => {
  const dir = mkTempCwd("preflight-r3c");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, {
      permission_mode: "bypassPermissions",
      isolation: "remote",
    })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

test("R3b: isolation key present with an EMPTY-STRING value still forces full checks (A3, non-worktree value)", () => {
  const dir = mkTempCwd("preflight-r3b");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, {
      permission_mode: "bypassPermissions",
      isolation: "",
    })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

test("R4: Agent dispatch under bypassPermissions with fenced force-push -> BLOCKED on lint-a even in relaxed branch", () => {
  const dir = mkTempCwd("preflight-r4");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const prompt =
    `${MARKER}\nRun the following:\n\`\`\`\ngit push --force origin feature-branch\n\`\`\`\n` +
    `Report what this work canNOT detect.`;
  const res = runHook(
    agentPayload("general-purpose", prompt, dir, { permission_mode: "bypassPermissions" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
});

test("R5a: wrong-case 'BypassPermissions' lands in full checks (strict ===, no case-fold)", () => {
  const dir = mkTempCwd("preflight-r5a");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, { permission_mode: "BypassPermissions" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

test("R5b: leading-whitespace ' bypassPermissions' lands in full checks (strict ===, no trim)", () => {
  const dir = mkTempCwd("preflight-r5b");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, { permission_mode: " bypassPermissions" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

test("R6: settings-unparsable still BLOCKS under bypassPermissions (never demoted, A2)", () => {
  const dir = mkTempCwd("preflight-r6");
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const badFile = path.join(claudeDir, "settings.local.json");
  fs.writeFileSync(badFile, "{ this is not valid JSON ][", "utf8");
  const res = runHook(
    agentPayload("general-purpose", COMPLIANT_CLEAN_PROMPT, dir, { permission_mode: "bypassPermissions" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /settings-unparsable/);
});

// R7: no-background-floor reinstatement, mode-gated to the full-check branch.
const NO_BG_CLAUSE_PROMPT =
  `${MARKER}\nNever use background task execution (run_in_background) in this dispatch.\n` +
  `Implement the feature and write tests. Report what this work canNOT detect.`;

// Marker present (so marker-floor stays satisfied) but deliberately WITHOUT
// the background-prohibition clause — distinct from COMPLIANT_CLEAN_PROMPT,
// which carries the clause so the pre-existing T1/T2/T11/T13/SMOKE fixtures
// keep their original ALLOW outcome now that the floor is reinstated.
const MARKER_ONLY_NO_BG_CLAUSE_PROMPT =
  `${MARKER}\nWrite a small helper function and add a unit test for it. ` +
  `Report what this work canNOT detect.`;

test("R7a: full-check-branch dispatch with NO background prohibition -> gains no-background-floor finding", () => {
  const dir = mkTempCwd("preflight-r7a");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(agentPayload("general-purpose", MARKER_ONLY_NO_BG_CLAUSE_PROMPT, dir));
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /no-background-floor/);
});

test("R7b: full-check-branch dispatch WITH a background prohibition clause -> no no-background-floor finding", () => {
  const dir = mkTempCwd("preflight-r7b");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(agentPayload("general-purpose", NO_BG_CLAUSE_PROMPT, dir));
  assert.equal(res.exitCode, 0, "stdout/stderr: " + res.stdout + res.stderr);
  assert.doesNotMatch(res.stderr, /no-background-floor/);
});

test("R7c: relaxed-branch dispatch without the background-prohibition clause -> no no-background-floor finding (skipped)", () => {
  const dir = mkTempCwd("preflight-r7c");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    agentPayload("general-purpose", NO_MARKER_CLEAN_PROMPT, dir, { permission_mode: "bypassPermissions" })
  );
  assert.equal(res.exitCode, 0, "stdout/stderr: " + res.stdout + res.stderr);
  assert.doesNotMatch(res.stderr, /no-background-floor/);
});

// ---------------------------------------------------------------------------
// R8/R8b/R8c/R8d: SendMessage resume relaxation (hardened spec C-1,
// 2026-08-24). See the hook's header "SENDMESSAGE RELAXATION (C-1)" section
// for the full rationale this closes (repro-3: a natural marker-less
// "please continue" resume of a worktree agent under bypassPermissions no
// longer blocks).
// ---------------------------------------------------------------------------

const RESUME_TEXT = "Thanks - your worktree is still intact. Please continue: finish the review you started and report your findings when done.";

test("R8: SendMessage + bypassPermissions + natural marker-less resume -> ALLOWED (repro-3 pin, C-1)", () => {
  const dir = mkTempCwd("preflight-r8");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    sendMessagePayload(RESUME_TEXT, dir, { permission_mode: "bypassPermissions" })
  );
  assert.equal(res.exitCode, 0, "stdout/stderr: " + res.stdout + res.stderr);
});

test("R8b: SendMessage + 'default' + marker-less resume -> BLOCKED (marker-floor still enforced, C-3)", () => {
  const dir = mkTempCwd("preflight-r8b");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(
    sendMessagePayload(RESUME_TEXT, dir, { permission_mode: "default" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /marker-floor/);
});

test("R8c: SendMessage + bypassPermissions + fenced force-push -> BLOCKED on lint-a (relaxed != unlinted)", () => {
  const dir = mkTempCwd("preflight-r8c");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const message = `${RESUME_TEXT}\nAlso run:\n\`\`\`\ngit push --force origin main\n\`\`\``;
  const res = runHook(
    sendMessagePayload(message, dir, { permission_mode: "bypassPermissions" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /lint-a-git-push-force/);
});

test("R8d: SendMessage + bypassPermissions + unparsable settings layer -> BLOCKED (settings-unparsable unconditional, A2)", () => {
  const dir = mkTempCwd("preflight-r8d");
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.local.json"), "{ not valid json ][", "utf8");
  const res = runHook(
    sendMessagePayload(RESUME_TEXT, dir, { permission_mode: "bypassPermissions" })
  );
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /settings-unparsable/);
});

// ---------------------------------------------------------------------------
// U-RD: isRelaxedDispatch's own total-classification table (every documented
// mode value, missing field, non-string, and isolation-present combinations)
// ---------------------------------------------------------------------------

test("U-RD1: isRelaxedDispatch — true only for Agent + exact 'bypassPermissions' + no isolation key", () => {
  assert.equal(isRelaxedDispatch("Agent", {}, "bypassPermissions"), true);
  assert.equal(isRelaxedDispatch("Agent", { subagent_type: "general-purpose" }, "bypassPermissions"), true);
});

test("U-RD2: isRelaxedDispatch — every other documented permission_mode value collapses to full (A5/A6)", () => {
  assert.equal(isRelaxedDispatch("Agent", {}, "default"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, "plan"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, "acceptEdits"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, "auto"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, "dontAsk"), false);
});

test("U-RD3: isRelaxedDispatch — missing field, non-string, and empty string all collapse to full", () => {
  assert.equal(isRelaxedDispatch("Agent", {}, null), false);
  assert.equal(isRelaxedDispatch("Agent", {}, undefined), false);
  assert.equal(isRelaxedDispatch("Agent", {}, 123), false);
  assert.equal(isRelaxedDispatch("Agent", {}, ""), false);
});

test("U-RD4: isRelaxedDispatch — casing/whitespace variants of the literal collapse to full (strict ===)", () => {
  assert.equal(isRelaxedDispatch("Agent", {}, "BypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, "BYPASSPERMISSIONS"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, " bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Agent", {}, "bypassPermissions "), false);
});

// U-RD5 (UPDATED, hardened spec C-1, 2026-08-24): SendMessage now relaxes
// under bypassPermissions (see U-RD7 for its own dedicated total-
// classification table). This test now covers the tool names that are
// NEITHER "Agent" NOR "SendMessage" — those still always collapse to full.
test("U-RD5: isRelaxedDispatch — tool names other than Agent/SendMessage always collapse to full", () => {
  assert.equal(isRelaxedDispatch("Bash", {}, "bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("", {}, "bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Write", {}, "bypassPermissions"), false);
});

test("U-RD7: isRelaxedDispatch — SendMessage total-classification table (C-1, 2026-08-24)", () => {
  assert.equal(isRelaxedDispatch("SendMessage", {}, "bypassPermissions"), true);
  assert.equal(isRelaxedDispatch("SendMessage", {}, "default"), false);
  assert.equal(isRelaxedDispatch("SendMessage", {}, "  bypassPermissions "), false);
  // Unconditional on tool_input — SendMessage has no "isolation" concept.
  assert.equal(isRelaxedDispatch("SendMessage", { isolation: "remote" }, "bypassPermissions"), true);
  assert.equal(isRelaxedDispatch("SendMessage", {}, "bypassPermissions"), true);
});

test("U-RD6: isRelaxedDispatch — isolation 'worktree' relaxes; every OTHER isolation value forces full (A3 amended 2026-08-24)", () => {
  assert.equal(isRelaxedDispatch("Agent", { isolation: "worktree" }, "bypassPermissions"), true);
  assert.equal(isRelaxedDispatch("Agent", { isolation: "remote" }, "bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Agent", { isolation: "" }, "bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Agent", { isolation: null }, "bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Agent", { isolation: undefined }, "bypassPermissions"), false);
  assert.equal(isRelaxedDispatch("Agent", { isolation: "Worktree" }, "bypassPermissions"), false);
});

// ---------------------------------------------------------------------------
// U-EVAL: evaluateDispatchWithCwd's new trailing `options` parameter
// ---------------------------------------------------------------------------

test("U-EVAL1: evaluateDispatchWithCwd with options OMITTED behaves exactly as full-check (backward compatible)", () => {
  const findings = evaluateDispatchWithCwd(NO_MARKER_CLEAN_PROMPT, process.cwd(), ["Bash", "PowerShell"], [], []);
  const ids = findings.map((f) => f.id);
  assert.ok(ids.includes("marker-floor"));
  assert.ok(ids.includes("no-background-floor"));
});

test("U-EVAL2: evaluateDispatchWithCwd({relaxed:true}) skips marker-floor and no-background-floor on the same input", () => {
  const findings = evaluateDispatchWithCwd(NO_MARKER_CLEAN_PROMPT, process.cwd(), ["Bash", "PowerShell"], [], [], { relaxed: true });
  const ids = findings.map((f) => f.id);
  assert.ok(!ids.includes("marker-floor"));
  assert.ok(!ids.includes("no-background-floor"));
});

test("U-EVAL3: relaxed mode skips settings-bare-bash and lint-e when unsatisfied; full mode fires both", () => {
  const psCueText = `${MARKER}\nRun: Invoke the PowerShell cmdlet to do the thing.`;

  const full = evaluateDispatchWithCwd(psCueText, process.cwd(), [], [], []);
  const fullIds = full.map((f) => f.id);
  assert.ok(fullIds.includes("settings-bare-bash"));
  assert.ok(fullIds.includes("lint-e-powershell-tool"));

  const relaxed = evaluateDispatchWithCwd(psCueText, process.cwd(), [], [], [], { relaxed: true });
  const relaxedIds = relaxed.map((f) => f.id);
  assert.ok(!relaxedIds.includes("settings-bare-bash"));
  assert.ok(!relaxedIds.includes("lint-e-powershell-tool"));
});

test("U-EVAL4: relaxed mode still fires lint-d/lint-g (everything except the 3 skipped findings stays active, item 3)", () => {
  const text = `${MARKER}\n\`\`\`\nsudo rm -rf /\n\`\`\`\n`;
  const relaxed = evaluateDispatchWithCwd(text, process.cwd(), ["Bash"], ["Bash(rm -rf *)"], [], { relaxed: true });
  const ids = relaxed.map((f) => f.id);
  assert.ok(ids.includes("lint-d-sudo"));
  assert.ok(ids.includes("lint-g-deny-list"));
});

test("U-EVAL5: settingsFindings (settings-unparsable) pass through unconditionally regardless of relaxed flag", () => {
  const unparsableFinding = [{ id: "settings-unparsable", detail: "settings file /fake/path unparsable" }];
  const relaxed = evaluateDispatchWithCwd(NO_MARKER_CLEAN_PROMPT, process.cwd(), ["Bash"], [], unparsableFinding, { relaxed: true });
  assert.ok(relaxed.some((f) => f.id === "settings-unparsable"));
});

// ---------------------------------------------------------------------------
// Unit tests: hasNoBackgroundClause (all three satisfying forms, plus the
// deliberate non-satisfying descriptive-only case)
// ---------------------------------------------------------------------------

test("U-NB1: hasNoBackgroundClause true for 'never...background' ordering", () => {
  assert.equal(hasNoBackgroundClause("NEVER use background task execution (run_in_background)."), true);
});

test("U-NB2: hasNoBackgroundClause true for 'background...forbidden/never' ordering", () => {
  assert.equal(hasNoBackgroundClause("Background task creation is forbidden in this dispatch."), true);
});

test("U-NB3: hasNoBackgroundClause true for run_in_background preceded within 40 chars by never/no/don't", () => {
  // "run_in_background" is one token (underscore is a \w char, so the
  // generic \bbackground\b patterns never match it) — this exercises the
  // dedicated third form instead: a literal never/no/don't word preceding
  // the token within 40 chars.
  assert.equal(hasNoBackgroundClause("Never, under any circumstance, pass run_in_background."), true);
});

test("U-NB4: hasNoBackgroundClause false for a bare descriptive mention", () => {
  assert.equal(hasNoBackgroundClause("For context, the agent runs in the background while you wait."), false);
});

test("U-NB5: hasNoBackgroundClause false when 'background' and 'no' are far apart (window bound respected)", () => {
  const filler = "x".repeat(80);
  assert.equal(hasNoBackgroundClause(`no ${filler} background`), false);
});

// ---------------------------------------------------------------------------
// Additional integration coverage (fail-open paths, non-target tools)
// ---------------------------------------------------------------------------

test("H-extra: non-Agent/non-SendMessage tool_name -> ALLOW untouched", () => {
  const res = runHook({ tool_name: "Write", tool_input: { file_path: "x", content: "y" } });
  assert.equal(res.exitCode, 0);
});

test("H-extra: malformed stdin JSON -> ALLOW (fail-open) with SKIPPED stderr note", () => {
  const res = runHook("{ not valid json", { isRaw: true });
  assert.equal(res.exitCode, 0);
  assert.match(res.stderr, /preflight SKIPPED \(json_parse_error\)/);
});

test("H-extra: empty stdin -> ALLOW (fail-open)", () => {
  const res = runHook("", { isRaw: true });
  assert.equal(res.exitCode, 0);
});

test("H-extra: Agent prompt field missing -> ALLOW (fail-open) with SKIPPED note", () => {
  const res = runHook({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose" } });
  assert.equal(res.exitCode, 0);
  assert.match(res.stderr, /preflight SKIPPED \(prompt_missing_or_non_string\)/);
});

test("H-extra: SendMessage empty message -> ALLOW (not a work assignment)", () => {
  const dir = mkTempCwd("preflight-hextra-sm-empty");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const res = runHook(sendMessagePayload("   ", dir));
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

test("H-extra: bare Bash missing from merged allow -> BLOCK, names settings-bare-bash", () => {
  const dir = mkTempCwd("preflight-hextra-nobash");
  writeSettings(dir, { permissions: { allow: ["Bash(*)", "PowerShell"] } }, true); // no bare "Bash"
  // Must also override HOME to an empty fixture — otherwise the union merge
  // picks up bare "Bash" from this machine's real ~/.claude/settings.json
  // (which does grant it) and the check passes for the wrong reason.
  const home = mkTempCwd("preflight-hextra-nobash-home");
  const res = runHook(agentPayload("general-purpose", COMPLIANT_CLEAN_PROMPT, dir), { home });
  assert.equal(res.exitCode, 2, "stdout/stderr: " + res.stdout + res.stderr);
  assert.match(res.stderr, /settings-bare-bash/);
});

test("H-extra: settings-unparsable finding fires even for an exempt-less SendMessage with everything else clean", () => {
  const dir = mkTempCwd("preflight-hextra-sm-badsettings");
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{{{not json", "utf8");
  const res = runHook(sendMessagePayload(COMPLIANT_CLEAN_PROMPT, dir));
  assert.equal(res.exitCode, 2);
  assert.match(res.stderr, /settings-unparsable/);
});

// ---------------------------------------------------------------------------
// Lint (f) sandbox-root resolution: resolvePathForSandboxCompare /
// isWithinSandbox (fix/preflight-sandbox-path-resolve).
//
// Bug fixed: normalizePathStr was a purely LEXICAL transform (backslash ->
// slash, lowercase, trailing-slash strip) with no "." / ".." collapsing, so
// a candidate like "C:/Projects/acct/dev/../Windows/System32/x.txt" started
// with the "C:/Projects/acct/dev" root as a bare string while resolving
// OUTSIDE every root once ".." is applied. isWithinSandbox's separator-
// boundary check (root === candidate, or candidate.startsWith(root + "/"))
// was already correct for the sibling "dev" vs "development" prefix case —
// S5 below is a regression test pinning that it stays correct, not a fix.
// ---------------------------------------------------------------------------

test("SANDBOX-S1: '..' traversal under a root resolves outside -> isWithinSandbox false", () => {
  const roots = ["c:/projects/acct/dev"];
  assert.equal(
    isWithinSandbox("C:/Projects/acct/dev/../Windows/System32/x.txt", roots),
    false
  );
});

test("SANDBOX-S2: '.' segments resolve to the same inside path -> isWithinSandbox true", () => {
  const roots = ["c:/projects/acct/dev"];
  assert.equal(
    isWithinSandbox("C:/Projects/acct/dev/./sub/x.txt", roots),
    true
  );
});

test("SANDBOX-S3: sibling-prefix 'development' vs root 'dev' -> isWithinSandbox false (boundary regression)", () => {
  const roots = ["c:/projects/acct/dev"];
  assert.equal(
    isWithinSandbox("C:/Projects/acct/development/foo.txt", roots),
    false
  );
});

test("SANDBOX-S4: mixed separators and case, genuinely inside -> isWithinSandbox true", () => {
  const roots = ["c:/projects/acct/dev"];
  assert.equal(
    isWithinSandbox("C:\\Projects\\ACCT\\Dev\\sub\\FILE.txt", roots),
    true
  );
});

test("SANDBOX-S5: UNC path -> isWithinSandbox false (never a local drive-letter root)", () => {
  const roots = ["c:/projects/acct/dev"];
  assert.equal(isWithinSandbox("\\\\server\\share\\x", roots), false);
  assert.equal(resolvePathForSandboxCompare("\\\\server\\share\\x"), null);
});

test("SANDBOX-S6: drive-relative 'C:x.txt' -> isWithinSandbox false (unresolvable, total-classification default)", () => {
  const roots = ["c:/projects/acct/dev"];
  assert.equal(isWithinSandbox("C:x.txt", roots), false);
  assert.equal(resolvePathForSandboxCompare("C:x.txt"), null);
});

test("SANDBOX-S7: a root supplied with a trailing slash (e.g. from local-policy.json) resolves and matches its own boundary correctly", () => {
  // Roots reach isWithinSandbox pre-resolved via buildSandboxRoots's own
  // pushRoot/resolvePathForSandboxCompare pass (see SANDBOX-S8) — a raw,
  // never-resolved root string is not a shape isWithinSandbox is ever
  // actually called with in production. Exercise that same resolution step
  // directly on a trailing-slash root, the shape local-policy.json's
  // "roots" array can supply.
  const rawRoot = "c:/projects/acct/dev/"; // trailing slash, as a human might write it
  const resolvedRoot = resolvePathForSandboxCompare(rawRoot);
  assert.equal(resolvedRoot, "c:/projects/acct/dev", "trailing slash must be stripped on resolution");
  const roots = [resolvedRoot];
  // Exact-equal-to-root form.
  assert.equal(isWithinSandbox("C:/Projects/acct/dev", roots), true);
  // Genuinely inside.
  assert.equal(isWithinSandbox("C:/Projects/acct/dev/sub/x.txt", roots), true);
  // Sibling still rejected even though the root was supplied with a
  // trailing slash before resolution.
  assert.equal(isWithinSandbox("C:/Projects/acct/development/x.txt", roots), false);
});

test("SANDBOX-S8: buildSandboxRoots collapses '..' in a policy-supplied root before comparison", () => {
  // Exercises buildSandboxRoots' own resolvePathForSandboxCompare pass over
  // roots (not just candidate tokens) — a root sourced with an un-collapsed
  // ".." must not silently widen or narrow the sandbox.
  const cwd = "C:/Projects/acct/dev/judge/../judge-pr8";
  const roots = buildSandboxRoots(cwd);
  const resolvedCwdRoot = resolvePathForSandboxCompare(cwd);
  assert.ok(roots.includes(resolvedCwdRoot), "cwd root should be resolved, not kept raw");
  assert.ok(!roots.some((r) => r.indexOf("..") !== -1), "no root should retain an un-collapsed '..'");
});

// ---------------------------------------------------------------------------
// node --check smoke (both files) + realistic captured-shape payload
// ---------------------------------------------------------------------------

test("SMOKE: node --check passes on both hook files", () => {
  execFileSync("node", ["--check", HOOK_PATH], { encoding: "utf8" });
  execFileSync("node", ["--check", __filename], { encoding: "utf8" });
});

test("SMOKE: realistic captured-shape payload (mirrors agent-adversary-floor's documented input shape)", () => {
  const dir = mkTempCwd("preflight-smoke");
  writeSettings(dir, CLEAN_ALLOW_SETTINGS, true);
  const realisticPayload = {
    tool_name: "Agent",
    cwd: dir,
    agent_id: "orchestrator-01",
    tool_input: {
      subagent_type: "general-purpose",
      description: "Author a small script",
      prompt: COMPLIANT_CLEAN_PROMPT,
    },
  };
  const res = runHook(realisticPayload);
  assert.equal(res.exitCode, 0, "stderr: " + res.stderr);
});

// ---------------------------------------------------------------------------
// Cleanup note: temp dirs created under os.tmpdir() are left in place
// (mirrors the sibling test suite's convention — OS temp cleanup handles
// this eventually; deleting mid-suite risks racing a still-open debug log
// or a slow subprocess on Windows).
// ---------------------------------------------------------------------------

void DEBUG_LOG; // referenced for documentation purposes only in this file

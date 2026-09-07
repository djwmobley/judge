"use strict";
// agent-model-routing-guard.test.js
// node:test suite for Hook 1 (agent-model-routing-guard.js) plus unit tests
// for the shared helper modules it depends on (model-routing-guards.unicode.js,
// model-routing-guards.exempt.js, hooks/lib/local-policy.js's model_tiers
// fold/validation, and agent-tier-ledger.js's per-agent tier ledger).
//
// Every real model-family literal is replaced with a placeholder tier
// literal (e.g. "planning-model-x") mapped to a tier via a fake
// ~/.claude/hooks/local-policy.json written under a temp HOME for each
// subprocess call — see mkTierHome()/runHook() below. This repo speaks tier
// language only (planning/drafting/mechanical); the mapping from a real
// model name to a tier is the ONE thing that lives outside this repo, in
// the operator's own local-policy.json (never committed).
//
// End-to-end cases spawn the hook as a child process with stdin JSON
// (matches the convention in the other *.test.js files in this directory).

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, execFile, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK_JS = path.join(__dirname, "agent-model-routing-guard.js");
// The REAL production SubagentStart entry point (scripts/install-guards.js's
// GUARDS registry, event: 'SubagentStart') — a separate on-disk file from
// HOOK_JS that does `require("./agent-model-routing-guard.js").main()`. See
// the "subagentstart_capture_via_production_shim" regression test below:
// every other SubagentStart-shaped test in this file spawns HOOK_JS
// directly, which never exercises this file at all.
const SHIM_JS = path.join(__dirname, "agent-model-routing-guard-subagentstart.js");
const { stripNormalize, isBlankAfterStrip, stripInvisible } = require("./model-routing-guards.unicode.js");
const { PINNED_EXEMPT_TYPES, resolveExemptTypes, sameSet } = require("./model-routing-guards.exempt.js");
const { validateModelTiers, foldModelTierToken } = require("./lib/local-policy.js");
const guard = require("./agent-model-routing-guard.js");
const ledger = require("./agent-tier-ledger.js");
const state = require("./model-routing-guards.state.js");

// ─── Placeholder tier literals (never a real model-family name) ──────────

const PLANNING_MODEL = "planning-model-x";
const DRAFTING_MODEL = "drafting-model-x";
const MECHANICAL_MODEL = "mechanical-model-x";
const DEFAULT_MODEL_TIERS = {
  [PLANNING_MODEL]: "planning",
  [DRAFTING_MODEL]: "drafting",
  [MECHANICAL_MODEL]: "mechanical",
};

function mkTierHome(modelTiers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amrg-home-"));
  const hooksDir = path.join(dir, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  if (modelTiers !== null) {
    fs.writeFileSync(path.join(hooksDir, "local-policy.json"), JSON.stringify({ model_tiers: modelTiers }), "utf8");
  }
  return dir;
}

const DEFAULT_HOME = mkTierHome(DEFAULT_MODEL_TIERS);

function runHook(stdinObj, opts) {
  opts = opts || {};
  const input = typeof stdinObj === "string" ? stdinObj : JSON.stringify(stdinObj);
  const env = Object.assign({}, process.env);
  const home = opts.home !== undefined ? opts.home : DEFAULT_HOME;
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
  }
  const result = spawnSync(process.execPath, [HOOK_JS], { input, encoding: "utf8", timeout: 10000, env });
  return { code: result.status != null ? result.status : 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/** Same as runHook(), but spawns SHIM_JS (the real installed SubagentStart
 * entry point) instead of HOOK_JS directly. */
function runShim(stdinObj, opts) {
  opts = opts || {};
  const input = typeof stdinObj === "string" ? stdinObj : JSON.stringify(stdinObj);
  const env = Object.assign({}, process.env);
  const home = opts.home !== undefined ? opts.home : DEFAULT_HOME;
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
  }
  const result = spawnSync(process.execPath, [SHIM_JS], { input, encoding: "utf8", timeout: 10000, env });
  return { code: result.status != null ? result.status : 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function runHookAsync(stdinObj, opts) {
  opts = opts || {};
  const input = typeof stdinObj === "string" ? stdinObj : JSON.stringify(stdinObj);
  const env = Object.assign({}, process.env);
  const home = opts.home !== undefined ? opts.home : DEFAULT_HOME;
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
  }
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK_JS], { encoding: "utf8", env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

const PLAN_ONLY_LINE = "PLAN-ONLY: no writes, no edits, no shell; return a plan only.";
const PLAN_ONLY_LINE_NO_PERIOD = "PLAN-ONLY: no writes, no edits, no shell; return a plan only";

function agentPayload(toolInput, extra) {
  return Object.assign({ tool_name: "Agent", tool_input: toolInput }, extra || {});
}
function sendMessagePayload(toolInput, extra) {
  return Object.assign({ tool_name: "SendMessage", tool_input: toolInput }, extra || {});
}

function uniqueSession(prefix) {
  return `${prefix || "test"}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanupLedgerSession(sessionId) {
  try {
    const key = ledger.resolveLedgerSessionKey(sessionId);
    const p = ledger.ledgerPathForSessionKey(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    for (const f of fs.readdirSync(state.STATE_DIR)) {
      if (f.startsWith(`agent-tier-ledger.${key}.`) && f.endsWith(".once")) {
        fs.unlinkSync(path.join(state.STATE_DIR, f));
      }
    }
  } catch (_) {
    // best effort
  }
}

/** A SubagentStart payload shaped like the one confirmed live on
 * 2026-09-06 (hooks/README.md's "Capture verified" section): the observed
 * top-level keys, plus `tool_use_id` — necessarily present in the real
 * payload too, since capture (which needs it) succeeded 6/6 times that
 * session — and an optional `name` for tests that look a recipient up by
 * display name. Deliberately carries no `tool_response` field: the
 * verified path never looks at one. */
function subagentStartPayload(sessionId, toolUseId, agentId, extra) {
  return Object.assign(
    {
      hook_event_name: "SubagentStart",
      session_id: sessionId,
      transcript_path: "C:\\fake\\transcript.jsonl",
      cwd: "C:\\fake\\cwd",
      scratchpad_dir: "C:\\fake\\scratchpad",
      prompt_id: `prompt-${Math.random().toString(36).slice(2)}`,
      agent_id: agentId,
      agent_type: "general-purpose",
      tool_use_id: toolUseId,
    },
    extra || {}
  );
}

/** Allowed Agent dispatch (drafting tier, cap line only) that captures a
 * pending ledger record, then a matching SubagentStart capture — returns
 * the agentId used so the caller can look it up / SendMessage to it. */
function captureAgent(sessionId, { tier, toolUseId, name, subagentType } = {}) {
  const modelByTier = { planning: PLANNING_MODEL, drafting: DRAFTING_MODEL, mechanical: MECHANICAL_MODEL };
  const model = modelByTier[tier || "drafting"];
  const tu = toolUseId || `tu-${Math.random().toString(36).slice(2)}`;
  const agentId = `agent-${Math.random().toString(36).slice(2)}`;
  let prompt = "Do the work.\nREPORT CAP: 50 words";
  if ((tier || "drafting") === "planning") prompt = `${PLAN_ONLY_LINE}\n${prompt}`;
  const preInput = { model, prompt };
  if (subagentType !== undefined) preInput.subagent_type = subagentType;
  const pre = runHook(
    agentPayload(preInput, { session_id: sessionId, tool_use_id: tu, hook_event_name: "PreToolUse" })
  );
  assert.equal(pre.code, 0, `expected capture setup dispatch to allow; stderr: ${pre.stderr}`);

  const post = runHook(subagentStartPayload(sessionId, tu, agentId, { name: name || null }));
  assert.equal(post.code, 0, "SubagentStart capture must never block");
  return { agentId, toolUseId: tu, tier: tier || "drafting", model };
}

// ══════════════════════════════════════════════════════════════════════════
// Unit tests: model-routing-guards.unicode.js
// ══════════════════════════════════════════════════════════════════════════

test("unit: stripNormalize removes Cf/Cc/Mn code points (deletion, not replacement)", () => {
  assert.equal(stripNormalize("a​b"), "ab"); // ZERO WIDTH SPACE (Cf)
  assert.equal(stripNormalize("a⁣b"), "ab"); // INVISIBLE SEPARATOR (Cf)
  assert.equal(stripNormalize("áb"), "ab"); // combining acute accent (Mn)
});

test("unit: stripNormalize removes Mc and Me code points too (widened Mn -> full \\p{M})", () => {
  assert.equal(stripNormalize("a" + String.fromCharCode(0x0903) + "b"), "ab"); // DEVANAGARI SIGN VISARGA (Mc)
  assert.equal(stripNormalize("a" + String.fromCharCode(0x20dd) + "b"), "ab"); // COMBINING ENCLOSING CIRCLE (Me)
});

test("unit: stripNormalize collapses \\p{Z} runs to a single U+0020", () => {
  assert.equal(stripNormalize("a   b"), "a b");
  assert.equal(stripNormalize("a  b"), "a b"); // NBSP + EM SPACE
  assert.equal(stripNormalize("PLAN-ONLY:  no  writes"), "PLAN-ONLY: no writes");
});

test("unit: stripNormalize non-string input returns empty string", () => {
  assert.equal(stripNormalize(undefined), "");
  assert.equal(stripNormalize(null), "");
  assert.equal(stripNormalize(42), "");
});

test("unit: isBlankAfterStrip true for empty/whitespace/invisible-only strings", () => {
  assert.equal(isBlankAfterStrip(""), true);
  assert.equal(isBlankAfterStrip("   "), true);
  assert.equal(isBlankAfterStrip("​"), true);
  assert.equal(isBlankAfterStrip("⁣"), true);
  assert.equal(isBlankAfterStrip("x"), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Unit tests: model-routing-guards.exempt.js
// ══════════════════════════════════════════════════════════════════════════

test("unit: resolveExemptTypes — matching require() result -> no drift", () => {
  const fakeRequire = () => ({ EXEMPT_TYPES: PINNED_EXEMPT_TYPES.slice() });
  const r = resolveExemptTypes(fakeRequire);
  assert.equal(r.drift, false);
  assert.deepEqual(r.exemptTypes.slice().sort(), PINNED_EXEMPT_TYPES.slice().sort());
});

test("unit: resolveExemptTypes — item 6/B9 fixture: drift (member removed) -> [] + drift:true", () => {
  const drifted = PINNED_EXEMPT_TYPES.filter((t) => t !== "Explore");
  const fakeRequire = () => ({ EXEMPT_TYPES: drifted });
  const r = resolveExemptTypes(fakeRequire);
  assert.equal(r.drift, true);
  assert.deepEqual(r.exemptTypes, []);
});

test("unit: resolveExemptTypes — member added -> drift:true, [] (widening never granted)", () => {
  const widened = PINNED_EXEMPT_TYPES.concat(["SomeNewType"]);
  const fakeRequire = () => ({ EXEMPT_TYPES: widened });
  const r = resolveExemptTypes(fakeRequire);
  assert.equal(r.drift, true);
  assert.deepEqual(r.exemptTypes, []);
});

test("unit: resolveExemptTypes — require() throws -> fallback to pinned, no drift", () => {
  const fakeRequire = () => {
    throw new Error("module not found");
  };
  const r = resolveExemptTypes(fakeRequire);
  assert.equal(r.drift, false);
  assert.deepEqual(r.exemptTypes.slice().sort(), PINNED_EXEMPT_TYPES.slice().sort());
});

test("unit: sameSet ignores order, catches length/membership differences", () => {
  assert.equal(sameSet(["a", "b"], ["b", "a"]), true);
  assert.equal(sameSet(["a", "b"], ["a", "c"]), false);
  assert.equal(sameSet(["a", "b"], ["a"]), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Hook 1 end-to-end: planning-tier branch
// ══════════════════════════════════════════════════════════════════════════

test("1: planning-tier model + PLAN-ONLY line + REPORT CAP: 200 words -> allow", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 200 words` }));
  assert.equal(r.code, 0);
});

test("2: planning-tier model + PLAN-ONLY line no trailing period + cap line -> allow", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: `${PLAN_ONLY_LINE_NO_PERIOD}\nREPORT CAP: 150 words` }));
  assert.equal(r.code, 0);
});

test("3: planning-tier, no PLAN-ONLY line, subagent_type absent, cap line present -> block", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: "Just look into this issue.\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /planning_prose_missing/);
});

test("4: planning-tier + cap line, PLAN-ONLY line absent -> block", () => {
  const r = runHook(
    agentPayload({ model: PLANNING_MODEL, subagent_type: "general-purpose", prompt: "Design a plan.\nREPORT CAP: 100 words" })
  );
  assert.equal(r.code, 2);
});

test("5: planning-tier + subagent_type Explore (EXEMPT_TYPES), no PLAN-ONLY line, cap line -> allow", () => {
  const r = runHook(
    agentPayload({
      model: PLANNING_MODEL,
      subagent_type: "Explore",
      prompt: "Find all callers of the payment module's sign function.\nREPORT CAP: 50 words",
    })
  );
  assert.equal(r.code, 0);
});

test("drafting-tier model + cap line -> allow; drafting-tier, no cap line -> block", () => {
  const r1 = runHook(agentPayload({ model: DRAFTING_MODEL, prompt: "Draft the doc.\nREPORT CAP: 300 words" }));
  assert.equal(r1.code, 0);
  const r2 = runHook(agentPayload({ model: DRAFTING_MODEL, prompt: "Draft the doc." }));
  assert.equal(r2.code, 2);
});

test("mechanical-tier model + cap line -> allow", () => {
  const r = runHook(agentPayload({ model: MECHANICAL_MODEL, prompt: "Grep for X.\nREPORT CAP: 50 words" }));
  assert.equal(r.code, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// A1/A2: absent/unconfigured model, unconditional block
// ══════════════════════════════════════════════════════════════════════════

test("A1: model absent + cap line + PLAN-ONLY line -> block, unconditional", () => {
  const r = runHook(agentPayload({ prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }));
  assert.equal(r.code, 2);
});

test("A2: model absent + subagent_type in EXEMPT_TYPES + cap line -> block, unconditional", () => {
  const r = runHook(
    agentPayload({ subagent_type: "Explore", prompt: "Find every caller of the sign function.\nREPORT CAP: 50 words" })
  );
  assert.equal(r.code, 2);
});

test("model 'unconfigured-model-x' (+ everything else present) -> block, unconditional", () => {
  const r = runHook(agentPayload({ model: "unconfigured-model-x", prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /model_missing_or_invalid/);
});

test("model 42, null, [<configured literal>] -> block, one each", () => {
  for (const badModel of [42, null, [PLANNING_MODEL]]) {
    const r = runHook(agentPayload({ model: badModel, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }));
    assert.equal(r.code, 2, `expected block for model=${JSON.stringify(badModel)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Fork-subagent gate
// ══════════════════════════════════════════════════════════════════════════

test("fork: subagent_type 'fork' + drafting-tier model + PLAN-ONLY line + cap line -> block, fork_subagent_forbidden", () => {
  const r = runHook(
    agentPayload({ model: DRAFTING_MODEL, subagent_type: "fork", prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` })
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

test("fork: subagent_type 'fork', no model at all -> block, fork_subagent_forbidden is the primary/only finding", () => {
  const r = runHook(agentPayload({ subagent_type: "fork", prompt: "Keep going on the same investigation." }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /1\. \[fork_subagent_forbidden\]/);
  assert.doesNotMatch(r.stderr, /model_missing_or_invalid/);
});

test("fork: subagent_type 'fork' + planning-tier model + EXEMPT_TYPES-shaped prompt (no PLAN-ONLY line) -> block, fork_subagent_forbidden", () => {
  const r = runHook(
    agentPayload({ model: PLANNING_MODEL, subagent_type: "fork", prompt: "Find all callers.\nREPORT CAP: 50 words" })
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /1\. \[fork_subagent_forbidden\]/);
  assert.doesNotMatch(r.stderr, /planning_prose_missing/);
});

test("fork: subagent_type ' fork ' (surrounding whitespace, trims to exact 'fork') -> block, fork_subagent_forbidden", () => {
  const r = runHook(agentPayload({ model: MECHANICAL_MODEL, subagent_type: " fork ", prompt: "Grep for X.\nREPORT CAP: 50 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

test("fork: subagent_type 'Fork' (wrong case) does not match the fork rule -> falls through to model_missing_or_invalid", () => {
  const r = runHook(agentPayload({ subagent_type: "Fork", prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /model_missing_or_invalid/);
  assert.doesNotMatch(r.stderr, /fork_subagent_forbidden/);
});

test("fork: non-fork dispatch (subagent_type 'Explore', existing suite fixture) is unaffected -> still allow", () => {
  const r = runHook(
    agentPayload({ model: PLANNING_MODEL, subagent_type: "Explore", prompt: "Find all callers.\nREPORT CAP: 50 words" })
  );
  assert.equal(r.code, 0);
});

// ── Invisible-character smuggling against the fork gate ──
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

test("fork smuggling: subagent_type 'fork' + trailing zero-width space -> block, fork_subagent_forbidden", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, subagent_type: "fork" + ZWSP, prompt: "Draft the doc.\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

test("fork smuggling: subagent_type 'f' + zero-width space + 'ork' (invisible char inside the word) -> block, fork_subagent_forbidden", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, subagent_type: "f" + ZWSP + "ork", prompt: "Draft the doc.\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

test("fork smuggling: subagent_type BOM + 'Fork' (wrong case) still falls through — case-sensitivity preserved after invisible-char stripping", () => {
  const r = runHook(agentPayload({ subagent_type: BOM + "Fork", prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /model_missing_or_invalid/);
  assert.doesNotMatch(r.stderr, /fork_subagent_forbidden/);
});

test("EXEMPT_TYPES smuggling: subagent_type 'Explore' + zero-width space, planning-tier, no PLAN-ONLY line -> normalized-recognized as exempt (allow)", () => {
  const r = runHook(
    agentPayload({ model: PLANNING_MODEL, subagent_type: "Explore" + ZWSP, prompt: "Find all callers.\nREPORT CAP: 50 words" })
  );
  assert.equal(r.code, 0);
});

// ── allowKey vs blockKey directional split ──
const MN_ACUTE = String.fromCharCode(0x0301);

test("allowKey does NOT strip Mn: subagent_type 'Exp'+combining-acute+'lore' is NOT exempt -> planning, no PLAN-ONLY line -> block, planning_prose_missing", () => {
  const r = runHook(
    agentPayload({ model: PLANNING_MODEL, subagent_type: "Exp" + MN_ACUTE + "lore", prompt: "Find all callers.\nREPORT CAP: 50 words" })
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /planning_prose_missing/);
});

test("allowKey still recognizes a real EXEMPT type with plain trailing whitespace (trim): subagent_type 'Explore ' -> exempt (allow)", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, subagent_type: "Explore ", prompt: "Find all callers.\nREPORT CAP: 50 words" }));
  assert.equal(r.code, 0);
});

test("allowKey strips Cf (BOM) same as before: subagent_type BOM+'Explore' -> exempt (allow)", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, subagent_type: BOM + "Explore", prompt: "Find all callers.\nREPORT CAP: 50 words" }));
  assert.equal(r.code, 0);
});

test("blockKey still strips Mn for the fork gate: subagent_type 'fo'+combining-acute+'rk' -> block, fork_subagent_forbidden", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, subagent_type: "fo" + MN_ACUTE + "rk", prompt: "Draft the doc.\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

// ── blockKey widened Mn -> full \p{M} (Mn+Mc+Me) ──
const MC_VISARGA = String.fromCharCode(0x0903);
const ME_ENCLOSING_CIRCLE = String.fromCharCode(0x20dd);

test("blockKey strips Mc (spacing combining mark): subagent_type 'fork'+U+0903 -> block, fork_subagent_forbidden", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, subagent_type: "fork" + MC_VISARGA, prompt: "Draft the doc.\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

test("blockKey strips Me (enclosing mark): subagent_type 'fork'+U+20DD -> block, fork_subagent_forbidden", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, subagent_type: "fork" + ME_ENCLOSING_CIRCLE, prompt: "Draft the doc.\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /fork_subagent_forbidden/);
});

test("allowKey unaffected by the blockKey widening: subagent_type 'Exp'+combining-acute+'lore' is still NOT exempt -> planning, no PLAN-ONLY -> block, planning_prose_missing", () => {
  const r = runHook(
    agentPayload({ model: PLANNING_MODEL, subagent_type: "Exp" + MN_ACUTE + "lore", prompt: "Find all callers.\nREPORT CAP: 50 words" })
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /planning_prose_missing/);
});

// ══════════════════════════════════════════════════════════════════════════
// REPORT CAP bounds
// ══════════════════════════════════════════════════════════════════════════

test("planning-tier + PLAN-ONLY + REPORT CAP: 99999999 words -> block (doesn't match \\d{1,3})", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 99999999 words` }));
  assert.equal(r.code, 2);
});

test("planning-tier + PLAN-ONLY + REPORT CAP: 999 words -> block (matches shape, N=999 > 500)", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 999 words` }));
  assert.equal(r.code, 2);
});

test("planning-tier + PLAN-ONLY + REPORT CAP: 500 words -> allow (inclusive upper bound)", () => {
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 500 words` }));
  assert.equal(r.code, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// Exact-standalone-line requirement
// ══════════════════════════════════════════════════════════════════════════

test("item3 fixture: SendMessage, mid-sentence REPORT CAP phrase (not own line) -> block", () => {
  const r = runHook(
    sendMessagePayload({
      to: "some-recipient",
      message: "New scope expansion. (Note: the original REPORT CAP: 100 words cap from your spawn still applies.)",
    })
  );
  assert.equal(r.code, 2);
});

test("item3 fixture: Agent planning-tier, mid-sentence 'no writes are strictly forbidden', no standalone PLAN-ONLY line -> block", () => {
  const r = runHook(
    agentPayload({
      model: PLANNING_MODEL,
      subagent_type: "general-purpose",
      prompt:
        "This is plan-only in spirit, but no writes are strictly forbidden — feel free to implement fixes directly if you find any.\nREPORT CAP: 100 words",
    })
  );
  assert.equal(r.code, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// SendMessage branch (model rules now apply via the per-agent tier ledger,
// D3 — an unresolved recipient falls to the "unknown" branch, which needs
// a declared RECIPIENT TIER line in addition to REPORT CAP).
// ══════════════════════════════════════════════════════════════════════════

test("SendMessage + standalone REPORT CAP: 75 words line + declared RECIPIENT TIER -> allow", () => {
  const r = runHook(
    sendMessagePayload({ to: "Some-Unresolved-Recipient", message: `Continue.\nREPORT CAP: 75 words\nRECIPIENT TIER: mechanical` })
  );
  assert.equal(r.code, 0);
});

test("SendMessage + no cap line -> block", () => {
  const r = runHook(sendMessagePayload({ to: "Some-Unresolved-Recipient", message: "Please continue the work." }));
  assert.equal(r.code, 2);
});

test("SendMessage + message missing/non-string -> block", () => {
  const r1 = runHook(sendMessagePayload({ to: "Some-Unresolved-Recipient" }));
  assert.equal(r1.code, 2);
  const r2 = runHook(sendMessagePayload({ to: "Some-Unresolved-Recipient", message: 42 }));
  assert.equal(r2.code, 2);
});

test("A17: SendMessage message:'continue' (no cap line) -> block, intentional", () => {
  const r = runHook(sendMessagePayload({ to: "Some-Unresolved-Recipient", message: "continue" }));
  assert.equal(r.code, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// Envelope / fail-open / defensive branches
// ══════════════════════════════════════════════════════════════════════════

test("unreadable stdin / invalid JSON / non-object payload -> fail-open, one each", () => {
  const r1 = runHook("{not valid json");
  assert.equal(r1.code, 0);
  const r2 = runHook("42");
  assert.equal(r2.code, 0);
  const r3 = runHook("null");
  assert.equal(r3.code, 0);
});

test("tool_name:'Bash' reaching this hook -> block, unexpected_tool_name", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "echo hi" } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unexpected_tool_name|unexpected tool_name/i);
});

test("tool_input:null on valid Agent call -> block (all-fields-absent path)", () => {
  const r = runHook({ tool_name: "Agent", tool_input: null });
  assert.equal(r.code, 2);
});

test("A23: prompt field > 100,000 chars, no exact-token lines anywhere -> block, oversized_field", () => {
  const hugePrompt = "x".repeat(100001);
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: hugePrompt }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /oversized_field|100,000/i);
});

test("missing tool_name entirely -> block, unexpected_tool_name (not fail-open)", () => {
  const r = runHook({ tool_input: {} });
  assert.equal(r.code, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// model_tiers (D1/A1/A2) — shape, fold, collision, tier-value validation
// ══════════════════════════════════════════════════════════════════════════

test("model_tiers: non-object/array/null shapes fall back to {}", () => {
  assert.deepEqual(validateModelTiers(null), {});
  assert.deepEqual(validateModelTiers([]), {});
  assert.deepEqual(validateModelTiers("x"), {});
  assert.deepEqual(validateModelTiers(42), {});
});

test("model_tiers: a non-string tier value invalidates the whole field", () => {
  assert.deepEqual(validateModelTiers({ [PLANNING_MODEL]: 1 }), {});
});

test("model_tiers: a tier value that doesn't fold to planning/drafting/mechanical invalidates the whole field", () => {
  assert.deepEqual(validateModelTiers({ [PLANNING_MODEL]: "not-a-tier" }), {});
});

test("model_tiers: two keys colliding after fold (case difference) invalidate the whole field, fail closed", () => {
  const result = validateModelTiers({ "Planning-Model-X": "planning", "planning-model-x": "drafting" });
  assert.deepEqual(result, {});
});

test("model_tiers_empty_key_after_fold_invalidates: a key made entirely of invisible characters invalidates the whole field (A1)", () => {
  const result = validateModelTiers({ [ZWSP]: "planning", [DRAFTING_MODEL]: "drafting" });
  assert.deepEqual(result, {}, "the whole field must be dropped, not just the empty-keyed entry");
});

test("model_tiers_empty_key_after_fold_invalidates: a dispatch model that folds to empty is the SAME finding as an absent model", () => {
  assert.equal(guard.resolveTierForModel(ZWSP, DEFAULT_MODEL_TIERS), null);
  assert.equal(guard.resolveTierForModel(undefined, DEFAULT_MODEL_TIERS), null);
  const r = runHook(agentPayload({ model: ZWSP, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /model_missing_or_invalid/);
});

test("tier_value_case_insensitive: a mixed-case tier value in config folds correctly", () => {
  assert.deepEqual(validateModelTiers({ [DRAFTING_MODEL]: "DrAfTiNg" }), { [DRAFTING_MODEL]: "drafting" });
});

test("tier_value_case_insensitive: a dispatch model in a different case than the configured key still resolves (D1)", () => {
  const home = mkTierHome({ "Planning-Model-X": "Planning" });
  const r = runHook(agentPayload({ model: "PLANNING-MODEL-X", prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }), { home });
  assert.equal(r.code, 0);
});

test("model_tiers empty/absent -> every dispatch blocks on model_missing_or_invalid (expected fail-closed state, not a new failure mode)", () => {
  const home = mkTierHome({});
  const r = runHook(agentPayload({ model: PLANNING_MODEL, prompt: `${PLAN_ONLY_LINE}\nREPORT CAP: 100 words` }), { home });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /model_missing_or_invalid/);
});

// ══════════════════════════════════════════════════════════════════════════
// fence_commonmark_length_matching (A7)
// ══════════════════════════════════════════════════════════════════════════

test("fence_commonmark_length_matching: REPORT CAP inside a fenced example does not count", () => {
  const text = ["```", "REPORT CAP: 100 words", "```", "REPORT CAP: 50 words"].join("\n");
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match[1], "50");
});

test("fence_commonmark_length_matching: a 3-backtick line cannot close a 4-backtick-opened fence (length matching)", () => {
  const text = ["````", "REPORT CAP: 100 words", "```", "REPORT CAP: 999 words", "````", "REPORT CAP: 50 words"].join("\n");
  // The 4-backtick fence only closes at the final ```` line — everything
  // between (including the 3-backtick line, which is too short to close
  // it) stays fenced; only the trailing line after the real close counts.
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match[1], "50");
});

test("fence_commonmark_length_matching: tilde and backtick fences don't cross-close each other", () => {
  const text = ["~~~", "REPORT CAP: 100 words", "```", "REPORT CAP: 999 words", "~~~", "REPORT CAP: 50 words"].join("\n");
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match[1], "50");
});

test("fence_commonmark_length_matching: an unclosed fence runs to end of text — nothing after it counts", () => {
  const text = ["```", "REPORT CAP: 100 words"].join("\n");
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 0);
});

test("D2: a REPORT CAP line inside a blockquote does not count", () => {
  const text = "> REPORT CAP: 100 words\nREPORT CAP: 50 words";
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match[1], "50");
});

test("D2: a REPORT CAP line inside a list item does not count", () => {
  const text = "- REPORT CAP: 100 words\n1. REPORT CAP: 200 words\nREPORT CAP: 50 words";
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match[1], "50");
});

// ══════════════════════════════════════════════════════════════════════════
// crlf_normalized_before_bare_line_match (A8)
// ══════════════════════════════════════════════════════════════════════════

test("crlf_normalized_before_bare_line_match: a CRLF-terminated REPORT CAP line matches exactly once", () => {
  const text = "Continue.\r\nREPORT CAP: 80 words\r\n";
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
});

test("crlf_normalized_before_bare_line_match: end-to-end CRLF prompt allows normally", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, prompt: "Draft it.\r\nREPORT CAP: 80 words\r\n" }));
  assert.equal(r.code, 0);
});

test("crlf_normalized_before_bare_line_match: a lone CR is also normalized to LF", () => {
  const text = "Continue.\rREPORT CAP: 80 words\r";
  const matches = guard.findBareLineMatches(text, "REPORT CAP: (\\d{1,3}) words", "");
  assert.equal(matches.length, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// duplicate_cap_lines_differing_by_invisibles_ambiguous (A8, round 2 item 9)
// ══════════════════════════════════════════════════════════════════════════

test("duplicate_cap_lines_differing_by_invisibles_ambiguous: two REPORT CAP lines differing only by an invisible char both count -> ambiguous", () => {
  const text = `REPORT CAP: 100 words\nREPORT CAP: 100 words${ZWSP}`;
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, prompt: text }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /report_cap_ambiguous/);
});

test("D2: two REPORT CAP lines (both valid) block as report_cap_ambiguous, not first-or-last", () => {
  const r = runHook(agentPayload({ model: DRAFTING_MODEL, prompt: "REPORT CAP: 50 words\nREPORT CAP: 100 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /report_cap_ambiguous/);
});

test("D2: two PLAN-ONLY lines block as plan_only_ambiguous, even with the EXEMPT_TYPES carve-out available", () => {
  const r = runHook(
    agentPayload({
      model: PLANNING_MODEL,
      subagent_type: "Explore",
      prompt: `${PLAN_ONLY_LINE}\n${PLAN_ONLY_LINE}\nREPORT CAP: 50 words`,
    })
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /plan_only_ambiguous/);
});

// ══════════════════════════════════════════════════════════════════════════
// recipient_tier_line_exact_match_rules (A9)
// ══════════════════════════════════════════════════════════════════════════

test("recipient_tier_line_exact_match_rules: case-insensitive literal + tier name, optional trailing period", () => {
  const m1 = guard.findBareLineMatches("recipient tier: DRAFTING", "RECIPIENT TIER: (planning|drafting|mechanical)\\.?", "i");
  assert.equal(m1.length, 1);
  const m2 = guard.findBareLineMatches("RECIPIENT TIER: mechanical.", "RECIPIENT TIER: (planning|drafting|mechanical)\\.?", "i");
  assert.equal(m2.length, 1);
});

test("recipient_tier_line_exact_match_rules: trailing text or missing colon disqualifies the line", () => {
  const m1 = guard.findBareLineMatches("RECIPIENT TIER: drafting please", "RECIPIENT TIER: (planning|drafting|mechanical)\\.?", "i");
  assert.equal(m1.length, 0);
  const m2 = guard.findBareLineMatches("RECIPIENT TIER drafting", "RECIPIENT TIER: (planning|drafting|mechanical)\\.?", "i");
  assert.equal(m2.length, 0);
});

test("recipient_tier_line_exact_match_rules: end-to-end, exactly one declared line required in the unknown branch", () => {
  const r = runHook(
    sendMessagePayload({
      to: "totally-unknown-recipient",
      message: "RECIPIENT TIER: mechanical\nRECIPIENT TIER: drafting\nREPORT CAP: 50 words",
    })
  );
  assert.equal(r.code, 2);
  assert.match(r.stderr, /recipient_tier_ambiguous/);
});

// ══════════════════════════════════════════════════════════════════════════
// Per-agent tier ledger (D3, amended) — capture, storage, lookup
// ══════════════════════════════════════════════════════════════════════════

test("capture_records_agent_id_and_tier", () => {
  const session = uniqueSession("ledger-basic");
  try {
    const { agentId } = captureAgent(session, { tier: "drafting" });
    const c = ledger.classifyRecipient(agentId);
    assert.equal(c.kind, "resolved");
    assert.equal(c.tier, "drafting");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("capture_missing_agent_id_records_nothing", () => {
  const session = uniqueSession("ledger-noid");
  try {
    const tu = `tu-${Math.random().toString(36).slice(2)}`;
    const pre = runHook(
      agentPayload({ model: DRAFTING_MODEL, prompt: "Do it.\nREPORT CAP: 50 words" }, { session_id: session, tool_use_id: tu, hook_event_name: "PreToolUse" })
    );
    assert.equal(pre.code, 0);
    // SubagentStart payload missing agent_id entirely — capture must not
    // block and must not synthesize a recipient from nothing.
    const post = runHook(
      subagentStartPayload(session, tu, undefined, { agent_id: undefined, unrelated_field: "no id here" })
    );
    assert.equal(post.code, 0);
    const c = ledger.classifyRecipient("some-name-nobody-used");
    assert.equal(c.kind, "unknown");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("capture_missing_tool_use_id_records_nothing", () => {
  const session = uniqueSession("ledger-notoolid");
  try {
    // SubagentStart payload missing tool_use_id — agent_id alone is not
    // enough to join to the pending record, so capture must record
    // nothing (never guesses at a join key).
    const post = runHook(
      subagentStartPayload(session, undefined, `agent-${Math.random().toString(36).slice(2)}`, { tool_use_id: undefined })
    );
    assert.equal(post.code, 0);
    const c = ledger.classifyRecipient("some-other-name-nobody-used");
    assert.equal(c.kind, "unknown");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("subagentstart_capture_verified_shape: top-level agent_id + tool_use_id, no tool_response involved", () => {
  // Regression guard for the 2026-09-06 live verification (hooks/README.md
  // "Capture verified"): a payload shaped exactly like the confirmed real
  // one — the observed top-level keys plus tool_use_id, and NO
  // tool_response field at all — must still resolve a recipient. This
  // pins the verified field path so a future change can't silently
  // reintroduce a dependency on a tool_response wrapper.
  const session = uniqueSession("ledger-verified-shape");
  const tu = `tu-${Math.random().toString(36).slice(2)}`;
  const agentId = `agent-${Math.random().toString(36).slice(2)}`;
  try {
    const pre = runHook(
      agentPayload(
        { model: DRAFTING_MODEL, prompt: "Do it.\nREPORT CAP: 50 words" },
        { session_id: session, tool_use_id: tu, hook_event_name: "PreToolUse" }
      )
    );
    assert.equal(pre.code, 0);

    const payload = subagentStartPayload(session, tu, agentId);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "tool_response"), false);

    const post = runHook(payload);
    assert.equal(post.code, 0, "SubagentStart capture must never block");

    const c = ledger.classifyRecipient(agentId);
    assert.equal(c.kind, "resolved");
    assert.equal(c.tier, "drafting");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("subagentstart_capture_via_production_shim: the real installed SubagentStart entry point (agent-model-routing-guard-subagentstart.js) also captures the id", () => {
  // Regression for the reported defect (routing-scorecard §2/decision
  // ledger): the real ~/.claude/hooks state showed
  // {guard:"agent-model-routing-guard", event:"fail_open",
  // reason:"json_parse_error", session_id:null} logged on every subagent
  // dispatch. Root cause: agent-model-routing-guard.js's stdin capture
  // (captureStdin(), which fills module-scope rawStdinBuffer) was only
  // ever invoked from its own `if (require.main === module) { ... }`
  // block — true when this file is executed directly, but ALWAYS false
  // when entered via SHIM_JS's `require("./agent-model-routing-guard.js"
  // ).main()`, because `require.main` there is the shim module, not this
  // one. So on every real SubagentStart dispatch, rawStdinBuffer stayed
  // `undefined`, main() did `JSON.parse(undefined)` (stringifies to the
  // non-JSON text "undefined"), and failed open with a bogus
  // "json_parse_error" before ever reaching handleSubagentStart — silently
  // breaking id capture on 100% of dispatches. Every OTHER SubagentStart
  // test in this file (including subagentstart_capture_verified_shape
  // directly above) spawns HOOK_JS, never the shim, so none of them could
  // have caught this. This test spawns SHIM_JS — the actual file
  // scripts/install-guards.js registers for the SubagentStart event — with
  // a fully valid, production-shaped payload, and asserts the id capture
  // that guard exists to perform actually happens through it.
  const session = uniqueSession("ledger-shim-path");
  const tu = `tu-${Math.random().toString(36).slice(2)}`;
  const agentId = `agent-${Math.random().toString(36).slice(2)}`;
  try {
    const pre = runHook(
      agentPayload(
        { model: DRAFTING_MODEL, prompt: "Do it.\nREPORT CAP: 50 words" },
        { session_id: session, tool_use_id: tu, hook_event_name: "PreToolUse" }
      )
    );
    assert.equal(pre.code, 0);

    const post = runShim(subagentStartPayload(session, tu, agentId));
    assert.equal(post.code, 0, "SubagentStart capture via the shim must never block");

    const c = ledger.classifyRecipient(agentId);
    assert.equal(c.kind, "resolved", "the shim must reach handleSubagentStart() and append the id record, not fail open on an unread stdin");
    assert.equal(c.tier, "drafting");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("subagentstart_shim_empty_stdin_still_fails_open_cleanly: genuinely empty stdin via the shim is a real parse failure, not silently swallowed or crashed on", () => {
  // Distinguishes the fixed behavior from the bug: an actually-empty stdin
  // (the harness failing to pipe anything at all) must still fail open with
  // json_parse_error — that is correct, unparseable input, on either entry
  // point. The bug was that the shim produced this SAME outcome even when
  // stdin was fully valid JSON, because it was never read in the first
  // place. This test pins the genuinely-empty case never regresses into an
  // uncaught exception (non-zero/null exit) now that captureStdin() runs
  // unconditionally inside main().
  const result = spawnSync(process.execPath, [SHIM_JS], { input: "", encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, "empty stdin must still fail open (exit 0), never crash");
});

test("lookup_by_id_exact", () => {
  const session = uniqueSession("ledger-byid");
  try {
    const { agentId } = captureAgent(session, { tier: "mechanical" });
    const c = ledger.classifyRecipient(agentId);
    assert.equal(c.kind, "resolved");
    assert.equal(c.tier, "mechanical");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("lookup_by_name_exact", () => {
  const session = uniqueSession("ledger-byname");
  try {
    captureAgent(session, { tier: "drafting", name: "Researcher-Exact" });
    const c = ledger.classifyRecipient("Researcher-Exact");
    assert.equal(c.kind, "resolved");
    assert.equal(c.tier, "drafting");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("lookup_ambiguous_name_two_tiers_blocks", () => {
  const session = uniqueSession("ledger-ambiguous");
  try {
    captureAgent(session, { tier: "drafting", name: "Shared-Name" });
    captureAgent(session, { tier: "mechanical", name: "Shared-Name" });
    const c = ledger.classifyRecipient("Shared-Name");
    assert.equal(c.kind, "ambiguous");

    const r = runHook(sendMessagePayload({ to: "Shared-Name", message: "REPORT CAP: 50 words" }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /recipient_tier_unknown/);
  } finally {
    cleanupLedgerSession(session);
  }
});

test("sendmessage_to_planning_without_plan_only_blocks", () => {
  const session = uniqueSession("ledger-plan-block");
  try {
    const { agentId } = captureAgent(session, { tier: "planning" });
    const r = runHook(sendMessagePayload({ to: agentId, message: "REPORT CAP: 50 words" }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /planning_prose_missing/);
  } finally {
    cleanupLedgerSession(session);
  }
});

test("sendmessage_to_drafting_cap_only_allows", () => {
  const session = uniqueSession("ledger-draft-allow");
  try {
    const { agentId } = captureAgent(session, { tier: "drafting" });
    const r = runHook(sendMessagePayload({ to: agentId, message: "REPORT CAP: 50 words" }));
    assert.equal(r.code, 0);
  } finally {
    cleanupLedgerSession(session);
  }
});

test("unknown_recipient_without_declared_tier_blocks", () => {
  const r = runHook(sendMessagePayload({ to: "never-spawned-recipient", message: "REPORT CAP: 50 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /recipient_tier_unknown/);
});

test("unknown_recipient_with_declared_tier_allows", () => {
  const r = runHook(
    sendMessagePayload({ to: "never-spawned-recipient-2", message: "REPORT CAP: 50 words\nRECIPIENT TIER: mechanical" })
  );
  assert.equal(r.code, 0);
});

test("ledger_record_overrides_declared_tier", () => {
  const session = uniqueSession("ledger-override");
  try {
    const { agentId } = captureAgent(session, { tier: "drafting" });
    // Self-serving false declaration of "planning" — the ledger's real
    // "drafting" resolution must win, so no PLAN-ONLY line is required and
    // this still allows.
    const r = runHook(sendMessagePayload({ to: agentId, message: "REPORT CAP: 50 words\nRECIPIENT TIER: planning" }));
    assert.equal(r.code, 0);
  } finally {
    cleanupLedgerSession(session);
  }
});

test("concurrent_appends_no_lost_record", async () => {
  const session = uniqueSession("ledger-concurrent");
  try {
    const N = 10;
    const calls = [];
    for (let i = 0; i < N; i++) {
      calls.push(
        runHookAsync(
          agentPayload(
            { model: DRAFTING_MODEL, prompt: "Do it.\nREPORT CAP: 50 words" },
            { session_id: session, tool_use_id: `tu-conc-${i}`, hook_event_name: "PreToolUse" }
          )
        )
      );
    }
    const results = await Promise.all(calls);
    for (const r of results) assert.equal(r.code, 0);

    const key = ledger.resolveLedgerSessionKey(session);
    const p = ledger.ledgerPathForSessionKey(key);
    const raw = fs.readFileSync(p, "utf8");
    const pendingLines = raw.split("\n").filter((l) => l.trim() !== "" && JSON.parse(l).kind === "pending");
    assert.equal(pendingLines.length, N, "every concurrent allowed dispatch must have appended exactly one pending record");
  } finally {
    cleanupLedgerSession(session);
  }
});

test("stale_ledger_pruned_after_7_days", () => {
  const session = uniqueSession("ledger-stale");
  try {
    const key = ledger.resolveLedgerSessionKey(session);
    const p = ledger.ledgerPathForSessionKey(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ kind: "pending", tool_use_id: "x", tier: "drafting", ts: new Date().toISOString() }) + "\n");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(p, eightDaysAgo / 1000, eightDaysAgo / 1000);
    ledger.sweepStaleLedgers();
    assert.equal(fs.existsSync(p), false);
  } finally {
    cleanupLedgerSession(session);
  }
});

test("blank_or_invisible_to_blocks", () => {
  assert.equal(ledger.classifyRecipient("").kind, "recipient_invalid");
  assert.equal(ledger.classifyRecipient("   ").kind, "recipient_invalid");
  assert.equal(ledger.classifyRecipient(ZWSP).kind, "recipient_invalid");
  assert.equal(ledger.classifyRecipient(42).kind, "recipient_invalid");

  const r = runHook(sendMessagePayload({ to: ZWSP, message: "REPORT CAP: 50 words" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /recipient_invalid/);
});

test("ledger_record_carries_rules_version_and_no_bodies", () => {
  const session = uniqueSession("ledger-shape");
  try {
    const { agentId } = captureAgent(session, { tier: "mechanical" });
    const { byAgentId } = ledger.buildJoinedRecordsByAgentId();
    const rec = byAgentId.get(agentId);
    assert.ok(rec, "expected a joined record for the captured agent id");
    const EXPECTED_KEYS = ["agent_id", "name", "model", "tier", "subagent_type", "description", "session_id", "ts", "rules_version"];
    assert.deepEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    for (const forbidden of ["prompt", "message", "tool_result", "result"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(rec, forbidden), false);
    }
    assert.equal(typeof rec.rules_version, "string");
    assert.ok(rec.rules_version.length > 0);
  } finally {
    cleanupLedgerSession(session);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Round-2 adversary closures not covered above
// ══════════════════════════════════════════════════════════════════════════

test("lookup_merges_all_session_files: a SendMessage from a different session_id still resolves a recipient captured elsewhere (A4)", () => {
  const captureSession = uniqueSession("ledger-cross-a");
  const sendSession = uniqueSession("ledger-cross-b");
  try {
    const { agentId } = captureAgent(captureSession, { tier: "drafting" });
    const r = runHook(sendMessagePayload({ to: agentId, message: "REPORT CAP: 50 words" }, { session_id: sendSession }));
    assert.equal(r.code, 0);
  } finally {
    cleanupLedgerSession(captureSession);
    cleanupLedgerSession(sendSession);
  }
});

test("ledger_record_tier_invalid_blocks: a resolved record whose tier is corrupted/blank blocks distinctly (A5)", () => {
  const session = uniqueSession("ledger-corrupt");
  const key = ledger.resolveLedgerSessionKey(session);
  try {
    const tu = "tu-corrupt-1";
    const agentId = "agent-corrupt-1";
    ledger.appendPendingRecord(key, {
      tool_use_id: tu,
      model: DRAFTING_MODEL,
      tier: "", // corrupted: present but not one of the three valid names.
      subagent_type: null,
      description: null,
      session_id: session,
      ts: new Date().toISOString(),
    });
    ledger.appendIdRecord(key, {
      tool_use_id: tu,
      agent_id: agentId,
      name: null,
      rules_version: "1:nopolicy",
      ts: new Date().toISOString(),
    });
    const c = ledger.classifyRecipient(agentId);
    assert.equal(c.kind, "ledger_record_tier_invalid");

    const r = runHook(sendMessagePayload({ to: agentId, message: "REPORT CAP: 50 words" }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ledger_record_tier_invalid/);
  } finally {
    cleanupLedgerSession(session);
  }
});

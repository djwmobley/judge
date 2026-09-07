"use strict";
// model-routing-guards.crash-path.test.js
// docs/specs/routing-scorecard.md §2.1 / §7.1a (R9) — regression tests for
// the crash-path hardening fix in orchestrator-tool-guard.js,
// agent-model-routing-guard.js, and agent-adversary-floor.js.
//
// DEFECT #1 (found in review of PR #14, d6a5f08): each of the three guards'
// top-level catch called decisions.appendCrashRecord with no try/catch of
// its own, and each guard's require() of the decisions module at module
// scope was bare. A missing/throwing module escaped as an uncaught
// exception — Node's default exit code 1, which the harness treats as
// ALLOW on a PreToolUse hook.
//
// DEFECT #2 (found by the independent approver reviewing the fix for
// defect #1): the first fix's defensive require() only covered require()
// itself throwing. It did NOT cover a module that LOADS successfully but
// whose exports are not callable — e.g. appendDecision/appendCrashRecord/
// hashTarget present as plain objects (or `undefined`) rather than
// functions. Every other call site in each guard (failOpen/block/allow/the
// inner `catch (internalErr)` — see hooks/orchestrator-tool-guard.js:55,
// 73,87,139,198,210,225 and the equivalent lines the approver named in
// agent-model-routing-guard.js and agent-adversary-floor.js) called
// `decisions.appendDecision(...)`/`decisions.hashTarget(...)` directly and
// unguarded. Calling a non-function throws a TypeError, which is NOT
// swallowed by the module-load try/catch (require() already succeeded) —
// so orchestrator-tool-guard/agent-model-routing-guard flipped ALLOW and
// malformed-JSON cases from exit 0 to exit 2, and agent-adversary-floor
// flipped its BLOCK case from exit 2 to exit 0 (a real escape: fail-open
// where the guard should have blocked).
//
// FIX: each guard now defines three local wrappers — logDecision/safeHash/
// safeCrash — immediately after its defensive require(). Each wrapper
// checks `typeof fn === "function"` before calling, wraps the call in its
// own try/catch, and returns a harmless default on any failure. Every
// call site in each guard's file now goes through a wrapper; no direct
// `decisions.*` call remains outside the three wrapper definitions
// themselves (verified structurally below in `assertNoUnwrappedCalls`).
//
// THIS FILE tests the resulting invariant directly, per the approver's
// required matrix: for every (guard x envelope x broken-module-shape)
// combination, the guard run against a BROKEN decisions module produces
// the EXACT SAME exit code and stdout as the same guard run against the
// real, HEALTHY module for the SAME envelope — never a hardcoded expected
// value, always a same-test healthy-vs-broken comparison, so the
// assertion can't drift from whatever the healthy path actually does.
//
// Module shapes tested (see PRELOAD_SOURCE below):
//   throw_on_load        — require() itself throws (defect #1's shape).
//   non_function_objects  — require() succeeds; appendDecision/
//                           appendCrashRecord/hashTarget are each `{}`
//                           (defect #2's reported shape).
//   undefined_exports     — require() succeeds; appendDecision/
//                           appendCrashRecord/hashTarget are each
//                           `undefined` (approver's explicit addition).
//   throwing_functions     — require() succeeds; each export IS a function,
//                           but throws when called (tests the wrappers'
//                           try/catch layer specifically, distinct from
//                           the typeof-guard layer the other three shapes
//                           exercise).
//
// Envelopes tested per guard: an ALLOW case, a BLOCK case, and a malformed
// (invalid JSON) fail-open case — see ENVELOPES_BY_GUARD below, each
// engineered to be deterministic without depending on rules.js internals
// or (beyond agent-model-routing-guard's ALLOW case, which needs a
// resolvable model tier) any machine-local config.
//
// Fixtures (the preload shadow script, and agent-model-routing-guard's
// temp local-policy.json HOME) are written to this test's own
// os.tmpdir()-based temp directories and removed in a `finally`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS_DIR = __dirname;
const DECISIONS_MODULE_PATH = path.join(HOOKS_DIR, "model-routing-guards.decisions.js");

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (_) {
    /* best effort */
  }
}

// ─── Structural check: no unwrapped decisions.* call remains ──────────────
// Defect #2's root cause was call sites bypassing the wrapper layer
// entirely. This is a static guard against that regression recurring: the
// only occurrences of the literal substrings "decisions.appendDecision(",
// "decisions.hashTarget(", "decisions.appendCrashRecord(" anywhere in each
// guard's source must be inside the wrapper functions' own bodies (which
// capture the reference into a local `fn` first, so the literal
// call-with-paren pattern does not appear there either) — i.e. the
// call-shaped pattern should not appear AT ALL outside a `const fn = ` line.
function assertNoUnwrappedCalls(guardFile) {
  const src = fs.readFileSync(guardFile, "utf8");
  const lines = src.split("\n");
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/decisions\.(appendDecision|hashTarget|appendCrashRecord)\(/.test(line)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `unwrapped decisions.* call(s) found outside the wrapper functions in ${guardFile}`);
}

// ─── Preload shadow script ──────────────────────────────────────────────
const PRELOAD_SOURCE = `
"use strict";
const Module = require("module");
const path = require("path");

function norm(p) {
  return path.resolve(p).toLowerCase();
}

const targetPath = norm(process.env.CRASH_PATH_TEST_DECISIONS_MODULE);
const mode = process.env.CRASH_PATH_TEST_SHADOW_MODE;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {
    return originalLoad.apply(this, arguments);
  }
  if (norm(resolved) !== targetPath) {
    return originalLoad.apply(this, arguments);
  }
  if (mode === "throw_on_load") {
    throw new Error("injected (test fixture): simulated decisions module require() failure (install drift)");
  }
  if (mode === "non_function_objects") {
    return { appendDecision: {}, appendCrashRecord: {}, hashTarget: {} };
  }
  if (mode === "undefined_exports") {
    return { appendDecision: undefined, appendCrashRecord: undefined, hashTarget: undefined };
  }
  if (mode === "throwing_functions") {
    return {
      appendDecision: function () {
        throw new Error("injected (test fixture): simulated appendDecision failure");
      },
      appendCrashRecord: function () {
        throw new Error("injected (test fixture): simulated appendCrashRecord failure");
      },
      hashTarget: function () {
        throw new Error("injected (test fixture): simulated hashTarget failure");
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
`;

const MALFORMED_STDIN = "{not valid json";

// ─── agent-model-routing-guard's ALLOW case needs a resolvable model tier ──
// (see hooks/agent-model-routing-guard.test.js's identical mkTierHome
// pattern — the model_tiers mapping lives only in an operator-local
// ~/.claude/hooks/local-policy.json, never in this repo).
const MECHANICAL_MODEL = "mechanical-model-x";
function mkTierHome() {
  const dir = mkTmpDir("amrg-crash-home-");
  const hooksDir = path.join(dir, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, "local-policy.json"),
    JSON.stringify({ model_tiers: { [MECHANICAL_MODEL]: "mechanical" } }),
    "utf8"
  );
  return dir;
}

function run(hookFile, stdinObj, opts) {
  opts = opts || {};
  const input = typeof stdinObj === "string" ? stdinObj : JSON.stringify(stdinObj);
  const env = Object.assign({}, process.env);
  if (opts.home) {
    env.HOME = opts.home;
    env.USERPROFILE = opts.home;
  }
  const args = [];
  if (opts.preloadPath) {
    args.push("-r", opts.preloadPath);
    env.CRASH_PATH_TEST_DECISIONS_MODULE = DECISIONS_MODULE_PATH;
    env.CRASH_PATH_TEST_SHADOW_MODE = opts.mode;
  }
  args.push(hookFile);
  const result = spawnSync(process.execPath, args, { input, encoding: "utf8", timeout: 10000, env });
  return { code: result.status != null ? result.status : 1, stdout: result.stdout || "" };
}

// ─── Per-guard envelopes: allow / block / malformed ────────────────────────
// Each engineered to be deterministic without depending on rules.js
// internals (orchestrator-tool-guard's cases use the exempt-subagent /
// unexpected-tool-name branches rather than file-path or shell-command
// classification), and, beyond agent-model-routing-guard's ALLOW case,
// without depending on any machine-local config.

const GUARDS = [
  {
    name: "orchestrator-tool-guard",
    file: path.join(HOOKS_DIR, "orchestrator-tool-guard.js"),
    envelopes: {
      allow: { tool_name: "Read", tool_input: {}, agent_id: "sub1", session_id: "otg-allow" },
      block: { tool_name: "NotebookEdit", session_id: "otg-block" },
      malformed: MALFORMED_STDIN,
    },
  },
  {
    name: "agent-model-routing-guard",
    file: path.join(HOOKS_DIR, "agent-model-routing-guard.js"),
    needsTierHome: true,
    envelopes: {
      allow: {
        tool_name: "Agent",
        tool_input: {
          subagent_type: "general-purpose",
          model: MECHANICAL_MODEL,
          prompt: "Do the task.\nREPORT CAP: 50 words",
        },
        session_id: "amrg-allow",
      },
      block: { tool_name: "Agent", tool_input: { subagent_type: "general-purpose" }, session_id: "amrg-block" },
      malformed: MALFORMED_STDIN,
    },
  },
  {
    name: "agent-adversary-floor",
    file: path.join(HOOKS_DIR, "agent-adversary-floor.js"),
    envelopes: {
      allow: {
        tool_name: "Agent",
        tool_input: { subagent_type: "Explore", prompt: "look around" },
        session_id: "aaf-allow",
      },
      block: {
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", prompt: "Just do it, no special clause." },
        session_id: "aaf-block",
      },
      malformed: MALFORMED_STDIN,
    },
  },
];

const SHAPES = ["throw_on_load", "non_function_objects", "undefined_exports", "throwing_functions"];
const ENVELOPE_KEYS = ["allow", "block", "malformed"];

for (const guard of GUARDS) {
  test(`${guard.name}: no unwrapped decisions.* call site remains outside the wrapper functions`, () => {
    assertNoUnwrappedCalls(guard.file);
  });

  for (const shape of SHAPES) {
    for (const envKey of ENVELOPE_KEYS) {
      test(`${guard.name} / ${envKey} envelope / decisions module shape "${shape}" -> exit code and stdout identical to the healthy-module run`, () => {
        const dir = mkTmpDir("crash-path-test-");
        const home = guard.needsTierHome ? mkTierHome() : undefined;
        try {
          const preloadPath = path.join(dir, "shadow-decisions-preload.js");
          fs.writeFileSync(preloadPath, PRELOAD_SOURCE);

          const stdinObj = guard.envelopes[envKey];
          const healthy = run(guard.file, stdinObj, { home });
          const broken = run(guard.file, stdinObj, { home, preloadPath, mode: shape });

          assert.equal(
            broken.code,
            healthy.code,
            `broken-module exit code (${broken.code}) must equal the healthy-module exit code (${healthy.code}) for the same envelope`
          );
          assert.equal(
            broken.stdout,
            healthy.stdout,
            "broken-module stdout must equal the healthy-module stdout for the same envelope"
          );
        } finally {
          rmTree(dir);
          if (home) rmTree(home);
        }
      });
    }
  }
}

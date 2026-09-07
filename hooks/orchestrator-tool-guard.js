"use strict";
// orchestrator-tool-guard.js
// Hook 2 (PreToolUse, matcher "Read|Bash|PowerShell|Write|Edit") — restricts
// mechanical/drafting tool use reaching these five tools DIRECTLY FROM THE
// ORCHESTRATOR. Exempts subagents (non-empty-string agent_id, per §2's
// Unicode-property definition of "empty"); everything else gets full
// scrutiny. Per-tool classification lives in model-routing-guards.rules.js;
// this file is the stdin/envelope/dispatch/logging entry point. See
// model-routing-guards.spec.md §4 for the classification table implemented.
//
// Independently sufficient: this hook does not rely on Hook 1 (or any other
// hook) having run first (§7 A22 note).

const fs = require("fs");
const { isBlankAfterStrip } = require("./model-routing-guards.unicode.js");
const state = require("./model-routing-guards.state.js");
const rules = require("./model-routing-guards.rules.js");
const { createLogger } = require("./model-routing-guards.log.js");

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

const appendDebug = createLogger("orchestrator-tool-guard");

// docs/specs/routing-scorecard.md §2.4 — this guard has no pre-existing
// version constant of its own; a new local one is required for the
// decision ledger's guard_version field.
const DECISIONS_GUARD_VERSION = "1";

// docs/specs/routing-scorecard.md §2.1 R1 — raw stdin is captured into a
// module-level (outer-scope) variable BEFORE main() runs, so the top-level
// catch below (which has never had access to main()'s own local `raw`) can
// pass it to appendCrashRecord for best-effort session_id recovery. This
// changes only WHEN the read happens (module scope, immediately before
// main() is invoked, in the same synchronous turn) — not what gets read,
// how a read failure is classified, or any block/allow/fail_open outcome.
let rawStdinBuffer;
let stdinReadFailed = false;

function captureStdin() {
  try {
    rawStdinBuffer = fs.readFileSync(0, "utf8");
  } catch (_) {
    stdinReadFailed = true;
  }
}

function decisionRecord(fields) {
  return Object.assign({ guard: "orchestrator-tool-guard", guard_version: DECISIONS_GUARD_VERSION }, fields);
}

function failOpen(reason, extra) {
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "fail_open", reason }, extra || {}));
  // §2.5: caller is "unknown" at every fail_open triggered before
  // agent_id has been parsed at all — true for all three fail_open reasons
  // this guard can produce (stdin_read_error/json_parse_error/parsed_not_object).
  logDecision(
    decisionRecord({ event: "fail_open", session_id: null, agent_id: null, caller: "unknown", tool_name: null, reason })
  );
  process.exit(0);
}

function buildBlockMessage(findings, toolName) {
  let msg = `orchestrator-tool-guard: BLOCKED — ${toolName} call failed ${findings.length} check(s):\n`;
  findings.forEach((f, i) => {
    msg += `  ${i + 1}. [${f.id}] ${f.detail}\n`;
  });
  msg += "Delegate to a drafting-tier or mechanical-tier subagent, or address each finding above and retry.\n";
  return msg;
}

function block(findings, toolName, extra, ctx) {
  const findingIds = findings.map((f) => f.id);
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "block", tool_name: toolName, finding_ids: findingIds }, extra || {}));
  logDecision(
    decisionRecord(
      Object.assign(
        { event: "block", tool_name: toolName, finding_ids: findingIds },
        ctx || {}
      )
    )
  );
  process.stderr.write(buildBlockMessage(findings, toolName));
  process.exit(2);
}

function allow(toolName, extra, ctx) {
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "allow", tool_name: toolName }, extra || {}));
  logDecision(decisionRecord(Object.assign({ event: "allow", tool_name: toolName }, ctx || {})));
  process.exit(0);
}

function classifyCaller(agentIdRaw) {
  if (typeof agentIdRaw !== "string") return "orchestrator"; // absent or non-string
  if (isBlankAfterStrip(agentIdRaw)) return "orchestrator"; // empty/whitespace/invisible
  return "subagent";
}

function emitLogNotes(logNotes) {
  if (!logNotes) return;
  for (const note of logNotes) {
    appendDebug(Object.assign({ ts: new Date().toISOString() }, note));
  }
}

function main() {
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

  // Opportunistic 7-day cleanup, at the start of every invocation, before
  // any tally read (wrapped internally — never blocks the current call).
  state.cleanupOldStateFiles();

  const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : "";
  const toolInput = parsed.tool_input && typeof parsed.tool_input === "object" ? parsed.tool_input : {};
  const sessionIdRaw = parsed.session_id;
  const sessionIdForDecision = typeof sessionIdRaw === "string" ? sessionIdRaw : null;
  const agentIdForDecision = typeof parsed.agent_id === "string" ? parsed.agent_id : null;
  const toolUseIdForDecision = typeof parsed.tool_use_id === "string" && parsed.tool_use_id !== "" ? parsed.tool_use_id : null;

  try {
    const caller = classifyCaller(parsed.agent_id);
    if (caller === "subagent") {
      appendDebug({ ts: new Date().toISOString(), event: "exempt_subagent", tool_name: toolName });
      logDecision(
        decisionRecord({
          event: "exempt_subagent",
          session_id: sessionIdForDecision,
          agent_id: agentIdForDecision,
          caller,
          tool_name: toolName,
          tool_use_id: toolUseIdForDecision,
        })
      );
      process.exit(0);
    }

    // Orchestrator branch — full scrutiny.
    let result;
    switch (toolName) {
      case "Read":
        result = rules.evaluateRead(toolInput, sessionIdRaw);
        break;
      case "Bash":
      case "PowerShell":
        result = rules.evaluateShellCommand(toolInput.command);
        break;
      case "Write":
        result = rules.evaluateWrite(toolInput);
        break;
      case "Edit":
        result = rules.evaluateEdit(toolInput, sessionIdRaw);
        break;
      default:
        block(
          [{ id: "unexpected_tool_name", detail: `unexpected tool_name "${toolName}" reached this hook (matcher should be Read|Bash|PowerShell|Write|Edit only).` }],
          toolName || "(missing)",
          {},
          { session_id: sessionIdForDecision, agent_id: agentIdForDecision, caller, tool_use_id: toolUseIdForDecision }
        );
        return;
    }

    emitLogNotes(result.logNotes);

    const extra = {};
    if (result.resolvedPath) extra.resolved_file_path = result.resolvedPath;
    if (typeof result.tally_edits === "number") extra.tally_edits = result.tally_edits;
    if (typeof result.tally_reads === "number") extra.tally_reads = result.tally_reads;

    // §2.2 target_hash: resolved file path (Read/Write/Edit) or the raw
    // command string (Bash/PowerShell) — never the raw value itself.
    let target = null;
    if (toolName === "Bash" || toolName === "PowerShell") {
      target = typeof toolInput.command === "string" ? toolInput.command : null;
    } else if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
      target = typeof result.resolvedPath === "string" ? result.resolvedPath : null;
    }
    const ctx = {
      session_id: sessionIdForDecision,
      agent_id: agentIdForDecision,
      caller,
      tool_use_id: toolUseIdForDecision,
      target_hash: safeHash(target),
    };

    if (result.allow) {
      if (result.orchestratorDirect) {
        appendDebug({
          ts: new Date().toISOString(),
          event: "orchestrator_direct_shell",
          tool_name: toolName,
          command: toolInput.command,
          session_id: sessionIdForDecision,
        });
        logDecision(decisionRecord(Object.assign({ event: "orchestrator_direct_shell", tool_name: toolName }, ctx)));
        process.exit(0);
      }
      allow(toolName, extra, ctx);
    } else {
      block(result.findings, toolName, extra, ctx);
    }
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
        caller: classifyCaller(parsed.agent_id),
        tool_use_id: toolUseIdForDecision,
      })
    );
    process.stderr.write("orchestrator-tool-guard: BLOCKED — internal error during classification — treat as block.\n");
    process.exit(2);
  }
}

if (require.main === module) {
  captureStdin();
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
      process.stderr.write("orchestrator-tool-guard: BLOCKED — internal error during classification — treat as block.\n");
    } catch (_) {}
    // §2.1 R1 — best-effort session recovery from the raw stdin captured
    // before main() ran; routes to that session's own file as event
    // "block" when session_id is recoverable, else to the global-fallback
    // file as event "guard_crash". safeCrash() (see the wrapper block near
    // the top of this file) already never throws — a missing module, a
    // non-function export, or a throwing appendCrashRecord are all
    // absorbed there — so no further try/catch is needed at this, the
    // guard's last line of defense before its own exit code below, which
    // is decided independently of whether this call did anything at all.
    safeCrash(rawStdinBuffer, "orchestrator-tool-guard", DECISIONS_GUARD_VERSION);
    process.exit(2);
  }
}

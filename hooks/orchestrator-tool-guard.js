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

const appendDebug = createLogger("orchestrator-tool-guard");

function failOpen(reason, extra) {
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "fail_open", reason }, extra || {}));
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

function block(findings, toolName, extra) {
  appendDebug(
    Object.assign(
      { ts: new Date().toISOString(), event: "block", tool_name: toolName, finding_ids: findings.map((f) => f.id) },
      extra || {}
    )
  );
  process.stderr.write(buildBlockMessage(findings, toolName));
  process.exit(2);
}

function allow(toolName, extra) {
  appendDebug(Object.assign({ ts: new Date().toISOString(), event: "allow", tool_name: toolName }, extra || {}));
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
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    failOpen("stdin_read_error");
    return;
  }

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

  try {
    const caller = classifyCaller(parsed.agent_id);
    if (caller === "subagent") {
      appendDebug({ ts: new Date().toISOString(), event: "exempt_subagent", tool_name: toolName });
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
          toolName || "(missing)"
        );
        return;
    }

    emitLogNotes(result.logNotes);

    const extra = {};
    if (result.resolvedPath) extra.resolved_file_path = result.resolvedPath;
    if (typeof result.tally_edits === "number") extra.tally_edits = result.tally_edits;
    if (typeof result.tally_reads === "number") extra.tally_reads = result.tally_reads;

    if (result.allow) {
      if (result.orchestratorDirect) {
        appendDebug({
          ts: new Date().toISOString(),
          event: "orchestrator_direct_shell",
          tool_name: toolName,
          command: toolInput.command,
          session_id: typeof sessionIdRaw === "string" ? sessionIdRaw : null,
        });
        process.exit(0);
      }
      allow(toolName, extra);
    } else {
      block(result.findings, toolName, extra);
    }
  } catch (internalErr) {
    appendDebug({
      ts: new Date().toISOString(),
      event: "block",
      tool_name: toolName,
      finding_ids: ["internal_exception"],
      message: String((internalErr && internalErr.message) || internalErr),
    });
    process.stderr.write("orchestrator-tool-guard: BLOCKED — internal error during classification — treat as block.\n");
    process.exit(2);
  }
}

if (require.main === module) {
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
    process.exit(2);
  }
}

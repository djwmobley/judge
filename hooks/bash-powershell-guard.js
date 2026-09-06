"use strict";
// bash-powershell-guard.js
// PreToolUse hook — blocks Bash tool calls that contain PowerShell syntax.
//
// Block conditions:
//   Bash command contains $env: (PowerShell environment variable reference).
//   Bash command contains a known PowerShell Verb-Noun cmdlet in command position.
//   Bash command contains a PowerShell-only flag (-ErrorAction, -ItemType, -Recurse,
//     -Force) co-occurring with a recognized cmdlet.
//   Bash command contains a PowerShell automatic variable ($PSScriptRoot,
//     $PSVersionTable, $PSCommandPath).
// Allow conditions:
//   Any tool other than Bash → allow.
//   Bash commands containing none of the above patterns → allow.
//   POSIX-valid constructs (backticks, $(...), ${...}, [[ ]], $VAR) are NOT blocked.
//
// Rationale: the Bash tool on this machine routes to /usr/bin/bash; PowerShell
// syntax is a hard parse error there. Precision over recall — a missed PS
// command is tolerable; a blocked legitimate bash command is not.

const fs   = require("fs");
const path = require("path");
const { appendRotating } = require("./model-routing-guards.log.js");

// ── Paths ──────────────────────────────────────────────────────────────────
// This guard's own install directory. __dirname resolves correctly both in
// an installed ~/.claude/hooks tree and when running the tests straight out
// of this repository's hooks/ directory — no owner-specific path baked in.
const HOOKS_DIR = __dirname;
const DEBUG_LOG = path.join(HOOKS_DIR, "bash-powershell-guard-debug.log");

// ── Helpers ────────────────────────────────────────────────────────────────

function appendDebug(obj) {
  appendRotating(DEBUG_LOG, JSON.stringify(obj));
}

// ── Detection ──────────────────────────────────────────────────────────────

// Curated list of PowerShell Verb-Noun cmdlets to detect.
const PS_CMDLETS = [
  "Test-Path",
  "Get-Content",
  "Set-Content",
  "Add-Content",
  "Clear-Content",
  "Get-ChildItem",
  "New-Item",
  "Remove-Item",
  "Copy-Item",
  "Move-Item",
  "Rename-Item",
  "Get-Item",
  "Set-Item",
  "Write-Output",
  "Write-Host",
  "Write-Error",
  "Select-Object",
  "Where-Object",
  "ForEach-Object",
  "Sort-Object",
  "Measure-Object",
  "Group-Object",
  "Out-File",
  "Out-String",
  "Out-Null",
  "Select-String",
  "Get-Command",
  "Get-Member",
  "Get-Process",
  "Stop-Process",
  "Start-Process",
  "Start-Sleep",
  "Set-Location",
  "Get-Location",
  "Push-Location",
  "Pop-Location",
  "Invoke-WebRequest",
  "Invoke-RestMethod",
  "Invoke-Expression",
  "Invoke-Command",
  "Get-Date",
  "ConvertTo-Json",
  "ConvertFrom-Json",
  "Import-Csv",
  "Export-Csv",
  "Format-List",
  "Format-Table",
  "Resolve-Path",
  "Join-Path",
  "Split-Path",
  "New-Object",
  "Get-Service",
  "Set-ItemProperty",
  "Get-ItemProperty",
];

// Boundary characters that can immediately precede a cmdlet in command position:
// start-of-string, newline, semicolon, pipe, &&, ||, (, {, $(.
// We build a regex that matches the cmdlet when preceded by one of these
// (or start-of-string) and followed by a word boundary (space, end, flag, etc.).
// The lookahead \b covers end-of-string and transition to non-word characters.
const COMMAND_POSITION_PREFIX =
  /(?:^|[\n;|({\s]|&&|\|\||\$\()/;

// Build a single regex from the cmdlet list; each cmdlet is anchored to
// command-position via the prefix class above.  We need to be careful: the
// prefix group can consume a character, so we use a non-capturing group for
// the prefix and then match the cmdlet ending at a word boundary.
function buildCmdletRegex(cmdlets) {
  // Escape hyphens in each cmdlet name for safety (they are literal here).
  const alts = cmdlets.map((c) => c.replace(/-/g, "-")).join("|");
  // (?:^|[\n;|({]|&&|\|\||\$\() matches command-position boundary (or SOL).
  // The cmdlet must then end at a word boundary (\b) which in JS regex is
  // the transition from \w to \W or to end-of-string.
  return new RegExp(
    "(?:^|[\\n;|({\\ ]|&&|\\|\\||\\$\\()(" + alts + ")\\b",
    "i"
  );
}

const CMDLET_REGEX = buildCmdletRegex(PS_CMDLETS);

// PowerShell environment variable syntax — bash cannot parse $env:FOO.
const ENV_COLON_REGEX = /\$env:/i;

// PowerShell automatic variables.
const PS_AUTO_VAR_REGEX = /\$(PSScriptRoot|PSVersionTable|PSCommandPath)\b/i;

// PowerShell-only flag tokens (require cmdlet co-occurrence; see check below).
const PS_FLAG_REGEX = /\b(-ErrorAction|-ItemType|-Recurse|-Force)\b/i;

/**
 * Returns a description of the first PowerShell pattern found in cmd,
 * or null if none found.
 */
function detectPowerShell(cmd) {
  // 1. $env: — definitive PS syntax.
  if (ENV_COLON_REGEX.test(cmd)) {
    return "PowerShell environment variable syntax `$env:` detected";
  }

  // 2. PS automatic variables.
  const autoVarMatch = cmd.match(PS_AUTO_VAR_REGEX);
  if (autoVarMatch) {
    return `PowerShell automatic variable \`${autoVarMatch[0]}\` detected`;
  }

  // 3. Cmdlet in command position.
  const cmdletMatch = cmd.match(CMDLET_REGEX);
  if (cmdletMatch) {
    // cmdletMatch[1] is the captured cmdlet name.
    return `PowerShell cmdlet \`${cmdletMatch[1]}\` detected in command position`;
  }

  // 4. PS flag co-occurring with a cmdlet anywhere in the command (case-insensitive).
  //    We already know no cmdlet is in command position, but a cmdlet could appear
  //    as an argument reference, which is still a strong PS signal when paired
  //    with a PS-only flag.  However, to honor the spec (flag alone is too weak),
  //    we only fire when BOTH a flag AND a cmdlet name appear anywhere in the cmd.
  const flagMatch = cmd.match(PS_FLAG_REGEX);
  if (flagMatch) {
    // Check if any cmdlet name appears anywhere in the command (not just command pos).
    const anyCmdletAnywhereRegex = new RegExp(
      "\\b(" + PS_CMDLETS.map((c) => c.replace(/-/g, "-")).join("|") + ")\\b",
      "i"
    );
    const anyCmdlet = cmd.match(anyCmdletAnywhereRegex);
    if (anyCmdlet) {
      return (
        `PowerShell flag \`${flagMatch[0]}\` co-occurring with cmdlet ` +
        `\`${anyCmdlet[1]}\` detected`
      );
    }
  }

  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Read all of stdin (fd 0) — works on Windows with Node.
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    process.exit(0); // Can't read stdin; allow to avoid breaking tooling.
  }

  // JSON.parse — on failure exit 0 (do not break unrelated tooling).
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const tool_name  = parsed.tool_name  || "";
  const tool_input = parsed.tool_input || {};
  const cmd        = (typeof tool_input.command === "string") ? tool_input.command : "";
  const caller     = parsed.agent_id ? String(parsed.agent_id) : "ROOT";

  // Determine block status before logging so we can include it in the debug line.
  let blocked    = false;
  let blockReason = null;

  // Only Bash commands are relevant; all other tools exit 0 after debug.
  if (tool_name === "Bash") {
    blockReason = detectPowerShell(cmd);
    blocked     = blockReason !== null;
  }

  appendDebug({
    ts:               new Date().toISOString(),
    tool_name,
    agent_id_present: !!parsed.agent_id,
    caller,
    blocked,
    cmd_prefix:       cmd.slice(0, 60),
  });

  if (tool_name !== "Bash") {
    process.exit(0);
  }

  if (blocked) {
    process.stderr.write(
      "bash-powershell-guard: BLOCKED — the Bash tool routes to /usr/bin/bash on " +
        "this machine and cannot execute PowerShell syntax.\n" +
        `Trigger: ${blockReason}.\n` +
        "Fix: use the PowerShell tool for pwsh syntax, OR rewrite in POSIX sh for " +
        "the Bash tool. For trivial file checks, prefer the Read or Glob tools.\n"
    );
    process.exit(2);
  }

  // Delegation: classifier-bait linter (bash-classifier-bait-guard.js).
  // Fail-open if the module is missing or throws.
  try {
    const bait = require("./bash-classifier-bait-guard.js").checkCommand(cmd);
    if (bait) {
      process.stderr.write(
        "bash-classifier-bait-guard: BLOCKED — this Bash command shape reliably triggers " +
          "the permission-classifier dialog.\n" +
          `Trigger: ${bait.reason} (branch ${bait.branch}).\n` +
          `Fix: ${bait.instruction}\n`
      );
      process.exit(2);
    }
  } catch (_) {}

  process.exit(0);
}

// Top-level guard: if main() throws for any unexpected reason, exit 0 so we
// never break unrelated tooling (same rationale as pr-independence.js).
try {
  main();
} catch (e) {
  process.exit(0);
}

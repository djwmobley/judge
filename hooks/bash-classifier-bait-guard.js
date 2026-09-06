"use strict";
// bash-classifier-bait-guard.js
// PreToolUse hook / require-delegation module — ergonomics linter (NOT a
// security gate). Pre-blocks Bash command SHAPES known to trigger the
// server-side permission classifier's dialog, so the agent reshapes the
// call instead of surfacing an owner dialog.
//
// Exports: checkCommand(cmd) -> null (allow) | { branch, reason, instruction }
//
// Dual mode:
//   require("./bash-classifier-bait-guard").checkCommand(cmd)   <- library use
//   node bash-classifier-bait-guard.js                          <- standalone hook (reads stdin JSON)
//
// False negative (missed dialog-bait shape) = tolerable, one owner dialog,
// add the pattern later. False positive (blocking normal repertoire) is not
// acceptable — precision over recall, same rationale as bash-powershell-guard.js.

const fs = require("fs");
const path = require("path");

// ── Tokenizer ────────────────────────────────────────────────────────────
//
// Quote-respecting, shell-ish tokenizer. Splits on whitespace and the
// separators `&&`, `||`, `;`, `|`, newline (separator tokens are boundaries,
// never part of a word token). `$(...)`/backtick spans are consumed
// atomically (parens/backtick-matched) so internal spaces/pipes never split
// a token or fake a segment boundary. Redirects `>`, `>>`, `&>` are their
// own tokens.
//
// Each word token carries:
//   text        - raw source text (quotes included)
//   value       - fully dequoted text (single- and double-quoted spans both
//                 stripped of their quote chars) — used for path/substring
//                 matching, since shell quoting doesn't change what path a
//                 command targets, only whether $ expands.
//   expandable  - dequoted text but WITH single-quoted spans excluded
//                 entirely (single-quoted $ is literal, never expands) —
//                 used for variable-sourced-target detection.
//   quoted      - true iff every character in the token came from inside a
//                 quote (no bare/unquoted characters at all). Operator /
//                 reserved-word / keyword matching skips any token where
//                 quoted === true, per spec: "prose in git commit -m '...'
//                 must never trigger operator/loop matches."
//   sep         - true for separator tokens (`;`,`&&`,`||`,`|`, newline)
//   redirect    - true for redirect tokens (`>`,`>>`,`&>`)

function tokenize(cmd) {
  const tokens = [];
  const n = cmd.length;
  let i = 0;

  while (i < n) {
    const c = cmd[i];

    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") { tokens.push({ text: "\n", value: "\n", expandable: "\n", quoted: false, sep: true }); i++; continue; }
    if (c === ";") { tokens.push({ text: ";", value: ";", expandable: ";", quoted: false, sep: true }); i++; continue; }
    if (c === "&" && cmd[i + 1] === "&") { tokens.push({ text: "&&", value: "&&", expandable: "&&", quoted: false, sep: true }); i += 2; continue; }
    if (c === "|" && cmd[i + 1] === "|") { tokens.push({ text: "||", value: "||", expandable: "||", quoted: false, sep: true }); i += 2; continue; }
    if (c === "|") { tokens.push({ text: "|", value: "|", expandable: "|", quoted: false, sep: true }); i++; continue; }
    if (c === "&" && cmd[i + 1] === ">") { tokens.push({ text: "&>", value: "&>", expandable: "&>", quoted: false, redirect: true }); i += 2; continue; }
    if (c === ">") {
      if (cmd[i + 1] === ">") { tokens.push({ text: ">>", value: ">>", expandable: ">>", quoted: false, redirect: true }); i += 2; continue; }
      tokens.push({ text: ">", value: ">", expandable: ">", quoted: false, redirect: true }); i++; continue;
    }

    // Word token — may concatenate bare / double-quoted / single-quoted /
    // $(...) / backtick spans with no intervening whitespace.
    let raw = "", value = "", expandable = "";
    let anyChar = false, allQuoted = true;

    while (i < n) {
      const ch = cmd[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      if (ch === ";" || ch === "|") break;
      if (ch === "&" && (cmd[i + 1] === "&" || cmd[i + 1] === ">")) break;
      if (ch === ">") break;

      if (ch === '"') {
        i++;
        const start = i;
        while (i < n && cmd[i] !== '"') i++;
        const inner = cmd.slice(start, i);
        value += inner; expandable += inner; raw += '"' + inner + '"';
        if (i < n) i++;
        anyChar = true;
        continue;
      }
      if (ch === "'") {
        i++;
        const start = i;
        while (i < n && cmd[i] !== "'") i++;
        const inner = cmd.slice(start, i);
        value += inner; raw += "'" + inner + "'"; // NOT added to expandable — single-quoted $ is literal
        if (i < n) i++;
        anyChar = true;
        continue;
      }
      if (ch === "$" && cmd[i + 1] === "(") {
        const start = i;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (cmd[i] === "(") depth++;
          else if (cmd[i] === ")") depth--;
          i++;
        }
        const span = cmd.slice(start, i);
        value += span; expandable += span; raw += span;
        anyChar = true; allQuoted = false;
        continue;
      }
      if (ch === "`") {
        const start = i;
        i++;
        while (i < n && cmd[i] !== "`") i++;
        if (i < n) i++;
        const span = cmd.slice(start, i);
        value += span; expandable += span; raw += span;
        anyChar = true; allQuoted = false;
        continue;
      }

      value += ch; expandable += ch; raw += ch;
      anyChar = true; allQuoted = false;
      i++;
    }

    if (anyChar) {
      tokens.push({ text: raw, value, expandable, quoted: allQuoted, sep: false });
    } else {
      // Guard against an infinite loop on an unexpected character.
      i++;
    }
  }

  return tokens;
}

function isSep(t) { return !!t.sep; }

// Boundary set for reserved-word (for/while/until) statement-start, per spec.
const STATEMENT_START_WORDS = ["do", "then", "(", "{"];
// Broader boundary set used for destructive-operator / find / xargs command-
// position matching: also treats the word right after `xargs`, `-exec`, or
// `-execdir` as being "in command position" (that word IS the command being
// invoked by the sweep primitive).
const COMMAND_POSITION_WORDS = ["do", "then", "(", "{", "xargs", "-exec", "-execdir"];

function isStatementStart(tokens, i) {
  if (i === 0) return true;
  const prev = tokens[i - 1];
  if (isSep(prev)) return true;
  if (!prev.quoted && STATEMENT_START_WORDS.includes(prev.value)) return true;
  return false;
}

function isCommandPosition(tokens, i) {
  if (i === 0) return true;
  const prev = tokens[i - 1];
  if (isSep(prev)) return true;
  if (!prev.quoted && COMMAND_POSITION_WORDS.includes(prev.value)) return true;
  return false;
}

function clauseEnd(tokens, i) {
  let j = i;
  while (j < tokens.length && !isSep(tokens[j])) j++;
  return j; // exclusive
}

// Pure separator-split segments (;, &&, ||, |, newline only — NOT do/then/(/{).
// Used for B3's "2+ segments" count and as the scope for B1-a's same-segment
// co-occurrence check.
function splitSegments(tokens) {
  const segs = [];
  let cur = [];
  for (const t of tokens) {
    if (isSep(t)) { segs.push(cur); cur = []; }
    else cur.push(t);
  }
  segs.push(cur);
  return segs.filter((s) => s.length > 0);
}

// ── Path predicates ─────────────────────────────────────────────────────

function normPath(v) { return v.toLowerCase().replace(/\\/g, "/"); }

function isDotEnvToken(v) {
  return /\.env(?=$|\/)/.test(v);
}

function isDotGitPathToken(v) {
  return /(^|\/)\.git(\/|$)/.test(v);
}

function isProtectedConfigPath(rawValue) {
  const v = normPath(rawValue);
  // .claude/ (or .claude\) NOT immediately followed by worktrees/
  const re = /\.claude\//g;
  let m;
  while ((m = re.exec(v)) !== null) {
    const after = v.slice(m.index + m[0].length);
    if (!after.startsWith("worktrees/")) return true;
  }
  if (v.includes("settings.json")) return true;
  if (v.includes("settings.local.json")) return true;
  if (isDotEnvToken(v)) return true;
  if (isDotGitPathToken(v)) return true;
  return false;
}

function isWorktreeScratchPath(rawValue) {
  return normPath(rawValue).includes(".claude/worktrees/");
}

// ── Destructive operator detection ──────────────────────────────────────
//
// Returns array of matches: { start, end, argStart, type, impliedProtected }
//   start/end   - absolute token index range of the matched clause [start,end)
//   argStart    - absolute index where "target arguments" begin (used by B2v)
//   impliedProtected - special-cased true for `git clean -f/-d/-x` (see
//                 DECISIONS below): treated as inherently protected-adjacent
//                 even with no literal protected-path token, because it wipes
//                 the whole untracked working tree (including untracked
//                 config/env files) rather than an explicit target.

function findDestructiveOperators(tokens) {
  const matches = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.sep || t.redirect) continue;
    if (t.quoted) continue;
    if (!isCommandPosition(tokens, i)) continue;

    const end = clauseEnd(tokens, i);

    if (["rm", "rmdir", "unlink", "shred"].includes(t.value)) {
      matches.push({ start: i, end, argStart: i + 1, type: t.value });
      continue;
    }

    if (t.value === "Remove-Item") {
      matches.push({ start: i, end, argStart: i + 1, type: "Remove-Item" });
      continue;
    }

    if (t.value === "rd") {
      const hasS = tokens.slice(i + 1, end).some((x) => !x.quoted && /^\/s$/i.test(x.value));
      if (hasS) matches.push({ start: i, end, argStart: i + 1, type: "rd /s" });
      continue;
    }

    if (t.value === "del") {
      matches.push({ start: i, end, argStart: i + 1, type: "del" });
      continue;
    }

    if (t.value === "git") {
      let j = i + 1;
      while (j < end) {
        const g = tokens[j];
        if (g.quoted) break;
        if (g.value === "-C" || g.value === "-c") { j += 2; continue; }
        if (g.value.startsWith("--git-dir=") || g.value.startsWith("--work-tree=")) { j += 1; continue; }
        break;
      }
      if (j >= end || tokens[j].quoted) continue;
      const sub = tokens[j].value;

      if (sub === "clean") {
        let hasFDX = false;
        for (let k = j + 1; k < end; k++) {
          const f = tokens[k];
          if (f.quoted) continue;
          if (/^-[a-z]+$/.test(f.value) && /[fdx]/.test(f.value.slice(1))) hasFDX = true;
        }
        if (hasFDX) matches.push({ start: i, end, argStart: j + 1, type: "git clean", impliedProtected: true });
      } else if (sub === "worktree") {
        const nxt = tokens[j + 1];
        if (nxt && !nxt.quoted && nxt.value === "remove") {
          matches.push({ start: i, end, argStart: j + 2, type: "git worktree remove" });
        }
      } else if (sub === "branch") {
        let hasDelete = false;
        for (let k = j + 1; k < end; k++) {
          const f = tokens[k];
          if (f.quoted) continue;
          if (f.value === "-D" || f.value === "-d" || f.value === "--delete" || f.value === "--force") hasDelete = true;
          else if (/^-[A-Za-z]+$/.test(f.value) && /[Dd]/.test(f.value.slice(1))) hasDelete = true;
        }
        if (hasDelete) matches.push({ start: i, end, argStart: j + 1, type: "git branch delete" });
      } else if (sub === "push") {
        let hasDelete = false;
        for (let k = j + 1; k < end; k++) {
          const f = tokens[k];
          if (f.quoted) continue;
          if (f.value === "--force-with-lease") continue; // explicit non-match
          if (f.value === "--delete" || f.value === "-d" || f.value === "--force" || f.value === "-f") hasDelete = true;
          else if (/^:.+/.test(f.value)) hasDelete = true; // :-prefixed refspec deletion
        }
        if (hasDelete) matches.push({ start: i, end, argStart: j + 1, type: "git push delete/force" });
      } else if (sub === "update-ref") {
        const nxt = tokens[j + 1];
        if (nxt && !nxt.quoted && nxt.value === "-d") {
          matches.push({ start: i, end, argStart: j + 2, type: "git update-ref -d" });
        }
      } else if (sub === "reset") {
        let hasHard = false;
        for (let k = j + 1; k < end; k++) {
          const f = tokens[k];
          if (!f.quoted && f.value === "--hard") hasHard = true;
        }
        if (hasHard) matches.push({ start: i, end, argStart: j + 1, type: "git reset --hard" });
      } else if (sub === "worktree_or_branch_force_generic") {
        // unreachable placeholder — --force on worktree/branch already covered above
      }
      continue;
    }
  }

  return matches;
}

// ── Sweep primitive detection ───────────────────────────────────────────

function findSweepPrimitives(tokens) {
  const sweeps = []; // { idx, type }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.sep || t.redirect || t.quoted) continue;

    if (["for", "while", "until"].includes(t.value) && isStatementStart(tokens, i)) {
      sweeps.push({ idx: i, type: t.value });
      continue;
    }

    if (t.value === "xargs" && isCommandPosition(tokens, i)) {
      sweeps.push({ idx: i, type: "xargs" });
      continue;
    }

    if (t.value === "find" && isCommandPosition(tokens, i)) {
      const end = clauseEnd(tokens, i);
      const clause = tokens.slice(i, end);
      const hasDeleteFlag = clause.some((c) => !c.quoted && c.value === "-delete");
      let hasExecDestructive = false;
      for (let k = 1; k < clause.length; k++) {
        const c = clause[k];
        if (!c.quoted && (c.value === "-exec" || c.value === "-execdir")) {
          const cmdName = clause[k + 1];
          if (cmdName && !cmdName.quoted && ["rm", "rmdir", "unlink", "shred", "mv", "cp"].includes(cmdName.value)) {
            hasExecDestructive = true;
          }
        }
      }
      if (hasDeleteFlag || hasExecDestructive) sweeps.push({ idx: i, type: "find" });
    }
  }

  return sweeps;
}

function hasDeleteFlagAnywhere(tokens) {
  return tokens.some((t) => !t.sep && !t.redirect && !t.quoted && (t.value === "-delete" || t.value === "--delete"));
}

// ── Variable-sourced target detection (B2v) ─────────────────────────────

const VAR_PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`/;

function destructiveMatchHasVariableTarget(tokens, m) {
  for (let k = m.argStart; k < m.end; k++) {
    if (VAR_PATTERN.test(tokens[k].expandable)) return true;
  }
  return false;
}

// ── Overwrite-class destination detection ───────────────────────────────
// Returns array of { destIdx } over the FULL flat token stream (redirects,
// mv/cp/install, tee). Scoped per pure separator-segment (mv/cp/install/tee
// only recognized in segment-initial command position, matching the spec's
// "destination = last positional arg" framing).

function findOverwriteDestinations(tokens) {
  const results = [];
  const segs = splitSegments(tokens);

  for (const seg of segs) {
    if (seg.length === 0) continue;
    const cmdTok = seg[0];

    if (!cmdTok.quoted && ["mv", "cp", "install"].includes(cmdTok.value)) {
      let destIdx = -1;
      for (let i = 1; i < seg.length; i++) {
        const tk = seg[i];
        if (!tk.quoted && (tk.value === "-t" || tk.value === "--target-directory")) {
          if (i + 1 < seg.length) destIdx = i + 1;
        } else if (!tk.quoted && tk.value.startsWith("--target-directory=")) {
          destIdx = i;
        }
      }
      if (destIdx === -1) {
        for (let i = seg.length - 1; i >= 1; i--) {
          const tk = seg[i];
          if (tk.quoted || !tk.value.startsWith("-")) { destIdx = i; break; }
        }
      }
      if (destIdx !== -1) results.push({ tok: seg[destIdx] });
    }

    if (!cmdTok.quoted && cmdTok.value === "tee") {
      for (let i = 1; i < seg.length; i++) {
        const tk = seg[i];
        if (tk.quoted || !tk.value.startsWith("-")) results.push({ tok: tk });
      }
    }

    for (let i = 0; i < seg.length; i++) {
      const tk = seg[i];
      if (!tk.sep && tk.redirect && i + 1 < seg.length) {
        results.push({ tok: seg[i + 1] });
      }
    }
  }

  return results;
}

// mkdir/touch of a protected path, per pure separator-segment (used by B3).
function segmentMkdirTouchesProtected(seg) {
  if (seg.length === 0) return false;
  const cmdTok = seg[0];
  if (cmdTok.quoted || !["mkdir", "touch"].includes(cmdTok.value)) return false;
  for (let i = 1; i < seg.length; i++) {
    const tk = seg[i];
    if (tk.quoted || !tk.value.startsWith("-")) {
      if (isProtectedConfigPath(tk.value)) return true;
    }
  }
  return false;
}

function segmentOverwritesProtected(seg) {
  const dests = findOverwriteDestinations(seg); // seg has no sep tokens, safe to reuse
  return dests.some((d) => isProtectedConfigPath(d.tok.value));
}

// ── Windows cmd /c indirection (B1-a auxiliary check only) ──────────────
//
// DECISION: `cmd /c "..."` (or with single quotes) hands its quoted argument
// to a separate interpreter (cmd.exe) rather than bash — the general
// "quoted content is never matched for operator purposes" rule would
// otherwise make `cmd /c "rd /s /q .claude\hooks"` invisible. We recursively
// tokenize the indirected string and check it ONLY for B1-a (protected-path
// + destructive-operator co-occurrence within that indirected content).
// We deliberately do NOT route indirected content through B2/B2v/B3 — no
// spec test requires it, and it would balloon the surface area of a
// linter whose job is dialog-bait SHAPES, not a full cmd.exe grammar.
// (Documented as a blind spot in the report.)

function indirectedCmdHasB1aCoOccurrence(cmd) {
  const re = /\bcmd\s+\/c\s+(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const inner = m[1] !== undefined ? m[1] : m[2];
    const innerTokens = tokenize(inner);
    const innerSegs = splitSegments(innerTokens);
    for (const seg of innerSegs) {
      const segDestructive = findDestructiveOperators(seg);
      if (segDestructive.length === 0) continue;
      const segHasProtected = seg.some((tk) => isProtectedConfigPath(tk.value)) ||
        segDestructive.some((d) => d.impliedProtected);
      if (segHasProtected) return true;
    }
  }
  return false;
}

// ── Branch classification ───────────────────────────────────────────────

const INSTRUCTIONS = {
  B1: "Config-grade protected path (settings/hooks/.git/.env) + destructive/overwrite op in one command. Use the Write/Edit tools for content changes, or isolate a genuinely-needed shell op into its own single-purpose command.",
  B2: "Sweep + destroy in one command is dialog bait. Materialize the target list read-only first, review it, then delete via a single command with explicitly enumerated literal arguments.",
  B3: "Isolate the protected-path write as its own single call, or use the Write/Edit tools.",
};

/**
 * checkCommand(cmd) -> null | { branch, reason, instruction }
 */
function checkCommand(cmd) {
  if (typeof cmd !== "string" || cmd.trim() === "") return null;

  const tokens = tokenize(cmd);
  const segs = splitSegments(tokens);
  const destructiveMatches = findDestructiveOperators(tokens);
  const sweeps = findSweepPrimitives(tokens);

  // ---- B1: protected-config + destructive/overwrite ----

  // B1-a: same (separator-)segment co-occurrence of a protected-config
  // reference and a destructive-operator match (or git-clean's implied
  // protection).
  for (const seg of segs) {
    const segStart = tokens.indexOf(seg[0]);
    const segEndExclusive = segStart + seg.length;
    const segDestructive = destructiveMatches.filter((m) => m.start >= segStart && m.start < segEndExclusive);
    if (segDestructive.length === 0) continue;
    const segHasImplied = segDestructive.some((m) => m.impliedProtected);
    const segHasProtectedToken = seg.some((tk) => isProtectedConfigPath(tk.value));
    if (segHasImplied || segHasProtectedToken) {
      return { branch: "B1", reason: "protected-config reference co-occurs with a destructive operator", instruction: INSTRUCTIONS.B1 };
    }
  }

  // B1-a auxiliary: cmd /c "..." indirection.
  if (indirectedCmdHasB1aCoOccurrence(cmd)) {
    return { branch: "B1", reason: "cmd /c indirection targets a protected-config path with a destructive operator", instruction: INSTRUCTIONS.B1 };
  }

  // B1-b: overwrite-class op lands directly on a protected-config
  // destination — ONLY when the whole command is a single segment (2+
  // segments routes the same shape through B3 instead; see DECISIONS).
  if (segs.length <= 1) {
    const dests = findOverwriteDestinations(tokens);
    if (dests.some((d) => isProtectedConfigPath(d.tok.value))) {
      return { branch: "B1", reason: "overwrite-class op lands on a protected-config destination", instruction: INSTRUCTIONS.B1 };
    }
  }

  // ---- B2: destructive sweep ----
  if (sweeps.length > 0 && (destructiveMatches.length > 0 || hasDeleteFlagAnywhere(tokens))) {
    return { branch: "B2", reason: "sweep primitive co-occurs with a destructive operator or delete flag", instruction: INSTRUCTIONS.B2 };
  }

  // ---- B2v: variable-sourced destruction (non-loop; B2 already caught loop cases) ----
  for (const m of destructiveMatches) {
    if (destructiveMatchHasVariableTarget(tokens, m)) {
      return { branch: "B2v", reason: `destructive operator (${m.type}) has a variable-sourced target`, instruction: INSTRUCTIONS.B2 };
    }
  }

  // ---- B3: bundled protected-config write ----
  if (segs.length >= 2) {
    for (const seg of segs) {
      if (segmentOverwritesProtected(seg) || segmentMkdirTouchesProtected(seg)) {
        return { branch: "B3", reason: "protected-config write/mkdir/touch bundled with other segment(s)", instruction: INSTRUCTIONS.B3 };
      }
    }
  }

  return null;
}

module.exports = { checkCommand, tokenize, splitSegments, isProtectedConfigPath, isWorktreeScratchPath };

// ── Standalone hook mode ────────────────────────────────────────────────

const DEBUG_LOG = path.join(__dirname, "bash-classifier-bait-guard-debug.log");
const { appendRotating } = require("./model-routing-guards.log.js");

function appendDebug(obj) {
  appendRotating(DEBUG_LOG, JSON.stringify(obj));
}

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const tool_name = parsed.tool_name || "";
  const tool_input = parsed.tool_input || {};
  const cmd = typeof tool_input.command === "string" ? tool_input.command : "";

  let result = null;
  if (tool_name === "Bash") {
    result = checkCommand(cmd);
  }

  appendDebug({
    ts: new Date().toISOString(),
    tool_name,
    blocked: !!result,
    branch: result ? result.branch : null,
    cmd_prefix: cmd.slice(0, 80),
  });

  if (tool_name !== "Bash" || !result) {
    process.exit(0);
  }

  process.stderr.write(
    "bash-classifier-bait-guard: BLOCKED — this Bash command shape reliably triggers " +
      "the permission-classifier dialog.\n" +
      `Trigger: ${result.reason} (branch ${result.branch}).\n` +
      `Fix: ${result.instruction}\n`
  );
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.exit(0); // fail-open on any internal error
  }
}

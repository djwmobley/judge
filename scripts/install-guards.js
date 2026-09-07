'use strict';

/**
 * install-guards.js — Wire judge's dispatch guards into a Claude Code
 * settings file.
 *
 * Ports the settings-merge approach from claude-memory's scripts/install.js
 * mergeHooks() (matcher-wrapped hooks schema, anchored ownership-marker
 * identity, backup + atomic write, --dry-run, --hooks-scope) to a list of
 * N independent guards instead of a fixed pair of verbs, and adds
 * --uninstall. This file is a fresh implementation for this repo, not a
 * cross-repo import — see hooks/README.md's tour of each guard for what
 * each one does.
 *
 * Claude Code's hooks schema is matcher-wrapped three levels deep:
 *   hooks.<Event>: [ { matcher?: string, hooks: [ { type: "command",
 *     command, timeout?, statusMessage? } ] } ]
 * mergeGuardHooks() walks that shape (never a flat `{command}` array),
 * finds any pre-existing judge-guard entry by an anchored command match
 * (never substring), re-points it to this checkout's hooks path, and places
 * it under the correct (event, matcher) pair without disturbing sibling
 * hooks or any other tool's entries.
 *
 * Usage:
 *   node scripts/install-guards.js [--dry-run] [--yes|-y] [--force] [--non-interactive]
 *                                   [--hooks-scope user|project|auto]
 *                                   [--uninstall] [--help|-h]
 *
 * --yes/-y and --force both skip the interactive confirmation prompt; they
 * are otherwise identical today (--force is kept for backward compatibility
 * and any future meaning specific to overwriting — see the "Flags" section
 * of USAGE below for the documented distinction). If stdin is not a TTY and
 * none of --yes, --force, --non-interactive, or --dry-run is given, the
 * confirmation prompt could never be answered — main() refuses immediately
 * (exit 1) naming --yes, instead of hanging on an unanswerable
 * readline.question().
 *
 * Exit codes: 0 success, 1 error or user abort, 2 refused (malformed input).
 *
 * Testability: mergeGuardHooks(), isOurs(), normalizeCommand(),
 * validateHooksSection(), scanEntries(), detectIndent(), detectOursPresent(),
 * serializeSettings(), diffLines(), reconcileFormatting(), unifiedDiff(),
 * makeBackupPath(), collectManagedRelPaths(), filesDiffer(), planBackups(),
 * and backupDiffering() are exported for unit testing against in-memory
 * objects and temp-directory fixtures ONLY — requiring this module never touches
 * argv/cwd/process.exit/the real home directory; resolveConfig() and main()
 * only run when this file is executed directly. The test suite for this
 * file (hooks/../test/install-guards.test.js) must never point at a real
 * ~/.claude/settings.json.
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

// ─── GUARD REGISTRY ──────────────────────────────────────────────────────────
//
// One entry per guard this repo ships. `id` is the ownership-marker verb
// (also the filename stem); `event` + `matcher` say where it's wired;
// `matcher: null` means an unfiltered group (used by the Stop guard, which
// has no tool to match against).
const GUARDS = [
  { id: 'no-punt-guard', file: 'no-punt-guard.js', event: 'Stop', matcher: null },
  { id: 'shell-write-guard', file: 'shell-write-guard.js', event: 'PreToolUse', matcher: 'Bash|PowerShell' },
  { id: 'bash-powershell-guard', file: 'bash-powershell-guard.js', event: 'PreToolUse', matcher: 'Bash' },
  { id: 'worktree-isolation-guard', file: 'worktree-isolation-guard.js', event: 'PreToolUse', matcher: 'Bash' },
  { id: 'bash-classifier-bait-guard', file: 'bash-classifier-bait-guard.js', event: 'PreToolUse', matcher: 'Bash' },
  { id: 'pr-independence', file: 'pr-independence.js', event: 'PreToolUse', matcher: 'Bash' },
  {
    id: 'orchestrator-tool-guard',
    file: 'orchestrator-tool-guard.js',
    event: 'PreToolUse',
    matcher: 'Read|Bash|PowerShell|Write|Edit',
  },
  {
    id: 'agent-permission-preflight',
    file: 'agent-permission-preflight.js',
    event: 'PreToolUse',
    matcher: 'Agent|SendMessage',
  },
  {
    id: 'agent-adversary-floor',
    file: 'agent-adversary-floor.js',
    event: 'PreToolUse',
    matcher: 'Agent|SendMessage',
  },
  {
    id: 'agent-model-routing-guard',
    file: 'agent-model-routing-guard.js',
    event: 'PreToolUse',
    matcher: 'Agent|SendMessage',
  },
  // Second registration of the SAME guard logic, at a different hook
  // event, for the per-agent tier ledger (owner decision D3). Gets its own
  // on-disk filename (a thin shim requiring the shared
  // agent-model-routing-guard.js module) rather than a second GUARDS entry
  // pointed at the identical file — isOurs() below identifies an installed
  // entry purely by which guard *file* its command runs, so two
  // registrations sharing one filename could never be told apart on
  // re-install (see the shim file's own header comment). A third
  // registration, `agent-model-routing-guard-posttooluse.js` on
  // PostToolUse/Agent, existed through PR 2 as an unverified id-capture
  // fallback; live verification on 2026-09-06 showed it never contributed
  // a captured id (see hooks/README.md's "Capture verified" section), so
  // it was removed rather than kept as dead weight.
  {
    id: 'agent-model-routing-guard-subagent-start',
    file: 'agent-model-routing-guard-subagentstart.js',
    event: 'SubagentStart',
    matcher: null,
  },
  // Explicit 30s timeout (10s of margin over this guard's own internal
  // 20s classification deadline — see the guard's own header comment):
  // Claude Code's documented platform default hook timeout is 600s, and a
  // hook killed for exceeding ITS timeout has its output discarded (the
  // harness then treats that the same as an ordinary no-output allow) —
  // an explicit, much shorter registered timeout plus the guard's own
  // internal deadline both exist so a stuck classification pass fails
  // into this guard's own UNKNOWN-block path well before either timeout
  // could turn "stuck" into a silent allow.
  {
    id: 'stop-stale-worktrees-guard',
    file: 'stop-stale-worktrees-guard.js',
    event: 'Stop',
    matcher: null,
    timeout: 30,
  },
];

// Files copied into the destination hooks directory alongside the guards
// above — shared plumbing every guard (or a subset) requires at runtime.
const SUPPORT_FILES = [
  'model-routing-guards.state.js',
  'model-routing-guards.unicode.js',
  'model-routing-guards.log.js',
  'model-routing-guards.exempt.js',
  'model-routing-guards.rules.js',
  'model-routing-guards.paths.js',
  'agent-tier-ledger.js',
];
const SUPPORT_DIRS = ['lib'];

// ─── USAGE ───────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node scripts/install-guards.js [--dry-run] [--yes|-y] [--force] [--non-interactive]
                                       [--hooks-scope user|project|auto]
                                       [--uninstall] [--help|-h]

Copies this repo's hooks/*.js guards (plus hooks/lib/) to ~/.claude/hooks/
and merges their PreToolUse/Stop entries into a Claude Code settings file.
Existing hooks are preserved — this script only adds/re-points/removes its
own guard entries (see hooks/README.md), never anyone else's. Before
overwriting an already-installed hook file whose content differs from the
incoming copy, the old copy is backed up to
~/.claude/hooks/.backup-<ISO timestamp>/ first (byte-identical files are
left alone).

Flags:
  --dry-run          Show what would happen without writing anything; prints
                      a unified diff of the settings file. Never prompts.
  --yes, -y          Skip the interactive confirmation prompt. This is the
                      flag to use for a non-interactive run (CI, an agent
                      shell with no TTY on stdin): it means "I consent to
                      this run", nothing more — backups and every other
                      safety check (backup-before-overwrite, atomic write,
                      JSON validation) still happen exactly as in an
                      interactive run.
  --force            Skip confirmation (same effect as --yes today). Kept
                      for backward compatibility and reserved for a
                      possible future "overwrite despite a safety check"
                      meaning; it is not, and never was, a "skip backups"
                      switch — overwritten hook files are always backed up
                      first regardless of which flag was used to skip the
                      prompt. Prefer --yes when scripting a non-interactive
                      run: it says what it means.
  --non-interactive  Same as --force/--yes (for CI / scripted setups).
  --hooks-scope      user | project | auto (default: auto).
  --uninstall        Remove judge's guard entries (and copied hook files)
                      instead of installing them.
  --help, -h         Print this message and exit.

Non-interactive stdin: if stdin is not a TTY and none of --yes, --force,
--non-interactive, or --dry-run is given, the confirmation prompt could
never be answered. The installer refuses immediately (exit 1) naming --yes,
instead of hanging.
`.trim();

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

function refuse(reason) {
  console.error(`Refusing: ${reason}`);
  process.exit(2);
}

function resolveConfig() {
  const args     = process.argv.slice(2);
  const showHelp = args.includes('--help') || args.includes('-h');
  const dryRun   = args.includes('--dry-run');
  const force    = args.includes('--force') || args.includes('--non-interactive');
  const yes      = args.includes('--yes') || args.includes('-y');
  const uninstall = args.includes('--uninstall');

  if (showHelp) { console.log(USAGE); process.exit(0); }

  const scopeFlagIdx = args.indexOf('--hooks-scope');
  let hooksScopeArg = 'auto';
  if (scopeFlagIdx !== -1) {
    hooksScopeArg = args[scopeFlagIdx + 1];
    if (!['user', 'project', 'auto'].includes(hooksScopeArg)) {
      refuse(`--hooks-scope must be one of: user, project, auto (got ${JSON.stringify(hooksScopeArg)})`);
    }
  }

  const repoRoot = path.resolve(__dirname, '..');
  const srcHooksDir = path.join(repoRoot, 'hooks');
  const destHooksDir = path.join(os.homedir(), '.claude', 'hooks');

  const userSettingsPath    = path.join(os.homedir(), '.claude', 'settings.json');
  const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.local.json');

  if (!fs.existsSync(srcHooksDir)) {
    console.error(`Error: hooks/ not found at:\n  ${srcHooksDir}`);
    process.exit(1);
  }

  return {
    dryRun, force, yes, uninstall, hooksScopeArg,
    repoRoot, srcHooksDir, destHooksDir,
    userSettingsPath, projectSettingsPath,
  };
}

// ─── IDENTITY: normalizeCommand / isOurs ─────────────────────────────────────

/**
 * Normalize a command string for identity comparison only (never written
 * back verbatim). Trims, collapses internal whitespace runs to a single
 * space, converts backslashes to forward slashes, and case-folds ONLY a
 * leading drive-letter prefix wherever one appears at the start of the
 * string, after whitespace, or after a quote.
 */
function normalizeCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  let s = cmd.trim().replace(/\s+/g, ' ').replace(/\\/g, '/');
  s = s.replace(/(^|[\s"'])([A-Za-z]):\//g, (m, pre, d) => `${pre}${d.toLowerCase()}:/`);
  return s;
}

/**
 * Anchored identity pattern: `node`/`node.exe`, then a path token
 * (optionally double-quoted), then end of string — no flags/arguments
 * tolerated after the path. Which guard it belongs to is decided below by
 * an exact "ends with hooks/<guard-file>" check, never a substring match.
 */
const NODE_COMMAND_RE = /^node(?:\.exe)? (?:"((?:[^"\\]|\\.)*)"|(\S+))$/;

/**
 * Return the guard id `rawCommand` belongs to, or null. Exported for tests.
 */
function isOurs(rawCommand) {
  if (typeof rawCommand !== 'string') return null;
  const cmd = normalizeCommand(rawCommand);
  const m = cmd.match(NODE_COMMAND_RE);
  if (!m) return null;
  const pathToken = m[1] !== undefined ? m[1] : m[2];
  if (typeof pathToken !== 'string' || pathToken.length === 0) return null;
  for (const g of GUARDS) {
    const suffix = `hooks/${g.file}`;
    if (pathToken === suffix || pathToken.endsWith(`/${suffix}`)) {
      return { id: g.id };
    }
  }
  return null;
}

// ─── VALIDATION (total classification) ───────────────────────────────────────

function validateHooksSection(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, reason: 'top-level JSON must be an object' };
  }
  if (!('hooks' in settings)) return { ok: true };
  const h = settings.hooks;
  if (h === null || typeof h !== 'object' || Array.isArray(h)) {
    return {
      ok: false,
      reason: `hooks must be an object, got ${h === null ? 'null' : Array.isArray(h) ? 'an array' : typeof h}`,
    };
  }
  for (const event of Object.keys(h)) {
    const arr = h[event];
    if (!Array.isArray(arr)) {
      return {
        ok: false,
        reason: `hooks.${event} must be an array, got ${arr === null ? 'null' : typeof arr}`,
      };
    }
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return {
          ok: false,
          reason: `hooks.${event}[${i}] must be an object, got ${
            entry === null ? 'null' : Array.isArray(entry) ? 'an array' : typeof entry
          }`,
        };
      }
    }
  }
  return { ok: true };
}

// ─── mergeGuardHooks (schema-aware) ──────────────────────────────────────────

/**
 * Scan settings.hooks once (no mutation) and classify every entry.
 * Returns { candidates: { <guardId>: [...] }, unrecognizedShape: [{event,index}] }.
 * Candidate shape: { event, matcher, groupRef, innerRef }.
 */
function scanEntries(hooks) {
  const candidates = {};
  for (const g of GUARDS) candidates[g.id] = [];
  const unrecognizedShape = [];

  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;

    arr.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        unrecognizedShape.push({ event, index });
        return;
      }
      if (Array.isArray(entry.hooks)) {
        const matcher = typeof entry.matcher === 'string' ? entry.matcher : null;
        entry.hooks.forEach((inner) => {
          if (inner && typeof inner === 'object' && typeof inner.command === 'string') {
            const id = isOurs(inner.command);
            if (id) {
              candidates[id.id].push({ event, matcher, groupRef: entry, innerRef: inner });
            }
          }
        });
        return;
      }
      // Not a matcher-wrapped group — this script never writes flat entries
      // and doesn't try to upgrade someone else's; leave it alone unless it
      // happens to be one of ours from an older install, in which case it's
      // still an unrecognized shape for OUR purposes (we don't rewrite it).
      unrecognizedShape.push({ event, index });
    });
  }

  return { candidates, unrecognizedShape };
}

/**
 * Merge (or, with opts.uninstall, remove) judge's guard hooks into an
 * already-validated settings object (mutates settings.hooks in place).
 *
 * opts: { hooksDir: absolute path to the installed hooks/ dir, uninstall }
 *
 * Returns a report: { added:[id], repointed:[id], moved:[{id,from,to}],
 *   deduped:[{id,event}], removed:[id], unrecognizedShape:[{event,index}] }
 */
function mergeGuardHooks(settings, opts) {
  opts = opts || {};
  const hooksDir = opts.hooksDir;
  const uninstall = !!opts.uninstall;

  if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const hooks = settings.hooks;

  const report = { added: [], repointed: [], moved: [], deduped: [], removed: [], unrecognizedShape: [] };
  const { candidates, unrecognizedShape } = scanEntries(hooks);
  report.unrecognizedShape = unrecognizedShape;

  const innerToRemove = new Set();
  const groupsToCheckEmpty = new Set();
  const additions = []; // { event, matcher, command, timeout? }

  for (const g of GUARDS) {
    const list = candidates[g.id];
    const command = `node ${path.join(hooksDir, g.file).replace(/\\/g, '/')}`;
    // `timeout` is an explicit per-guard opt-in (currently only
    // stop-stale-worktrees-guard) — most guards rely on Claude Code's
    // documented 600s platform default and declare nothing here.
    const timeout = typeof g.timeout === 'number' ? g.timeout : undefined;

    if (uninstall) {
      if (list.length > 0) {
        for (const c of list) {
          innerToRemove.add(c.innerRef);
          groupsToCheckEmpty.add(c.groupRef);
        }
        report.removed.push(g.id);
      }
      continue;
    }

    if (list.length === 0) {
      additions.push({ event: g.event, matcher: g.matcher, command, timeout });
      report.added.push(g.id);
      continue;
    }

    // Prefer a candidate already at the right (event, matcher); else the first.
    const keep = list.find((c) => c.event === g.event && c.matcher === g.matcher) || list[0];

    for (const c of list) {
      if (c === keep) continue;
      innerToRemove.add(c.innerRef);
      groupsToCheckEmpty.add(c.groupRef);
      report.deduped.push({ id: g.id, event: c.event });
    }

    if (keep.event === g.event && keep.matcher === g.matcher) {
      let changed = false;
      if (keep.innerRef.command !== command) {
        keep.innerRef.command = command;
        changed = true;
      }
      // Only a guard that actually declares a timeout owns that field on
      // its own entry — never touches/clears a field on a guard that
      // doesn't declare one (no guard currently sets one by hand, but this
      // keeps a future manual edit for an undeclared guard untouched).
      if (timeout !== undefined && keep.innerRef.timeout !== timeout) {
        keep.innerRef.timeout = timeout;
        changed = true;
      }
      if (changed) report.repointed.push(g.id);
      continue;
    }

    // keep lives at the wrong (event, matcher) — move it.
    innerToRemove.add(keep.innerRef);
    groupsToCheckEmpty.add(keep.groupRef);
    additions.push({ event: g.event, matcher: g.matcher, command, timeout });
    report.moved.push({ id: g.id, from: keep.event, to: g.event });
  }

  // Apply removals: drop inner hooks, then any group left with an empty
  // hooks[] array.
  for (const groupRef of groupsToCheckEmpty) {
    groupRef.hooks = groupRef.hooks.filter((inner) => !innerToRemove.has(inner));
  }
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((entry) => {
      if (Array.isArray(entry.hooks) && groupsToCheckEmpty.has(entry) && entry.hooks.length === 0) {
        return false;
      }
      return true;
    });
  }

  // Apply additions: find an existing group at (event, matcher) to append
  // to, else create a new group.
  for (const add of additions) {
    if (!Array.isArray(hooks[add.event])) hooks[add.event] = [];
    const target = hooks[add.event].find((entry) => {
      if (!Array.isArray(entry.hooks)) return false;
      const entryMatcher = typeof entry.matcher === 'string' ? entry.matcher : null;
      return entryMatcher === add.matcher;
    });
    const newInner = { type: 'command', command: add.command };
    if (add.timeout !== undefined) newInner.timeout = add.timeout;
    if (target) {
      target.hooks.push(newInner);
    } else {
      const newGroup = { hooks: [newInner] };
      if (add.matcher !== null) newGroup.matcher = add.matcher;
      hooks[add.event].push(newGroup);
    }
  }

  return report;
}

// ─── FILE I/O HELPERS ────────────────────────────────────────────────────────

function detectIndent(text) {
  const lines = text.split(/\r\n|\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const m = lines[i].match(/^(\t+| +)/);
    if (m) return m[1][0] === '\t' ? '\t' : ' '.repeat(m[1].length);
  }
  return '  ';
}

function readSettingsFileOrRefuse(filePath) {
  if (!fs.existsSync(filePath)) {
    return { settings: {}, existed: false, hadBOM: false, eol: '\n', indent: '  ', raw: null, jsonTextLF: null };
  }
  const buf = fs.readFileSync(filePath);
  const hadBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const raw = buf.toString('utf8');
  const jsonText = hadBOM ? raw.slice(1) : raw;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    refuse(`${filePath} is not valid JSON (${e.message}). Fix the file by hand, then re-run.`);
  }

  const validation = validateHooksSection(parsed);
  if (!validation.ok) {
    refuse(`${filePath}: ${validation.reason}`);
  }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = detectIndent(jsonText);
  const jsonTextLF = jsonText.replace(/\r\n/g, '\n');
  return { settings: parsed, existed: true, hadBOM, eol, indent, raw, jsonTextLF };
}

function detectOursPresent(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const buf = fs.readFileSync(filePath);
    const hadBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const raw = buf.toString('utf8');
    const parsed = JSON.parse(hadBOM ? raw.slice(1) : raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.hooks || typeof parsed.hooks !== 'object') return false;
    for (const event of Object.keys(parsed.hooks)) {
      const arr = parsed.hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
        for (const inner of entry.hooks) {
          if (inner && typeof inner.command === 'string' && isOurs(inner.command)) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', l: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', l: a[i] });
      i++;
    } else {
      ops.push({ t: '+', l: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ t: '-', l: a[i] }); i++; }
  while (j < m) { ops.push({ t: '+', l: b[j] }); j++; }
  return ops;
}

function reconcileFormatting(originalText, naiveText) {
  const a = originalText.split('\n');
  const b = naiveText.split('\n');
  const ops = diffLines(a, b);
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.t === ' ') { out.push(op.l); continue; }
    if (op.t === '-') {
      const next = ops[k + 1];
      if (next && next.t === '+' && next.l.trim() === op.l.trim()) {
        out.push(op.l);
        k++;
        continue;
      }
      continue;
    }
    out.push(op.l);
  }
  return out.join('\n');
}

function serializeSettings(settings, { indent, eol, hadBOM, originalJsonText }) {
  let jsonText = JSON.stringify(settings, null, indent) + '\n';
  if (typeof originalJsonText === 'string') {
    jsonText = reconcileFormatting(originalJsonText, jsonText);
  }
  let text = jsonText;
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (hadBOM) text = '﻿' + text;
  return text;
}

function unifiedDiff(beforeText, afterText, label) {
  const ops = diffLines(beforeText.split('\n'), afterText.split('\n'));
  if (ops.every((o) => o.t === ' ')) return '';

  const CONTEXT = 3;
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue; }
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    while (end < ops.length) {
      if (ops[end].t !== ' ') { end++; continue; }
      let run = 0;
      let p = end;
      while (p < ops.length && ops[p].t === ' ') { run++; p++; }
      if (run > CONTEXT * 2 || p >= ops.length) { end += Math.min(run, CONTEXT); break; }
      end = p;
    }
    const hunk = ops.slice(start, end);
    let oldStart = 1;
    let newStart = 1;
    for (let q = 0; q < start; q++) {
      if (ops[q].t !== '+') oldStart++;
      if (ops[q].t !== '-') newStart++;
    }
    const oldCount = hunk.filter((o) => o.t !== '+').length;
    const newCount = hunk.filter((o) => o.t !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of hunk) lines.push(`${o.t}${o.l}`);
    k = end;
  }
  return lines.join('\n') + '\n';
}

async function confirm(question) {
  const { createInterface } = require('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (Y/n): `);
  rl.close();
  const t = answer.trim().toLowerCase();
  return t === '' || t === 'y';
}

function makeBackupPath(targetSettingsPath, ts) {
  const stamp = ts || new Date().toISOString().replace(/:/g, '-');
  let backupPath = `${targetSettingsPath}.bak-${stamp}`;
  let n = 2;
  while (fs.existsSync(backupPath)) {
    backupPath = `${targetSettingsPath}.bak-${stamp}-${n}`;
    n++;
  }
  return backupPath;
}

// ─── BACKUP OF OVERWRITTEN HOOK FILES ────────────────────────────────────────

/**
 * Every relative path (relative to hooksDir) this installer will write on a
 * normal (non-uninstall) run: each GUARDS file, each SUPPORT_FILES entry
 * that exists in srcHooksDir, and every file found directly inside each
 * SUPPORT_DIRS subdirectory. This is also the exact set eligible for
 * backup — the installer never backs up, or otherwise touches, any file
 * outside it.
 */
function collectManagedRelPaths(srcHooksDir) {
  const relPaths = [];
  for (const g of GUARDS) relPaths.push(g.file);
  for (const f of SUPPORT_FILES) {
    if (fs.existsSync(path.join(srcHooksDir, f))) relPaths.push(f);
  }
  for (const d of SUPPORT_DIRS) {
    const srcDir = path.join(srcHooksDir, d);
    if (!fs.existsSync(srcDir)) continue;
    for (const f of fs.readdirSync(srcDir)) {
      relPaths.push(path.join(d, f));
    }
  }
  return relPaths;
}

/**
 * True only when destPath exists AND its bytes differ from srcPath's. A
 * missing dest (fresh install of that file) or byte-identical dest are both
 * "no backup needed" — this function never mutates either path.
 */
function filesDiffer(srcPath, destPath) {
  if (!fs.existsSync(destPath)) return false;
  if (!fs.existsSync(srcPath)) return false;
  const a = fs.readFileSync(srcPath);
  const b = fs.readFileSync(destPath);
  return !a.equals(b);
}

/**
 * Read-only plan: which of the installer-managed relative paths (see
 * collectManagedRelPaths) already exist in destHooksDir with DIFFERENT
 * content than the incoming src copy. Never writes anything — safe to call
 * from --dry-run. Returns the list of differing relative paths (identical
 * or not-yet-present files are excluded).
 */
function planBackups(srcHooksDir, destHooksDir) {
  const relPaths = collectManagedRelPaths(srcHooksDir);
  const toBackup = [];
  for (const rel of relPaths) {
    if (filesDiffer(path.join(srcHooksDir, rel), path.join(destHooksDir, rel))) {
      toBackup.push(rel);
    }
  }
  return toBackup;
}

/**
 * Copy each of `relPaths` (as they currently stand in destHooksDir, i.e.
 * BEFORE this run's overwrite) into a fresh `.backup-<ISO timestamp>/`
 * subdirectory of destHooksDir, mirroring each file's relative path.
 * Callers must only ever pass relPaths produced by planBackups(), so this
 * never touches a file the installer doesn't manage. Returns the backup
 * directory's absolute path. Only called when relPaths is non-empty.
 */
function backupDiffering(destHooksDir, relPaths, ts) {
  const stamp = ts || new Date().toISOString().replace(/:/g, '-');
  const backupDir = path.join(destHooksDir, `.backup-${stamp}`);
  for (const rel of relPaths) {
    const destSrc = path.join(destHooksDir, rel);
    const destBackup = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(destBackup), { recursive: true });
    fs.copyFileSync(destSrc, destBackup);
  }
  return backupDir;
}

function printReport(report) {
  console.log(`    added:      ${report.added.length}`);
  console.log(`    repointed:  ${report.repointed.length}`);
  console.log(`    moved:      ${report.moved.length}`);
  console.log(`    deduped:    ${report.deduped.length}`);
  console.log(`    removed:    ${report.removed.length}`);
  if (report.unrecognizedShape.length > 0) {
    console.log(`    unrecognized_shape: ${report.unrecognizedShape.length}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main(cfg) {
  const {
    dryRun, force, yes, uninstall, hooksScopeArg,
    srcHooksDir, destHooksDir,
    userSettingsPath, projectSettingsPath,
  } = cfg;

  let scope = hooksScopeArg;
  if (scope === 'auto') {
    scope = detectOursPresent(userSettingsPath) ? 'user' : detectOursPresent(projectSettingsPath) ? 'project' : 'user';
  }
  const targetSettingsPath = scope === 'user' ? userSettingsPath : projectSettingsPath;
  const settingsExists = fs.existsSync(targetSettingsPath);

  console.log('\njudge installer');
  if (dryRun) console.log('(dry-run — nothing will be written)');
  console.log('');
  console.log(uninstall ? `  Remove judge's guards from ${destHooksDir}` : `  Copy ${GUARDS.length} guard(s) + support files to ${destHooksDir}`);
  console.log(`  Hooks scope: ${scope} → ${targetSettingsPath}`);
  console.log('');

  if (!dryRun && !force && !yes) {
    if (!process.stdin.isTTY) {
      console.error(
        'Refusing: stdin is not a TTY, so the interactive confirmation prompt ' +
        'could never be answered (this would otherwise hang forever).\n' +
        'Pass --yes (or -y) to skip the confirmation prompt for a ' +
        'non-interactive run (CI, an agent shell), or --dry-run to preview ' +
        'without writing anything.'
      );
      process.exit(1);
    }
    const ok = await confirm(
      uninstall
        ? `About to remove judge's guard entries from ${targetSettingsPath} and delete copied hook files from ${destHooksDir}.\nContinue?`
        : `About to copy judge's guards to ${destHooksDir} and wire hooks into ${targetSettingsPath}.\nContinue?`
    );
    if (!ok) {
      console.log('Aborted.');
      process.exit(1);
    }
    console.log('');
  }

  const { settings: readSettings, hadBOM, eol, indent, raw, jsonTextLF } = readSettingsFileOrRefuse(targetSettingsPath);

  if (dryRun) {
    const clone = raw !== null ? JSON.parse(hadBOM ? raw.slice(1) : raw) : {};
    const report = mergeGuardHooks(clone, { hooksDir: destHooksDir, uninstall });
    const beforeText = raw !== null ? raw : '';
    const afterText = serializeSettings(clone, { indent, eol, hadBOM, originalJsonText: jsonTextLF });

    console.log(`  Hooks (would ${settingsExists ? 'merge into' : 'create'} ${targetSettingsPath}):`);
    printReport(report);
    console.log('');
    if (!uninstall) {
      const toBackup = planBackups(srcHooksDir, destHooksDir);
      console.log(`  Files (would copy to ${destHooksDir}):`);
      console.log(`    would back up ${toBackup.length} differing file(s)`);
      console.log('');
    }
    const diff = unifiedDiff(beforeText, afterText, path.basename(targetSettingsPath));
    console.log(diff ? `  Diff:\n${diff.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}` : '  Diff: (no changes)');
    console.log('\nDry-run complete. Re-run without --dry-run to apply.\n');
    return;
  }

  if (uninstall) {
    for (const g of GUARDS) {
      const dest = path.join(destHooksDir, g.file);
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    }
  } else {
    fs.mkdirSync(destHooksDir, { recursive: true });
    const toBackup = planBackups(srcHooksDir, destHooksDir);
    if (toBackup.length > 0) {
      const backupFilesDir = backupDiffering(destHooksDir, toBackup);
      console.log(`  Backed up ${toBackup.length} differing file(s) to ${backupFilesDir}`);
    }
    for (const g of GUARDS) {
      fs.copyFileSync(path.join(srcHooksDir, g.file), path.join(destHooksDir, g.file));
    }
    for (const f of SUPPORT_FILES) {
      const src = path.join(srcHooksDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destHooksDir, f));
    }
    for (const d of SUPPORT_DIRS) {
      const srcDir = path.join(srcHooksDir, d);
      if (!fs.existsSync(srcDir)) continue;
      const destDir = path.join(destHooksDir, d);
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
      }
    }
  }

  fs.mkdirSync(path.dirname(targetSettingsPath), { recursive: true });

  const report = mergeGuardHooks(readSettings, { hooksDir: destHooksDir, uninstall });
  const outText = serializeSettings(readSettings, { indent, eol, hadBOM, originalJsonText: jsonTextLF });
  const noop = settingsExists && outText === raw;

  let backupPath = null;
  if (!noop) {
    if (settingsExists) {
      backupPath = makeBackupPath(targetSettingsPath);
      fs.copyFileSync(targetSettingsPath, backupPath);
    }
    const tmpPath = `${targetSettingsPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, outText, 'utf8');
    fs.renameSync(tmpPath, targetSettingsPath);
  }

  console.log(`  Hooks (${settingsExists ? 'merged into' : 'created'} ${targetSettingsPath}):`);
  if (noop) {
    console.log('    no changes; nothing written.');
  } else {
    if (backupPath) console.log(`  Backup: ${backupPath}`);
    printReport(report);
  }
  console.log('\nDone. Restart Claude Code or open a fresh session to pick up the changes.\n');
}

if (require.main === module) {
  const cfg = resolveConfig();
  main(cfg).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  GUARDS,
  mergeGuardHooks,
  isOurs,
  normalizeCommand,
  validateHooksSection,
  detectIndent,
  detectOursPresent,
  serializeSettings,
  unifiedDiff,
  scanEntries,
  diffLines,
  reconcileFormatting,
  makeBackupPath,
  collectManagedRelPaths,
  filesDiffer,
  planBackups,
  backupDiffering,
};

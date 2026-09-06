"use strict";
// shell-write-guard.js
// PreToolUse hook — gates shell-executed writes to a GATED extension
// (config: .ps1/.psm1/.psd1 by default) so those writes get routed through
// the Edit/Write tool's PostToolUse linter instead of silently bypassing it
// via Bash/PowerShell.
//
// NOT WIRED into settings.json by this change — wiring is a separate step
// after independent review (PR/merge-independence rule).
//
// Matcher scope: Bash | PowerShell. Both tools carry the command string at
// tool_input.command. Owner-run `!` commands are in scope too — there is no
// distinct tool_name for those, so they arrive here as ordinary Bash calls.
//
// ── TOTAL CLASSIFICATION (every command lands in exactly one branch) ───────
//   1. no write detected                                   -> allow
//   2. write detected, resolved target extension NOT gated -> allow
//   3. write detected, resolved target extension IS gated  -> BLOCK
//   4. write-shaped but target is unresolvable/ambiguous   -> BLOCK
// A write verb whose target we cannot classify is branch 4, never silently
// branch 1 — see resolveTarget/classifyExtension below.
//
// ── Detector -> branch table (see report for the full worked table) ────────
//   redirect >,>> ; tee ; sed -i ; cp/mv/install ; dd of= ; truncate ; rsync ;
//   ln -sf ; curl -o/-O ; wget -O ; tar -x* ; unzip -o ; rename ; perl -i/-pi ;
//   ex/vim -c wq ; node|python|pwsh|powershell -e/-c/-Command bodies with a
//   write API ; heredoc-fed interpreter with a write API in its body ;
//   git checkout --/restore/apply/stash pop|apply/reset --hard <pathspec> ;
//   cmd /c indirection (gated ext anywhere in body + a write verb) ;
//   PowerShell-tool cmdlets (Set-Content/Out-File/Add-Content/Copy-Item/
//   Move-Item/Rename-Item/New-Item/[IO.File]::Write*/WriteAllText/sc) and
//   `| Out-File`/`| Set-Content`/`>` at the top level of a PowerShell command.
//
// Explicitly ALLOWED (branch 1), never flagged: git mv (tracked rename);
// bare script invocation (node x.js, pwsh -File x.ps1, python x.py) with no
// inline -e/-c/-Command body; reads (cat, grep, Get-Content, Select-String,
// Invoke-ScriptAnalyzer -Path); a gated extension appearing only as a
// read/exec argument; git add/commit/diff/status. None of these match ANY
// detector below, so they fall through to branch 1 by construction — this
// hook is a positive-detection design (find a write signal), not a deny/
// allow-list, so "explicitly allowed" here is a precision guarantee to test
// against, not a separate code path.
//
// Override: a command whose RAW string starts (position 0, no leading
// whitespace tolerated) with the LITERAL `SHELL_WRITE_OK=1` followed by a
// space is allowed unconditionally, and the override is logged with the
// full command. Bug fix (independent-review gap 2): any other value
// (`SHELL_WRITE_OK=0`, `=true`, `=yes`, `=""`, `=1foo` with no separating
// whitespace) is NOT an override — the token is then just an ordinary
// VAR=value env-prefix that findPrimaryVerbIndex strips before verb
// classification proceeds normally, since a prior looser regex
// (`SHELL_WRITE_OK=\S+\s`) accepted ANY non-space value as a full bypass.
// The anchor is index-0 of the whole string, so it can never be satisfied
// by content inside a quote, a heredoc body, or mid-command — those all
// start at a later string offset. The `=1 ` form is a valid POSIX env-var-
// assignment prefix so the shell itself accepts the line unmodified (hooks
// cannot rewrite/strip the command before exec).
//
// ── Reuse provenance ─────────────────────────────────────────────────────
// tokenize/splitSegments: required directly from bash-classifier-bait-guard.js
// (exported). COMMAND_POSITION_WORDS/isSep/isCommandPosition are module-
// private there (not exported) — copied verbatim from
// bash-classifier-bait-guard.js line 148 (COMMAND_POSITION_WORDS), line 140
// (isSep), lines 158-164 (isCommandPosition).
// normalizeForCompare/computeSegmentCwds: required directly from
// worktree-isolation-guard.js (exported) — used for cd-aware relative-target
// resolution and case/slash-insensitive path comparison.
// extractBashWriteTargets from worktree-isolation-guard.js is DELIBERATELY
// NOT reused for extraction: it silently DROPS an ambiguous token (var/glob)
// rather than reporting it, and does not tag which verb produced a target
// (needed here for the cp/mv/install directory-destination join rule). This
// hook's spec requires an ambiguous target to BLOCK (branch 4), not vanish —
// a materially different contract, not a stylistic reimplementation — so
// this file re-derives per-verb target extraction using the SAME tokenizer
// (tokenize()) rather than duplicating that function's internals.
//
// ── Declared blind spots (do not attempt to silently "fix" — see report) ──
//   - bare-script (node x.js) internals are never inspected.
//   - cmd.exe's real grammar is not parsed; the cmd /c check is a documented
//     coarse co-occurrence heuristic (gated ext anywhere in the body + a
//     write verb), not a parser.
//   - writes performed by any tool OTHER than Bash/PowerShell (Write/Edit
//     itself, an MCP tool, a background process) are invisible to this hook.
//   - PowerShell branch does not track Set-Location/cd — relative targets
//     resolve only against the hook-input cwd, never a mid-script cd.
//   - inline-body (-e/-c/-Command) target extraction is a best-effort quoted-
//     literal-with-known-extension scan, not a parser of the target
//     language; most inline bodies with a write API and no such literal
//     resolve to branch 4 (unresolvable), which is the safe default.
//   - stderr redirects (`2>`, `&>`) are excluded from write-target detection
//     entirely (matches worktree-isolation-guard.js's own convention) — a
//     `2>real-file.ps1` capturing stderr into a gated-extension file is not
//     detected. Inherited blind spot, not introduced here.
//
// ── Independent-review patch (D1-D5) ────────────────────────────────────────
// D1 TOTAL VERB CLASSIFICATION (was an allow-list — FIXED): every Bash verb
//   token now lands in exactly one of three buckets, checked in this order:
//   (i) KNOWN-READ-ONLY (KNOWN_READ_VERBS / isKnownReadVerb) -> branch 1
//   regardless of arguments; (ii) KNOWN-WRITE (KNOWN_WRITE_VERBS /
//   dispatchKnownWrite) -> existing per-verb target resolution -> 2/3/4;
//   (iii)/(iv) ANY OTHER verb (catchAllUnknownVerb) -> branch 4 if ANY of its
//   arguments is ambiguous or resolves to a gated extension (naming the
//   unknown verb), else branch 1. (iii) is the friction-over-escape default:
//   an unrecognized verb with a gated-looking argument blocks rather than
//   silently allowing (this is what closes xcopy/robocopy/7z/unknown
//   aliases). PowerShell aliases (copy/cp/mv/move/ren/sc/ac/ni/rni/mi/cpi)
//   were added to the KNOWN-WRITE set (both the Bash dispatcher, defensively,
//   and analyzePowerShell's own alias table) so they get real target
//   resolution instead of either escaping or blanket-blocking.
// D2 find -exec placeholder + -name gating (FIXED): "{}"/"{}+" are now
//   unconditionally ambiguous tokens (isAmbiguousToken), so a write verb
//   dispatched via -exec with an unresolved placeholder target blocks
//   (branch 4). Independently, checkFindNamePattern flags find's own
//   -name/-iname pattern when it names a gated extension, regardless of
//   what (if anything) is -exec'd.
// D3 stderr/clobber redirects (FIXED): detectStderrClobberRedirects treats
//   `2>`, `2>>`, `&>`, `>|` onto a resolvable target as a write (both tools).
//   `2>&1`/`1>&2` (fd duplication) and `2>/dev/null` / `>$null` remain
//   non-writes.
// D4 logging (FIXED): this file's own rotate/append helpers were replaced
//   with appendRotating/createLogger from ./model-routing-guards.log.js
//   (the shared convention every sibling hook now uses).
// D5 PowerShell false positives (FIXED): blankPsQuotesForScan strips
//   single/double-quoted CONTENT (keeping delimiters) before the cmdlet/
//   alias/-WhatIf scan, so a cmdlet name mentioned only inside a quoted
//   string (Write-Host "Run Set-Content ...") is not a detector hit; target
//   EXTRACTION still runs against the original unblanked command text.
//   -WhatIf anywhere in the (quote-stripped) command short-circuits the
//   whole command to branch 1 (simulate-only, no real write).

const fs = require("fs");
const path = require("path");

// This guard's own install directory. __dirname resolves correctly both in
// an installed ~/.claude/hooks tree and when running the tests straight out
// of this repository's hooks/ directory — no owner-specific path baked in.
const HOOKS_DIR = __dirname;
const CONFIG_PATH = path.join(HOOKS_DIR, "shell-write-guard.config.json");

const DEFAULT_GATED_EXTENSIONS = [".ps1", ".psm1", ".psd1"];

function loadConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath || CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.gatedExtensions) && parsed.gatedExtensions.length > 0) {
      return parsed.gatedExtensions.map((e) => String(e).toLowerCase());
    }
  } catch (_) {
    // Missing/malformed config -> safe default, never fail open to "no gating".
  }
  return DEFAULT_GATED_EXTENSIONS.slice();
}

// ── Reused: bash-classifier-bait-guard.js ──────────────────────────────────
const {
  tokenize,
  splitSegments,
} = require(path.join(HOOKS_DIR, "bash-classifier-bait-guard.js"));

// Copied verbatim from bash-classifier-bait-guard.js (not exported there).
// Source: bash-classifier-bait-guard.js line 148.
const COMMAND_POSITION_WORDS = ["do", "then", "(", "{", "xargs", "-exec", "-execdir"];
// Source: bash-classifier-bait-guard.js line 140.
function isSep(t) { return !!t.sep; }
// Source: bash-classifier-bait-guard.js lines 158-164.
function isCommandPosition(tokens, i) {
  if (i === 0) return true;
  const prev = tokens[i - 1];
  if (isSep(prev)) return true;
  if (!prev.quoted && COMMAND_POSITION_WORDS.includes(prev.value)) return true;
  return false;
}
void isCommandPosition; // retained for parity with the source module; used indirectly via findPrimaryVerbIndex's own wrapper-skip walk below.

// ── Reused: worktree-isolation-guard.js ────────────────────────────────────
const {
  normalizeForCompare,
  computeSegmentCwds,
} = require(path.join(HOOKS_DIR, "worktree-isolation-guard.js"));

// ── Logging (D4: shared helper, matches every sibling hook) ────────────────
const { createLogger } = require(path.join(HOOKS_DIR, "model-routing-guards.log.js"));
const appendDebug = createLogger("shell-write-guard");

// ── Ambiguity / extension classification ───────────────────────────────────

function isAmbiguousToken(tok) {
  if (tok == null || tok === "") return true;
  if (tok === "{}" || tok === "{}+") return true; // find's -exec placeholder (D2) — never a real intended filename
  if (/\$/.test(tok)) return true;      // $VAR, ${...}, $(...)
  if (/`/.test(tok)) return true;       // `...`
  if (/[*?[\]]/.test(tok)) return true; // globs: * ? [ ]
  // Self-found escape, fixed: PowerShell splatting (`Set-Content @p`) passes
  // parameters via a hashtable/array variable — the literal token is just
  // "@p", which otherwise resolves to a harmless-looking non-gated
  // "extension" while the REAL target lives in the variable, invisible to
  // any text-based extraction. Any token beginning with `@` is ambiguous,
  // shared across both Bash and PowerShell resolution (same rationale as
  // the `$` check above: friction over silent escape).
  if (/^@/.test(tok)) return true;
  return false;
}

/**
 * classifyExtension(basename, gatedExts) -> { branch, ext, reason? }
 * Extension = text after the FINAL dot of the basename only. A multi-dot
 * basename whose FIRST extension segment is gated (x.ps1.bak), or a single-
 * extension basename whose extension segment merely STARTS WITH a gated
 * name but isn't exactly equal to it (x.ps1~), is branch 4 — not silently
 * allowed just because the literal final/only segment doesn't exactly match.
 */
function classifyExtension(basename, gatedExts) {
  const gatedNoDot = gatedExts.map((e) => String(e).replace(/^\./, "").toLowerCase());
  const firstDot = basename.indexOf(".");
  if (firstDot === -1) return { branch: 2, ext: null };
  const extPart = basename.slice(firstDot + 1);
  const segs = extPart.split(".");
  if (segs.length === 1) {
    if (gatedNoDot.includes(segs[0])) return { branch: 3, ext: "." + segs[0] };
    for (const g of gatedNoDot) {
      if (segs[0] !== g && segs[0].startsWith(g)) {
        return { branch: 4, ext: "." + segs[0], reason: "trailing-suffix-evasion" };
      }
    }
    return { branch: 2, ext: "." + segs[0] };
  }
  // 2+ extension segments.
  if (gatedNoDot.includes(segs[0])) {
    return { branch: 4, ext: "." + segs.join("."), reason: "multi-dot-first-segment-gated" };
  }
  const finalSeg = segs[segs.length - 1];
  if (gatedNoDot.includes(finalSeg)) return { branch: 3, ext: "." + finalSeg };
  return { branch: 2, ext: "." + finalSeg };
}

/**
 * resolveTarget(rawTarget, cwd, gatedExts) -> { branch, ext, target, reason }
 * `cwd` may be a real absolute-path string, null/undefined (no cwd known),
 * or the INDETERMINATE symbol produced by worktree-isolation-guard.js's
 * computeSegmentCwds (detected here via typeof === "symbol" since that
 * module does not export the sentinel itself — it is a module-scoped
 * singleton, so identity-by-type is sufficient without importing it).
 */
function resolveTarget(rawTarget, cwd, gatedExts) {
  if (isAmbiguousToken(rawTarget)) {
    return { branch: 4, reason: "ambiguous-target-token", target: rawTarget || null };
  }
  let abs;
  if (path.isAbsolute(rawTarget)) {
    abs = rawTarget;
  } else {
    if (!cwd || typeof cwd === "symbol") {
      return { branch: 4, reason: "indeterminate-cwd", target: rawTarget };
    }
    abs = path.resolve(cwd, rawTarget);
  }
  let normalized;
  try { normalized = normalizeForCompare(abs); } catch (_) { normalized = null; }
  if (!normalized) return { branch: 4, reason: "path-resolve-failed", target: rawTarget };
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const cls = classifyExtension(basename, gatedExts);
  return {
    branch: cls.branch,
    ext: cls.ext,
    target: normalized,
    reason: cls.reason || (cls.branch === 3 ? "gated-extension" : cls.branch === 2 ? "not-gated" : undefined),
  };
}

function tagDetector(result, detectorLabel) {
  if (!result) return null;
  return { branch: result.branch, detector: detectorLabel, target: result.target, reason: result.reason, ext: result.ext };
}

function pickWorst(results, detectorLabel) {
  let worst = null;
  for (const r of results) {
    if (!r) continue;
    if (!worst || r.branch > worst.branch) worst = r;
  }
  if (!worst) return null;
  return { branch: worst.branch, detector: detectorLabel, target: worst.target, reason: worst.reason, ext: worst.ext };
}

// ── cp/mv/install directory-destination join rule ──────────────────────────

/**
 * isDirLikeDest(destRaw, cwd) -> boolean
 * Per spec item 5: trailing slash OR no extension in the dest basename is
 * dir-like. ADVERSARY-FOUND ADDITION: a real on-disk directory whose NAME
 * happens to contain a dot (e.g. `conf.d`, `versions.d`) has an "extension"
 * lexically but is still a directory at the filesystem level — `cp x.ps1
 * conf.d` really writes `conf.d/x.ps1`. A lexical-only check missed this and
 * silently allowed it (adversary finding — fixed here) by additionally
 * consulting fs.statSync when the (non-ambiguous) target resolves to an
 * EXISTING path. Never treated as an error to fail open on: any stat
 * failure (doesn't exist, permission error) just falls back to the lexical
 * heuristic.
 */
function isDirLikeDest(destRaw, cwd) {
  if (/[/\\]$/.test(destRaw)) return true; // trailing slash
  const trimmed = destRaw.replace(/[/\\]+$/, "");
  const bn = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  if (bn.indexOf(".") === -1) return true; // no extension in dest basename
  if (!isAmbiguousToken(destRaw)) {
    try {
      const abs = path.isAbsolute(destRaw) ? destRaw : (cwd && typeof cwd !== "symbol" ? path.resolve(cwd, destRaw) : null);
      if (abs && fs.statSync(abs).isDirectory()) return true;
    } catch (_) {
      // Doesn't exist / stat failed — fall back to the lexical heuristic result (false) below.
    }
  }
  return false;
}
function joinDirDest(destRaw, sourceRaw) {
  const destClean = destRaw.replace(/[/\\]+$/, "");
  const srcClean = sourceRaw.replace(/[/\\]+$/, "");
  const srcBn = srcClean.slice(Math.max(srcClean.lastIndexOf("/"), srcClean.lastIndexOf("\\")) + 1);
  return destClean + "/" + srcBn;
}

// ── Verb-position discovery ─────────────────────────────────────────────────

/**
 * Returns the index of the effective "verb" token in `stage` (a token array
 * for one simple-command stage), after skipping any sudo/env wrapper and its
 * flags/VAR=val assignments (bash-classifier-bait-guard.js's own
 * COMMAND_POSITION_WORDS does not model sudo/env at all — this hook's spec
 * explicitly requires them). Returns -1 ONLY when no verb token exists at
 * all (empty stage or a wrapper chain with nothing after it).
 *
 * Bug fix (independent-review gap 3): this used to `return -1` the instant
 * ANY scanned token — including the eventual verb token itself — was
 * quoted, and analyzeStage treated -1 as "no verb, allow" (branch 1). Real
 * shell semantics: quoting a word only suppresses alias/keyword expansion,
 * it does not stop the word from being executed as a command — `"cp" a
 * b`/`'cp' a b` still runs cp. That made a quoted verb an unconditional
 * classification bypass (`"cp" a.txt out.ps1` silently allowed a real gated
 * write). Quoted-ness of the verb token is no longer disqualifying here;
 * classifyVerbToken (below) is what decides whether a quoted verb's
 * DEQUOTED value can even name a single command (no whitespace/metachars)
 * before treating it as that command's normal classification path.
 */
// sudo/env flags that consume the FOLLOWING token as their own argument
// (e.g. `sudo -u root cp ...`) — without this, the walk below would treat
// the flag's argument ("root") as if it were the verb itself.
const WRAPPER_FLAGS_WITH_ARG = new Set([
  "-u", "--user", "-g", "--group", "-h", "--host", "-r", "--role",
  "-t", "--type", "-C", "--close-from", "-p", "--prompt",
  "-d", "--distribution", // wsl's distro-select flag (final round)
]);

function findPrimaryVerbIndex(stage) {
  let j = 0;
  let inWrapper = false;
  while (j < stage.length) {
    const t = stage[j];
    if (t.value === "sudo" || t.value === "env" || t.value === "wsl") { inWrapper = true; j++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(t.value)) { inWrapper = true; j++; continue; } // VAR=val prefix (env or bare)
    if (inWrapper && WRAPPER_FLAGS_WITH_ARG.has(t.value) && j + 1 < stage.length) { j += 2; continue; }
    // "--" (wsl's own-args/command separator) falls through here too, since
    // it starts with "-" — no special case needed.
    if (inWrapper && /^-/.test(t.value)) { j++; continue; } // sudo/env's own no-arg flags (-i, -E, ...)
    break;
  }
  return j < stage.length ? j : -1;
}

/**
 * Gap 3 total classification: does `value` (a token's DEQUOTED string)
 * qualify as a single, ordinary command name? Whitespace means the quoted
 * token was really multiple shell words glued together (`'gh api'`) — no
 * single command can have a space in its name. Any of `;|&<>$()` backtick
 * or a glob char (`*?[]`) means the string cannot be a literal executable
 * name either (it names a shell construct, expansion, or pattern instead).
 * Used ONLY to gate a QUOTED verb token — an unquoted verb token can never
 * contain these by construction (tokenize() splits on them as separators
 * when they are not inside quotes).
 */
const VERB_METACHAR_RE = /[;|&<>$()`*?[\]]/;
function isValidBareVerbToken(value) {
  if (typeof value !== "string" || value === "") return false;
  if (/\s/.test(value)) return false;
  if (VERB_METACHAR_RE.test(value)) return false;
  return true;
}

function parsePositionalsAfterVerb(stage, verbIdx, flagsWithArg) {
  const positionals = [];
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && t.value.startsWith("-")) {
      if (flagsWithArg.has(t.value) && i + 1 < stage.length) { i += 2; continue; }
      i++; continue;
    }
    positionals.push(t.value);
    i++;
  }
  return positionals;
}

// ── Per-verb handlers ────────────────────────────────────────────────────

function handleCpMvInstall(stage, verbIdx, verb, cwd, gatedExts) {
  const flagsWithArg = new Set(["-t", "--target-directory", "-S", "--suffix", "-o", "-g", "-m", "-M", "--owner", "--group", "--mode"]);
  const positionals = parsePositionalsAfterVerb(stage, verbIdx, flagsWithArg);
  if (positionals.length === 0) return null;
  if (positionals.length === 1) {
    return tagDetector(resolveTarget(positionals[0], cwd, gatedExts), verb);
  }
  const destRaw = positionals[positionals.length - 1];
  const sources = positionals.slice(0, positionals.length - 1);
  if (isDirLikeDest(destRaw, cwd)) {
    const results = sources.map((src) => {
      if (isAmbiguousToken(src)) return { branch: 4, reason: "ambiguous-source-for-dir-join", target: src };
      return resolveTarget(joinDirDest(destRaw, src), cwd, gatedExts);
    });
    return pickWorst(results, verb + " (dir-dest join)");
  }
  return tagDetector(resolveTarget(destRaw, cwd, gatedExts), verb);
}

function handleTee(stage, verbIdx, cwd, gatedExts) {
  const files = [];
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-a" || t.value === "--append")) { i++; continue; }
    if (!t.quoted && t.value.startsWith("-")) { i++; continue; }
    files.push(t.value); i++;
  }
  if (files.length === 0) return null;
  return pickWorst(files.map((f) => resolveTarget(f, cwd, gatedExts)), "tee");
}

function handleSed(stage, verbIdx, cwd, gatedExts) {
  let i = verbIdx + 1;
  let hasI = false;
  let scriptConsumed = false;
  const files = [];
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-e" || t.value === "-f")) { i += 2; continue; }
    if (!t.quoted && (/^-i/.test(t.value) || /^--in-place/.test(t.value))) { hasI = true; i++; continue; }
    if (!t.quoted && t.value.startsWith("-")) { i++; continue; }
    if (!scriptConsumed) { scriptConsumed = true; i++; continue; }
    files.push(t.value); i++;
  }
  if (!hasI) return null;
  if (files.length === 0) return { branch: 4, detector: "sed -i", reason: "no-file-operand", target: null };
  return pickWorst(files.map((f) => resolveTarget(f, cwd, gatedExts)), "sed -i");
}

function handlePerl(stage, verbIdx, cwd, gatedExts) {
  let i = verbIdx + 1;
  let hasI = false;
  let scriptConsumed = false;
  const files = [];
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && /^-[pn]*i[a-z]*(\.\S+)?$/i.test(t.value)) { hasI = true; i++; continue; }
    if (!t.quoted && t.value === "-e") { i += 2; scriptConsumed = true; continue; }
    if (!t.quoted && t.value.startsWith("-")) { i++; continue; }
    if (!scriptConsumed) { scriptConsumed = true; i++; continue; }
    files.push(t.value); i++;
  }
  if (!hasI) return null;
  if (files.length === 0) return { branch: 4, detector: "perl -i", reason: "no-file-operand", target: null };
  return pickWorst(files.map((f) => resolveTarget(f, cwd, gatedExts)), "perl -i");
}

function handleVim(stage, verbIdx, cwd, gatedExts) {
  let hasWq = false;
  let i = verbIdx + 1;
  const positionals = [];
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && t.value === "-c") {
      const arg = stage[i + 1];
      if (arg && /wq/i.test(arg.value)) hasWq = true;
      i += 2; continue;
    }
    if (!t.quoted && t.value.startsWith("-")) { i++; continue; }
    positionals.push(t.value); i++;
  }
  if (!hasWq) return null;
  if (positionals.length === 0) return { branch: 4, detector: "vim -c wq", reason: "no-file-operand", target: null };
  return pickWorst(positionals.map((f) => resolveTarget(f, cwd, gatedExts)), "vim -c wq");
}

function handleGit(stage, verbIdx, cwd, gatedExts) {
  const j = verbIdx + 1;
  if (j >= stage.length || stage[j].quoted) return null;
  const sub = stage[j].value;
  if (sub === "mv" || sub === "add" || sub === "commit" || sub === "diff" || sub === "status") return null;
  if (sub === "checkout") {
    let k = j + 1, sawDashDash = false;
    const paths = [];
    while (k < stage.length) {
      const t = stage[k];
      if (!t.quoted && t.value === "--") { sawDashDash = true; k++; continue; }
      if (sawDashDash) paths.push(t.value);
      k++;
    }
    if (!sawDashDash || paths.length === 0) return null;
    return pickWorst(paths.map((p) => resolveTarget(p, cwd, gatedExts)), "git checkout --");
  }
  if (sub === "restore") {
    let k = j + 1;
    const paths = [];
    while (k < stage.length) {
      const t = stage[k];
      if (!t.quoted && t.value.startsWith("-")) { k++; continue; }
      paths.push(t.value); k++;
    }
    if (paths.length === 0) return { branch: 4, detector: "git restore", reason: "no-pathspec", target: null };
    return pickWorst(paths.map((p) => resolveTarget(p, cwd, gatedExts)), "git restore");
  }
  if (sub === "apply") {
    return { branch: 4, detector: "git apply", reason: "patch-target-unknowable", target: null };
  }
  if (sub === "stash") {
    const nxt = stage[j + 1];
    if (nxt && !nxt.quoted && (nxt.value === "pop" || nxt.value === "apply")) {
      return { branch: 4, detector: "git stash " + nxt.value, reason: "stash-target-unknowable", target: null };
    }
    return null;
  }
  if (sub === "reset") {
    let k = j + 1, hasHard = false;
    const paths = [];
    while (k < stage.length) {
      const t = stage[k];
      if (!t.quoted && t.value === "--hard") { hasHard = true; k++; continue; }
      if (!t.quoted && t.value.startsWith("-")) { k++; continue; }
      paths.push(t.value); k++;
    }
    if (!hasHard || paths.length === 0) return null; // bare --hard w/o pathspec out of this hook's scope
    return pickWorst(paths.map((p) => resolveTarget(p, cwd, gatedExts)), "git reset --hard");
  }
  return null;
}

function handleRsync(stage, verbIdx, cwd, gatedExts) {
  const positionals = parsePositionalsAfterVerb(stage, verbIdx, new Set());
  if (positionals.length === 0) return null;
  const dest = positionals[positionals.length - 1];
  if (/^[\w.-]+@[\w.-]+:/.test(dest) || dest.includes("::")) return null; // remote target, not local
  return tagDetector(resolveTarget(dest, cwd, gatedExts), "rsync");
}

function handleLn(stage, verbIdx, cwd, gatedExts) {
  let hasS = false, hasF = false;
  const positionals = [];
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && t.value.startsWith("-")) {
      if (t.value.includes("s") || t.value === "--symbolic") hasS = true;
      if (t.value.includes("f") || t.value === "--force") hasF = true;
      i++; continue;
    }
    positionals.push(t.value); i++;
  }
  if (!hasS || !hasF) return null;
  if (positionals.length === 0) return { branch: 4, detector: "ln -sf", reason: "no-linkname", target: null };
  return tagDetector(resolveTarget(positionals[positionals.length - 1], cwd, gatedExts), "ln -sf");
}

function handleCurl(stage, verbIdx, cwd, gatedExts) {
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-o" || t.value === "--output")) {
      const arg = stage[i + 1];
      if (!arg) return { branch: 4, detector: "curl -o", reason: "missing-arg", target: null };
      return tagDetector(resolveTarget(arg.value, cwd, gatedExts), "curl -o");
    }
    if (!t.quoted && t.value === "-O") {
      return { branch: 4, detector: "curl -O", reason: "remote-derived-filename", target: null };
    }
    i++;
  }
  return null;
}

function handleWget(stage, verbIdx, cwd, gatedExts) {
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-O" || t.value === "--output-document")) {
      const arg = stage[i + 1];
      if (!arg) return { branch: 4, detector: "wget -O", reason: "missing-arg", target: null };
      return tagDetector(resolveTarget(arg.value, cwd, gatedExts), "wget -O");
    }
    i++;
  }
  return null;
}

function handleTar(stage, verbIdx) {
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (/^-[a-z]*x[a-z]*$/i.test(t.value) || t.value === "--extract")) {
      return { branch: 4, detector: "tar -x", reason: "archive-contents-unknown", target: null };
    }
    i++;
  }
  return null;
}

function handleUnzip(stage, verbIdx) {
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && t.value === "-o") {
      return { branch: 4, detector: "unzip -o", reason: "archive-contents-unknown", target: null };
    }
    i++;
  }
  return null;
}

function handleRename(stage, verbIdx, cwd, gatedExts) {
  const positionals = parsePositionalsAfterVerb(stage, verbIdx, new Set());
  if (positionals.length < 2) return null;
  if (/^s[/#|].*[/#|]/.test(positionals[0])) {
    return { branch: 4, detector: "rename", reason: "perl-style-rename-pattern-unresolvable", target: null };
  }
  return tagDetector(resolveTarget(positionals[positionals.length - 1], cwd, gatedExts), "rename");
}

function handleDd(stage, verbIdx, cwd, gatedExts) {
  for (let i = verbIdx + 1; i < stage.length; i++) {
    const t = stage[i];
    if (!t.quoted && /^of=/.test(t.value)) {
      return tagDetector(resolveTarget(t.value.slice(3), cwd, gatedExts), "dd of=");
    }
  }
  return null;
}

function handleTruncate(stage, verbIdx, cwd, gatedExts) {
  const positionals = [];
  let i = verbIdx + 1;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-s" || t.value === "--size")) { i += 2; continue; }
    if (!t.quoted && t.value.startsWith("-")) { i++; continue; }
    positionals.push(t.value); i++;
  }
  if (positionals.length === 0) return null;
  return tagDetector(resolveTarget(positionals[positionals.length - 1], cwd, gatedExts), "truncate");
}

const INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "pwsh", "powershell", "sh", "bash", "zsh", "dash"]);
// Final-round item: sh/bash/zsh/dash -c/-lc bodies are recursively
// classified through analyzeBash itself (handleShellInline, below) rather
// than the generic write-API-regex scan used for node/python/pwsh/
// powershell script bodies (handleInterpreterInline) — a shell -c body IS a
// full shell command, not an opaque scripting-language blob.
const SHELL_FAMILY = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_INLINE_MAX_DEPTH = 3;

// E1: full .NET file/directory mutating surface, shared by the bash-inline-
// body boolean gate (WRITE_API_RE, below) and the PowerShell-specific
// structured detector (detectDotNetIoMutation, near analyzePowerShell).
// Deliberately excludes Read*/Open (bare) — File.Open only counts when its
// own argument list mentions Write/Create/Append (see detectDotNetIoMutation
// for that conditional check; the bash-inline gate below is a boolean-only
// "does a write-shaped marker appear at all" check and is intentionally more
// liberal, since an unresolvable literal path still safely falls to branch 4).
const DOTNET_IO_SURFACE_RE_SRC =
  "\\[(?:System\\.)?IO\\.File\\]::(?:Write\\w*|Append\\w*|Copy|Move|Delete|CreateText|Create|Replace|Open\\w*)" +
  "|\\[(?:System\\.)?IO\\.Directory\\]::(?:Move|Delete|CreateDirectory)" +
  "|New-Object\\s+(?:-TypeName\\s+)?(?:System\\.IO\\.)?(?:StreamWriter|FileStream)\\b" +
  "|\\[(?:System\\.IO\\.)?(?:StreamWriter|FileStream)\\]::new\\s*\\(";

const WRITE_API_RE = new RegExp(
  "writeFileSync|copyFileSync|renameSync|appendFileSync|open\\([^)]*['\"](?:w|a)['\"]" +
  "|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|Rename-Item|New-Item" +
  "|WriteAllText|(?:^|[^A-Za-z0-9_-])sc(?:[^A-Za-z0-9_-]|$)" +
  "|" + DOTNET_IO_SURFACE_RE_SRC,
  "i"
);

/**
 * E1: structured .NET static-method / constructor mutation detector for the
 * PowerShell branch — target = FIRST STRING LITERAL ARGUMENT (these forms
 * are always positional/parenthetical, never named PS params). Returns
 * { verb, idx, style: "dotnet" } or null. `text` should be the quote-
 * blanked scan text (per D5); the caller re-slices the ORIGINAL command at
 * the returned `idx` for target extraction (blankPsQuotesForScan preserves
 * string length, so indices stay aligned).
 */
// Methods whose real write TARGET is the SECOND string-literal argument, not
// the first — File.Copy(source, dest), File.Move(source, dest),
// File.Replace(sourceFileName, destinationFileName, ...), Directory.Move
// (sourceDirName, destDirName). Self-found bug (adversary pass): the
// reviewer's "target = first string literal argument" rule is correct for
// Write*/Append*/Delete/Create/CreateText/Open(path) but silently extracts
// the SOURCE (not the write target) for these four — fixed by tagging
// argIndex per method rather than blanket-using index 0.
const DOTNET_SECOND_ARG_METHODS = new Set(["copy", "move", "replace"]);

function detectDotNetIoMutation(text) {
  const fileRe = /\[(?:System\.)?IO\.File\]::(Write\w*|Append\w*|Copy|Move|Delete|CreateText|Create|Replace|Open\w*)\b/i;
  const m = text.match(fileRe);
  if (m) {
    const method = m[1];
    const argIndex = DOTNET_SECOND_ARG_METHODS.has(method.toLowerCase()) ? 1 : 0;
    if (/^open/i.test(method)) {
      // File.Open(...) only counts as a mutation when Write/Create/Append is
      // mentioned — either right in the METHOD NAME itself (File.OpenWrite
      // already says so) or in the surrounding argument list up to the next
      // statement boundary (File.Open(path, FileMode.Create)). Self-found
      // bug (adversary pass): an earlier version excluded the method name
      // from this check, so `[IO.File]::OpenWrite(...)` — whose own name IS
      // the write marker — fell through unqualified and allowed. Fixed by
      // checking the method name first. NOTE: File.OpenText is a READ API
      // (opens an existing file for reading) despite starting with "Open"
      // — it must NOT match, and doesn't: "OpenText" contains none of
      // write/create/append.
      const boundary = text.slice(m.index).search(/[;\n]/);
      const scope = boundary === -1 ? text.slice(m.index) : text.slice(m.index, m.index + boundary);
      if (/write|create|append/i.test(method) || /write|create|append/i.test(scope.slice(m[0].length))) {
        return { verb: `[IO.File]::${method}`, idx: m.index, style: "dotnet", argIndex: 0 };
      }
    } else {
      return { verb: `[IO.File]::${method}`, idx: m.index, style: "dotnet", argIndex };
    }
  }
  const dirRe = /\[(?:System\.)?IO\.Directory\]::(Move|Delete|CreateDirectory)\b/i;
  const dm = text.match(dirRe);
  if (dm) {
    const dirArgIndex = dm[1].toLowerCase() === "move" ? 1 : 0;
    return { verb: `[IO.Directory]::${dm[1]}`, idx: dm.index, style: "dotnet", argIndex: dirArgIndex };
  }
  // F3: StreamReader is inherently read-only (there is no write path through
  // it) -> never a mutation, regardless of arguments. StreamWriter is
  // always a mutation. FileStream depends on its access-mode argument: an
  // explicit Read access -> read (branch 1); Write/ReadWrite/Append/Create/
  // Truncate, OR no access argument at all -> write (conservative default).
  // NOTE: prefix accepts bare "IO." OR full "System.IO." (same style as
  // fileRe/dirRe above) — PowerShell scripts commonly reference the well-
  // known System.IO namespace via just "IO.", and an earlier version only
  // accepted the full "System.IO." form, silently missing `New-Object
  // IO.StreamWriter(...)`.
  const streamRe = /(?:New-Object\s+(?:-TypeName\s+)?(?:(?:System\.)?IO\.)?(StreamWriter|FileStream|StreamReader)\b)|(?:\[(?:(?:System\.)?IO\.)?(StreamWriter|FileStream|StreamReader)\]::new\s*\()/i;
  const sm = text.match(streamRe);
  if (sm) {
    const cls = sm[1] || sm[2];
    const clsLower = cls.toLowerCase();
    // Self-found bug: a bare `null` here is indistinguishable from "no
    // dotnet pattern matched at all", so a `New-Object ClassName(...)` read
    // (which DOES have a plain leading identifier, unlike `[Class]::...`)
    // fell through to the generic unknown-verb catch-all — which then
    // misflagged the bracket syntax itself (`[IO.FileMode]::Open`) as an
    // "ambiguous" glob-like argument. Return a distinct "recognized, but
    // not a mutation" marker instead so the caller skips the clause
    // entirely rather than treating the class name as an unknown verb.
    if (clsLower === "streamreader") return { style: "dotnet-read" };
    if (clsLower === "streamwriter") return { verb: cls, idx: sm.index, style: "dotnet", argIndex: 0 };
    // FileStream: inspect the access-mode argument(s) up to the next
    // statement boundary.
    const boundary = text.slice(sm.index).search(/[;\n]/);
    const scope = boundary === -1 ? text.slice(sm.index) : text.slice(sm.index, sm.index + boundary);
    if (classifyFileStreamAccess(scope) === "read") return { style: "dotnet-read" };
    return { verb: cls, idx: sm.index, style: "dotnet", argIndex: 0 };
  }
  return null;
}

/**
 * F3: best-effort access-mode classifier for a FileStream constructor's
 * argument scope. "read" only when an explicit Read access marker is
 * present and it is not part of "ReadWrite" (word-boundary matching already
 * prevents "ReadWrite" from satisfying a bare /\bRead\b/ test). Any of
 * Write/ReadWrite/Append/Create/Truncate, OR no access marker at all,
 * classifies as "write" — the conservative default per spec.
 */
function classifyFileStreamAccess(scopeText) {
  if (/\bReadWrite\b/i.test(scopeText)) return "write";
  if (/\bAppend\b/i.test(scopeText)) return "write";
  if (/\bCreate\b/i.test(scopeText)) return "write";
  if (/\bTruncate\b/i.test(scopeText)) return "write";
  if (/\bWrite\b/i.test(scopeText)) return "write";
  if (/\bRead\b/i.test(scopeText)) return "read";
  return "write";
}

/** First single- or double-quoted string literal in `text` (or null). */
function extractFirstStringLiteral(text) {
  return extractNthStringLiteral(text, 0);
}

/** The Nth (0-based) single- or double-quoted string literal in `text` (or null). */
function extractNthStringLiteral(text, n) {
  const re = /"([^"]*)"|'([^']*)'/g;
  let m;
  let count = 0;
  while ((m = re.exec(text)) !== null) {
    if (count === n) return m[1] !== undefined ? m[1] : m[2];
    count++;
  }
  return null;
}

/**
 * Final fix: an interpreter -c/-lc/-e/-Command BODY containing a command
 * substitution ($(...) or backticks), a variable expansion ($VAR/${...},
 * including PowerShell's $var sigil), or a heredoc (<<)/process
 * substitution (<(...) / >(...)) marker is unknowable statically — its
 * real content depends on runtime state this hook cannot see — and must be
 * branch 4, NEVER branch 1, regardless of whether a literal write target
 * also happens to appear in the same body. Deliberately generic text
 * matching (not scoped to detected write verbs): the spec explicitly
 * accepts this as friction ("bash -c \"echo $X > a.txt\"" blocks even
 * though the redirect target itself is literal).
 */
function isDynamicInterpreterBody(text) {
  if (/\$\(/.test(text)) return true;               // $(...)
  if (/`/.test(text)) return true;                   // backticks
  if (/\$\{/.test(text)) return true;                // ${...}
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(text)) return true; // $VAR / PowerShell $var
  if (/<</.test(text)) return true;                  // heredoc marker
  if (/<\(|>\(/.test(text)) return true;             // process substitution
  return false;
}

function handleInterpreterInline(stage, verbIdx, cwd, gatedExts) {
  const verb = stage[verbIdx].value.toLowerCase();
  if (!INTERPRETERS.has(verb)) return null;
  const isPs = (verb === "pwsh" || verb === "powershell");

  // F2: -EncodedCommand carries a base64 body — decoding and recursively
  // analyzing it is out of scope; the safe default is unconditional branch 4.
  if (isPs) {
    for (let k = verbIdx + 1; k < stage.length; k++) {
      const t = stage[k];
      if (!t.quoted && /^-EncodedCommand$/i.test(t.value)) {
        return { branch: 4, detector: `${verb} -EncodedCommand`, reason: "encoded-body-unresolvable", target: null };
      }
    }
  }

  let i = verbIdx + 1;
  let bodyTok = null;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-e" || t.value === "-c" || t.value === "--eval" ||
        t.value === "-Command" || t.value === "--Command" || /^-c$/i.test(t.value))) {
      bodyTok = stage[i + 1];
      break;
    }
    i++;
  }
  if (!bodyTok) return null; // bare script invocation -> explicitly allowed (branch 1)
  const body = bodyTok.value;

  if (isDynamicInterpreterBody(body)) {
    return { branch: 4, detector: `${verb} inline body (dynamic)`, reason: "dynamic-body-unresolvable", target: null };
  }

  if (isPs) {
    // F2: reuse the SAME PowerShell analyzer used for the native
    // PowerShell tool_name path (statement-splitting, detectDotNetIoMutation
    // with its per-method argIndex, cmdlet/alias resolution, -WhatIf,
    // stderr/clobber redirects) instead of the generic WRITE_API_RE +
    // first-literal-with-a-known-extension scan below.
    const psResult = analyzePowerShell(body, cwd, gatedExts);
    if (psResult.branch <= 1) return null;
    return {
      branch: psResult.branch,
      detector: `${verb} -Command (${psResult.detector || "nested PS"})`,
      target: psResult.target,
      reason: psResult.reason,
      ext: psResult.ext,
    };
  }

  if (!WRITE_API_RE.test(body)) return null;
  const apiMatch = body.match(WRITE_API_RE);
  const pathMatch = body.match(/['"]([^'"]+\.(?:ps1|psm1|psd1|txt|json|log|cfg|ini|md|js|py))['"]/i);
  if (pathMatch) {
    return tagDetector(resolveTarget(pathMatch[1], cwd, gatedExts), `${verb} inline body (${apiMatch[0].trim()})`);
  }
  return { branch: 4, detector: `${verb} inline body`, reason: "script-computed-target-unresolvable", target: null };
}

/**
 * Final-round item: sh/bash/zsh/dash -c/-lc bodies are RECURSIVELY
 * classified through analyzeBash itself (not a regex write-API scan) —
 * the body is a real shell command, so it gets the full total-
 * classification treatment (D1-D5, E1-E4, everything) it would get if it
 * had been the top-level command. Covers `sh -c '...'`, `bash -lc "..."`,
 * `wsl -- bash -lc '...'` (via findPrimaryVerbIndex's wsl-unwrap), and
 * `env bash -c '...'` (via the existing env-unwrap).
 *
 * "Strip one layer of quoting": tokenize() already fully dequotes a single
 * quoted span into ONE token's `.value` — that IS one layer stripped. A
 * body argument that is NOT a single clean quoted/bare token (bodyTok
 * missing, or present but the tokenizer could not treat it as one coherent
 * token) is branch 4 (cannot classify cleanly), per spec.
 *
 * Nesting depth cap 3: `depth` counts recursion levels already taken;
 * at/beyond SHELL_INLINE_MAX_DEPTH the body is not analyzed further and
 * this is unconditionally branch 4.
 */
function handleShellInline(stage, verbIdx, cwd, gatedExts, depth) {
  if (depth >= SHELL_INLINE_MAX_DEPTH) {
    return { branch: 4, detector: `${stage[verbIdx].value} -c (nesting depth cap)`, reason: "nesting-depth-exceeded", target: null };
  }
  let i = verbIdx + 1;
  let bodyTok = null;
  while (i < stage.length) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-c" || t.value === "-lc")) {
      bodyTok = stage[i + 1];
      break;
    }
    i++;
  }
  if (!bodyTok) return null; // bare / -l-only invocation -> explicitly allowed (branch 1)
  if (!bodyTok.quoted) {
    // A -c argument that tokenize() did not see as a single quoted span is
    // not "cleanly unquotable" (e.g. an unquoted multi-word body would
    // already be split across several OUTER tokens, a shape this hook does
    // not attempt to reassemble) -> branch 4 per spec.
    return { branch: 4, detector: `${stage[verbIdx].value} -c (unquoted body)`, reason: "body-not-cleanly-quoted", target: null };
  }
  // Final fix: a dynamic body ($(...), backticks, $VAR/${...}, heredoc,
  // process substitution) is unknowable statically -> branch 4, never
  // recursed into (recursing would just re-analyze literal placeholder
  // text, which is not what actually executes at runtime).
  if (isDynamicInterpreterBody(bodyTok.value)) {
    return { branch: 4, detector: `${stage[verbIdx].value} -c (dynamic body)`, reason: "dynamic-body-unresolvable", target: null };
  }
  const bodyResult = analyzeBash(bodyTok.value, cwd, gatedExts, depth + 1);
  if (bodyResult.branch <= 1) return null;
  return {
    branch: bodyResult.branch,
    detector: `${stage[verbIdx].value} -c (nested, depth ${depth + 1})`,
    target: bodyResult.target,
    reason: bodyResult.reason,
    ext: bodyResult.ext,
  };
}

function handleFirstPositionalTarget(stage, verbIdx, verb, cwd, gatedExts) {
  const positionals = parsePositionalsAfterVerb(stage, verbIdx, new Set());
  if (positionals.length === 0) return null;
  return tagDetector(resolveTarget(positionals[0], cwd, gatedExts), verb);
}

// ── D1: total verb classification (was an allow-list) ─────────────────────

// (i) KNOWN-READ-ONLY — branch 1 regardless of arguments.
// NOTE (adversary v2 follow-up): generic CLI wrappers whose subcommands can
// themselves perform an arbitrary local write (wsl, az, gh, psql, pg_dump,
// pg_restore, docker, ssh, scp, and any other such wrapper) are deliberately
// NOT in this set — they fall through to catchAllUnknownVerb instead, which
// blocks only when an argument actually looks gated/ambiguous. A prior
// revision listed gh/az/wsl/psql/pg_dump here as unconditionally read-only
// per an explicit (mistaken) instruction; adversary testing showed real
// escapes (`wsl cp a.txt out.ps1`, `az storage blob download --file
// out.ps1`) and the instruction was corrected.
// `gh api` is the ONE exception, checked structurally (isGhApiReadSegment)
// rather than by adding "gh" to this set: `gh api <endpoint>` talks to the
// GitHub REST API and has no local-file write surface of its own (unlike
// `gh` more broadly, which subsumes subcommands such as `gh pr checkout`
// indirection); a REST path/query argument routinely contains `?`/`&`,
// which the catch-all's generic ambiguous-token scan otherwise misreads as
// a glob and blocks (branch 4 false positive). Every other `gh` subcommand
// still falls through to catchAllUnknownVerb unchanged.
const KNOWN_READ_VERBS = new Set([
  "cat", "less", "more", "head", "tail", "grep", "rg", "wc", "file", "stat",
  "ls", "dir", "diff",
  // E4: common read-only utilities extended per review.
  "du", "df", "sort", "uniq", "cut", "tr", "jq", "yq",
  "md5sum", "sha1sum", "sha256sum", "tree", "which", "where", "type",
  "realpath", "readlink", "basename", "dirname", "cmp", "comm", "xxd", "od",
  "strings",
]);
// echo/printf are read-only in the sense that THIS check contributes no
// finding of its own — a real redirect on the same stage is still caught
// independently by scanRedirects/detectStderrClobberRedirects.
const KNOWN_READ_ECHO_VERBS = new Set(["echo", "printf"]);

/**
 * isGhApiReadSegment(tokens, verbIdx) -> boolean
 * Single point of truth for the one `gh` exception (see the comment above
 * KNOWN_READ_VERBS): true iff `tokens[verbIdx]` is the UNQUOTED, ASCII-exact
 * token "gh" and `tokens[verbIdx + 1]` is the UNQUOTED, ASCII-exact token
 * "api". `tokens` is the shared {value, quoted} token-array shape used by
 * both the Bash `stage` array (from tokenize()/splitSegments()) and the
 * PowerShell adapter (psTokensForGhApiCheck, below) — one predicate, two
 * shape-compatible producers, per spec (no duplicated inline check).
 * Nothing else about the token list matters: no flag parsing, no method
 * parsing, no scanning of later tokens. A quoted "gh"/"api" (`'gh' api`,
 * `gh 'api'`), a non-ASCII lookalike, an alias-renamed `gh` invocation, or a
 * global flag before `api` (`gh -R o/r api ...`) all correctly return false
 * here — JS string equality (`===`) against the literal ASCII "gh"/"api"
 * already rejects lookalike codepoints without a separate ASCII check.
 */
function isGhApiReadSegment(tokens, verbIdx) {
  const verbTok = tokens[verbIdx];
  if (!verbTok || verbTok.quoted || verbTok.value !== "gh") return false;
  const nextTok = tokens[verbIdx + 1];
  return !!(nextTok && !nextTok.quoted && nextTok.value === "api");
}

/**
 * Adapter for the PowerShell side: `rawFromVerb` is the raw (unblanked)
 * text starting at the "gh" verb token through the end of its clause
 * (e.g. `gh api 'repos/o/r?x=1' --jq '...'`). Tokenizes it into the same
 * {value, quoted} shape isGhApiReadSegment expects, so the ONE predicate
 * above serves both detectors rather than a second inline reimplementation.
 */
function psTokensForGhApiCheck(rawFromVerb) {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const toks = [];
  let m;
  while ((m = re.exec(rawFromVerb)) !== null) {
    if (m[1] !== undefined) toks.push({ value: m[1], quoted: true });
    else if (m[2] !== undefined) toks.push({ value: m[2], quoted: true });
    else toks.push({ value: m[3], quoted: false });
  }
  return toks;
}

function stageHasFlag(stage, verbIdx, flagNames) {
  for (let i = verbIdx + 1; i < stage.length; i++) {
    const t = stage[i];
    if (!t.quoted && flagNames.includes(t.value)) return true;
  }
  return false;
}

function isKnownReadVerb(stage, verbIdx) {
  const verb = stage[verbIdx].value;
  if (isGhApiReadSegment(stage, verbIdx)) return true;
  if (KNOWN_READ_VERBS.has(verb)) return true;
  if (KNOWN_READ_ECHO_VERBS.has(verb)) return true;
  // curl stays read-only unless -o/-O/--output is present (its --data @file
  // argument is a read, not a write) — curl itself remains the one generic
  // CLI wrapper with a real known-write path (handleCurl), per instruction.
  if (verb === "curl") return !stageHasFlag(stage, verbIdx, ["-o", "-O", "--output"]);
  // E4: awk/sed are read-only unless -i (in-place edit) is present; a real
  // redirect on the same stage is independently caught by scanRedirects
  // regardless of this verb's own classification (same rationale as
  // echo/printf above).
  if (verb === "awk") return !stageHasFlag(stage, verbIdx, ["-i"]);
  // E4: certutil is read-only ONLY for -hashfile; its other subcommands
  // (-encode/-decode/etc.) can write files and fall through to the
  // catch-all instead of being blanket-allowed.
  if (verb === "certutil") return stageHasFlag(stage, verbIdx, ["-hashfile"]);
  if (INTERPRETERS.has(verb.toLowerCase())) {
    // bare / -File invocation is read-only; -e/-c/-Command/-lc routes
    // through handleInterpreterInline or handleShellInline (known-write).
    return !stageHasFlag(stage, verbIdx, ["-e", "-c", "--eval", "-Command", "--Command", "-lc", "-EncodedCommand"]);
  }
  if (verb === "Invoke-ScriptAnalyzer" || verb === "Get-Content" || verb === "Select-String" ||
      verb === "Test-Path" || verb === "Measure-Object" || verb === "Out-String" ||
      verb === "Out-Host" || verb === "Write-Output" || verb === "Write-Host") return true;
  if (/^Get-/.test(verb) || /^Test-/.test(verb) || /^Measure-/.test(verb) ||
      /^Select-/.test(verb) || /^Format-/.test(verb) || /^ConvertTo-/.test(verb) ||
      /^ConvertFrom-/.test(verb)) return true; // PowerShell read-cmdlet families
  if (verb === "git") {
    const sub = stage[verbIdx + 1];
    if (!sub || sub.quoted) return false;
    const READ_SUBS = new Set([
      "add", "commit", "diff", "status", "log", "show", "fetch", "pull", "push",
      "rev-parse", "ls-files", "check-ignore", "mv",
    ]);
    if (READ_SUBS.has(sub.value)) return true;
    if (sub.value === "branch") {
      const nxt = stage[verbIdx + 2];
      return !!(nxt && !nxt.quoted && (nxt.value === "--list" || nxt.value === "-l"));
    }
    return false; // falls through to handleGit's own write-subcommand resolution
  }
  return false;
}

// (ii) KNOWN-WRITE — existing per-verb target resolution -> branch 2/3/4.
// PowerShell aliases (copy/cp/mv/move/ren/sc/ac/ni/rni/mi/cpi) added per D1;
// cp/mv/install already present. INTERPRETERS (node/python/pwsh/powershell)
// are also known-write when reached here (isKnownReadVerb already filtered
// out their read-only/bare-invocation shape).
const KNOWN_WRITE_VERBS = new Set([
  "tee", "sed", "cp", "mv", "install", "dd", "truncate", "rsync", "ln",
  "curl", "wget", "tar", "unzip", "rename", "perl", "ex", "vim", "vi", "git",
  "copy", "move", "ren", "sc", "ac", "ni", "rni", "mi", "cpi",
]);

function dispatchKnownWrite(stage, verbIdx, cwd, gatedExts, depth) {
  const verb = stage[verbIdx].value;
  if (!KNOWN_WRITE_VERBS.has(verb) && !INTERPRETERS.has(verb.toLowerCase())) {
    return { found: false };
  }
  let result;
  switch (verb) {
    case "tee": result = handleTee(stage, verbIdx, cwd, gatedExts); break;
    case "sed": result = handleSed(stage, verbIdx, cwd, gatedExts); break;
    case "cp": case "mv": case "install":
    case "copy": case "move": case "cpi": case "mi": case "ren": case "rni":
      result = handleCpMvInstall(stage, verbIdx, verb, cwd, gatedExts); break;
    case "sc": case "ac": case "ni":
      result = handleFirstPositionalTarget(stage, verbIdx, verb, cwd, gatedExts); break;
    case "dd": result = handleDd(stage, verbIdx, cwd, gatedExts); break;
    case "truncate": result = handleTruncate(stage, verbIdx, cwd, gatedExts); break;
    case "rsync": result = handleRsync(stage, verbIdx, cwd, gatedExts); break;
    case "ln": result = handleLn(stage, verbIdx, cwd, gatedExts); break;
    case "curl": result = handleCurl(stage, verbIdx, cwd, gatedExts); break;
    case "wget": result = handleWget(stage, verbIdx, cwd, gatedExts); break;
    case "tar": result = handleTar(stage, verbIdx); break;
    case "unzip": result = handleUnzip(stage, verbIdx); break;
    case "rename": result = handleRename(stage, verbIdx, cwd, gatedExts); break;
    case "perl": result = handlePerl(stage, verbIdx, cwd, gatedExts); break;
    case "ex": case "vim": case "vi": result = handleVim(stage, verbIdx, cwd, gatedExts); break;
    case "git": result = handleGit(stage, verbIdx, cwd, gatedExts); break;
    default:
      result = SHELL_FAMILY.has(verb.toLowerCase())
        ? handleShellInline(stage, verbIdx, cwd, gatedExts, depth || 0)
        : handleInterpreterInline(stage, verbIdx, cwd, gatedExts);
  }
  return { found: true, result };
}

// (iii)/(iv) ANY OTHER verb: friction-over-escape default. An unrecognized
// verb whose arguments include an ambiguous token or a gated-extension
// basename blocks (branch 4, naming the unknown verb) — we don't know which
// argument (if any) is really the write target, so ANY qualifying argument
// is sufficient. No gated-looking argument at all -> branch 1.
function catchAllUnknownVerb(stage, verbIdx, gatedExts) {
  const verb = stage[verbIdx].value;
  for (let i = verbIdx + 1; i < stage.length; i++) {
    const t = stage[i];
    if (t.sep || t.redirect) continue;
    const val = t.value;
    if (isAmbiguousToken(val)) {
      return { branch: 4, detector: `unknown verb "${verb}"`, reason: "unknown-verb-ambiguous-argument", target: val };
    }
    const bn = val.slice(Math.max(val.lastIndexOf("/"), val.lastIndexOf("\\")) + 1);
    const cls = classifyExtension(bn, gatedExts);
    if (cls.branch >= 3) {
      return { branch: 4, detector: `unknown verb "${verb}"`, reason: "unknown-verb-gated-argument", target: val };
    }
  }
  return null;
}

// E3: `find`'s -name/-iname pattern gating is a SECOND, independent branch-4
// signal, but only when the SAME find invocation actually mutates anything —
// a plain `find . -name '*.ps1'` (a pure search) must allow. Qualifying
// mutating actions: -exec/-execdir/-ok/-okdir immediately followed by a
// KNOWN-WRITE verb; -delete; or -fprint/-fprintf/-fls (which also
// independently resolve their OWN file-operand target like a redirect —
// see checkFindFprintFamily below).
// -delete, and -exec/-execdir/-ok/-okdir with a KNOWN-WRITE verb, mutate an
// UNKNOWN set of files determined entirely by find's OWN matching — without
// a -name/-iname/-path/-ipath pattern there is no way to know which
// extensions those files carry (F1).
function findHasDeleteOrWriteExecAction(stage) {
  for (let i = 0; i < stage.length; i++) {
    const t = stage[i];
    if (t.quoted) continue;
    if (t.value === "-delete") return true;
    if (t.value === "-exec" || t.value === "-execdir" || t.value === "-ok" || t.value === "-okdir") {
      const nxt = stage[i + 1];
      if (nxt && !nxt.quoted && KNOWN_WRITE_VERBS.has(nxt.value)) return true;
    }
  }
  return false;
}

// -fprint/-fprintf/-fls carry their OWN literal file operand (resolved
// separately and precisely by checkFindFprintFamily below) — their presence
// still unlocks the -name-pattern GATED check (existing E3 behavior), but
// does NOT by itself trigger F1's "no pattern -> unresolvable" penalty,
// since that specific target is never actually unresolvable.
function findHasFprintFamilyFlag(stage) {
  return stage.some((t) => !t.quoted && (t.value === "-fprint" || t.value === "-fprintf" || t.value === "-fls"));
}

// F1: a find invocation carrying -delete or a write-verb -exec/-execdir/
// -ok/-okdir, with NO resolvable -name/-iname/-path/-ipath pattern at all,
// is unresolvable — we cannot tell which extensions the matched (and
// deleted/exec'd) files carry — so it must block (branch 4), not silently
// allow. With a pattern present (or -fprint family alone), the existing
// gated-vs-not-gated check (E3) still governs.
function checkFindNamePattern(stage, gatedExts) {
  const hasDeleteOrExec = findHasDeleteOrWriteExecAction(stage);
  const hasFprint = findHasFprintFamilyFlag(stage);
  if (!hasDeleteOrExec && !hasFprint) return null;
  const gatedNoDot = gatedExts.map((e) => String(e).replace(/^\./, "").toLowerCase());
  let sawPattern = false;
  for (let i = 0; i < stage.length; i++) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-name" || t.value === "-iname" || t.value === "-path" || t.value === "-ipath")) {
      const pat = stage[i + 1];
      if (!pat) continue;
      sawPattern = true;
      const low = pat.value.toLowerCase();
      if (gatedNoDot.some((ext) => low.includes("." + ext))) {
        return { branch: 4, detector: "find -name gated pattern", reason: "find-name-pattern-gated", target: pat.value };
      }
    }
  }
  if (!sawPattern && hasDeleteOrExec) {
    return { branch: 4, detector: "find mutating action without resolvable pattern", reason: "find-pattern-unresolvable", target: null };
  }
  return null;
}

// -fprint/-fprintf/-fls write find's matched-file listing to their own FILE
// operand — resolved like a redirect target (extension-gated), independent
// of -name/-exec.
function checkFindFprintFamily(stage, cwd, gatedExts) {
  const results = [];
  for (let i = 0; i < stage.length; i++) {
    const t = stage[i];
    if (!t.quoted && (t.value === "-fprint" || t.value === "-fprintf" || t.value === "-fls")) {
      const fileTok = stage[i + 1];
      if (!fileTok) {
        results.push({ branch: 4, detector: `find ${t.value}`, reason: "no-file-operand", target: null });
        continue;
      }
      results.push(tagDetector(resolveTarget(fileTok.value, cwd, gatedExts), `find ${t.value}`));
    }
  }
  return pickWorst(results, "find -fprint family");
}

// Total classification entry point for one verb-position token (primary
// verb of a stage, or the token dispatched immediately after
// xargs/-exec/-execdir). Replaces the old allow-list dispatchVerb.
function classifyVerbToken(stage, verbIdx, cwd, gatedExts, depth) {
  const verbTok = stage[verbIdx];
  const verb = verbTok.value;
  // Gap 3: a QUOTED verb token whose dequoted value contains whitespace or a
  // shell metacharacter cannot name a single command (`'gh api'`, `"a;b"`,
  // or — the degenerate case where the whole "verb" IS the sole remaining
  // token, e.g. an env-prefix that swallowed everything up to a following
  // quoted glob-looking word — a lone `'a?b'`). This is unconditionally
  // branch 4 (friction over escape): unlike catchAllUnknownVerb (which
  // blocks only when a scanned ARGUMENT is gated/ambiguous), the verb token
  // itself is what fails to name a command here, so there may be zero
  // following arguments to scan — delegating to catchAllUnknownVerb's own
  // arg-loop would silently return null/allow in exactly that shape. Named
  // and labeled the same way catchAllUnknownVerb labels a real unknown verb
  // (`unknown verb "X"`) for consistent reporting. A quoted verb that IS a
  // valid bare word (`"cp"`, `'echo'`) falls through and is classified
  // exactly like its unquoted equivalent by every branch below.
  if (verbTok.quoted && !isValidBareVerbToken(verb)) {
    return { branch: 4, detector: `unknown verb "${verb}"`, reason: "quoted-verb-not-a-bare-word", target: verb };
  }
  if (verb === "find") {
    // find's own gating is independent of read/write classification; the
    // -exec'd verb (if any) is separately dispatched by analyzeStage's own
    // xargs/-exec/-execdir side-loop, which calls this same function again.
    const findings = [checkFindNamePattern(stage, gatedExts), checkFindFprintFamily(stage, cwd, gatedExts)].filter(Boolean);
    if (findings.length === 0) return null;
    return findings.reduce((a, b) => (b.branch > a.branch ? b : a));
  }
  if (isKnownReadVerb(stage, verbIdx)) return null;
  const known = dispatchKnownWrite(stage, verbIdx, cwd, gatedExts, depth || 0);
  if (known.found) return known.result;
  return catchAllUnknownVerb(stage, verbIdx, gatedExts);
}

function scanRedirects(stage, cwd, gatedExts) {
  const results = [];
  for (let i = 0; i < stage.length; i++) {
    const t = stage[i];
    if (!t.redirect) continue;
    if (t.value !== ">" && t.value !== ">>") continue; // &> already excluded by this check
    const prev = stage[i - 1];
    if (prev && !prev.quoted && (prev.value === "2" || prev.value === "&")) continue; // stderr/combined
    const next = stage[i + 1];
    if (!next) { results.push({ branch: 4, detector: "redirect", reason: "no-target-token", target: null }); continue; }
    if (/^\/dev\//.test(next.value)) continue;
    results.push(tagDetector(resolveTarget(next.value, cwd, gatedExts), t.value === ">>" ? "append-redirect" : "redirect"));
  }
  return results;
}

// D3: stderr/clobber redirects onto a resolvable target are writes (they
// truncate the file) — `2>`, `2>>`, `&>`, `>|`. Operates on RAW text (not
// tokens) since tokenize() has no concept of these fused operator forms.
// `2>&1`/`1>&2` (fd duplication) and `2>/dev/null`/`>$null` remain non-writes
// — the target char class excludes `&`, so a fd-dup target captures empty
// and is skipped; /dev/null and $null are explicitly excluded too. Shared
// by both the Bash (per cd-segment) and PowerShell (whole-command) callers.
function detectStderrClobberRedirects(rawText, cwd, gatedExts) {
  const results = [];
  const re = /(2>>?|&>|>\|)\s*([^\s|;&<>]*)/g;
  let m;
  while ((m = re.exec(rawText)) !== null) {
    const op = m[1];
    const tgt = m[2];
    if (!tgt) continue; // e.g. 2>&1 — '&' excluded from the target char class, empty capture
    if (/^&[0-9]$/.test(tgt)) continue; // fd duplication, fused form
    if (/^\/dev\/null$/i.test(tgt)) continue;
    if (/^\$null$/i.test(tgt)) continue; // PowerShell's null target
    results.push(tagDetector(resolveTarget(tgt, cwd, gatedExts), `stderr/clobber redirect (${op})`));
  }
  return results;
}

function analyzeStage(stage, cwd, gatedExts, depth) {
  const findings = [];
  findings.push(...scanRedirects(stage, cwd, gatedExts));
  const verbIdx = findPrimaryVerbIndex(stage);
  if (verbIdx !== -1) {
    const f = classifyVerbToken(stage, verbIdx, cwd, gatedExts, depth);
    if (f) findings.push(f);
  }
  for (let k = 0; k < stage.length; k++) {
    const t = stage[k];
    if (!t.quoted && (t.value === "xargs" || t.value === "-exec" || t.value === "-execdir")) {
      const idx2 = k + 1;
      if (idx2 < stage.length && !stage[idx2].quoted && idx2 !== verbIdx) {
        const f = classifyVerbToken(stage, idx2, cwd, gatedExts, depth);
        if (f) findings.push(f);
      }
    }
  }
  return findings.filter(Boolean);
}

// ── cmd /c indirection (documented residual — not a cmd.exe parser) ────────
// Pattern modeled on bash-classifier-bait-guard.js's
// indirectedCmdHasB1aCoOccurrence (lines 465-481) — NOT reused directly,
// since that function checks for a DIFFERENT co-occurrence (protected-path +
// destructive-op); this hook needs a gated-extension + write-verb
// co-occurrence check instead.
function detectCmdCIndirection(rawText, gatedExts) {
  const re = /\bcmd(?:\.exe)?\s+\/c\s+(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  const gatedNoDot = gatedExts.map((e) => String(e).replace(/^\./, "").toLowerCase());
  while ((m = re.exec(rawText)) !== null) {
    const inner = m[1] !== undefined ? m[1] : m[2];
    const hasWriteVerb = /\b(copy|move|echo|type)\b/i.test(inner);
    if (!hasWriteVerb) continue;
    const innerLower = inner.toLowerCase();
    const hasGatedExt = gatedNoDot.some((ext) => innerLower.includes("." + ext));
    if (hasGatedExt) {
      return { branch: 4, detector: "cmd /c indirection", reason: "cmd-grammar-not-parsed", target: null };
    }
  }
  return null;
}

// ── Heredoc-fed interpreter (whole-command scope; body spans multiple lines
// beyond any single cd-tracked segment) ────────────────────────────────────
function detectHeredocFedInterpreter(rawCmd) {
  const re = /\b(node|nodejs|python3?|pwsh|powershell)(?:\.exe)?\s*<<(-?)\s*(['"]?)(\w+)\3/gi;
  let m;
  const lines = rawCmd.split("\n");
  while ((m = re.exec(rawCmd)) !== null) {
    const strip = m[2] === "-";
    const delim = m[4];
    const upto = rawCmd.slice(0, m.index);
    let li = upto.split("\n").length - 1 + 1; // body starts on the next physical line
    const bodyLines = [];
    while (li < lines.length) {
      const checkLine = strip ? lines[li].replace(/^\t*/, "") : lines[li];
      if (checkLine === delim) break;
      bodyLines.push(lines[li]);
      li++;
    }
    const body = bodyLines.join("\n");
    if (WRITE_API_RE.test(body)) {
      return { branch: 4, detector: "heredoc-fed interpreter", reason: "script-body-target-unresolvable", target: null };
    }
  }
  return null;
}

/**
 * Comments must never contribute a target, a verb, a -WhatIf, or an
 * override marker. Bash `#` starts a comment only when it begins a TOKEN —
 * preceded by whitespace, a separator (`;|&(){}`), or at the very start of
 * the string — and is NOT inside a quote (`$#`/`a#b` are not comments,
 * neither is a `#` inside `"..."`/`'...'`). Blanks comment text to spaces
 * (preserving string length/index alignment for every downstream absolute-
 * offset computation) rather than deleting it. Declared residual: heredoc
 * body content is not modeled here (this hook has no heredoc-body-aware
 * pass of its own outside detectHeredocFedInterpreter/computeSegmentCwds),
 * so a literal `#` inside a heredoc body may be blanked incorrectly.
 */
function stripBashComments(text) {
  let out = "";
  let inSingle = false, inDouble = false, atWordStart = true;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inSingle) {
      out += ch; if (ch === "'") inSingle = false;
      atWordStart = false; i++; continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < n) { out += ch + text[i + 1]; i += 2; atWordStart = false; continue; }
      out += ch; if (ch === '"') inDouble = false;
      atWordStart = false; i++; continue;
    }
    if (ch === "'") { inSingle = true; out += ch; atWordStart = false; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; atWordStart = false; i++; continue; }
    if (ch === "#" && atWordStart) {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      for (let k = i; k < j; k++) out += " ";
      i = j;
      continue;
    }
    out += ch;
    atWordStart = /\s/.test(ch) || /[;|&(){}]/.test(ch);
    i++;
  }
  return out;
}

// ── Bash analysis ───────────────────────────────────────────────────────────

function analyzeBash(cmd, initialCwd, gatedExts, depth) {
  cmd = stripBashComments(cmd);
  depth = depth || 0;
  let worst = null;
  function consider(f) { if (f && (!worst || f.branch > worst.branch)) worst = f; }

  consider(detectHeredocFedInterpreter(cmd));

  const cwdSegs = computeSegmentCwds(cmd, initialCwd);
  for (const seg of cwdSegs) {
    if (!seg.text || !seg.text.trim()) continue;
    consider(detectCmdCIndirection(seg.text, gatedExts));
    for (const f of detectStderrClobberRedirects(seg.text, seg.cwd, gatedExts)) consider(f);
    const tokens = tokenize(seg.text);
    const stages = splitSegments(tokens);
    for (const stage of stages) {
      for (const f of analyzeStage(stage, seg.cwd, gatedExts, depth)) consider(f);
    }
  }
  if (!worst) return { allow: true, branch: 1 };
  return { allow: worst.branch <= 2, branch: worst.branch, detector: worst.detector, target: worst.target, reason: worst.reason, ext: worst.ext };
}

// ── PowerShell analysis (simplified — no Set-Location/cd tracking) ─────────

/**
 * D5: strip single/double-quoted CONTENT (keep delimiter chars, preserve
 * string LENGTH so match indices stay aligned with the original `cmd`)
 * before scanning for cmdlet/alias names or -WhatIf — a cmdlet name
 * mentioned only inside a quoted string (Write-Host "Run Set-Content ...")
 * must not be a detector hit. Modeled structurally on pr-independence.js's
 * scrubDataRegions passes 2-3 (blank quoted content, keep delimiters),
 * adapted for PowerShell's backtick escape instead of backslash. Target
 * EXTRACTION still runs against the original unblanked `cmd` text.
 * Residual: PowerShell's doubled '' escaped-literal-quote inside a single-
 * quoted string is not modeled.
 */
function blankPsQuotesForScan(text) {
  let out = "";
  let inSingle = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inSingle) {
      out += ch;
      if (ch === "'") inSingle = true;
    } else if (ch === "'") {
      out += ch;
      inSingle = false;
    } else {
      out += " ";
    }
  }
  const afterSingle = out;
  out = "";
  let inDouble = false;
  for (let i = 0; i < afterSingle.length; i++) {
    const ch = afterSingle[i];
    if (!inDouble) {
      out += ch;
      if (ch === '"') inDouble = true;
    } else if (ch === "`" && i + 1 < afterSingle.length) {
      out += "  ";
      i++;
    } else if (ch === '"') {
      out += ch;
      inDouble = false;
    } else {
      out += " ";
    }
  }
  return out;
}

// Self-found bug, fixed: a flag consumes an ARGUMENT SLOT in PowerShell's
// positional binding even when passed by name — `Set-Content -Value x
// out.ps1` has "out.ps1" as its only REAL positional (position 0 = -Path),
// but the old extraction skipped "-Value" and then kept "x" as if it were
// positional 0, silently allowing the real gated target ("out.ps1",
// invisible at the wrong index) to slip through. Every flag not in this
// known-switch list is assumed to consume the NEXT token as its value
// (PowerShell's actual default), per spec.
const PS_KNOWN_SWITCH_FLAGS = new Set([
  "force", "whatif", "confirm", "recurse", "nonewline", "append", "passthru",
  "noclobber", "asbytestream", "raw", "wait", "verbose", "debug",
]);
// Recognized value-taking flag names (including -ErrorAction/-WarningAction/
// -Encoding, called out explicitly in spec) — seeing one of these does NOT
// make the positional parse ambiguous, since we KNOW it consumes a value.
// Seeing anything else NOT in PS_KNOWN_SWITCH_FLAGS either is the ambiguous
// case: we still consume its value defensively (spec's stated default), but
// flag the parse as ambiguous since we cannot be certain.
const PS_KNOWN_VALUE_FLAGS = new Set([
  "path", "literalpath", "filepath", "destination", "newname", "name",
  "value", "outfile", "uri", "argumentlist", "variable",
  "erroraction", "warningaction", "encoding",
]);

/**
 * Best-effort positional-argument extraction for alias-style / positional
 * cmdlet invocations (`copy a.txt out.ps1`, `Set-Content out.ps1 -Value x`).
 * Every `-Flag` consumes the next non-flag token as its value UNLESS the
 * flag is a KNOWN SWITCH (no value). Collects bare/quoted tokens up to the
 * next `;`/`|`/newline, skipping the matched verb/alias token itself.
 * Returns { positionals, ambiguousFlag, allNonFlagTokens }:
 *   - positionals: tokens NOT consumed by any flag (used for normal,
 *     trustworthy positional-INDEX resolution).
 *   - ambiguousFlag: true when an UNRECOGNIZED flag was seen (not a known
 *     switch, not a known value-flag) — its value is still consumed
 *     defensively, but the positional INDEX mapping is no longer
 *     trustworthy.
 *   - allNonFlagTokens: EVERY non-flag token, including ones consumed as a
 *     value (by ANY flag, known or unknown) — self-found bug, fixed: when
 *     ambiguousFlag is true, a caller that only scanned `positionals` for
 *     gated/ambiguous content missed the real target sitting in a token an
 *     unknown flag had swallowed (`New-Item -Container out.ps1` — "-Container"
 *     is unrecognized, defensively consumes "out.ps1", leaving zero
 *     positionals — the gated token still exists here, just not as a
 *     "positional").
 */
function extractPsPositionals(afterText) {
  const boundary = afterText.search(/[;|\n]/);
  const scope = boundary === -1 ? afterText : afterText.slice(0, boundary);
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const tokens = [];
  let m, first = true;
  while ((m = re.exec(scope)) !== null) {
    if (first) { first = false; continue; } // skip the matched verb/alias token itself
    tokens.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  const positionals = [];
  const allNonFlagTokens = [];
  let ambiguousFlag = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^-/.test(tok)) {
      const flagLower = tok.replace(/^-+/, "").toLowerCase();
      if (PS_KNOWN_SWITCH_FLAGS.has(flagLower)) continue; // no value consumed
      if (!PS_KNOWN_VALUE_FLAGS.has(flagLower)) ambiguousFlag = true;
      if (i + 1 < tokens.length) { i++; allNonFlagTokens.push(tokens[i]); } // consume its value (not a positional, but still scannable)
      continue;
    }
    positionals.push(tok);
    allNonFlagTokens.push(tok);
  }
  return { positionals, ambiguousFlag, allNonFlagTokens };
}

/**
 * When extractPsPositionals reports an unrecognized flag, the positional
 * INDEX mapping is unreliable, so per spec: branch 4 whenever ANY non-flag
 * token — including one an unknown flag consumed as its (bogus) value — is
 * gated or ambiguous, else no finding (branch 1). Pass `allNonFlagTokens`,
 * not just `positionals`, here.
 */
function resolvePsAmbiguousPositionals(allNonFlagTokens, verbName, gatedExts) {
  const hit = allNonFlagTokens.find((tok) => {
    if (isAmbiguousToken(tok)) return true;
    const bn = tok.slice(Math.max(tok.lastIndexOf("/"), tok.lastIndexOf("\\")) + 1);
    return classifyExtension(bn, gatedExts).branch >= 3;
  });
  if (hit === undefined) return null;
  return { branch: 4, detector: verbName, reason: "ambiguous-positional-parse", target: hit };
}

// E2: quote-aware split of a PowerShell command into top-level statements on
// `;`, `|` (pipeline boundary), `&&`, `||`, or newline — NOT inside a quoted
// span. -WhatIf (and every other per-statement check) is then evaluated PER
// STATEMENT, so `Get-ChildItem -WhatIf; Set-Content -Path out.ps1 -Value x`
// still blocks on its second statement even though the first carries -WhatIf.
function splitPsStatements(cmd) {
  const segments = [];
  let cur = "";
  let inSingle = false, inDouble = false;
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const ch = cmd[i];
    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      if (ch === "`" && i + 1 < n) { cur += ch + cmd[i + 1]; i += 2; continue; }
      cur += ch;
      if (ch === '"') inDouble = false;
      i++; continue;
    }
    if (ch === "'") { inSingle = true; cur += ch; i++; continue; }
    if (ch === '"') { inDouble = true; cur += ch; i++; continue; }
    if (ch === ";" || ch === "\n") { segments.push(cur); cur = ""; i++; continue; }
    if (ch === "|" && cmd[i + 1] === "|") { segments.push(cur); cur = ""; i += 2; continue; }
    if (ch === "|") { segments.push(cur); cur = ""; i++; continue; }
    if (ch === "&" && cmd[i + 1] === "&") { segments.push(cur); cur = ""; i += 2; continue; }
    cur += ch;
    i++;
  }
  segments.push(cur);
  return segments;
}

// F4: a cmdlet/alias name regex must match ONLY in VERB POSITION — the
// start of the statement, or right after a command-boundary character
// (`;`, `|`, `&`, `(`, `{`) possibly with whitespace in between — never
// glued to a preceding word character. Without this, e.g. `Test-Path -Path
// report.mi` false-matched the "mi" alias (Move-Item) purely because "mi"
// happens to be the file EXTENSION of an unrelated argument (".mi" is
// preceded by a "." — a non-word char — so a bare `\b` boundary alone does
// not protect against this). `;`/`|`/`&&`/`||` are already consumed as
// statement separators by splitPsStatements before this function ever sees
// the text, but a `{`/`(`/`&` (script block, subexpression, call operator)
// can still introduce a fresh verb position WITHIN one statement.
const PS_VERB_BOUNDARY_CHARS = new Set([";", "|", "&", "(", "{"]);

function isPsVerbPosition(text, matchIndex) {
  let j = matchIndex - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true; // start of statement (ignoring leading whitespace)
  return PS_VERB_BOUNDARY_CHARS.has(text[j]);
}

/** Global search for the first VERB-POSITION match of `re` in `text` (or null). */
function findPsVerbPositionMatch(text, re) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const globalRe = new RegExp(re.source, flags);
  let m;
  while ((m = globalRe.exec(text)) !== null) {
    if (isPsVerbPosition(text, m.index)) return m;
    if (globalRe.lastIndex === m.index) globalRe.lastIndex++; // guard against zero-length matches
  }
  return null;
}

/** Classification for ONE PowerShell statement — returns a finding object or null. */
// ── PowerShell D1 inversion (was a fixed cmdlet allow-list) ────────────────
// analyzePsStatement previously only fired on a FIXED set of write cmdlets/
// aliases/dotnet patterns — anything else (Invoke-WebRequest -OutFile,
// Start-Process, any third-party cmdlet) fell through unnoticed. Total
// classification per clause, mirroring the Bash-side D1 design:
//   (i)   known-read cmdlet/alias           -> branch 1, no argument scan
//   (ii)  known-write cmdlet/alias/.NET call -> existing target resolution
//   (iii) Invoke-WebRequest/-RestMethod/curl/wget/iwr/irm -> write iff -OutFile
//   (iv)  ANY OTHER cmdlet/alias/verb in verb position whose arguments
//         include a gated/ambiguous token, or a named path-flag with a
//         gated value -> branch 4 naming the cmdlet (friction default)
//   (v)   otherwise -> branch 1
// A "clause" is a maximal run of text between structural boundary
// characters (; | & ( ) { } =) — finer-grained than statement-splitting
// (which only handles top-level ;/|/&&/||), so a write cmdlet nested inside
// a script block (`ForEach-Object { Set-Content ... }`) or after `=`
// (`$x = Set-Content ...`) is still independently classified.

const PS_KNOWN_READ_EXACT = new Set([
  "out-string", "out-host", "write-output", "write-host", "where-object",
  "foreach-object", "resolve-path", "split-path", "join-path",
  "compare-object", "invoke-scriptanalyzer",
]);
// "tee-less": deliberately excludes "tee" (Tee-Object writes to a file).
const PS_KNOWN_READ_ALIASES = new Set([
  "gc", "gci", "ls", "dir", "cat", "type", "select", "where", "foreach", "sort", "measure",
]);

// Control-flow KEYWORDS (if/elseif/while/until/switch/for/try/catch/
// finally/do). Treated as read for their OWN clause (keyword + condition
// header, e.g. `if ($x -eq 1)`), which is kept together with its parens by
// splitPsClauses (see PS_CONTROL_FLOW_KEYWORDS below) the same way a
// function call's own arg-list parens are — WITHOUT this, a condition
// containing any `$variable` (extremely common) would spuriously scan as
// an "unrecognized clause" argument and produce a false branch-4 for
// ordinary, harmless control flow. Any REAL write cmdlet after the `{`
// that follows is still an independent clause, classified normally.
// DECLARED RESIDUAL: a write cmdlet placed INSIDE the condition itself
// (`if (Set-Content -Path out.ps1 -Value x) { }`) is swallowed by this
// skip and never independently classified — see report.
const PS_CONTROL_FLOW_KEYWORDS = new Set([
  "if", "elseif", "while", "until", "switch", "for", "foreach", "try", "catch", "finally", "do", "else",
]);

function isPsKnownReadVerb(verbName) {
  const lower = verbName.toLowerCase();
  // ConvertTo-* removed per-round: a `ConvertTo-*` cmdlet with a
  // -Path/-FilePath/-LiteralPath argument is a real write (see
  // resolvePsExportConvertTo below) — letting it fall through to normal
  // classification (rather than an unconditional read) still allows the
  // common no-such-flag case (nothing gated found -> branch 1 anyway).
  if (/^get-/.test(lower) || /^test-/.test(lower) || /^measure-/.test(lower) ||
      /^select-/.test(lower) || /^format-/.test(lower) ||
      /^convertfrom-/.test(lower)) return true;
  if (PS_KNOWN_READ_EXACT.has(lower)) return true;
  if (PS_KNOWN_READ_ALIASES.has(lower)) return true;
  if (PS_CONTROL_FLOW_KEYWORDS.has(lower)) return true;
  return false;
}

// ── Per-cmdlet target map (was one generic -Destination/-Path fallback) ────
// Each write cmdlet/alias has its OWN target parameter — reusing a single
// "-Destination wins over -Path" rule silently broke shapes like Rename-Item
// (whose real target is -NewName, never -Path or -Destination) and treated
// Copy-Item/Move-Item's -Path (the SOURCE) as an acceptable fallback target.
const PS_ROLE_NEWNAME = new Set(["rename-item", "rni", "ren"]);
const PS_ROLE_DESTINATION = new Set(["copy-item", "move-item", "cpi", "mi", "copy", "move"]);
const PS_ROLE_PATH_FIRST = new Set(["set-content", "add-content", "out-file", "sc", "ac"]);
const PS_ROLE_NEWITEM = new Set(["new-item", "ni"]);
const PS_ROLE_TEE = new Set(["tee-object"]);
const PS_ROLE_START_PROCESS = new Set(["start-process"]);

function isPsKnownWriteVerb(verbName) {
  const lower = verbName.toLowerCase();
  return PS_ROLE_NEWNAME.has(lower) || PS_ROLE_DESTINATION.has(lower) ||
    PS_ROLE_PATH_FIRST.has(lower) || PS_ROLE_NEWITEM.has(lower) ||
    PS_ROLE_TEE.has(lower) || PS_ROLE_START_PROCESS.has(lower);
}

const PS_WEB_REQUEST_VERBS = new Set(["invoke-webrequest", "invoke-restmethod", "curl", "wget", "iwr", "irm"]);
// Export-*/ConvertTo-* are not in the known-write set above (too many
// distinct cmdlets to enumerate) — they are instead caught by the generic
// catch-all's own named-path-flag scan (classifyPsClauseArguments already
// checks -Path/-FilePath/-LiteralPath), which is why ConvertTo-* was removed
// from isPsKnownReadVerb rather than special-cased here.

/**
 * Self-found escape, fixed: PowerShell's colon-bound parameter syntax
 * (`-Path:out.ps1`, `-OutFile:'out.ps1'`, `-Destination:"out.ps1"`) fuses
 * the flag and its value into ONE whitespace-delimited token, which none of
 * the `-Flag\s+value` regexes below (or the catch-all's simple tokenizer)
 * ever matched — the fused token was skipped outright as "just another
 * flag", and its value's extension was never checked. Rewriting `-Word:`
 * (any flag name, immediately followed by non-whitespace) to `-Word ` once,
 * up front, makes every downstream consumer (known-write extraction,
 * web-request -OutFile, catch-all) see the exact shape it already handles
 * — fixed in one place rather than duplicated across three regexes.
 *
 * Self-found bug, fixed: a KNOWN SWITCH (-Confirm, -WhatIf, ...) never
 * takes a real value — `-Confirm:$false` binds `$false` to the SWITCH
 * itself, not a separate positional argument. Rewriting it the same way as
 * a value-flag (`-Confirm $false`) left a stray "$false" token that
 * extractPsPositionals's tokenizer then treated as a genuine positional
 * (shifting index-based target resolution, e.g. Rename-Item's -NewName-at-
 * positional-2 lookup). Known-switch colon-bindings are stripped entirely
 * (the flag name is kept, its bound value discarded) BEFORE the generic
 * colon-to-space rewrite runs.
 */
const PS_SWITCH_COLON_STRIP_RE = new RegExp(
  "(-(?:" + Array.from(PS_KNOWN_SWITCH_FLAGS).join("|") + ")\\b):\\S+",
  "gi"
);

function normalizePsColonParams(text) {
  text = text.replace(PS_SWITCH_COLON_STRIP_RE, "$1");
  return text.replace(/(-[A-Za-z][A-Za-z0-9]*):(?=\S)/g, "$1 ");
}

function psNamedFlagValue(rawFromVerb, flagAlternation) {
  const m = rawFromVerb.match(new RegExp("-(?:" + flagAlternation + ")\\s+(?:\"([^\"]+)\"|'([^']+)'|(\\S+))", "i"));
  return m ? (m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3])) : null;
}

/**
 * Per-cmdlet target resolution — replaces the old one-size-fits-all
 * -Destination/-Path fallback. Always returns a finding object (never a
 * bare string) so cmdlets needing bespoke handling (Copy-Item/Move-Item's
 * directory-join, New-Item's -Path+-Name join, Start-Process's inherent
 * ambiguity) can be resolved in one place. A mapped target parameter that
 * is absent AND has no positional value -> branch 4 (unresolvable).
 */
function resolvePsKnownWriteClause(verbName, rawFromVerb, cwd, gatedExts) {
  const lower = verbName.toLowerCase();
  const unresolvable = () => ({ branch: 4, detector: verbName, reason: "unresolvable-target", target: null });

  // Start-Process: -FilePath (program) / -ArgumentList (its args) never
  // resolve a real file-write target — an arbitrary process can write
  // anything — so this is unconditionally ambiguous.
  if (PS_ROLE_START_PROCESS.has(lower)) {
    return { branch: 4, detector: verbName, reason: "process-target-unknowable", target: null };
  }

  // Rename-Item/rni/ren -> -NewName ONLY (never -Path, the source being
  // renamed). Positional 2 (0-indexed 1) when unnamed: `Rename-Item a b`.
  if (PS_ROLE_NEWNAME.has(lower)) {
    let target = psNamedFlagValue(rawFromVerb, "NewName");
    if (!target) {
      const p = extractPsPositionals(rawFromVerb);
      if (p.ambiguousFlag) return resolvePsAmbiguousPositionals(p.allNonFlagTokens, verbName, gatedExts);
      target = p.positionals[1];
    }
    if (!target) return unresolvable();
    return tagDetector(resolveTarget(target, cwd, gatedExts), verbName);
  }

  // Copy-Item/Move-Item/cpi/mi/copy/move -> -Destination ONLY (never
  // -Path/-LiteralPath/-FilePath, the SOURCE). Directory-shaped destination
  // joins with the source's basename (same helpers as the Bash cp/mv path).
  if (PS_ROLE_DESTINATION.has(lower)) {
    let dest = psNamedFlagValue(rawFromVerb, "Destination");
    let source = psNamedFlagValue(rawFromVerb, "LiteralPath|FilePath|Path");
    if (!dest || !source) {
      const p = extractPsPositionals(rawFromVerb);
      if (p.ambiguousFlag) return resolvePsAmbiguousPositionals(p.allNonFlagTokens, verbName, gatedExts);
      if (!source) source = p.positionals[0];
      if (!dest) dest = p.positionals[1];
    }
    if (!dest) return unresolvable();
    if (source && isDirLikeDest(dest, cwd)) {
      if (isAmbiguousToken(source)) {
        return { branch: 4, detector: verbName, reason: "ambiguous-source-for-dir-join", target: source };
      }
      return tagDetector(resolveTarget(joinDirDest(dest, source), cwd, gatedExts), verbName);
    }
    return tagDetector(resolveTarget(dest, cwd, gatedExts), verbName);
  }

  // Set-Content/Add-Content/Out-File/sc/ac -> -Path/-LiteralPath/-FilePath,
  // positional 1 (0-indexed 0) when unnamed.
  if (PS_ROLE_PATH_FIRST.has(lower)) {
    let target = psNamedFlagValue(rawFromVerb, "LiteralPath|FilePath|Path");
    if (!target) {
      const p = extractPsPositionals(rawFromVerb);
      if (p.ambiguousFlag) return resolvePsAmbiguousPositionals(p.allNonFlagTokens, verbName, gatedExts);
      target = p.positionals[0];
    }
    if (!target) return unresolvable();
    return tagDetector(resolveTarget(target, cwd, gatedExts), verbName);
  }

  // New-Item/ni -> -Path joined with -Name when BOTH are present (typical
  // `New-Item -Path dir -Name file.ext` form); -Path alone is already the
  // full path; falls back to positional 1 otherwise.
  if (PS_ROLE_NEWITEM.has(lower)) {
    const pathVal = psNamedFlagValue(rawFromVerb, "LiteralPath|Path");
    const nameVal = psNamedFlagValue(rawFromVerb, "Name");
    let target;
    if (pathVal && nameVal) {
      if (isAmbiguousToken(pathVal) || isAmbiguousToken(nameVal)) {
        return { branch: 4, detector: verbName, reason: "ambiguous-target-token", target: isAmbiguousToken(pathVal) ? pathVal : nameVal };
      }
      target = pathVal.replace(/[/\\]+$/, "") + "/" + nameVal;
    } else {
      target = pathVal || nameVal;
    }
    if (!target) {
      const p = extractPsPositionals(rawFromVerb);
      if (p.ambiguousFlag) return resolvePsAmbiguousPositionals(p.allNonFlagTokens, verbName, gatedExts);
      target = p.positionals[0];
    }
    if (!target) return unresolvable();
    return tagDetector(resolveTarget(target, cwd, gatedExts), verbName);
  }

  // Tee-Object -> -FilePath (resolvable file write) or -Variable (stores in
  // memory, not a file — but per spec still treated as ambiguous rather
  // than silently allowed, since we cannot further validate it either way).
  if (PS_ROLE_TEE.has(lower)) {
    const fileVal = psNamedFlagValue(rawFromVerb, "FilePath");
    if (fileVal) return tagDetector(resolveTarget(fileVal, cwd, gatedExts), verbName);
    if (/-Variable\b/i.test(rawFromVerb)) {
      return { branch: 4, detector: verbName, reason: "tee-variable-ambiguous", target: null };
    }
    return unresolvable();
  }

  return unresolvable();
}

/** -OutFile target for the web-request cmdlet family (undefined = no -OutFile at all -> read). */
function extractPsOutFileTarget(rawFromVerb) {
  const m = rawFromVerb.match(/-OutFile\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

const PS_NAMED_PATH_FLAG_RE = /^-(?:OutFile|FilePath|Path|LiteralPath|Destination|Target|PSPath)$/i;

/** (iv) catch-all: gated/ambiguous bare argument OR named path-flag value. */
function classifyPsClauseArguments(verbName, rawFromVerb, gatedExts) {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const tokens = [];
  let m, first = true;
  while ((m = re.exec(rawFromVerb)) !== null) {
    if (first) { first = false; continue; } // skip the verb token itself
    tokens.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (PS_NAMED_PATH_FLAG_RE.test(tok)) {
      const val = tokens[i + 1];
      if (val === undefined) return { branch: 4, detector: `unknown cmdlet "${verbName}"`, reason: "named-flag-missing-value", target: null };
      if (isAmbiguousToken(val)) return { branch: 4, detector: `unknown cmdlet "${verbName}"`, reason: "named-flag-ambiguous-value", target: val };
      const bn = val.slice(Math.max(val.lastIndexOf("/"), val.lastIndexOf("\\")) + 1);
      if (classifyExtension(bn, gatedExts).branch >= 3) {
        return { branch: 4, detector: `unknown cmdlet "${verbName}"`, reason: "named-flag-gated-value", target: val };
      }
      i++;
      continue;
    }
    if (/^-/.test(tok)) continue;
    if (isAmbiguousToken(tok)) return { branch: 4, detector: `unknown cmdlet "${verbName}"`, reason: "argument-ambiguous", target: tok };
    const bn = tok.slice(Math.max(tok.lastIndexOf("/"), tok.lastIndexOf("\\")) + 1);
    if (classifyExtension(bn, gatedExts).branch >= 3) {
      return { branch: 4, detector: `unknown cmdlet "${verbName}"`, reason: "argument-gated", target: tok };
    }
  }
  return null;
}

/**
 * Split (quote-blanked) text into clause {start,end} offsets on structural
 * boundaries. NOTE: bare "&" is deliberately NOT a hard boundary here (it
 * was originally one, but that fragmented the call operator `& (...)` /
 * `& $var` / `& "..."` from its own following shape into TWO separate
 * clauses — the "&" ending up alone in an empty clause and the "(...)"
 * content starting a fresh one, so findPsCallOperatorRest's own
 * position-0-of-the-clause check never saw them together and silently
 * missed the whole construct (self-found regression while extending the
 * check to every clause). "&" is instead recognized exclusively by
 * findPsCallOperatorRest itself, checked at the start of each clause below.
 */
function splitPsClauses(scanText) {
  const clauses = [];
  let last = 0;
  for (let i = 0; i < scanText.length; i++) {
    const ch = scanText[i];
    if (ch === ";" || ch === "|" || ch === "{" || ch === "}" || ch === "=") {
      clauses.push({ start: last, end: i });
      last = i + 1;
      continue;
    }
    if (ch === "(") {
      // A "(" immediately preceded by an identifier character (letter/
      // digit/_) is a FUNCTION/METHOD CALL's own argument-list paren
      // (`Open(`, `StreamWriter(`, `::new(`) and must stay in the SAME
      // clause as the call so detectDotNetIoMutation can see the whole
      // thing — splitting here was a real bug (self-found): it fragmented
      // `[IO.File]::Open('x', [IO.FileMode]::Create)` into a piece ending
      // right after "Open", hiding the qualifying "Create" marker in a
      // separate clause and silently allowing the write.
      const prev = i > 0 ? scanText[i - 1] : "";
      let keepTogether = /[A-Za-z0-9_]/.test(prev);
      if (!keepTogether) {
        // Also keep together when the word right before "(" (skipping
        // whitespace) is a control-flow KEYWORD (`if (`, `foreach (`,
        // `while (`, ...) — that "(" opens a CONDITION/HEADER, not a fresh
        // command position; splitting there let a condition's own
        // `$variable` (extremely common) spuriously scan as an
        // "unrecognized clause" argument and false-block ordinary control
        // flow (self-found while implementing per-clause call-operator
        // detection). A genuine bare subexpression used AS a command
        // (`(mi a.txt b.ps1)`) has no such keyword before it and still
        // splits normally.
        let j = i - 1;
        while (j >= 0 && /\s/.test(scanText[j])) j--;
        if (j >= 0 && (scanText[j] === "&" || scanText[j] === ".")) {
          // The call/dot-source operator immediately (mod whitespace)
          // before "(" — this is `& (...)` / `. (...)`, which
          // findPsCallOperatorRest needs to see as ONE clause starting
          // with the operator. Keep together.
          keepTogether = true;
        } else {
          let k = j;
          while (k >= 0 && /[A-Za-z]/.test(scanText[k])) k--;
          const word = scanText.slice(k + 1, j + 1).toLowerCase();
          if (PS_CONTROL_FLOW_KEYWORDS.has(word)) keepTogether = true;
        }
      }
      if (!keepTogether) {
        clauses.push({ start: last, end: i });
        last = i + 1;
      }
      continue;
    }
    // ")" is deliberately never a boundary — see the comment above; the
    // matching "(" already decided whether this paren-span was split.
  }
  clauses.push({ start: last, end: scanText.length });
  return clauses;
}

/**
 * Item 2: `&` (call operator) or `.` (dot-source) followed — after optional
 * whitespace — by a parenthesized expression, a variable, or a string
 * (`& (Get-Command X) ...`, `& $cmd ...`, `& "Set-Content" ...`) computes
 * its ACTUAL verb at runtime; it cannot be identified statically. Detected
 * only at the START of a statement (its normal syntactic position — these
 * operators invoke a fresh command, not a mid-expression construct).
 * Returns the ORIGINAL (unblanked) text following the operator's own
 * verb-shape (i.e. everything that would be arguments to the dynamic
 * verb), or null if the statement does not start with this shape.
 */
function findPsCallOperatorRest(scanText, stmt) {
  const m = scanText.match(/^\s*[&.]\s*(\(|\$|["'])/);
  if (!m) return null;
  const shapeChar = m[1];
  const shapeStart = m.index + m[0].length - 1;
  let endPos;
  if (shapeChar === "(") {
    let depth = 0, i = shapeStart;
    for (; i < scanText.length; i++) {
      if (scanText[i] === "(") depth++;
      else if (scanText[i] === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    endPos = i;
  } else if (shapeChar === "$") {
    const varMatch = scanText.slice(shapeStart).match(/^\$[A-Za-z_][A-Za-z0-9_]*/);
    endPos = shapeStart + (varMatch ? varMatch[0].length : 1);
  } else {
    // Quote delimiter: scanText preserves the delimiter chars even though
    // the CONTENT between them is blanked — find the matching closer.
    const closeIdx = scanText.indexOf(shapeChar, shapeStart + 1);
    endPos = closeIdx === -1 ? scanText.length : closeIdx + 1;
  }
  return stmt.slice(endPos);
}

/**
 * Self-found bug, fixed: `-WhatIf` only means "simulate, don't actually
 * write" when it is bare (no explicit value) or explicitly bound to
 * `$true`. `-WhatIf:$false`, `-WhatIf:$anyVar`, or `-WhatIf:(expr)` bind an
 * EXPLICIT value that is not statically known to be true (a variable could
 * hold anything at runtime) — treating those as suppression would silently
 * allow a real write. A blanket `/-WhatIf\b/` match treated ALL of these
 * identically (bare and colon-bound alike), since `\b` matches right
 * before the `:` too.
 */
function psWhatIfSuppresses(scanText) {
  const re = /-WhatIf\b(?::(\S+))?/gi;
  let m;
  while ((m = re.exec(scanText)) !== null) {
    const bound = m[1];
    if (bound === undefined) return true; // bare -WhatIf
    if (/^\$true$/i.test(bound)) return true; // -WhatIf:$true
    // -WhatIf:$false / -WhatIf:$anyVar / -WhatIf:(expr) -> NOT suppressed;
    // keep scanning in case a LATER -WhatIf in the same statement text
    // (unusual, but not impossible) does qualify.
  }
  return false;
}

function analyzePsStatement(stmt, initialCwd, gatedExts) {
  const scanText = blankPsQuotesForScan(stmt);

  let worst = null;
  function consider(f) { if (f && (!worst || f.branch > worst.branch)) worst = f; }

  for (const clause of splitPsClauses(scanText)) {
    const clauseScanText = scanText.slice(clause.start, clause.end);
    const clauseRawText = stmt.slice(clause.start, clause.end);

    // D5/E2 (fixed — per-clause, not whole-statement): -WhatIf suppresses
    // only the clause that carries its OWN bare -WhatIf/-WhatIf:$true — a
    // clause elsewhere in the same statement (a different `if`/`else`
    // branch, a later statement in the same `{ }` block, a sibling
    // `try`/`catch` body) is classified normally regardless. Self-found
    // bug (whole-statement scope): `if ($true) { Get-Item -WhatIf } else
    // { Set-Content -Path out.ps1 -Value x }` is ONE statement (no top-
    // level ;/|/&&/||), so a single -WhatIf anywhere used to suppress the
    // REAL write in the `else` branch too.
    if (psWhatIfSuppresses(clauseScanText)) continue;

    // Item 2 (extended): ambiguous call/dot-source operator, checked at
    // EVERY clause start (not just the statement start) — a clause nested
    // inside a script block (`{ & $cmd ... }`) must be classified the same
    // way as one at the top level. The real verb is unknown, so scan its
    // arguments like the unknown-verb catch-all (branch 4 iff any argument
    // is gated/ambiguous, else no finding from this clause).
    const callOpRest = findPsCallOperatorRest(clauseScanText, clauseRawText);
    if (callOpRest !== null) {
      consider(classifyPsClauseArguments("&", "X " + callOpRest, gatedExts));
      continue;
    }

    // .NET bracket-syntax / New-Object mutation check — these do not start
    // with a plain identifier (`[IO.File]::...`), so they must be checked
    // before (and independent of) the identifier-based verbMatch.
    const dm = detectDotNetIoMutation(clauseScanText);
    if (dm) {
      if (dm.style === "dotnet-read") continue; // recognized (StreamReader / read-access FileStream) but not a mutation
      const rawFromDm = stmt.slice(clause.start + dm.idx, clause.end);
      const target = extractNthStringLiteral(rawFromDm, dm.argIndex || 0);
      if (!target) {
        consider({ branch: 4, detector: dm.verb, reason: "unresolvable-target", target: null });
      } else {
        const resolved = resolveTarget(target, initialCwd, gatedExts);
        consider({ branch: resolved.branch, detector: dm.verb, target: resolved.target, reason: resolved.reason, ext: resolved.ext });
      }
      continue;
    }

    const leadWs = clauseScanText.match(/^\s*/)[0].length;
    const verbMatch = clauseScanText.slice(leadWs).match(/^[A-Za-z_][A-Za-z0-9_.:-]*/);
    if (!verbMatch) {
      const content = clauseRawText.slice(leadWs);
      // A clause starting with "[" is .NET bracket/type-literal syntax
      // (`[IO.File]::ReadAllText(...)`, `[IO.FileMode]::Open`) already
      // evaluated by detectDotNetIoMutation above (which returned null —
      // recognized-but-not-a-mutation, or simply out of scope like
      // ReadAllText/OpenText). Self-found bug: scanning it as
      // "unrecognized clause" content misfired on the brackets themselves —
      // `[`/`]` are also this hook's GLOB-ambiguity markers — falsely
      // flagging a pure read as branch 4. Skip rather than scan.
      if (/^\[/.test(content)) continue;
      // A clause whose first token is neither a valid identifier nor a
      // recognized call-operator form is never silently skipped: scan its
      // own content the same way an unrecognized verb's arguments are
      // scanned (branch 4 iff gated/ambiguous, else no finding).
      if (content.trim()) consider(classifyPsClauseArguments("(unrecognized clause)", "X " + content, gatedExts));
      continue;
    }
    const verbName = verbMatch[0];
    const lowerVerb = verbName.toLowerCase();
    const absVerbStart = clause.start + leadWs;
    // Colon-bound parameters (`-Path:out.ps1`, `-OutFile:'out.ps1'`) are
    // valid PowerShell syntax equivalent to a space-separated flag+value —
    // normalize colon to a space BEFORE any named-flag extraction so every
    // consumer (known-write target extraction, web-request -OutFile,
    // catch-all) sees the same shape it already handles. Self-found escape,
    // fixed here rather than duplicated in three regexes.
    const rawFromVerb = normalizePsColonParams(stmt.slice(absVerbStart, clause.end));

    // Sole `gh` exception (see comment above KNOWN_READ_VERBS in the Bash
    // section): `gh api <endpoint>` is read here too — same predicate,
    // tokenized from this clause's raw text via psTokensForGhApiCheck.
    if (verbName === "gh" && isGhApiReadSegment(psTokensForGhApiCheck(rawFromVerb), 0)) continue;

    if (isPsKnownReadVerb(verbName)) continue;

    if (PS_WEB_REQUEST_VERBS.has(lowerVerb)) {
      const outFile = extractPsOutFileTarget(rawFromVerb);
      if (outFile === undefined) continue; // no -OutFile -> read
      consider(tagDetector(resolveTarget(outFile, initialCwd, gatedExts), verbName));
      continue;
    }

    if (isPsKnownWriteVerb(verbName)) {
      consider(resolvePsKnownWriteClause(verbName, rawFromVerb, initialCwd, gatedExts));
      continue;
    }

    consider(classifyPsClauseArguments(verbName, rawFromVerb, gatedExts));
  }

  // Plain redirect (>,>>), whole-statement scope — not tied to a specific clause.
  const redirRe = /(?<![2&])(1?>>?)\s*([^\s|;&<>]*)/g;
  let rm;
  while ((rm = redirRe.exec(scanText)) !== null) {
    const tokRaw = rm[2];
    if (!tokRaw) continue;
    if (/^\/dev\//.test(tokRaw)) continue;
    if (/^\$null$/i.test(tokRaw)) continue;
    consider(tagDetector(resolveTarget(tokRaw, initialCwd, gatedExts), "PowerShell redirect"));
  }

  return worst;
}

/**
 * Comments must never contribute a target, a verb, a -WhatIf, or an
 * override marker. PowerShell `#` starts a line comment anywhere OUTSIDE a
 * quote (unlike Bash, PowerShell does not require `#` to be token-initial);
 * `<# ... #>` is a block comment (can span multiple lines). Blanks comment
 * text to spaces (newlines kept as newlines, so line/statement splitting
 * elsewhere is unaffected) rather than deleting it, preserving index
 * alignment for every downstream absolute-offset computation.
 */
function stripPsComments(text) {
  let out = "";
  let inSingle = false, inDouble = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inSingle) {
      out += ch; if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      if (ch === "`" && i + 1 < n) { out += ch + text[i + 1]; i += 2; continue; }
      out += ch; if (ch === '"') inDouble = false;
      i++; continue;
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    if (ch === "<" && text[i + 1] === "#") {
      const closeIdx = text.indexOf("#>", i + 2);
      const end = closeIdx === -1 ? n : closeIdx + 2;
      for (let j = i; j < end; j++) out += (text[j] === "\n" ? "\n" : " ");
      i = end;
      continue;
    }
    if (ch === "#") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      for (let k = i; k < j; k++) out += " ";
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function analyzePowerShell(cmd, initialCwd, gatedExts) {
  cmd = stripPsComments(cmd);
  const statements = splitPsStatements(cmd);
  let worst = null;
  for (const stmt of statements) {
    if (!stmt.trim()) continue;
    const r = analyzePsStatement(stmt, initialCwd, gatedExts);
    if (r && (!worst || r.branch > worst.branch)) worst = r;
  }

  // D3: stderr/clobber redirects, whole-command scope (no cd-tracking here;
  // -WhatIf does not suppress a shell-level redirect, so this stays
  // unscoped by statement — see report).
  const stderrFindings = detectStderrClobberRedirects(cmd, initialCwd, gatedExts);
  for (const f of stderrFindings) {
    if (f && (!worst || f.branch > worst.branch)) worst = f;
  }

  if (!worst) return { allow: true, branch: 1 };
  return { allow: worst.branch <= 2, branch: worst.branch, detector: worst.detector, target: worst.target, reason: worst.reason, ext: worst.ext };
}

// ── Override + top-level dispatch ──────────────────────────────────────────

const OVERRIDE_RE = /^SHELL_WRITE_OK=1\s/;

function classifyCommand(cmd, cwd, toolName, gatedExts) {
  if (typeof cmd !== "string" || cmd === "") return { allow: true, branch: 1 };
  if (OVERRIDE_RE.test(cmd)) return { allow: true, branch: 1, overridden: true, detector: "override" };
  if (toolName === "PowerShell") return analyzePowerShell(cmd, cwd, gatedExts);
  return analyzeBash(cmd, cwd, gatedExts);
}

module.exports = {
  classifyCommand,
  analyzeBash,
  analyzePowerShell,
  classifyExtension,
  resolveTarget,
  findPrimaryVerbIndex,
  isAmbiguousToken,
  detectCmdCIndirection,
  detectHeredocFedInterpreter,
  detectStderrClobberRedirects,
  isKnownReadVerb,
  isGhApiReadSegment,
  psTokensForGhApiCheck,
  classifyVerbToken,
  catchAllUnknownVerb,
  checkFindNamePattern,
  checkFindFprintFamily,
  findHasDeleteOrWriteExecAction,
  findHasFprintFamilyFlag,
  blankPsQuotesForScan,
  detectDotNetIoMutation,
  isDynamicInterpreterBody,
  classifyFileStreamAccess,
  isPsVerbPosition,
  splitPsClauses,
  isPsKnownReadVerb,
  isPsKnownWriteVerb,
  normalizePsColonParams,
  resolvePsKnownWriteClause,
  findPsCallOperatorRest,
  psNamedFlagValue,
  psWhatIfSuppresses,
  stripBashComments,
  stripPsComments,
  extractPsPositionals,
  resolvePsAmbiguousPositionals,
  findPsVerbPositionMatch,
  extractFirstStringLiteral,
  extractNthStringLiteral,
  splitPsStatements,
  analyzePsStatement,
  loadConfig,
  DEFAULT_GATED_EXTENSIONS,
};

// ── Standalone hook mode ────────────────────────────────────────────────────

function main() {
  let raw;
  try { raw = fs.readFileSync(0, "utf8"); } catch (_) { process.exit(0); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { process.exit(0); }

  const tool_name = parsed.tool_name || "";
  const tool_input = parsed.tool_input || {};
  const cmd = (typeof tool_input.command === "string") ? tool_input.command : "";
  const cwd = (typeof parsed.cwd === "string" && parsed.cwd) ? parsed.cwd : null;

  if (tool_name !== "Bash" && tool_name !== "PowerShell") {
    process.exit(0);
  }

  const gatedExts = loadConfig();
  let result;
  try {
    result = classifyCommand(cmd, cwd, tool_name, gatedExts);
  } catch (_) {
    result = { allow: true, branch: 1, reason: "internal-error-fail-open" };
  }

  appendDebug({
    ts: new Date().toISOString(),
    tool_name,
    caller: parsed.agent_id ? String(parsed.agent_id) : "ROOT",
    allow: result.allow,
    branch: result.branch,
    detector: result.detector || null,
    target: result.target || null,
    overridden: !!result.overridden,
    cmd_prefix: cmd.slice(0, 100),
  });

  if (result.allow) process.exit(0);

  process.stderr.write(
    `shell-write-guard: BLOCKED (branch ${result.branch}) — detector: ${result.detector || "unknown"}` +
    (result.target ? `, resolved target: ${result.target}` : ", target: unresolvable") + ".\n" +
    `Reason: ${result.reason || "gated extension"}.\n` +
    "Fix: Delegate this edit to a subagent that uses the Edit/Write tool (they trigger the PostToolUse linter); " +
    "a shell write skips the linter and can flatten CRLF. Override: prefix `SHELL_WRITE_OK=1 ` (logged).\n"
  );
  process.exit(2);
}

if (require.main === module) {
  try { main(); } catch (e) { process.exit(0); }
}

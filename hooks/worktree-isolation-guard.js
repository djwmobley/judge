"use strict";
// worktree-isolation-guard.js
// PreToolUse hook — enforces the worktree-isolation rule for subagents.
//
// Problem: when a subagent (Agent tool invocation) is given isolation="worktree",
// it operates inside a LINKED git worktree under <repo>/.claude/worktrees/... and
// MUST make all file edits inside that linked worktree — never in the repo's MAIN
// checkout.  Recurring drift (≥2 occurrences): a worktree-isolated subagent edits
// the MAIN checkout (e.g., <repo>/scripts/...), polluting the main working tree and
// forcing manual `git stash` cleanup.
//
// Block conditions:
//   Caller is a subagent (agent_id present, non-ROOT) AND
//   the target file_path / Bash write target resolves into the MAIN git working
//   tree (i.e., git rev-parse --absolute-git-dir === git rev-parse --git-common-dir)
//   AND that target is TRACKED by git (see "TRACKED-NESS" below — hardened spec A,
//   2026-08-24).
//
// ── TOTAL CLASSIFICATION (hardened spec A, 2026-08-24) ─────────────────────
// Field defect: classifyPath() classified purely by directory containment,
// never consulting tracked-ness or ignore status. A subagent writing a
// gitignored log, or a brand-new untracked file, inside the main checkout
// blocked identically to editing tracked code — a false positive with no
// actual leak risk (a gitignored/untracked write in main never pollutes
// `git status` for tracked files, and `git stash` cleanup is not needed for
// content git doesn't track). Every write target now resolves through the
// TOTAL classification below — every combination of {tool, caller, target}
// maps to exactly one row; there is no "didn't consider this case" gap:
//
//   1. tool not in {Write, Edit, Bash}                    -> allow (out of scope)
//   2. caller is ROOT (no agent_id)                       -> allow
//   3. no target determinable                             -> allow (fail-open, debug-logged)
//   4. target basename is a handoff rotation file          -> allow (existing exemption)
//   5. target dir-classifies "worktree"                    -> allow
//   6. target dir-classifies "unknown" (outside any repo,
//      or a git error occurred)                            -> allow (fail-open)
//   7. target dir-classifies "main" AND is TRACKED          -> BLOCK, exit 2
//      (git -C <probeDir> ls-files --error-unmatch -- <target> exits 0)
//   8. target dir-classifies "main" AND is IGNORED          -> allow
//      (git -C <probeDir> check-ignore -q -- <target> exits 0)
//   9. target dir-classifies "main" AND is untracked-and-
//      NOT-ignored (a brand-new file)                       -> allow, but a
//      debug-log line is appended with event:"untracked-main-write" as an
//      AUDIT TRAIL, not a block. This lean is operator-directed (the field
//      report that triggered this hardening pass named untracked-file
//      false-block as the defect, not a missed-catch). Row 9 could
//      alternatively block a brand-new untracked main-checkout write — that
//      was surfaced to the operator as an open design choice, not silently
//      picked by the author; the debug event exists specifically so this
//      choice can be revisited from real audit data without re-deriving it.
//  10. either git probe (tracked-ness or ignore-status) errors — a REAL
//      failure (git not found, fatal error), not the normal "no match" exit
//      1/128 path used to detect "not tracked" / "not ignored" — -> allow
//      (fail-open, debug-logged)
//
// Allow conditions (Write / Edit): rows 1-2 and 4-10 above, as they apply.
// Allow conditions (Bash): same rows, evaluated per extracted write target
// (see "BASH CD-AWARE RESOLUTION" below for how each target's base directory
// is determined) — plus: no write-target paths extracted at all -> allow
// (row 3, nothing to evaluate); any error during Bash target extraction or
// classification -> allow (fail-open).
//
// Fail-open philosophy:
//   Only exit(2) on POSITIVE confirmation: subagent + main checkout + TRACKED.
//   On ANY uncertainty (git not found, path resolution failure, outside-repo path,
//   parse error, ambiguous command construct, indeterminate cd-tracked cwd, etc.)
//   -> exit(0).
//   Rationale: a false block of ROOT is prevented by the step-2 ROOT early-allow.
//   A false block of a legitimate worktree edit, or of an untracked/gitignored
//   main-checkout write, is annoying but recoverable or simply harmless (nothing
//   tracked changed). An actual leak (subagent mutates TRACKED main-checkout
//   state) is also recoverable via `git stash`/`git checkout`, but REPEATED
//   leaks are the recurring bug. Confident deterministic block on positive
//   evidence (main + tracked); fail-open on uncertainty or on a target git
//   itself doesn't track.
//
// ── IDENTITY / PATH-COMPARISON SEMANTICS (one normalization engine, pinned) ─
// Every path COMPARISON in this file goes through the single
// `normalizeForCompare(p)` function: path.resolve -> backslashes -> forward
// slashes -> FULL lowercase (the Windows filesystem is case-insensitive
// end-to-end; a previous drive-letter-only lowercase was inconsistent and
// left non-drive path segments case-sensitive in the comparison, even though
// the filesystem itself doesn't treat them that way). MSYS `/c/...`-style
// paths are never `path.resolve()`d directly — first rewrite `^/([a-z])/` ->
// `$1:/`, THEN resolve, so a POSIX-shaped drive path normalizes to the same
// identity as its Windows-shaped equivalent. classifyPath's own git
// subprocess arguments (the "main vs worktree" dir-classification probes)
// always keep the caller-supplied casing unchanged — git resolves those
// against the actual filesystem itself, case-insensitively, same as any OS
// call. The ONE exception is checkMainTrackedness's tracked-ness/ignore-
// status probes (rows 7-10): those git pathspec arguments are case-SENSITIVE
// text comparisons against the index, not OS-level resolution, so an
// EXISTING target is canonicalized to its TRUE on-disk casing via
// `fs.realpathSync.native` before those specific probes run (V-1 hardening,
// 2026-08-24 — see canonicalizeIfExists's own doc comment for the full
// mid-path case-flip evasion this closes, and its declared limits).
//
// ── BASH WRITE-TARGET DETECTION ─────────────────────────────────────────────
// (extractBashWriteTargets — patterns, unchanged from the prior field-bug-fix
// pass except for the mv-source addition described next)
//   Output redirection:  > FILE, >> FILE, 1> FILE, 1>> FILE
//   tee:                 tee [-a|--append] FILE...
//   sed in-place:        sed -i[SUFFIX] ... FILE, sed --in-place[=SUFFIX] ... FILE
//   cp DEST:              final path operand of cp ... DEST (cp's SOURCE is
//                         read-only — never classified; see mv below for why
//                         mv differs)
//   mv — ALL positionals (hardened spec A-2, 2026-08-24): every positional
//                         operand of `mv ... `, not just the final DEST.
//                         `mv <tracked-main-file> <anywhere>` MUTATES tracked
//                         state via its SOURCE (the tracked file no longer
//                         exists at that path afterward) even though the
//                         DEST itself may resolve outside the main checkout
//                         entirely (worktree, /tmp, unknown) and therefore
//                         never trip row 7 on its own. Classifying every mv
//                         positional closes that gap: the source alone is
//                         sufficient to hit row 7 (main + tracked) even when
//                         the destination would fail-open.
//   dd of=FILE:          of=FILE key=value argument
//   truncate FILE:       final non-flag positional of truncate
//   install DEST:        final non-flag positional of install, ONLY when
//                         "install" is in COMMAND POSITION (not preceded by
//                         another word — see the detector's own comment).
//                         `npm install`, `pip install`, `yarn install`,
//                         `cargo install`, `apt install`, `brew install`,
//                         etc. are correctly OUT of scope: "install" there
//                         is a subcommand of a package manager, not the
//                         coreutils install(1) binary, and none of those
//                         package managers' own write targets are modeled
//                         by this hook (same "too tool-specific to guess"
//                         status as the awk/python/perl line below).
//
//   NOT detected (ambiguous / too risky to guess — fail-open):
//   2>, &>, 2>> (stderr redirection), process substitution >(...), /dev/null,
//   paths derived from variables ($VAR/file, $(cmd)/file), glob expansion,
//   subshells `(...)` (see "BASH CD-AWARE RESOLUTION" below — a subshell is
//   now tracked far enough to be recognized as an ambiguity trigger rather
//   than silently ignored, but its INTERNAL cwd-shifting effect is still not
//   modeled), xargs pipelines, awk/python/perl inline writes, any construct
//   using command substitution to produce the target path, package-manager-
//   internal write targets (e.g. what `npm install` / `pip install` actually
//   write to disk — never modeled; only the coreutils `install(1)` command-
//   position invocation is), rm/git-mv DELETIONS (a deletion is never
//   modeled as a "write target" by this file at all — a tracked file being
//   *removed* rather than *overwritten* is a declared blind spot, not a
//   dodge this hook closes), and env/wrapper-prefixed command invocations
//   (`sudo install ...`, `FOO=bar install ...`, `nice install ...`) — the
//   command-position check requires "install" to be preceded only by a shell
//   command-boundary character or the start of the command string, so a
//   wrapper word immediately before it is (conservatively, fail-open)
//   treated the same as a package-manager subcommand.
//
// ── BASH CD-AWARE RESOLUTION (hardened spec A-3/A-4, 2026-08-24) ───────────
// Field defects (both confirmed): (1-B false positive) `cd "<worktree>" &&
// node --test ... > results.txt`, invoked with the hook-reported `cwd` set to
// the MAIN project dir (the harness's own cwd for the Bash tool call, NOT
// necessarily the subagent's actual shell cwd after its own `cd`), blocked
// even though the write plainly lands inside the worktree — the relative
// target was resolved against the hook-input `cwd` with NO awareness that
// the command itself changes directory first. (1-B false negative, CONFIRMED
// via reproduction) the same blind spot cuts the other way: `cd <worktree>
// && echo hi > ../../../scripts/handoff.js` resolved the relative target
// against the (wrong) hook-input cwd, landed outside any repo entirely, and
// was silently ALLOWED — even though from the worktree's actual location
// that relative path targets a TRACKED file in the main checkout.
//
// Fix: the (heredoc-body-blanked, but NOT quote-content-blanked — see below)
// command is split into `&&`/`;`-delimited top-level segments, tracking an
// `effectiveCwd` that starts at the hook-input `cwd` and updates whenever a
// segment is EXACTLY `cd <quoted-or-bare token>` (nothing else on that
// segment): absolute (or MSYS `/x/...`) targets replace `effectiveCwd`
// outright; relative targets resolve against the `effectiveCwd` in force at
// that point. A relative write-target extracted from a later segment
// resolves against whatever `effectiveCwd` was in force AT THAT SEGMENT's
// position — never against the original hook-input cwd once a `cd` has
// updated it.
//
// Ambiguity (⇒ effectiveCwd becomes INDETERMINATE for the REST of the
// command, one-way, never recovers — a later `cd` cannot "fix" it): a `cd`
// argument containing `$`, `*`, `?`, a backtick, or unbalanced/embedded
// parens; a `cd` segment that isn't a single clean quoted-or-bare token
// (extra trailing content after the token — e.g. `cd /foo || true` is not a
// recognized pure-cd form); and any segment containing an UNQUOTED `(`
// (subshell / command-substitution open) — deliberately conservative: this
// hook does not model a subshell's own internal cwd-shifting, so it treats
// the mere presence of `(` as reason enough to stop trusting any cwd
// tracking for the rest of the command. A relative target whose segment's
// effectiveCwd is INDETERMINATE is `unknown` -> fail-open (row 3) — it is
// NEVER silently resolved against the original hook-input cwd.
//
// `|` (pipe) does NOT reset or change effectiveCwd — only a pure `cd`
// segment does; a piped chain stays within its enclosing `&&`/`;` segment.
//
// Why NOT scrubDataRegions here: extractBashWriteTargets (unchanged) uses
// pr-independence.js's scrubDataRegions, which BLANKS quoted-string CONTENT
// entirely (keeping only the delimiter quote characters) — correct for
// extracting write-target tokens (a quoted argument's literal content isn't
// needed to recognize the SHAPE `> "..."` at all, and blanking prevents data
// payloads from masquerading as commands elsewhere). But a `cd` TARGET's
// actual VALUE is exactly the content we need to read (e.g. `cd
// "C:\...\worktrees\agent-xyz"` — the quoted path IS the payload we must
// parse to track effectiveCwd). Blanking it would destroy the very thing
// A-3 needs. So segmentation/cd-tracking here uses its OWN lightweight
// heredoc-body blanker (`blankHeredocBodies`, mirroring scrubDataRegions's
// heredoc pass only) plus a quote-STATE-tracking (not quote-content-
// dropping) walk that only ever uses quote state to avoid mis-splitting on
// an `&&`/`;`/`(` that happens to sit inside a quoted string.
//
// Matcher note: this hook is wired to BOTH Write|Edit and Bash tool matchers.
//
// Git version note (git 2.52.0.windows.1 on this machine):
//   `git rev-parse --git-common-dir` returns a RELATIVE path (".git") when invoked
//   inside the main checkout, and an ABSOLUTE path when invoked inside a linked
//   worktree.  The hook uses `--path-format=absolute --git-common-dir` (supported
//   since git 2.31) so git always returns an absolute path.  A fallback manual-
//   resolution step is included for older git versions.
//
// ── DECLARED BLIND SPOTS (do NOT attempt to close these — see the hardened
// spec's own list) ──────────────────────────────────────────────────────────
//   - rm / git-mv DELETIONS are never modeled as write targets at all.
//   - A file that is untracked NOW but gets `git add`ed LATER in the same or
//     a subsequent command is not retroactively reconsidered — row 9's debug
//     event is the intended audit hook for this, not a live re-check.
//   - Process substitution, xargs, eval, PowerShell-side writes, and awk/
//     python/perl inline writes remain outside this file's model.
//   - A subshell's OWN internal cd-tracking is not modeled — `(cd x && ...)`
//     is recognized only as an ambiguity trigger (INDETERMINATE), never
//     resolved.
//   - No git history exists for this hooks directory (not a git repo) — the
//     defect timeline this hardening pass fixes was reconstructed from debug
//     logs and file mtimes, not from commit history.

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ── Paths ──────────────────────────────────────────────────────────────────
// This guard's own install directory. __dirname resolves correctly both in
// an installed ~/.claude/hooks tree and when running the tests straight out
// of this repository's hooks/ directory — no owner-specific path baked in.
const HOOKS_DIR = __dirname;

// Reuse scrubDataRegions from pr-independence.js to neutralize heredoc bodies
// and quoted-string contents before scanning for write-target paths.
const { scrubDataRegions } = require(path.join(HOOKS_DIR, "pr-independence.js"));
const { appendRotating } = require("./model-routing-guards.log.js");
const DEBUG_LOG = path.join(HOOKS_DIR, "worktree-isolation-guard-debug.log");

// Sentinel for "we lost track of effectiveCwd" (A-3/A-4). Never leaks
// outside this module — every consumer either resolves a relative target
// against a real path string or treats this sentinel as fail-open/row 3.
const INDETERMINATE = Symbol("worktree-isolation-guard:indeterminate-cwd");

// ── Helpers ────────────────────────────────────────────────────────────────

function appendDebug(obj) {
  appendRotating(DEBUG_LOG, JSON.stringify(obj));
}

/**
 * The ONE path-comparison normalization engine in this file (hardened spec
 * A, identity semantics). Used for every path IDENTITY comparison — never
 * for an argument handed to a `git` subprocess, which always keeps its
 * original casing (git itself resolves paths against the real filesystem).
 *
 * path.resolve -> backslashes -> forward slashes -> FULL lowercase.
 * MSYS `/c/...` forms are rewritten to `c:/...` BEFORE path.resolve (never
 * resolved directly in their POSIX-drive-letter shape).
 *
 * Returns the normalized string, or null if the input is falsy.
 */
function normalizeForCompare(p) {
  if (!p) return null;
  let s = String(p);
  s = s.replace(/^\/([A-Za-z])\//, (_, d) => d + ":/");
  let resolved = path.resolve(s);
  resolved = resolved.replace(/\\/g, "/");
  resolved = resolved.toLowerCase();
  return resolved;
}

/**
 * True if the path's basename is a handoff rotation file
 * (HANDOFF.md / HANDOFF-HISTORY.md). These files are gitignored and exist ONLY
 * in the main checkout — a linked worktree (clean checkout of HEAD) cannot hold
 * them — so the isolation rule is unsatisfiable for them. Rotation is delegated
 * to the handoff-writer subagent, which must therefore be allowed to write them
 * in the main checkout. Exempt from the main-checkout block in both branches.
 */
function isHandoffFile(p) {
  if (!p) return false;
  const base = path.basename(String(p)).toLowerCase();
  return base === "handoff.md" || base === "handoff-history.md";
}

/**
 * Find the nearest EXISTING ancestor directory of `filePath`.
 * The file itself may not yet exist (for Write of a new file); we walk up
 * the directory chain until we find a directory that exists.
 * Returns the directory path string, or null if none found.
 *
 * @param {string} filePath — absolute path to the target file
 * @returns {string|null}
 */
function findExistingAncestorDir(filePath) {
  // Start with the file's own parent directory.
  let dir = path.dirname(filePath);
  // Guard against infinite loops (path.dirname("/") === "/").
  let prev = null;
  while (dir !== prev) {
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) return dir;
    } catch (_) {
      // Directory does not exist; keep walking up.
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Classify a file path as "main", "worktree", or "unknown" based on git internals.
 *
 * "main"     — the path lives inside the repo's PRIMARY working tree
 *              (git rev-parse --absolute-git-dir equals --git-common-dir).
 * "worktree" — the path lives inside a LINKED worktree
 *              (git rev-parse --absolute-git-dir differs from --git-common-dir).
 * "unknown"  — git probing failed, path is outside any repo, or an error occurred.
 *
 * NOTE: this function answers ONLY "which checkout directory is this in?" —
 * it does not consult tracked-ness or ignore status. The hardened-spec A
 * total classification (rows 7-10) layers that on top for "main"-classified
 * targets via checkMainTrackedness(); classifyPath's own contract and return
 * values are unchanged from before that hardening pass.
 *
 * Algorithm:
 *   1. Walk up from filePath to find the nearest existing ancestor directory
 *      (the file itself may not exist yet for a Write of a new file).
 *   2. Run `git -C <probeDir> rev-parse --absolute-git-dir` to get the per-worktree
 *      gitDir (e.g., "/repo/.git" for main or "/repo/.git/worktrees/wt" for linked).
 *   3. Run `git -C <probeDir> rev-parse --path-format=absolute --git-common-dir` to
 *      get the shared commonDir (always "/repo/.git" regardless of which worktree).
 *      Falls back to manual resolution (resolve relative result against probeDir) if
 *      --path-format=absolute is not supported by the installed git version.
 *   4. Normalize both paths (normalizeForCompare — full lowercase, see above)
 *      and compare.
 *
 * @param {string} filePath  — path to the file being written/edited.
 *                             If relative AND baseDir is provided, resolved against
 *                             baseDir before probing.  If relative and no baseDir,
 *                             falls back to path.resolve() (hook-process cwd).
 *                             Existing callers (Write/Edit) always pass an absolute
 *                             filePath, so this parameter does not change their behavior.
 * @param {string} [baseDir] — optional base directory for resolving relative filePaths.
 *                             Typical use: pass the subagent's cwd for Bash targets.
 * @returns {"main"|"worktree"|"unknown"}
 */
function classifyPath(filePath, baseDir) {
  if (!filePath) return "unknown";

  // Resolve relative paths against baseDir when provided; otherwise use the
  // default path.resolve() behavior (which uses the hook-process cwd — correct
  // for Write/Edit callers that always supply absolute paths already).
  if (baseDir && !path.isAbsolute(filePath)) {
    filePath = path.resolve(baseDir, filePath);
  }

  const probeDir = findExistingAncestorDir(filePath);
  if (!probeDir) return "unknown";

  try {
    // Step 2: per-worktree git dir (always absolute).
    const rawGitDir = execFileSync(
      "git",
      ["-C", probeDir, "rev-parse", "--absolute-git-dir"],
      { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }
    ).trim();

    if (!rawGitDir) return "unknown";

    // Step 3a: try --path-format=absolute first (git ≥ 2.31).
    let rawCommonDir = null;
    let commonDirResolved = false;
    try {
      rawCommonDir = execFileSync(
        "git",
        ["-C", probeDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }
      ).trim();
      commonDirResolved = true;
    } catch (_) {
      // --path-format=absolute not supported; fall back below.
    }

    if (!commonDirResolved || !rawCommonDir) {
      // Step 3b: fallback — call without --path-format=absolute and resolve manually.
      // On older git, --git-common-dir returns a relative path (".git") when in the
      // main checkout, so we resolve it relative to probeDir.
      try {
        rawCommonDir = execFileSync(
          "git",
          ["-C", probeDir, "rev-parse", "--git-common-dir"],
          { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }
        ).trim();
        if (rawCommonDir) {
          // If it is a relative path, resolve it from probeDir.
          if (!path.isAbsolute(rawCommonDir)) {
            rawCommonDir = path.resolve(probeDir, rawCommonDir);
          }
        }
      } catch (_) {
        return "unknown";
      }
    }

    if (!rawCommonDir) return "unknown";

    // Step 4: normalize and compare.
    const gitDir    = normalizeForCompare(rawGitDir);
    const commonDir = normalizeForCompare(rawCommonDir);

    if (!gitDir || !commonDir) return "unknown";

    if (gitDir === commonDir) {
      // Per-worktree git dir IS the common dir → main checkout.
      return "main";
    } else {
      // Per-worktree git dir is a subdirectory under the common dir
      // (e.g., <commonDir>/worktrees/<name>) → linked worktree.
      return "worktree";
    }

  } catch (_) {
    // git not found, path outside repo, or any other error → unknown / fail-open.
    return "unknown";
  }
}

/**
 * V-1 hardening (2026-08-24, validator-found mid-path case-flip evasion):
 * canonicalize an EXISTING path to its true on-disk casing before it is
 * ever handed to a git pathspec probe. `git ls-files`/`check-ignore`
 * pathspec matching is case-SENSITIVE text comparison against the index —
 * it does NOT case-fold the way Windows filesystem calls (fs.statSync,
 * directory traversal) do. Before this fix, a subagent `Write` to a
 * mid-path case-flipped variant of a tracked file (e.g.
 * `C:\...\claude-memory\SCRIPTS\handoff.js` instead of the tracked
 * `scripts\handoff.js`) would resolve fine at the OS level (Windows is
 * case-insensitive end-to-end, so the write lands on the REAL tracked
 * file), but `git ls-files --error-unmatch` on the case-flipped pathspec
 * would report "not tracked" — landing on row 9 (untracked, ALLOW) instead
 * of row 7 (tracked, BLOCK), even though the write mutates tracked state.
 *
 * `fs.realpathSync.native` resolves any EXISTING path (the file itself, or
 * any of its existing ancestor directories) to its canonical on-disk
 * casing — succeeding regardless of what casing was supplied, because the
 * underlying OS call is itself case-insensitive. It THROWS (ENOENT) for a
 * path that does not exist yet. That failure mode is exactly the boundary
 * this fix needs: a genuinely NEW file has no on-disk casing to canonicalize
 * against yet, so it correctly falls back to the path as given and stays
 * row 9 (untracked) — canonicalization only ever affects paths that
 * ALREADY exist on disk, never widens or narrows the untracked-new-file
 * lean.
 */
function canonicalizeIfExists(absPath) {
  try {
    return fs.realpathSync.native(absPath);
  } catch (_) {
    // Does not exist yet (or realpath failed for some other reason, e.g. a
    // permissions error) — fall back to the path as given. Nothing on disk
    // to canonicalize against; the tracked-ness probes below will correctly
    // report "not tracked" for a genuinely new file regardless.
    return absPath;
  }
}

/**
 * Hardened spec A, rows 7-10: given an ABSOLUTE path already dir-classified
 * as "main" by classifyPath, probe git for tracked-ness / ignore-status.
 *
 * Returns exactly one of:
 *   { row: 7,  decision: "block" }                                    — tracked
 *   { row: 8,  decision: "allow" }                                    — ignored
 *   { row: 9,  decision: "allow", debugEvent: "untracked-main-write" } — new file
 *   { row: 10, decision: "allow" }                                    — real probe error (fail-open)
 *
 * `git ls-files --error-unmatch` exits 0 when the path IS tracked, and 1 for
 * the normal "not tracked" case (NOT an error — `--error-unmatch` merely
 * makes that case detectable via exit code instead of silent empty output).
 * `git check-ignore -q` exits 0 when the path IS ignored, 1 when it is NOT
 * ignored (again, not an error). Any OTHER exit code (typically 128, a fatal
 * git error) from either probe is treated as row 10 — a real failure, fail-open.
 *
 * `stdio: ["ignore", "pipe", "pipe"]` on every probe below: execFileSync's
 * default stdio inherits the CHILD's stderr straight to this hook's own
 * stderr, so a normal (expected, non-error) "not tracked" / "not ignored"
 * git probe result was printing raw git error text ("error: pathspec ...
 * did not match any file(s) known to git") on every allow-path run. That
 * text is captured (not silenced) rather than genuinely lost — an unusual
 * probe failure still surfaces via the row-10 fail-open path and the
 * debug log — this only stops it from leaking onto the hook's own stderr
 * on the routine, expected code paths.
 */
function checkMainTrackedness(absPath) {
  // V-1: canonicalize BEFORE computing probeDir too, so a case-flipped
  // ancestor segment of an EXISTING target resolves to its true casing
  // everywhere git is invoked, not just in the final pathspec argument.
  const canonicalPath = canonicalizeIfExists(absPath);
  const probeDir = findExistingAncestorDir(canonicalPath) || path.dirname(canonicalPath);

  try {
    execFileSync(
      "git",
      ["-C", probeDir, "ls-files", "--error-unmatch", "--", canonicalPath],
      { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }
    );
    // Exit 0 -> tracked.
    return { row: 7, decision: "block" };
  } catch (trackedErr) {
    const exitCode = (trackedErr && typeof trackedErr.status === "number") ? trackedErr.status : null;
    if (exitCode !== 1) {
      // Not the normal "no match" exit — a real probe failure (git missing,
      // fatal git error, etc.) — fail-open (row 10).
      return { row: 10, decision: "allow" };
    }
    // Not tracked — check ignore status.
    try {
      execFileSync(
        "git",
        ["-C", probeDir, "check-ignore", "-q", "--", canonicalPath],
        { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }
      );
      // Exit 0 -> ignored.
      return { row: 8, decision: "allow" };
    } catch (ignoreErr) {
      const ignoreExit = (ignoreErr && typeof ignoreErr.status === "number") ? ignoreErr.status : null;
      if (ignoreExit === 1) {
        // Not ignored, not tracked -> brand-new file (audit trail, not a block).
        return { row: 9, decision: "allow", debugEvent: "untracked-main-write" };
      }
      // Any other exit code (e.g. 128 fatal) -> real error, fail-open (row 10).
      return { row: 10, decision: "allow" };
    }
  }
}

/**
 * Full hardened-spec-A evaluation (rows 5-10) for one absolute write target.
 * Rows 1-4 (tool scope, ROOT, no-target, handoff exemption) are the caller's
 * responsibility — this function assumes filePath is a real, non-handoff,
 * absolute candidate write target.
 */
function evaluateWriteTarget(absPath) {
  let cls;
  try {
    cls = classifyPath(absPath);
  } catch (_) {
    return { row: 10, decision: "allow" };
  }
  if (cls === "worktree") return { row: 5, decision: "allow" };
  if (cls === "unknown")  return { row: 6, decision: "allow" };
  try {
    return checkMainTrackedness(absPath);
  } catch (_) {
    return { row: 10, decision: "allow" };
  }
}

// ── Bash write-target extraction ───────────────────────────────────────────

/**
 * Given a Bash command string, return a conservative list of candidate
 * FILE paths that the command will WRITE TO.  The list may be empty when no
 * write-target is recognized or when the construct is too ambiguous to parse
 * safely (fail-open).
 *
 * The function operates on a pre-scrubbed copy of `command` (heredoc bodies
 * and quoted-string contents blanked via scrubDataRegions) so that paths that
 * appear only as data payloads are never treated as live write targets.
 * Exception: a redirect TARGET itself may be legitimately quoted, so
 * surrounding quotes on an EXTRACTED token are stripped.
 *
 * @param {string} command — the raw Bash command string
 * @returns {string[]}     — candidate write-target paths (may be empty)
 */
function extractBashWriteTargets(command) {
  if (!command || typeof command !== "string") return [];

  const targets = [];

  // Scrub data regions first.
  const scrubbed = scrubDataRegions(command);

  // Strip surrounding matched quote pair from a token.
  function stripQuotes(tok) {
    if (!tok) return tok;
    if (
      (tok.startsWith('"') && tok.endsWith('"')) ||
      (tok.startsWith("'") && tok.endsWith("'"))
    ) {
      return tok.slice(1, -1);
    }
    return tok;
  }

  // Return true if the token is ambiguous (variable, glob, process-substitution).
  function isAmbiguous(tok) {
    if (!tok) return true;
    if (/\$/.test(tok)) return true;
    if (/[*?[]/.test(tok)) return true;
    if (/[><]\(/.test(tok)) return true;
    return false;
  }

  // Add a token to targets if non-empty and unambiguous.
  function addTarget(tok) {
    if (!tok) return;
    const t = stripQuotes(tok.trim());
    if (!t) return;
    if (isAmbiguous(t)) return;
    targets.push(t);
  }

  // ── Shared: clean the argument run following a verb match ──────────────
  // Field bug fix (worktree-isolation-guard, install-DEST false-positive):
  // the previous per-verb capture groups used a character class like
  // [^\n|;&]+ that does NOT exclude '<' / '>'. When a command carries a
  // trailing redirect/pipe with no separating whitespace immediately before
  // the operator — the canonical case being `2>&1` (a bare digit directly
  // abutting the operator, e.g. `npm install 2>&1 | tail -5`) — that
  // character class lets each per-token match run right up to (but not
  // across) the disallowed char, so the run stops mid-token and leaves a
  // FRAGMENT ("2") sitting in the captured args as if it were a complete,
  // final positional argument. Since several of these detectors treat "the
  // last positional" as the DEST, that fragment gets promoted to a bogus
  // write target, which then gets resolved against the tracked Bash cwd —
  // producing a false block/warning on an ordinary command that never wrote
  // anywhere near that path.
  //
  // Fix: find the boundary explicitly (first '|', ';', '&', '<', '>', or
  // newline at/after startIdx) and slice the args up to THAT position, not
  // a per-token character-class exclusion. Then, if the slice's own
  // trailing edge is NOT whitespace-terminated (i.e. the last token butts
  // directly against the boundary char with no separating space — exactly
  // the `2>&1` shape, but also any `word>file` / `word|cmd` no-space form),
  // drop that whole trailing fused token rather than keep a truncated
  // fragment of it. This is deliberately conservative (matches the hook's
  // documented fail-open philosophy): a token fused to a redirect/pipe
  // operator with no separating whitespace is exactly the kind of
  // ambiguous construct the header already documents as "too risky to
  // guess" (see the stderr-redirect / no-space-redirect handling above) —
  // dropping it never causes a missed detection, because the FILE side of
  // an actual redirect (`>bar`, `2>&1`, etc.) is independently caught by
  // the dedicated redirect detector in section 1, which already handles
  // the no-space form correctly.
  function extractArgsUntilBoundary(text, startIdx) {
    const boundaryRe = /[|;&<>\n]/;
    const remainder = text.slice(startIdx);
    const bm = boundaryRe.exec(remainder);
    if (!bm) return remainder;
    let slice = remainder.slice(0, bm.index);
    if (slice.length > 0 && !/\s$/.test(slice)) {
      // Trailing token is fused to the boundary operator (no separating
      // whitespace) — drop it entirely rather than keep a partial fragment.
      const lastSpaceRunStart = slice.search(/\s+\S*$/);
      slice = lastSpaceRunStart === -1 ? "" : slice.slice(0, lastSpaceRunStart);
    }
    return slice;
  }

  // ── 1. Output redirection: > FILE, >> FILE, 1> FILE, 1>> FILE ──────────
  //   Allow optional whitespace between the operator and the target path.
  //   Exclude stderr (2>) and combined (&>) redirections.
  {
    const redirRe = /(?<![2&])(?:1?>>?)\s+([^\s|;&<>]+)/g;
    let m;
    while ((m = redirRe.exec(scrubbed)) !== null) {
      const tok = m[1];
      if (/^\/dev\//.test(tok)) continue;
      addTarget(tok);
    }
    // Also match no-space form: cmd>/path (no space before path).
    const redirNoSpaceRe = /(?<![2&])(?:1?>>?)([^\s|;&<>]+)/g;
    while ((m = redirNoSpaceRe.exec(scrubbed)) !== null) {
      const tok = m[1];
      if (/^\/dev\//.test(tok)) continue;
      addTarget(tok);
    }
  }

  // ── 2. tee [-a|--append] FILE... ───────────────────────────────────────
  {
    const teeRe = /\btee\b((?:\s+(?:--append|-a|[^\s|;&<>]+))*)/g;
    let m;
    while ((m = teeRe.exec(scrubbed)) !== null) {
      const rest = m[1] || "";
      for (const tok of rest.trim().split(/\s+/)) {
        if (!tok || tok === "-a" || tok === "--append") continue;
        if (tok.startsWith("-")) continue;
        addTarget(tok);
      }
    }
  }

  // ── 3. sed -i / sed --in-place ──────────────────────────────────────────
  {
    const sedVerbRe = /\bsed\b/g;
    let m;
    while ((m = sedVerbRe.exec(scrubbed)) !== null) {
      const args = extractArgsUntilBoundary(scrubbed, sedVerbRe.lastIndex);
      if (!/(?:^|\s)(?:-i\S*|--in-place(?:=\S*)?)(?:\s|$)/.test(args)) continue;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      let scriptConsumed = false;
      const fileTokens = [];
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok === "-e" || tok === "-f") { i += 2; continue; }
        if (/^-i/.test(tok) || /^--in-place/.test(tok)) { i++; continue; }
        if (tok.startsWith("-")) { i++; continue; }
        if (!scriptConsumed) { scriptConsumed = true; i++; continue; }
        fileTokens.push(tok);
        i++;
      }
      for (const ft of fileTokens) addTarget(ft);
    }
  }

  // ── 4. cp / mv: positionals ──────────────────────────────────────────────
  // cp: last non-flag positional = destination (source is READ-ONLY, never
  // classified). mv: hardened spec A-2 (2026-08-24) — classify EVERY
  // positional, not just the destination. `mv` mutates its SOURCE (the
  // tracked file no longer exists at its old path afterward) even when the
  // destination resolves somewhere this hook would otherwise fail-open on
  // (worktree, /tmp, unknown) — so the source alone must be able to trip
  // row 7 (main + tracked) independent of where the file is being moved TO.
  for (const verb of ["cp", "mv"]) {
    const verbRe = new RegExp(`\\b${verb}\\b`, "g");
    let m;
    while ((m = verbRe.exec(scrubbed)) !== null) {
      const args = extractArgsUntilBoundary(scrubbed, verbRe.lastIndex);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const positionals = [];
      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.startsWith("-")) {
          if (!tok.includes("=") && i + 1 < tokens.length &&
              !tokens[i + 1].startsWith("-") &&
              /^--?(?:backup|suffix|target-directory|S|t)$/.test(tok)) {
            i += 2; continue;
          }
          i++; continue;
        }
        positionals.push(tok);
        i++;
      }
      if (positionals.length >= 2) {
        if (verb === "mv") {
          for (const p of positionals) addTarget(p);
        } else {
          addTarget(positionals[positionals.length - 1]);
        }
      }
    }
  }

  // ── 5. dd of=FILE ───────────────────────────────────────────────────────
  {
    const ddOfRe = /\bdd\b[^\n|;&]*?\bof=([^\s|;&]+)/g;
    let m;
    while ((m = ddOfRe.exec(scrubbed)) !== null) addTarget(m[1]);
  }

  // ── 6. truncate FILE (last non-flag positional) ─────────────────────────
  {
    const truncVerbRe = /\btruncate\b/g;
    let m;
    while ((m = truncVerbRe.exec(scrubbed)) !== null) {
      const args = extractArgsUntilBoundary(scrubbed, truncVerbRe.lastIndex);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const positionals = [];
      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.startsWith("-")) {
          if ((tok === "-s" || tok === "--size") && i + 1 < tokens.length) {
            i += 2;
          } else { i++; }
          continue;
        }
        positionals.push(tok);
        i++;
      }
      if (positionals.length > 0) addTarget(positionals[positionals.length - 1]);
    }
  }

  // ── 7. install DEST (last non-flag positional) ──────────────────────────
  // Field bug: `\binstall\b` alone matches the literal word "install"
  // ANYWHERE it appears — including as the SECOND word of `npm install`,
  // `pip install`, `yarn install`, `pnpm install`, `cargo install`,
  // `apt install`, `apt-get install`, `brew install`, `gem install`,
  // `conda install`, `composer install`, `go install`, `choco install`,
  // `winget install`, `scoop install`, `vcpkg install`, etc. — every one of
  // which uses "install" as a SUBCOMMAND of a package manager, not an
  // invocation of the coreutils `install(1)` binary. The old regex then
  // treated whatever followed as install's OWN argument list and picked the
  // last positional as a bogus DEST.
  //
  // Categorical fix (not an npm special-case): `install` only counts as the
  // command being detected when it is in COMMAND POSITION — i.e. it is not
  // preceded (ignoring intervening whitespace) by any other word-character
  // token. Structurally, that means the nearest non-whitespace character
  // before it must be either nothing (start of the command string) or a
  // shell command-boundary character: `;` `&` `|` a backtick, `(`, or a
  // newline. Any word character immediately before it (npm, pip, yarn,
  // cargo, gem, brew, apt, conda, go, composer, choco, winget, scoop,
  // vcpkg, or any future package manager never enumerated here) means
  // "install" is a subcommand/argument of THAT program, not the coreutils
  // command, and is correctly excluded — with no per-tool allow-list.
  {
    const installVerbRe = /(?:^|[;&|`(\n])[ \t]*install\b/g;
    let m;
    while ((m = installVerbRe.exec(scrubbed)) !== null) {
      const args = extractArgsUntilBoundary(scrubbed, installVerbRe.lastIndex);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const positionals = [];
      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.startsWith("-")) {
          if (/^(?:-o|-g|-m|-M|--owner|--group|--mode|--suffix|-S|--target-directory|-t)$/.test(tok) &&
              i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
            i += 2;
          } else { i++; }
          continue;
        }
        positionals.push(tok);
        i++;
      }
      if (positionals.length > 0) addTarget(positionals[positionals.length - 1]);
    }
  }

  // Deduplicate while preserving order.
  const seen = new Set();
  return targets.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; });
}

// ── Bash cd-aware effective-cwd resolution (hardened spec A-3/A-4) ─────────

/**
 * Blank ONLY heredoc BODY lines (mirrors pr-independence.js's scrubDataRegions
 * pass 1, duplicated here deliberately — see the header's "Why NOT
 * scrubDataRegions here" note: unlike write-target extraction, cd-tracking
 * needs quoted-string CONTENT preserved, and scrubDataRegions blanks that
 * unconditionally). Keeps the heredoc's opening line (command verb tokens)
 * and closing delimiter line intact; body lines become empty strings.
 */
function blankHeredocBodies(cmd) {
  const lines = cmd.split("\n");
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const hdRe = /<<(-?)\s*(['"]?)(\w+)\2/g;
    let hdMatch = null;
    let lastHdMatch = null;
    while ((hdMatch = hdRe.exec(line)) !== null) lastHdMatch = hdMatch;
    if (!lastHdMatch) { result.push(line); i++; continue; }
    result.push(line);
    i++;
    const strip = lastHdMatch[1] === "-";
    const delim = lastHdMatch[3];
    let foundClose = false;
    while (i < lines.length) {
      const bodyLine = lines[i];
      const checkLine = strip ? bodyLine.replace(/^\t*/, "") : bodyLine;
      if (checkLine === delim) {
        result.push(bodyLine);
        i++;
        foundClose = true;
        break;
      }
      result.push("");
      i++;
    }
    void foundClose; // unbalanced heredoc: body already blanked; safe either way.
  }
  return result.join("\n");
}

/**
 * Split a (heredoc-body-blanked) command into top-level `&&`/`;`-delimited
 * segments, tracking single/double-quote STATE (never dropping quote
 * content) so a `&&`/`;` inside a quoted string never causes a false split.
 * Returns a flat array alternating [text, sep, text, sep, ..., text] — even
 * indices are segment text, odd indices are the separator that followed
 * ("&&" or ";").
 */
function splitTopLevelCommandSegments(command) {
  const heredocBlanked = blankHeredocBodies(command);
  const segments = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < heredocBlanked.length; i++) {
    const ch = heredocBlanked[i];
    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < heredocBlanked.length) {
        cur += ch + heredocBlanked[i + 1];
        i++;
        continue;
      }
      cur += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; cur += ch; continue; }
    if (ch === '"') { inDouble = true; cur += ch; continue; }
    if (ch === ";") { segments.push(cur); segments.push(";"); cur = ""; continue; }
    if (ch === "&" && heredocBlanked[i + 1] === "&") {
      segments.push(cur); segments.push("&&"); cur = ""; i++; continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

/**
 * True if a `cd` argument is too ambiguous to resolve safely: contains a
 * variable sigil, glob character, or backtick/paren (command substitution /
 * subshell). Whitespace is NOT itself a red flag here — parseCdSegment only
 * ever hands this function a single already-isolated token (quoted content
 * may legitimately contain spaces, e.g. `"C:\Program Files\..."`).
 */
function isAmbiguousCdArg(raw) {
  if (!raw) return true;
  if (/[$*?`]/.test(raw)) return true;
  if (/[()]/.test(raw)) return true;
  return false;
}

/**
 * If `segText` (trimmed) is EXACTLY `cd <quoted-or-bare token>` and nothing
 * else, return the raw token (quotes stripped, content untouched). Returns
 * null if the segment is not a clean single-token cd form (including a
 * segment with trailing junk after the token, e.g. `cd /foo || true` — that
 * is NOT recognized as a pure-cd form and the caller treats it as
 * ambiguous/INDETERMINATE, never as "no cd happened here").
 */
function parseCdSegment(segText) {
  const trimmed = segText.trim();
  const m = /^cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(trimmed);
  if (!m) return null;
  return (m[1] !== undefined) ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

/**
 * Core of hardened spec A-3/A-4: given the raw Bash command and the
 * hook-input cwd, return an array of { text, cwd } — one entry per top-level
 * `&&`/`;`-delimited segment — where `cwd` is either a real absolute-path
 * string (the effectiveCwd in force AT that segment's position) or the
 * INDETERMINATE sentinel.
 *
 * effectiveCwd starts at `initialCwd` (or INDETERMINATE if no initialCwd was
 * given at all). It updates on a segment that is EXACTLY `cd <token>`:
 * absolute (or MSYS `/x/...`, rewritten to `X:/...` first) replaces it
 * outright; relative resolves against the CURRENT effectiveCwd. Any
 * ambiguous cd argument, any non-clean cd segment, or any segment containing
 * an unquoted `(` latches INDETERMINATE for the REST of the command
 * (one-way — a later cd cannot recover it). `|` never changes effectiveCwd.
 */
function computeSegmentCwds(command, initialCwd) {
  const rawSegs = splitTopLevelCommandSegments(command);
  const results = [];
  let cwd = initialCwd || null;
  let indeterminate = !initialCwd;

  for (let i = 0; i < rawSegs.length; i += 2) {
    const text = rawSegs[i];
    results.push({ text, cwd: indeterminate ? INDETERMINATE : cwd });

    if (indeterminate) continue;

    // A-4: an unquoted '(' anywhere in this segment (subshell / command
    // substitution) — this walker does not model its internal cwd effects,
    // so treat its mere presence as reason to stop trusting cwd tracking.
    if (/\(/.test(text)) { indeterminate = true; continue; }

    const trimmed = text.trim();
    if (/^cd\b/.test(trimmed)) {
      const raw = parseCdSegment(text);
      if (raw === null || isAmbiguousCdArg(raw)) {
        indeterminate = true;
        continue;
      }
      const normRaw = raw.replace(/^\/([A-Za-z])\//, (_, d) => d.toUpperCase() + ":/");
      if (path.isAbsolute(normRaw)) {
        cwd = normRaw;
      } else {
        cwd = path.resolve(cwd, normRaw);
      }
    }
  }

  return results;
}

// Export pure functions for unit-test isolation.
// The CLI entrypoint is guarded below with `if (require.main === module)`.
module.exports = {
  classifyPath,
  extractBashWriteTargets,
  normalizeForCompare,
  isHandoffFile,
  canonicalizeIfExists,
  checkMainTrackedness,
  evaluateWriteTarget,
  splitTopLevelCommandSegments,
  computeSegmentCwds,
};

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

  const tool_name  = (parsed.tool_name)  || "";
  const tool_input = (parsed.tool_input) || {};
  const caller     = parsed.agent_id ? String(parsed.agent_id) : "ROOT";
  const filePath   = (tool_input && typeof tool_input.file_path === "string")
    ? tool_input.file_path
    : "";

  // ── Debug log (always) ──────────────────────────────────────────────────
  appendDebug({
    ts:               new Date().toISOString(),
    tool_name,
    agent_id_present: !!parsed.agent_id,
    caller,
    file_path_prefix: filePath.slice(0, 80),
  });

  // ── Step 1: Dispatch by tool name (row 1) ───────────────────────────────
  if (tool_name === "Bash") {
    // ── Bash branch ─────────────────────────────────────────────────────
    // Fail-open on any error; only block on positive row-7 confirmation.
    try {
      // Row 2: ROOT is always allowed.
      if (caller === "ROOT") process.exit(0);

      const command = (tool_input && typeof tool_input.command === "string")
        ? tool_input.command : "";
      if (!command) {
        appendDebug({
          ts: new Date().toISOString(), event: "no-target-determinable",
          reason: "empty-command", caller,
        });
        process.exit(0);
      }

      const initialCwd = (typeof parsed.cwd === "string" && parsed.cwd) ? parsed.cwd : null;
      const segments = computeSegmentCwds(command, initialCwd);

      for (const seg of segments) {
        const segTargets = extractBashWriteTargets(seg.text);
        if (!segTargets.length) continue;

        for (const rawTarget of segTargets) {
          let absTarget;
          if (path.isAbsolute(rawTarget)) {
            absTarget = rawTarget;
          } else if (seg.cwd === INDETERMINATE || !seg.cwd) {
            // Row 3: relative target with no reliable base — fail-open,
            // NEVER silently resolved against the original hook-input cwd
            // (that was the confirmed 1-B false-negative this hardening
            // pass closes).
            appendDebug({
              ts: new Date().toISOString(), event: "no-target-determinable",
              reason: "indeterminate-effective-cwd", caller, raw_target: rawTarget,
            });
            continue;
          } else {
            absTarget = path.resolve(seg.cwd, rawTarget);
          }

          // Row 4: handoff rotation files are exempt.
          if (isHandoffFile(absTarget)) continue;

          let result;
          try {
            result = evaluateWriteTarget(absTarget);
          } catch (_) {
            result = { row: 10, decision: "allow" };
          }

          appendDebug({
            ts:     new Date().toISOString(),
            event:  result.debugEvent || "bash-classification",
            caller,
            target: absTarget,
            row:    result.row,
            decision: result.decision,
          });

          if (result.decision === "block") {
            process.stderr.write(
              `worktree-isolation-guard: subagent ${caller} attempted to write` +
              ` the MAIN checkout via Bash (${absTarget}).\n` +
              `Worktree-isolated subagents must write only inside their linked worktree` +
              ` (under .claude/worktrees/...), never the main checkout.\n` +
              `Perform this write inside your worktree copy.\n`
            );
            process.exit(2);
          }
        }
      }
      // No target hit row 7 → allow.
      process.exit(0);

    } catch (_) {
      // Any unexpected error in the Bash branch → fail-open.
      process.exit(0);
    }
  }

  // ── Write / Edit branch ──────────────────────────────────────────────────
  if (tool_name !== "Write" && tool_name !== "Edit") {
    process.exit(0);
  }

  // ── Step 2: ROOT is always allowed to edit the main checkout ────────────
  // The main orchestrator session legitimately works in the main checkout.
  // Only subagents (agent_id present) are constrained by the isolation rule.
  if (caller === "ROOT") {
    process.exit(0);
  }

  // ── Row 3: Missing or empty file_path — cannot determine; fail-open ─────
  if (!filePath) {
    appendDebug({
      ts: new Date().toISOString(), event: "no-target-determinable",
      reason: "missing-file-path", caller,
    });
    process.exit(0);
  }

  // ── Row 4: Handoff rotation files are exempt ─────────────────────────────
  // HANDOFF.md / HANDOFF-HISTORY.md are gitignored, exist only in the main
  // checkout, and rotation is delegated to the handoff-writer subagent. Allow.
  if (isHandoffFile(filePath)) {
    process.exit(0);
  }

  // ── Rows 5-10: full hardened-spec-A evaluation ───────────────────────────
  let result;
  try {
    result = evaluateWriteTarget(filePath);
  } catch (_) {
    result = { row: 10, decision: "allow" };
  }

  appendDebug({
    ts:        new Date().toISOString(),
    event:     result.debugEvent || "classification",
    caller,
    file_path: filePath,
    row:       result.row,
    decision:  result.decision,
  });

  if (result.decision === "block") {
    // POSITIVE CONFIRMATION: subagent is editing a TRACKED file in the MAIN
    // checkout → block.
    process.stderr.write(
      `worktree-isolation-guard: subagent ${caller} attempted to edit the MAIN checkout` +
      ` (${filePath}).\n` +
      `Worktree-isolated subagents must edit only inside their linked worktree` +
      ` (under .claude/worktrees/...), never the main checkout.\n` +
      `Make this edit in your worktree copy.\n`
    );
    process.exit(2);
  }

  // decision === "allow" (rows 5, 6, 8, 9, or a fail-open 10) → allow.
  process.exit(0);
}

// Top-level guard: if main() throws unexpectedly, exit 0 to avoid
// breaking unrelated tooling.  Only confident positive evidence blocks.
if (require.main === module) {
  try {
    main();
  } catch (topErr) {
    process.exit(0);
  }
}

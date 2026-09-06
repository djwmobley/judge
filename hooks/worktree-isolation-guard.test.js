"use strict";
// worktree-isolation-guard.test.js
// Unit tests for the worktree-isolation-guard hook.
// Run with:  node hooks/worktree-isolation-guard.test.js (from the repo root)
//
// Uses node:test + node:assert (Node v18+ built-ins; Node v22 available here).
//
// Strategy: uses REAL temporary git repos (git init + git worktree add) rather
// than mocking git internals.  This ensures the classifyPath() logic is verified
// against actual git behavior on this machine, including the --git-common-dir
// relative-path quirk on Windows (git 2.52.0.windows.1).
//
// Test matrix:
//   T1  classifyPath — existing file in main checkout → "main"
//   T2a classifyPath — existing file in linked worktree → "worktree"
//   T2b classifyPath — non-existent file inside linked worktree (new Write) → "worktree"
//   T2c classifyPath — non-existent file inside main checkout (new Write) → "main"
//   T3  classifyPath — path outside any git repo → "unknown"
//   T4  hook stdin: subagent + main checkout (Write) → exit 2 (blocked)
//   T5  hook stdin: subagent + linked worktree (Write) → exit 0 (allowed)
//   T6  hook stdin: ROOT + main checkout → exit 0 (allowed)
//   T7  hook stdin: non-Write/Edit tool name (Bash read-only) → exit 0 (allowed)
//   T8  hook stdin: missing file_path → exit 0 (allowed, fail-open)
//   T9  hook stdin: path outside any git repo → exit 0 (allowed, fail-open)
//   T10 hook stdin: subagent + Edit tool + main checkout → exit 2 (blocked)
//   T11 hook stdin: malformed stdin JSON → exit 0 (fail-open)
//
//   Bash integration tests (new):
//   TB1  subagent + Bash + `echo hi > <ABS main path>` → exit 2 (blocked)
//   TB2  subagent + Bash + `sed -i 's/a/b/' <ABS main path>` → exit 2 (blocked)
//   TB3  subagent + Bash + `tee <ABS main path>` → exit 2 (blocked)
//   TB4  subagent + Bash + `echo hi > relative` with cwd=worktree → exit 0 (allowed)
//   TB5  subagent + Bash + `echo hi > <ABS worktree path>` → exit 0 (allowed)
//   TB6  ROOT  + Bash + `echo hi > <ABS main path>` → exit 0 (allowed)
//   TB7  subagent + Bash + read-only (`cat <ABS main path>`) → exit 0 (allowed)
//   TB8  subagent + Bash + ambiguous (`cd /x && echo > f`) → exit 0 (fail-open)
//   TB9  subagent + Bash + variable path (`echo > $DIR/f`) → exit 0 (fail-open)
//
//   extractBashWriteTargets unit tests (new):
//   TU1  redirect: `echo hi > /tmp/out.txt` → ["/tmp/out.txt"]
//   TU2  redirect: `echo hi >> /tmp/out.txt` → ["/tmp/out.txt"]
//   TU3  tee: `cmd | tee /tmp/out.txt` → ["/tmp/out.txt"]
//   TU4  sed: `sed -i 's/a/b/' /tmp/f.txt` → ["/tmp/f.txt"]
//   TU5  cp:  `cp src.txt /tmp/dest.txt` → ["/tmp/dest.txt"]
//   TU6  dd:  `dd if=/dev/zero of=/tmp/out.bin` → ["/tmp/out.bin"]
//   TU7  heredoc body with fake `>` NOT extracted
//   TU8  variable path skipped: `echo hi > $DIR/f` → []
//   TU9  stderr redirect skipped: `cmd 2>/dev/null` → []
//   TU10 mv:  `mv src.txt /tmp/dest.txt` → ["/tmp/dest.txt"]
//
//   Field bug fix (2026-08-16): install-DEST false positive on `npm install`
//   plus a shared argument-boundary fix across sed/cp/mv/truncate/install.
//   extractBashWriteTargets unit tests:
//   TU11 `npm install` (plain) → [] (categorical: "install" not in command
//        position, not npm-special-cased — same for pip/yarn/cargo/apt-get)
//   TU12 `npm install 2>&1 | tail -5` → [] (the exact field repro)
//   TU13 `pip install requests` / `yarn install` / `cargo install ripgrep` /
//        `apt-get install -y curl` → [] each (categorical, not npm-only)
//   TU14 `npm install --prefix /out/of/worktree/path` → [] (npm's own write
//        target was never modeled by this hook; judged per its documented
//        "too tool-specific to guess" scope, same as awk/python/perl)
//   TU15 `install src.txt /tmp/dest.txt` (plain coreutils, command position)
//        → ["/tmp/dest.txt"] (must STILL detect — the intended case)
//   TU16 `install src.txt /tmp/dest.txt 2>&1 | tail -5` →
//        ["/tmp/dest.txt"] (still detects DEST correctly; no more bogus "2"
//        fragment from the old unbounded arg capture)
//   TU17 `sudo install src.txt /tmp/dest.txt` → [] (documented blind spot:
//        a wrapper word before "install" is conservatively treated the same
//        as a subcommand — fail-open, not a regression target)
//   TU18 `cp src.txt /tmp/dest.txt 2>&1 | tail -5` → ["/tmp/dest.txt"]
//        (categorical arg-boundary fix also verified for cp, not install-only)
//   TU19 `mv src.txt /tmp/dest.txt 2>&1 | tail` → ["/tmp/dest.txt"]
//   TU20 `sed -i s/a/b/ /tmp/f.txt 2>&1 | tail -5` → ["/tmp/f.txt"]
//   TU21 `truncate -s 0 /tmp/out.txt 2>&1 | tail` → ["/tmp/out.txt"]
//
//   Hook-level (real git repo) evidence, per intended detection, that the
//   fix does not regress any existing detector:
//   TB10 subagent + Bash `npm install` (plain, cwd=worktree) → exit 0
//   TB11 subagent + Bash `npm install 2>&1 | tail -5` → exit 0 (field repro)
//   TB12 subagent + Bash `npm install --prefix <ABS main path>` → exit 0
//        (judged: npm's own write target is out of this hook's scope)
//   TB13 subagent + Bash plain `install SRC <ABS main path>` → exit 2
//        (install detector must STILL block a real coreutils invocation)
//   TB14 subagent + Bash `cp SRC <ABS main path> 2>&1 | tail -5` → exit 2
//        (cp must still block; proves the arg-boundary fix doesn't weaken it)
//   TB15 subagent + Bash `mv SRC <ABS main path>` → exit 2 (mv still blocks)
//   TB16 subagent + Bash `dd of=<ABS main path>` → exit 2 (dd still blocks)
//   TB17 subagent + Bash `truncate <ABS main path>` → exit 2
//        (truncate still blocks)
//
//   Hardened spec A (2026-08-24): tracked-ness total classification, one
//   normalization engine, cd-aware Bash relative-target resolution, mv-source
//   semantics. NOTE: makeTestRepo() now pre-commits (tracks) several more
//   fixture filenames (scripts/something.js, hack.txt, installed-file,
//   cp-target.txt, mv-target.txt, dd-target.bin, truncate-target.txt,
//   tracked-file.js, src.txt) and adds a .gitignore (*.log, ignored-*.txt) —
//   required because T4/TB1/TB3/TB13-TB17's pre-existing BLOCK expectations
//   are only meaningful against a TRACKED target now that row 9 (brand-new
//   untracked main-checkout write) correctly allows instead of blocking.
//   T12-T15  (new): row-7/8/9 + identity-semantics regression coverage —
//            T12 tracked→block, T13 gitignored→allow (repro-1a), T14
//            brand-new-untracked→allow+debug event (repro-1a2), T15a/T15b
//            normalizeForCompare unit tests (full lowercase; MSYS /c/...
//            identity), T15c drive-letter-casing variant→block at the hook
//            level. T15d/T15e (V-1, validator-found+closed 2026-08-24):
//            mid-path case-flip of an EXISTING tracked file→block
//            (canonicalizeIfExists), and the companion — mid-path
//            case-flip of a GENUINELY NONEXISTENT file→still row 9 allow.
//   TB8      REWRITTEN: the original fixture passed cwd=worktree, which
//            masked the cd-unaware base-resolution bug (it coincidentally
//            resolved into the worktree either way). Now passes cwd=mainDir
//            so the `cd /tmp` in the command text is the ONLY thing that can
//            make the relative target resolve outside any repo.
//   TB18-TB24 (new): cd-aware resolution (A-3/A-4) — TB18 cd-into-worktree
//            relative-redirect with hook cwd=main (repro-1b, was a false
//            positive), TB19 cd-into-worktree then relative ESCAPE back to a
//            tracked main file (closes the confirmed false negative), TB20
//            cd-into-main dodge with hook cwd=worktree, TB21 ambiguous `cd
//            $DIR` → INDETERMINATE fail-open, TB22 append (>>) to a tracked
//            main file, TB23 mv-source semantics (A-2), TB24 redirect to a
//            gitignored main-checkout .log path (repro-1c).

const { test, after } = require("node:test");
const assert          = require("node:assert/strict");
const fs              = require("fs");
const path            = require("path");
const os              = require("os");
const { execFileSync, execSync } = require("child_process");

const HOOK_PATH  = path.join(__dirname, "worktree-isolation-guard.js");
const DEBUG_LOG  = path.join(__dirname, "worktree-isolation-guard-debug.log");
const { classifyPath, extractBashWriteTargets, normalizeForCompare } = require(HOOK_PATH);

// ── Temp repo setup ──────────────────────────────────────────────────────────

/**
 * Create a real temporary git repo with one commit plus one linked worktree.
 * Returns:
 *   mainDir   — absolute path to the main checkout
 *   wtDir     — absolute path to the linked worktree
 *   tmpBase   — the temp base dir (for cleanup)
 */
function makeTestRepo() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "wt-guard-test-"));
  const mainDir = path.join(tmpBase, "main");
  const wtDir   = path.join(tmpBase, "wt");

  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(path.join(mainDir, "scripts"), { recursive: true });

  // Initialize repo.
  execSync("git init", { cwd: mainDir, encoding: "utf8" });
  execSync("git config user.email test@test.com", { cwd: mainDir, encoding: "utf8" });
  execSync("git config user.name Test",           { cwd: mainDir, encoding: "utf8" });

  // Create tracked fixture files, commit.
  //
  // Hardened spec A (2026-08-24): classification now consults TRACKED-NESS,
  // not just directory containment — an untracked main-checkout write no
  // longer blocks (row 9). Every pre-existing test that asserts a BLOCK
  // (exit 2) therefore needs its target to be an explicitly TRACKED file, or
  // the new tracked-ness-aware classification would correctly (and
  // intentionally) allow it as a brand-new untracked write instead. The
  // filenames below are committed here specifically so the pre-existing
  // T4/TB1/TB3/TB13-TB17 block-expectations stay meaningful without changing
  // those tests' bodies at all — only this shared fixture setup changed.
  fs.writeFileSync(path.join(mainDir, "file.txt"), "hello\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "scripts", "something.js"), "// tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "hack.txt"), "tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "installed-file"), "tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "cp-target.txt"), "tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "mv-target.txt"), "tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "dd-target.bin"), "tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "truncate-target.txt"), "tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "tracked-file.js"), "// tracked\n", "utf8");
  fs.writeFileSync(path.join(mainDir, "src.txt"), "tracked\n", "utf8");
  // .gitignore fixture for the ignored-vs-untracked rows (8 vs 9).
  fs.writeFileSync(path.join(mainDir, ".gitignore"), "*.log\nignored-*.txt\n", "utf8");
  execSync("git add .", { cwd: mainDir, encoding: "utf8" });
  execSync("git commit -m init", { cwd: mainDir, encoding: "utf8" });

  // Add a linked worktree.
  execSync(`git worktree add "${wtDir}"`, { cwd: mainDir, encoding: "utf8" });

  return { mainDir, wtDir, tmpBase };
}

// Create ONE shared repo for classify tests (T1–T3) and hook integration tests (T4–T11).
const { mainDir, wtDir, tmpBase } = makeTestRepo();

// Path outside any git repo (OS temp root is safe to assume not under a repo).
// Use a fresh dedicated dir so it definitely has no .git.
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-guard-outside-"));
const outsidePath = path.join(outsideDir, "something.txt");

// ── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  // Remove linked worktree before deleting tmpBase, otherwise git complains.
  try {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: mainDir, encoding: "utf8" });
  } catch (_) {
    // Ignore errors here — cleanup best-effort.
  }
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (_) {}
  try {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  } catch (_) {}
});

// ── Helper: spawn hook with a constructed stdin payload ──────────────────────

/**
 * Invoke the hook as a subprocess with the given JSON payload as stdin.
 * Returns { exitCode, stderr } without throwing on non-zero exit.
 */
function runHook(payload) {
  let exitCode = 0;
  let stderr   = "";
  try {
    execFileSync(
      "node",
      [HOOK_PATH],
      {
        input:    JSON.stringify(payload),
        encoding: "utf8",
        timeout:  15000,
      }
    );
    // Exited 0.
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stderr   = (err.stderr) ? String(err.stderr) : "";
  }
  return { exitCode, stderr };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// T1: classifyPath — file in main checkout → "main"
test("T1: classifyPath — existing file in main checkout → 'main'", () => {
  const target = path.join(mainDir, "file.txt");
  const result = classifyPath(target);
  assert.equal(
    result,
    "main",
    `expected "main" for ${target}, got ${JSON.stringify(result)}`
  );
});

// T2a: classifyPath — existing file in linked worktree → "worktree"
test("T2a: classifyPath — existing file in linked worktree → 'worktree'", () => {
  const target = path.join(wtDir, "file.txt");
  const result = classifyPath(target);
  assert.equal(
    result,
    "worktree",
    `expected "worktree" for ${target}, got ${JSON.stringify(result)}`
  );
});

// T2b: classifyPath — non-existent file INSIDE linked worktree (new Write) → "worktree"
//      Critical new-file case: the file doesn't exist yet; we walk up to the
//      existing worktree directory and classify from there.
test("T2b: classifyPath — non-existent file inside linked worktree → 'worktree'", () => {
  const target = path.join(wtDir, "new-file-that-does-not-exist.txt");
  const result = classifyPath(target);
  assert.equal(
    result,
    "worktree",
    `expected "worktree" for non-existent ${target}, got ${JSON.stringify(result)}`
  );
});

// T2c: classifyPath — non-existent file INSIDE main checkout (new Write) → "main"
test("T2c: classifyPath — non-existent file inside main checkout → 'main'", () => {
  const target = path.join(mainDir, "new-file-that-does-not-exist.txt");
  const result = classifyPath(target);
  assert.equal(
    result,
    "main",
    `expected "main" for non-existent ${target}, got ${JSON.stringify(result)}`
  );
});

// T3: classifyPath — path outside any git repo → "unknown"
test("T3: classifyPath — path outside any git repo → 'unknown'", () => {
  const result = classifyPath(outsidePath);
  assert.equal(
    result,
    "unknown",
    `expected "unknown" for ${outsidePath}, got ${JSON.stringify(result)}`
  );
});

// T4: Full hook — subagent editing main checkout → blocked (exit 2)
test("T4: hook — subagent + Write + main checkout → exit 2 (blocked)", () => {
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: path.join(mainDir, "scripts", "something.js") },
    agent_id:   "agent-abc123",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}. stderr: ${stderr}`);
  assert.ok(
    stderr.includes("MAIN checkout"),
    `expected stderr to mention "MAIN checkout"; got: ${stderr}`
  );
});

// T5: Full hook — subagent editing linked worktree → allowed (exit 0)
test("T5: hook — subagent + Write + linked worktree → exit 0 (allowed)", () => {
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: path.join(wtDir, "scripts", "something.js") },
    agent_id:   "agent-abc123",
    cwd:        wtDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (allow), got ${exitCode}`);
});

// T6: Full hook — ROOT editing main checkout → allowed (exit 0)
test("T6: hook — ROOT + Write + main checkout → exit 0 (allowed)", () => {
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: path.join(mainDir, "scripts", "something.js") },
    // No agent_id → ROOT
    cwd:        mainDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (ROOT always allowed), got ${exitCode}`);
});

// T7: Full hook — non-Write/Edit tool name (Bash) → allowed (exit 0)
test("T7: hook — non-Write/Edit tool (Bash) + subagent + main → exit 0 (allowed)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "echo hello" },
    agent_id:   "agent-abc123",
    cwd:        mainDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 for non-Write/Edit tool, got ${exitCode}`);
});

// T8: Full hook — missing file_path → allowed (exit 0, fail-open)
test("T8: hook — subagent + missing file_path → exit 0 (fail-open)", () => {
  const payload = {
    tool_name:  "Write",
    tool_input: {},
    agent_id:   "agent-abc123",
    cwd:        mainDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (fail-open on missing path), got ${exitCode}`);
});

// T9: Full hook — subagent, path outside any git repo → allowed (exit 0, fail-open)
test("T9: hook — subagent + path outside any git repo → exit 0 (fail-open)", () => {
  const payload = {
    tool_name:  "Edit",
    tool_input: { file_path: outsidePath },
    agent_id:   "agent-abc123",
    cwd:        outsideDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (outside repo → unknown → allow), got ${exitCode}`);
});

// T10: Edit tool (not just Write) → same block rules apply
test("T10: hook — subagent + Edit + main checkout → exit 2 (blocked)", () => {
  const payload = {
    tool_name:  "Edit",
    tool_input: { file_path: path.join(mainDir, "file.txt") },
    agent_id:   "agent-xyz789",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 for Edit tool on main, got ${exitCode}. stderr: ${stderr}`);
});

// T11: Malformed stdin → allowed (exit 0, fail-open / do not break tooling)
test("T11: hook — malformed stdin JSON → exit 0 (fail-open)", () => {
  let exitCode = 0;
  try {
    execFileSync("node", [HOOK_PATH], {
      input:    "NOT VALID JSON !!!",
      encoding: "utf8",
      timeout:  8000,
    });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
  }
  assert.equal(exitCode, 0, `expected exit 0 on malformed stdin, got ${exitCode}`);
});

// ── Hardened spec A (2026-08-24) new tests: T12-T15 ─────────────────────────
// Total classification (rows 1-10), identity semantics. See the hook's own
// header comment for the full row table.

// T12: subagent + Write + main + explicitly-tracked file → exit 2 (row 7).
// Uses a dedicated freshly-committed tracked file so the "tracked" condition
// is unambiguous and independent of any other test's fixture.
test("T12: hook — subagent + Write + main + tracked file → exit 2 (row 7, block)", () => {
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: path.join(mainDir, "tracked-file.js") },
    agent_id:   "agent-t12",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (tracked main file), got ${exitCode}. stderr: ${stderr}`);
  assert.ok(stderr.includes("MAIN checkout"), `expected stderr to mention "MAIN checkout"; got: ${stderr}`);
});

// T13: subagent + Write + main + gitignored file → exit 0 (row 8, repro-1a).
test("T13: hook — subagent + Write + main + gitignored file → exit 0 (row 8, repro-1a)", () => {
  const target = path.join(mainDir, "ignored-scratch-note.txt"); // matches .gitignore's ignored-*.txt
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: target },
    agent_id:   "agent-t13",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (gitignored main file), got ${exitCode}. stderr: ${stderr}`);
});

// T14: subagent + Write + main + brand-new untracked file → exit 0 + debug
// event "untracked-main-write" logged (row 9, repro-1a2).
test("T14: hook — subagent + Write + main + brand-new untracked file → exit 0 + debug untracked-main-write (row 9, repro-1a2)", () => {
  const target = path.join(mainDir, "docs-notes", "brand-new-untracked-note.md");
  const beforeSize = fs.existsSync(DEBUG_LOG) ? fs.statSync(DEBUG_LOG).size : 0;
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: target },
    agent_id:   "agent-t14",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (brand-new untracked main file), got ${exitCode}. stderr: ${stderr}`);
  const afterContent = fs.readFileSync(DEBUG_LOG, "utf8");
  const newContent = afterContent.slice(beforeSize);
  assert.ok(
    /"event":"untracked-main-write"/.test(newContent) &&
    newContent.includes("agent-t14"),
    `expected a NEW debug-log line with event "untracked-main-write" for this invocation; new content: ${newContent}`
  );
});

// T15: identity semantics (normalizeForCompare — hardened spec A pinned
// normalization engine — PLUS canonicalizeIfExists, the V-1 hardening added
// 2026-08-24 after independent validation).
//
// NOTE on test design: normalizeForCompare is used ONLY for the
// classifyPath "main vs worktree" DIRECTORY-identity comparison (two
// absolute paths BOTH returned by git for the SAME repo probe) — it is
// NEVER applied to a path handed to a git tracked-ness/ignore-status probe
// (checkMainTrackedness). T15a/T15b below unit-test normalizeForCompare
// directly; T15c is a realistic drive-letter-casing regression at the hook
// level (drive-letter casing is the one segment both the OS and git's own
// directory traversal handle case-insensitively regardless of this file's
// logic).
//
// V-1 (validator-found, 2026-08-24, CLOSED): a MID-PATH case-flip — e.g.
// `SCRIPTS\handoff.js` instead of the tracked `scripts\handoff.js` — used
// to evade detection entirely: `git ls-files --error-unmatch`'s pathspec
// matching is a case-SENSITIVE text comparison against the index (unlike
// Windows filesystem calls, which resolve such a path to the same file
// case-insensitively), so the mismatched pathspec reported "not tracked" ->
// row 9 (untracked, ALLOW) even though the write physically lands on the
// tracked file. Closed by canonicalizeIfExists: any EXISTING target is
// resolved to its TRUE on-disk casing (via fs.realpathSync.native) before
// it is ever handed to a git tracked-ness probe — see that function's own
// doc comment for why a genuinely nonexistent target is unaffected (row 9
// stays correct there). T15d/T15e below are the direct regression pair the
// validator asked for.
test("T15a: normalizeForCompare — full lowercase, not just the drive letter (unit)", () => {
  const mixed = "C:\\Home\\Testuser\\Dev\\Claude-Memory\\SCRIPTS\\Handoff.js";
  const norm = normalizeForCompare(mixed);
  assert.equal(norm, norm.toLowerCase(), "result must be fully lowercase");
  assert.equal(
    normalizeForCompare("c:\\home\\testuser\\dev\\claude-memory\\scripts\\handoff.js"),
    norm,
    "two differently-cased-but-equivalent paths must normalize identically"
  );
});

test("T15b: normalizeForCompare — MSYS /c/... form normalizes to the same identity as its Windows equivalent (unit)", () => {
  const posixForm = "/C/Home/Testuser/Dev/Claude-Memory";
  const winForm = "C:\\Home\\Testuser\\Dev\\Claude-Memory";
  assert.equal(normalizeForCompare(posixForm), normalizeForCompare(winForm));
});

test("T15c: hook — subagent + Edit + main + tracked, DRIVE-LETTER casing variant → exit 2 (realistic identity regression)", () => {
  const target = path.join(mainDir, "file.txt");
  // Flip ONLY the drive letter's case — the one path segment both the OS
  // and git treat case-insensitively end-to-end, unlike an arbitrary
  // mid-path segment (see the note above).
  const flipped = /^[A-Za-z]:/.test(target)
    ? (target[0] === target[0].toLowerCase() ? target[0].toUpperCase() : target[0].toLowerCase()) + target.slice(1)
    : target;
  const payload = {
    tool_name:  "Edit",
    tool_input: { file_path: flipped },
    agent_id:   "agent-t15c",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (same tracked file, drive-letter casing variant), got ${exitCode}. stderr: ${stderr}`);
});

// T15d (V-1 regression, validator-required): a MID-PATH case-flipped
// EXISTING tracked file must now BLOCK. Before canonicalizeIfExists, this
// resolved to row 9 (untracked, allow) — the confirmed evasion.
test("T15d: hook — subagent + Write + main, MID-PATH case-flipped EXISTING tracked file → exit 2 (V-1 closed)", () => {
  const realTarget = path.join(mainDir, "scripts", "something.js"); // tracked (initial commit)
  const flipped = realTarget.replace(
    path.join(mainDir, "scripts"),
    path.join(mainDir, "SCRIPTS")
  );
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: flipped },
    agent_id:   "agent-t15d",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(
    exitCode, 2,
    `expected exit 2 (mid-path case-flip of a tracked file must be canonicalized and blocked), got ${exitCode}. stderr: ${stderr}`
  );
  assert.ok(stderr.includes("MAIN checkout"), `expected stderr to mention "MAIN checkout"; got: ${stderr}`);
});

// T15e (V-1 companion, validator-required): a MID-PATH case-flipped path to
// a GENUINELY NONEXISTENT file must still be row 9 (allow) — canonicalizing
// an existing target must never widen into treating a brand-new file as if
// it already existed under some other casing.
test("T15e: hook — subagent + Write + main, MID-PATH case-flipped path to a GENUINELY NONEXISTENT file → exit 0 (row 9 still allow)", () => {
  const flipped = path.join(mainDir, "SCRIPTS", "brand-new-nonexistent-file.js");
  const payload = {
    tool_name:  "Write",
    tool_input: { file_path: flipped },
    agent_id:   "agent-t15e",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(
    exitCode, 0,
    `expected exit 0 (genuinely new file must stay row 9 allow regardless of casing), got ${exitCode}. stderr: ${stderr}`
  );
});

// ── extractBashWriteTargets unit tests ────────────────────────────────────────

// TU1: redirect > FILE
test("TU1: extractBashWriteTargets — redirect > FILE", () => {
  const r = extractBashWriteTargets("echo hi > /tmp/out.txt");
  assert.ok(r.includes("/tmp/out.txt"), `expected ["/tmp/out.txt"], got ${JSON.stringify(r)}`);
});

// TU2: redirect >> FILE
test("TU2: extractBashWriteTargets — append redirect >> FILE", () => {
  const r = extractBashWriteTargets("echo hi >> /tmp/out.txt");
  assert.ok(r.includes("/tmp/out.txt"), `expected ["/tmp/out.txt"], got ${JSON.stringify(r)}`);
});

// TU3: tee FILE
test("TU3: extractBashWriteTargets — tee FILE", () => {
  const r = extractBashWriteTargets("some-cmd | tee /tmp/out.txt");
  assert.ok(r.includes("/tmp/out.txt"), `expected ["/tmp/out.txt"], got ${JSON.stringify(r)}`);
});

// TU4: sed -i FILE
test("TU4: extractBashWriteTargets — sed -i FILE", () => {
  const r = extractBashWriteTargets("sed -i 's/a/b/' /tmp/f.txt");
  assert.ok(r.includes("/tmp/f.txt"), `expected ["/tmp/f.txt"], got ${JSON.stringify(r)}`);
});

// TU5: cp SRC DEST
test("TU5: extractBashWriteTargets — cp SRC DEST", () => {
  const r = extractBashWriteTargets("cp src.txt /tmp/dest.txt");
  assert.ok(r.includes("/tmp/dest.txt"), `expected ["/tmp/dest.txt"], got ${JSON.stringify(r)}`);
});

// TU6: dd of=FILE
test("TU6: extractBashWriteTargets — dd of=FILE", () => {
  const r = extractBashWriteTargets("dd if=/dev/zero of=/tmp/out.bin bs=1024 count=1");
  assert.ok(r.includes("/tmp/out.bin"), `expected ["/tmp/out.bin"], got ${JSON.stringify(r)}`);
});

// TU7: heredoc body with fake '>' MUST NOT be extracted
test("TU7: extractBashWriteTargets — heredoc body fake redirect not extracted", () => {
  const cmd = "cat <<EOF\n> /evil/path/main/file.txt\nEOF";
  const r = extractBashWriteTargets(cmd);
  assert.ok(
    !r.includes("/evil/path/main/file.txt"),
    `heredoc body '>' must not be extracted; got ${JSON.stringify(r)}`
  );
});

// TU8: variable path skipped (ambiguous)
test("TU8: extractBashWriteTargets — variable path skipped", () => {
  const r = extractBashWriteTargets("echo hi > $DIR/f");
  assert.deepEqual(r, [], `expected [] for variable path, got ${JSON.stringify(r)}`);
});

// TU9: stderr redirect 2>/dev/null not extracted
test("TU9: extractBashWriteTargets — stderr redirect 2>/dev/null skipped", () => {
  const r = extractBashWriteTargets("cmd 2>/dev/null");
  assert.deepEqual(r, [], `expected [] for stderr redirect, got ${JSON.stringify(r)}`);
});

// TU10: mv SRC DEST
test("TU10: extractBashWriteTargets — mv SRC DEST", () => {
  const r = extractBashWriteTargets("mv /tmp/src.txt /tmp/dest.txt");
  assert.ok(r.includes("/tmp/dest.txt"), `expected ["/tmp/dest.txt"], got ${JSON.stringify(r)}`);
});

// ── Field bug fix (2026-08-16): install-DEST false positive + shared
// argument-boundary fix. See extractBashWriteTargets' section-7 comment and
// the extractArgsUntilBoundary helper for the full reasoning. ────────────

// TU11: npm install (plain) — categorical, not npm-special-cased.
test("TU11: extractBashWriteTargets — npm install (plain) → []", () => {
  const r = extractBashWriteTargets("npm install");
  assert.deepEqual(r, [], `expected [] (install not in command position), got ${JSON.stringify(r)}`);
});

// TU12: the exact field repro — npm install with a trailing redirect+pipe.
test("TU12: extractBashWriteTargets — npm install 2>&1 | tail -5 → [] (field repro)", () => {
  const r = extractBashWriteTargets("npm install 2>&1 | tail -5");
  assert.deepEqual(r, [], `expected [] (field repro must not produce a bogus target), got ${JSON.stringify(r)}`);
});

// TU13: categorical across every package manager, not just npm.
test("TU13: extractBashWriteTargets — other package managers' install subcommand → [] each", () => {
  const cmds = [
    "pip install requests",
    "yarn install",
    "cargo install ripgrep",
    "apt-get install -y curl",
    "brew install jq",
    "gem install rails",
    "conda install numpy",
    "composer install",
    "go install ./...",
    "pnpm install",
  ];
  for (const cmd of cmds) {
    const r = extractBashWriteTargets(cmd);
    assert.deepEqual(r, [], `expected [] for ${JSON.stringify(cmd)}, got ${JSON.stringify(r)}`);
  }
});

// TU14: npm install --prefix <out-of-worktree path> — judged per the hook's
// documented intent: npm's own write target was never modeled by this hook
// (same "too tool-specific to guess" status as awk/python/perl inline
// writes), so this stays [] both before and after the fix's own change in
// behavior — the fix's effect here is only that "install" no longer even
// attempts (and previously mis-attempted, via the buggy flag-skip path) to
// treat --prefix's argument as a DEST.
test("TU14: extractBashWriteTargets — npm install --prefix <path> → [] (out of hook's modeled scope)", () => {
  const r = extractBashWriteTargets("npm install --prefix /some/main/checkout/path");
  assert.deepEqual(r, [], `expected [] (npm --prefix write target is not modeled by this hook), got ${JSON.stringify(r)}`);
});

// TU15: plain coreutils `install SRC DEST` at command position — must STILL
// be detected (the intended detection, unaffected by the false-positive fix).
test("TU15: extractBashWriteTargets — install SRC DEST (command position) → [DEST] (still detects)", () => {
  const r = extractBashWriteTargets("install src.txt /tmp/dest.txt");
  assert.ok(r.includes("/tmp/dest.txt"), `expected DEST still detected, got ${JSON.stringify(r)}`);
});

// TU16: plain coreutils install with a trailing redirect+pipe — must still
// resolve the REAL DEST, not a bogus fragment ("2") from the old unbounded
// argument capture.
test("TU16: extractBashWriteTargets — install SRC DEST 2>&1 | tail -5 → [DEST], no bogus fragment", () => {
  const r = extractBashWriteTargets("install src.txt /tmp/dest.txt 2>&1 | tail -5");
  assert.ok(r.includes("/tmp/dest.txt"), `expected DEST detected, got ${JSON.stringify(r)}`);
  assert.ok(!r.includes("2"), `must not leak a bogus "2" fragment, got ${JSON.stringify(r)}`);
});

// TU17: documented blind spot — a wrapper word (sudo) before "install" is
// conservatively treated the same as a subcommand (fail-open), not a
// regression target for this fix.
test("TU17: extractBashWriteTargets — sudo install SRC DEST → [] (documented blind spot, fail-open)", () => {
  const r = extractBashWriteTargets("sudo install src.txt /tmp/dest.txt");
  assert.deepEqual(r, [], `expected [] (wrapper-prefixed install is a documented fail-open gap), got ${JSON.stringify(r)}`);
});

// TU18-TU21: the SAME argument-boundary fix verified for cp/mv/sed/truncate
// — not an install-only patch. Each must still resolve the real DEST/FILE
// with a trailing redirect+pipe present, proving the categorical fix.
test("TU18: extractBashWriteTargets — cp SRC DEST 2>&1 | tail -5 → [DEST]", () => {
  const r = extractBashWriteTargets("cp src.txt /tmp/dest.txt 2>&1 | tail -5");
  assert.ok(r.includes("/tmp/dest.txt"), `expected DEST detected, got ${JSON.stringify(r)}`);
});

test("TU19: extractBashWriteTargets — mv SRC DEST 2>&1 | tail → [DEST]", () => {
  const r = extractBashWriteTargets("mv src.txt /tmp/dest.txt 2>&1 | tail");
  assert.ok(r.includes("/tmp/dest.txt"), `expected DEST detected, got ${JSON.stringify(r)}`);
});

test("TU20: extractBashWriteTargets — sed -i FILE 2>&1 | tail -5 → [FILE]", () => {
  const r = extractBashWriteTargets("sed -i s/a/b/ /tmp/f.txt 2>&1 | tail -5");
  assert.ok(r.includes("/tmp/f.txt"), `expected FILE detected, got ${JSON.stringify(r)}`);
});

test("TU21: extractBashWriteTargets — truncate FILE 2>&1 | tail → [FILE]", () => {
  const r = extractBashWriteTargets("truncate -s 0 /tmp/out.txt 2>&1 | tail");
  assert.ok(r.includes("/tmp/out.txt"), `expected FILE detected, got ${JSON.stringify(r)}`);
});

// ── Bash integration tests (real git repos) ───────────────────────────────────

// TB1: subagent + `echo hi > <ABS main path>` → blocked (exit 2)
test("TB1: hook — subagent + Bash redirect to ABS main path → exit 2 (blocked)", () => {
  const target = path.join(mainDir, "hack.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `echo hi > ${target}` },
    agent_id:   "agent-bash-tb1",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (blocked), got ${exitCode}. stderr: ${stderr}`);
  assert.ok(
    stderr.includes("MAIN checkout"),
    `expected stderr to mention "MAIN checkout"; got: ${stderr}`
  );
});

// TB2: subagent + `sed -i` on ABS main path → blocked (exit 2)
test("TB2: hook — subagent + Bash sed -i on ABS main path → exit 2 (blocked)", () => {
  const target = path.join(mainDir, "file.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `sed -i 's/hello/world/' ${target}` },
    agent_id:   "agent-bash-tb2",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (blocked), got ${exitCode}. stderr: ${stderr}`);
});

// TB3: subagent + `tee <ABS main path>` → blocked (exit 2)
test("TB3: hook — subagent + Bash tee to ABS main path → exit 2 (blocked)", () => {
  const target = path.join(mainDir, "hack.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `echo data | tee ${target}` },
    agent_id:   "agent-bash-tb3",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (blocked), got ${exitCode}. stderr: ${stderr}`);
});

// TB4: subagent + `echo hi > relative` with cwd=worktree → allowed (exit 0)
//      Relative path resolves into the worktree → not "main".
test("TB4: hook — subagent + Bash redirect to relative path with cwd=worktree → exit 0 (allowed)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "echo hi > output.txt" },
    agent_id:   "agent-bash-tb4",
    cwd:        wtDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (relative resolves into worktree), got ${exitCode}`);
});

// TB5: subagent + `echo hi > <ABS worktree path>` → allowed (exit 0)
test("TB5: hook — subagent + Bash redirect to ABS worktree path → exit 0 (allowed)", () => {
  const target = path.join(wtDir, "new-file.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `echo hi > ${target}` },
    agent_id:   "agent-bash-tb5",
    cwd:        wtDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (worktree target), got ${exitCode}`);
});

// TB6: ROOT + `echo hi > <ABS main path>` → allowed (exit 0)
test("TB6: hook — ROOT + Bash redirect to ABS main path → exit 0 (allowed)", () => {
  const target = path.join(mainDir, "root-edit.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `echo hi > ${target}` },
    // No agent_id → ROOT
    cwd:        mainDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (ROOT always allowed), got ${exitCode}`);
});

// TB7: subagent + read-only command (`cat <ABS main path>`) → allowed (exit 0)
test("TB7: hook — subagent + Bash read-only cat on main path → exit 0 (allowed)", () => {
  const target = path.join(mainDir, "file.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `cat ${target}` },
    agent_id:   "agent-bash-tb7",
    cwd:        wtDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (read-only, no write target), got ${exitCode}`);
});

// TB8 (REWRITTEN, hardened spec A): the ORIGINAL fixture passed cwd=wtDir,
// which MASKED the base-resolution bug this hardening pass fixes — under the
// old (non-cd-aware) code, the relative target resolved against the
// hook-input cwd (wtDir) regardless of the `cd /tmp` in the command text, so
// the test passed for the WRONG reason (coincidentally landing in the
// worktree) without ever exercising cd-tracking at all.
//
// Rewritten to pass a DIFFERENT hook-input cwd (mainDir, not wtDir) so the
// test actually exercises A-3: if cd-tracking were broken (silently
// resolving "somefile.txt" against the hook-input cwd instead of following
// `cd /tmp`), the target would land in mainDir — untracked there, so this
// specific rewrite doesn't distinguish "wrong base" from "right base" by
// itself; TB19/TB20 below are the tests that pin the tracked/untracked
// distinction. TB8 pins the more basic invariant: a `cd` to an absolute path
// outside any repo takes effect and resolves the relative target there
// (unknown → fail-open), not against parsed.cwd.
test("TB8: hook — subagent + Bash cd-then-redirect follows the cd, not the hook-input cwd (fail-open on the cd target) → exit 0", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "cd /tmp && echo hi > somefile.txt" },
    agent_id:   "agent-bash-tb8",
    cwd:        mainDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (cd /tmp resolves outside any repo -> unknown -> fail-open), got ${exitCode}`);
});

// TB9: subagent + variable path (`echo hi > $DIR/f`) → allowed (exit 0, fail-open)
test("TB9: hook — subagent + Bash variable path in redirect → exit 0 (fail-open)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "echo hi > $DIR/f" },
    agent_id:   "agent-bash-tb9",
    cwd:        wtDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (variable path skipped), got ${exitCode}`);
});

// ── Field bug fix (2026-08-16), hook-level evidence ──────────────────────

// TB10: npm install (plain) in a worktree cwd → allowed (exit 0).
// This is the false-positive the field report described.
test("TB10: hook — subagent + Bash `npm install` (plain) → exit 0 (allowed, fix verified)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "npm install" },
    agent_id:   "agent-bash-tb10",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}. stderr: ${stderr}`);
});

// TB11: the exact field repro — npm install with a trailing redirect+pipe,
// invoked with cwd resolving into the MAIN checkout (the reported failure
// mode: the bogus captured target resolved against the harness-tracked
// Bash cwd). Must now allow.
test("TB11: hook — subagent + Bash `npm install 2>&1 | tail -5` (cwd=main) → exit 0 (field repro fixed)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "npm install 2>&1 | tail -5" },
    agent_id:   "agent-bash-tb11",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (field repro must no longer false-block), got ${exitCode}. stderr: ${stderr}`);
});

// TB12: npm install --prefix <ABS main checkout path> — judged per the
// hook's documented intent: npm's own write mechanics were never modeled
// by this hook (same class as awk/python/perl inline writes), so this
// stays allowed even though --prefix names a path inside the main checkout.
test("TB12: hook — subagent + Bash `npm install --prefix <ABS main path>` → exit 0 (npm write target out of scope)", () => {
  const target = path.join(mainDir, "npm-prefix-target");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `npm install --prefix ${target}` },
    agent_id:   "agent-bash-tb12",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (npm --prefix target not modeled by this hook), got ${exitCode}. stderr: ${stderr}`);
});

// TB13: plain coreutils `install SRC <ABS main path>` — must STILL block.
test("TB13: hook — subagent + Bash plain `install SRC <ABS main path>` → exit 2 (still blocks)", () => {
  const target = path.join(mainDir, "installed-file");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `install src.txt ${target}` },
    agent_id:   "agent-bash-tb13",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (install must still block a real coreutils invocation), got ${exitCode}. stderr: ${stderr}`);
  assert.ok(stderr.includes("MAIN checkout"), `expected stderr to mention "MAIN checkout"; got: ${stderr}`);
});

// TB14: cp with a trailing redirect+pipe targeting the MAIN checkout — must
// still block, proving the shared arg-boundary fix does not weaken cp.
test("TB14: hook — subagent + Bash `cp SRC <ABS main path> 2>&1 | tail -5` → exit 2 (still blocks)", () => {
  const target = path.join(mainDir, "cp-target.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `cp src.txt ${target} 2>&1 | tail -5` },
    agent_id:   "agent-bash-tb14",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (cp must still block), got ${exitCode}. stderr: ${stderr}`);
});

// TB15: mv targeting the MAIN checkout — must still block (no existing
// TB-level test covered mv before this fix).
test("TB15: hook — subagent + Bash `mv SRC <ABS main path>` → exit 2 (still blocks)", () => {
  const target = path.join(mainDir, "mv-target.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `mv src.txt ${target}` },
    agent_id:   "agent-bash-tb15",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (mv must still block), got ${exitCode}. stderr: ${stderr}`);
});

// TB16: dd of=<ABS main path> — must still block (no existing TB-level test
// covered dd before this fix).
test("TB16: hook — subagent + Bash `dd of=<ABS main path>` → exit 2 (still blocks)", () => {
  const target = path.join(mainDir, "dd-target.bin");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `dd if=/dev/zero of=${target} bs=1 count=1` },
    agent_id:   "agent-bash-tb16",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (dd must still block), got ${exitCode}. stderr: ${stderr}`);
});

// TB17: truncate <ABS main path> — must still block (no existing TB-level
// test covered truncate before this fix).
test("TB17: hook — subagent + Bash `truncate <ABS main path>` → exit 2 (still blocks)", () => {
  const target = path.join(mainDir, "truncate-target.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `truncate -s 0 ${target}` },
    agent_id:   "agent-bash-tb17",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (truncate must still block), got ${exitCode}. stderr: ${stderr}`);
});

// ── Hardened spec A (2026-08-24) new tests: TB18-TB24 (cd-aware resolution,
// mv-source semantics, ignored-vs-untracked) ────────────────────────────────

// TB18: cd into the worktree, then a RELATIVE redirect — hook-input cwd is
// the MAIN dir (mirrors the real harness shape: the Bash tool call's own
// reported cwd is the project root, not wherever the command's own `cd`
// lands) → exit 0 (repro-1b: the confirmed false-positive this closes).
test("TB18: hook — subagent + Bash `cd \"<worktree>\" && cmd > rel.txt`, hook cwd = main → exit 0 (repro-1b)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `cd "${wtDir}" && node --test scripts/test-handoff.js > results.txt` },
    agent_id:   "agent-bash-tb18",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (relative target resolves into the worktree via cd-tracking), got ${exitCode}. stderr: ${stderr}`);
});

// TB19: cd into the worktree, then a relative redirect that traverses OUT of
// the worktree back into a TRACKED main-checkout file — hook-input cwd is
// again the MAIN dir → exit 2. This is the CONFIRMED FALSE NEGATIVE the
// hardened spec closes: under the old (non-cd-aware) code this relative
// path resolved against the hook-input cwd (mainDir) + "../../../file.txt",
// landing OUTSIDE any repo entirely → silently allowed, even though from the
// worktree's actual location this path targets a tracked main file.
test("TB19: hook — subagent + Bash cd-into-worktree then relative escape to a TRACKED main file → exit 2 (closes confirmed FN)", () => {
  const relFromWtToMain = path.relative(wtDir, mainDir).split(path.sep).join("/");
  const relTarget = relFromWtToMain + "/file.txt"; // "file.txt" is tracked (initial commit)
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `cd "${wtDir}" && echo hi > ${relTarget}` },
    agent_id:   "agent-bash-tb19",
    cwd:        mainDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (relative escape from worktree back to a tracked main file), got ${exitCode}. stderr: ${stderr}`);
});

// TB20: cd-into-main dodge — hook-input cwd is the WORKTREE (as a legitimate
// worktree-isolated subagent's Bash calls normally are), but the command
// itself `cd`s into the main checkout first, then writes a RELATIVE target
// that resolves (via the tracked cd, not the hook-input cwd) to a tracked
// main file → exit 2.
test("TB20: hook — subagent + Bash `cd \"<main>\" && echo x > <tracked rel path>`, hook cwd = worktree → exit 2", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `cd "${mainDir}" && echo x > file.txt` },
    agent_id:   "agent-bash-tb20",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (cd-into-main dodge must still block), got ${exitCode}. stderr: ${stderr}`);
});

// TB21: `cd $DIR && echo x > f` — a variable cd argument is ambiguous and
// latches effectiveCwd to INDETERMINATE for the rest of the command; the
// later relative target must fail-open, never silently fall back to the
// hook-input cwd.
test("TB21: hook — subagent + Bash `cd $DIR && echo x > f` → exit 0 (INDETERMINATE fail-open)", () => {
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: "cd $DIR && echo x > f" },
    agent_id:   "agent-bash-tb21",
    cwd:        wtDir,
  };
  const { exitCode } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (ambiguous cd target -> INDETERMINATE -> fail-open), got ${exitCode}`);
});

// TB22: append (>>) to a TRACKED ABS main path — transport-agnostic dodge
// closure (append, not just plain overwrite, must also block).
test("TB22: hook — subagent + Bash append (>>) to ABS tracked main path → exit 2", () => {
  const target = path.join(mainDir, "file.txt");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `echo more >> ${target}` },
    agent_id:   "agent-bash-tb22",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (append to tracked main file must block), got ${exitCode}. stderr: ${stderr}`);
});

// TB23: mv-away dodge (A-2) — the SOURCE of an mv is a tracked main file;
// the DEST is some unrelated path this hook would otherwise fail-open on.
// The source alone must trip row 7.
test("TB23: hook — subagent + Bash `mv <ABS tracked main path> /tmp/x` → exit 2 (A-2 mv-source semantics)", () => {
  const source = path.join(mainDir, "mv-target.txt"); // tracked (initial commit)
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `mv ${source} /tmp/mv-away-x` },
    agent_id:   "agent-bash-tb23",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 2, `expected exit 2 (mv SOURCE is tracked in main -> block via A-2), got ${exitCode}. stderr: ${stderr}`);
});

// TB24: redirect to an ABS main-checkout path that matches the .gitignore
// pattern (*.log) → exit 0 (row 8, repro-1c).
test("TB24: hook — subagent + Bash redirect to ABS main gitignored .log path → exit 0 (row 8, repro-1c)", () => {
  const target = path.join(mainDir, "bench-run-repro.log");
  const payload = {
    tool_name:  "Bash",
    tool_input: { command: `node scripts/bench-handoff.js > ${target}` },
    agent_id:   "agent-bash-tb24",
    cwd:        wtDir,
  };
  const { exitCode, stderr } = runHook(payload);
  assert.equal(exitCode, 0, `expected exit 0 (gitignored main-checkout target), got ${exitCode}. stderr: ${stderr}`);
});

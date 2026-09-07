"use strict";
// stop-stale-worktrees-guard.test.js
// Tests for the stop-stale-worktrees-guard Stop hook.
// Run with: node hooks/stop-stale-worktrees-guard.test.js (from the repo root)
//
// Most tests spawn the hook as a real subprocess (runHook, mirroring
// no-punt-guard.test.js's pattern) against REAL temporary git repositories
// (fs.mkdtempSync + execFileSync('git', ...)) -- no mocked git output for
// these. A small, explicitly-named set of tests instead calls the exported
// `evaluateStop()` in-process with an injected `execGit` and/or `now`
// clock, per the spec's own instruction to simulate deadline/timeout
// behavior rather than waiting a real 20 seconds:
//   - deadline_exceeded_blocks_with_partial_classification
//   - git_call_timeout_treated_as_failure_unknown_blocks
//   - git_failure_during_item_classification_unknown_blocks
//   - batched_git_calls_used_not_per_branch (needs to COUNT calls)
//   - worktree_missing_locked_prunable_fields_treated_as_false_with_prune_dry_run_cross_check
//     (needs to strip fields from real porcelain output)
// Every one of these still runs against a REAL temp git repo underneath;
// only the specific git call(s) under test are intercepted, everything
// else delegates to the hook's own real `defaultExecGit`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOK_PATH = path.join(__dirname, "stop-stale-worktrees-guard.js");
const {
  evaluateStop,
  defaultExecGit,
  normalizePathForCompare,
  resolveTargetDir,
  REBLOCK_STRIKE_CAP,
  computeItemKey,
  applyBoundedReblock,
  reblockStatePath,
  readReblockState,
  writeReblockStateAtomic,
  appendYieldLogLine,
  HMAC_KEY_FILENAME,
  HMAC_KEY_BYTES,
  hmacKeyPath,
  readOrCreateHmacKey,
  canonicalizeItems,
  computeMac,
} = require(HOOK_PATH);

// ─── Low-level git/fs helpers ──────────────────────────────────────────────

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // best-effort
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function gitAllowFail(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (err) {
    return { ok: false, err };
  }
}

function initRepo(defaultBranch) {
  const dir = mkTmpDir("stop-guard-repo-");
  git(dir, ["init", "-q", "-b", defaultBranch || "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeAndCommit(dir, "README.md", "init\n", "init");
  return dir;
}

function writeAndCommit(dir, filename, content, message) {
  fs.writeFileSync(path.join(dir, filename), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function currentBranch(dir) {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function addBareOrigin(dir, branch) {
  const bareDir = mkTmpDir("stop-guard-bare-");
  git(bareDir, ["init", "-q", "--bare"]);
  git(dir, ["remote", "add", "origin", bareDir]);
  git(dir, ["push", "-q", "-u", "origin", branch]);
  git(bareDir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  git(dir, ["remote", "set-head", "origin", "-a"]);
  return bareDir;
}

function primaryGitDir(dir) {
  return path.join(dir, ".git");
}

// Round-4 (§16) activity-recency helpers: condition (c) reads logs/HEAD's
// own recorded reflog timestamp (never a file mtime), so simulating a
// "quiet" worktree means rewriting that timestamp field in place, not
// touching the file's OS mtime.
function worktreeGitDir(repoDir, worktreePath) {
  return git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
}

function backdateReflog(gitDir, secondsAgo) {
  const reflogPath = path.join(gitDir, "logs", "HEAD");
  const oldTs = Math.floor(Date.now() / 1000) - secondsAgo;
  let content;
  try {
    content = fs.readFileSync(reflogPath, "utf8");
  } catch (_) {
    return; // no reflog -- nothing to backdate.
  }
  content = content.replace(/\d{10,}(?=\s[+-]\d{4}\t)/g, String(oldTs));
  fs.writeFileSync(reflogPath, content);
  const commitEditMsg = path.join(gitDir, "COMMIT_EDITMSG");
  if (fs.existsSync(commitEditMsg)) {
    const old = new Date(oldTs * 1000);
    fs.utimesSync(commitEditMsg, old, old);
  }
}

function plantMarker(dir, relPath, { isDir } = {}) {
  const p = path.join(primaryGitDir(dir), relPath);
  if (isDir) {
    fs.mkdirSync(p, { recursive: true });
  } else {
    fs.writeFileSync(p, "abc123\n");
  }
}

// ─── Hook subprocess runner ─────────────────────────────────────────────────

function withPathEnv(baseEnv, newPathValue) {
  const env = Object.assign({}, baseEnv);
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === "path") delete env[k];
  }
  env.PATH = newPathValue;
  return env;
}

// ─── Bounded-reblock test isolation ────────────────────────────────────────
// Every `runHook` call now goes through `main()`'s real bounded-reblock
// layer (docs/specs/stop-guard-bounded-reblock.md), which persists
// per-session, per-item strike state to disk. Two things must be true for
// the pre-existing (non-bounded-reblock) tests below to keep behaving as
// independent, single-shot checks: (1) each subprocess call gets its own
// fresh state directory, so unrelated tests never share strike counts via
// the real `hooks/state/` directory or via reusing the same session id,
// and (2) each call gets its own fresh `session_id` unless a test
// explicitly supplies one (including explicitly `undefined`, to exercise
// the missing-session_id path -- see the `'session_id' in payload` check
// below, which treats an explicit `session_id: undefined` as "caller
// wants it truly absent," distinct from "caller didn't think about it").
let reblockSessionCounter = 0;
const reblockTempDirs = [];
function freshReblockStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-stop-guard-state-"));
  reblockTempDirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of reblockTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // best-effort
    }
  }
});

/**
 * Run the hook as a subprocess. `opts.env` is merged over process.env;
 * `opts.cwd` is the child process's own working directory (independent of
 * CLAUDE_PROJECT_DIR / stdin cwd -- used to test the resolution fallback
 * chain itself).
 */
function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  if (!env.JUDGE_STOP_GUARD_STATE_DIR) {
    env.JUDGE_STOP_GUARD_STATE_DIR = freshReblockStateDir();
  }
  let finalPayload = payload || {};
  if (finalPayload && typeof finalPayload === "object" && !("session_id" in finalPayload)) {
    reblockSessionCounter += 1;
    finalPayload = Object.assign({}, finalPayload, {
      session_id: `test-session-${process.pid}-${reblockSessionCounter}-${Date.now()}`,
    });
  }
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(finalPayload),
      encoding: "utf8",
      timeout: 30000,
      env,
      cwd: opts.cwd,
    });
  } catch (err) {
    exitCode = err.status != null ? err.status : 1;
    stdout = err.stdout ? String(err.stdout) : "";
    stderr = err.stderr ? String(err.stderr) : "";
  }
  return { exitCode, stdout, stderr };
}

function runHookInRepo(repoDir, payload, envOverrides) {
  // No hardcoded default session_id here (a shared literal like "s1" would
  // reintroduce the exact cross-test strike pollution the isolation
  // machinery above exists to prevent) -- `runHook` itself fills in a
  // fresh, unique one whenever the payload doesn't mention the key at all.
  return runHook(payload || { stop_hook_active: false, cwd: repoDir },
    { env: Object.assign({ CLAUDE_PROJECT_DIR: repoDir }, envOverrides || {}) });
}

function parseDecision(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  return JSON.parse(trimmed);
}

// ═══════════════════════════════════════════════════════════════════════════
// Scope gate
// ═══════════════════════════════════════════════════════════════════════════

test("scope_not_a_repo_allows: temp dir with no .git allows silently", () => {
  const dir = mkTmpDir("stop-guard-notrepo-");
  try {
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
  }
});

test("scope_no_git_on_path: PATH stripped of git allows silently", () => {
  const dir = initRepo();
  try {
    const env = withPathEnv(
      Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir }),
      path.dirname(process.execPath)
    );
    const { exitCode, stdout } = runHook({ cwd: dir }, { env });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
  }
});

test("scope_bare_repo_allows: git init --bare allows silently", () => {
  const dir = mkTmpDir("stop-guard-bare-target-");
  git(dir, ["init", "-q", "--bare"]);
  try {
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
  }
});

test("scope_no_remote_uses_local_base: no remote, local main present, classifies normally", () => {
  const dir = initRepo("main");
  try {
    const base = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "-b", "oldfeature"]);
    git(dir, ["checkout", "-q", "main"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    void base;
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "expected a block decision");
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /oldfeature/);
    assert.match(decision.reason, /git branch -d oldfeature/);
  } finally {
    rmTree(dir);
  }
});

test("scope_submodule_in_scope: target dir inside a submodule classifies the submodule's own repo", () => {
  const subSource = initRepo("main");
  const outer = initRepo("main");
  try {
    git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subSource.replace(/\\/g, "/"), "sub"]);
    const subDir = path.join(outer, "sub");
    // A cloned submodule checkout does NOT inherit the outer repo's local
    // user.email/user.name config -- on a clean CI runner with no global
    // git identity configured at all, the writeAndCommit below fails with
    // "unable to auto-detect email address". Every repo this test suite
    // commits into needs its own explicit identity (initRepo() already
    // does this for repos it creates directly; a clone needs it set
    // separately since it isn't created via initRepo()).
    git(subDir, ["config", "user.email", "test@example.com"]);
    git(subDir, ["config", "user.name", "Test User"]);
    git(subDir, ["config", "commit.gpgsign", "false"]);
    // `submodule add` leaves the submodule with an "origin" remote whose
    // remote-tracking HEAD/main are frozen at clone time -- removing it
    // avoids that becoming the resolved base (a stale-remote-ref scenario
    // covered by its own dedicated test) and lets this test isolate what
    // it's actually checking: that classification happens against the
    // submodule's OWN repo, via local main.
    git(subDir, ["remote", "remove", "origin"]);
    // Create a stale (ancestor) branch inside the SUBMODULE's own repo.
    git(subDir, ["checkout", "-q", "-b", "oldfeature"]);
    git(subDir, ["checkout", "-q", "main"]);
    writeAndCommit(subDir, "sub-b.txt", "b\n", "advance submodule main");

    const { exitCode, stdout } = runHookInRepo(subDir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "expected a block decision from the submodule's own repo");
    assert.match(decision.reason, /oldfeature/);
  } finally {
    rmTree(outer);
    rmTree(subSource);
  }
});

test("scope_resolves_via_claude_project_dir_over_cwd: CLAUDE_PROJECT_DIR wins over stdin cwd and process cwd", () => {
  const realRepo = initRepo("main");
  const scratch = mkTmpDir("stop-guard-scratch-");
  try {
    git(realRepo, ["checkout", "-q", "-b", "oldfeature"]);
    git(realRepo, ["checkout", "-q", "main"]);
    writeAndCommit(realRepo, "b.txt", "b\n", "advance main");

    const { exitCode, stdout } = runHook(
      { cwd: scratch },
      { env: { CLAUDE_PROJECT_DIR: realRepo }, cwd: scratch }
    );
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "must classify the CLAUDE_PROJECT_DIR repo, not the scratch dir");
    assert.match(decision.reason, /oldfeature/);
  } finally {
    rmTree(realRepo);
    rmTree(scratch);
  }
});

test("scope_falls_back_to_stdin_cwd_when_project_dir_unset: uses stdin cwd", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "oldfeature"]);
    git(dir, ["checkout", "-q", "main"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    const env = Object.assign({}, process.env);
    delete env.CLAUDE_PROJECT_DIR;
    const { exitCode, stdout } = runHook({ cwd: dir }, { env });
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /oldfeature/);
  } finally {
    rmTree(dir);
  }
});

test("scope_falls_back_to_process_cwd_when_both_unset: uses process.cwd()", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "oldfeature"]);
    git(dir, ["checkout", "-q", "main"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    const env = Object.assign({}, process.env);
    delete env.CLAUDE_PROJECT_DIR;
    const { exitCode, stdout } = runHook({}, { env, cwd: dir });
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /oldfeature/);
  } finally {
    rmTree(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Worktree classification
// ═══════════════════════════════════════════════════════════════════════════

test("worktree_primary_ok: single worktree, on base -> allow", () => {
  const dir = initRepo("main");
  try {
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
  }
});

test("primary_worktree_detached_head_unknown_blocks: no in-progress marker", () => {
  const dir = initRepo("main");
  try {
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "--detach", head]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /detached HEAD/);
    assert.doesNotMatch(decision.reason, /fix:/);
  } finally {
    rmTree(dir);
  }
});

test("primary_worktree_mid_rebase_allows_with_system_message", () => {
  const dir = initRepo("main");
  try {
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "--detach", head]);
    plantMarker(dir, "rebase-merge", { isDir: true });
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "expected a systemMessage");
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /rebase in progress/);
  } finally {
    rmTree(dir);
  }
});

test("primary_worktree_mid_cherry_pick_allows_with_system_message", () => {
  const dir = initRepo("main");
  try {
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "--detach", head]);
    plantMarker(dir, "CHERRY_PICK_HEAD", { isDir: false });
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.systemMessage, /cherry-pick in progress/);
  } finally {
    rmTree(dir);
  }
});

test("worktree_prunable_blocks: linked worktree dir deleted", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["worktree", "add", "-q", "-b", "linkedbranch", linked]);
    rmTree(linked);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /worktree remove/);
    assert.match(decision.reason, /worktree prune/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_detached_unknown_blocks: linked, detached HEAD", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    const head = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["worktree", "add", "-q", "--detach", linked, head]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /detached HEAD/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_stale_branch_blocks: linked worktree on ancestor branch -> both fixes", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    // Round-4/§16: `worktree add` itself wrote a fresh reflog entry --
    // backdate it so this exercises the intended clean/quiet/stale steady
    // state, not the "just created this millisecond" active instant.
    backdateReflog(worktreeGitDir(dir, linked), 3600);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /worktree remove/);
    assert.match(decision.reason, /git branch -d oldfeature/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_locked_stale_fix_prepends_unlock", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    git(dir, ["worktree", "lock", linked, "--reason", "test"]);
    backdateReflog(worktreeGitDir(dir, linked), 3600);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    const fixIdx = decision.reason.indexOf("fix:");
    const unlockIdx = decision.reason.indexOf("worktree unlock");
    const removeIdx = decision.reason.indexOf("worktree remove");
    assert.ok(fixIdx !== -1 && unlockIdx !== -1 && removeIdx !== -1);
    assert.ok(unlockIdx < removeIdx, "unlock must precede remove in the fix text");
  } finally {
    gitAllowFail(dir, ["worktree", "unlock", linked]);
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_active_allows: linked, unmerged, no upstream", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["checkout", "-q", "-b", "feature2"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["worktree", "add", "-q", linked, "feature2"]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("path_normalization_windows_case_and_separator_match: normalizePathForCompare is case/separator insensitive on win32", () => {
  const a = "D:\\Example\\Project\\Repo\\";
  const b = "d:/example/project/repo";
  if (process.platform === "win32") {
    assert.equal(normalizePathForCompare(a), normalizePathForCompare(b));
  } else {
    // On a non-Windows CI runner, case-folding is intentionally skipped;
    // separator normalization and trailing-slash stripping still apply.
    assert.equal(normalizePathForCompare("/a/b/c/"), normalizePathForCompare("/a/b/c"));
  }
});

test("path_normalization_end_to_end: CLAUDE_PROJECT_DIR in a differently-cased/separated form still classifies", () => {
  const dir = initRepo("main");
  try {
    const varied = dir.replace(/\\/g, "/").toUpperCase();
    const { exitCode, stdout } = runHook({ cwd: dir }, { env: { CLAUDE_PROJECT_DIR: varied } });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "", "primary-on-base repo must still classify as allow despite path casing/separator differences");
  } finally {
    rmTree(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Branch classification
// ═══════════════════════════════════════════════════════════════════════════

test("branch_ancestor_stale: fast-forward-merged branch -> -d", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["branch", "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /oldfeature/);
    assert.match(decision.reason, /evidence: ancestor/);
    assert.match(decision.reason, /git branch -d oldfeature/);
    assert.doesNotMatch(decision.reason, /-D oldfeature/);
  } finally {
    rmTree(dir);
  }
});

test("branch_empty_local_allows: new branch off base, zero commits, no upstream", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["branch", "freshbranch"]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
  }
});

test("branch_squash_merged_remote_kept_stale: tree-equality, remote branch NOT deleted", () => {
  const dir = initRepo("main");
  let bareDir = null;
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    // Simulate a squash-merge: main gets a NEW commit whose resulting tree
    // matches feature's tree exactly (same file content), but it's a
    // distinct, non-ancestor commit -- the tree-equality signature.
    fs.writeFileSync(path.join(dir, "f.txt"), "f\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "squash-merge feature"]);
    // Add the origin AFTER main's squash-merge commit, so the resolved
    // base (via origin/HEAD -> origin/main) is main's CURRENT tip, not a
    // stale pre-squash snapshot -- a separate, dedicated test covers a
    // genuinely stale/dangling origin/HEAD.
    bareDir = addBareOrigin(dir, "main");
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    // feature's own remote-tracking ref is untouched (not deleted) -- track is not [gone].
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /feature/);
    assert.match(decision.reason, /evidence: tree-equality/);
    assert.match(decision.reason, /git branch -D feature/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("branch_rebase_merged_stale: rewritten hashes, not an ancestor -> cherry, -D", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f1.txt", "one\n", "feature commit one");
    writeAndCommit(dir, "f2.txt", "two\n", "feature commit two");
    git(dir, ["checkout", "-q", "main"]);
    // Apply patch-id-identical commits to main, but with an EXTRA,
    // interleaved commit that only exists on main -- this makes main's
    // tip tree (and every one of its ancestors' trees) differ from
    // feature's tip tree, so row 4 (tree-equality) can never fire; only
    // `git cherry`'s patch-id-based matching (row 5) recognizes that both
    // of feature's commits are already applied.
    const c1 = git(dir, ["rev-parse", "feature~1"]);
    const c2 = git(dir, ["rev-parse", "feature"]);
    git(dir, ["cherry-pick", c1]);
    writeAndCommit(dir, "extra.txt", "extra\n", "unrelated commit only on main");
    git(dir, ["cherry-pick", c2]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /feature/);
    assert.match(decision.reason, /evidence: cherry/);
    assert.match(decision.reason, /git branch -D feature/);
  } finally {
    rmTree(dir);
  }
});

test("branch_upstream_gone_stale: [gone] upstream", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    git(dir, ["checkout", "-q", "main"]);
    // Remote deletes the branch upstream; local remote-tracking ref goes stale.
    git(bareDir, ["branch", "-D", "feature"]);
    git(dir, ["fetch", "-q", "--prune", "origin"]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /feature/);
    assert.match(decision.reason, /evidence: gone-upstream/);
    assert.match(decision.reason, /git branch -D feature/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("branch_reset_to_base_with_stale_upstream_squash_signature_stale: upstream-tip tree-equality", () => {
  const dir = initRepo("main");
  let bareDir = null;
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    // Squash-merge feature's content into main.
    git(dir, ["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "f\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "squash-merge feature"]);
    // Add the origin AFTER the squash-merge commit (see the sibling
    // tree-equality test's comment) so the resolved base tracks main's
    // CURRENT tip, then push feature (its own pre-squash history) so its
    // remote-tracking ref captures the pre-reset, already-merged content.
    bareDir = addBareOrigin(dir, "main");
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    // Reset the LOCAL feature branch back to base's tip (as if someone
    // "cleaned up" locally) -- upstream ref still holds the pre-reset,
    // already-squash-merged commit.
    const baseTip = git(dir, ["rev-parse", "main"]);
    git(dir, ["branch", "-f", "feature", baseTip]);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /feature/);
    assert.match(decision.reason, /evidence: upstream-tip-tree-equality/);
    assert.match(decision.reason, /git branch -D feature/);
    assert.match(decision.reason, /git push origin --delete feature/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("branch_active_no_upstream: unpushed commits, no upstream -> allow", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
  }
});

test("branch_active_upstream_present: tracking live remote, ahead, upstream tip also unmerged -> allow", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("branch_upstream_equals_base_tip_empty_local_not_stale: fresh branch tracking origin/main directly, no divergence yet", () => {
  // Regression test for a real bug found by this PR's own smoke run: a
  // branch created with its upstream set directly to the BASE's own
  // remote-tracking ref (e.g. `git worktree add -b feature origin/main`,
  // before any commits of its own) has upTip.hash === base.tip. Without
  // the trivial-self-match guard, `merge-base --is-ancestor X X` always
  // exits 0, so row 6 would misclassify every such fresh branch as stale
  // on its very first Stop invocation -- exactly what happened to this
  // guard's own linked development worktree during the real smoke run.
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    git(dir, ["branch", "--set-upstream-to=origin/main", "feature"]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "", "a fresh branch tracking the base's own remote ref must never classify as stale");
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("checked_out_branch_stale_suggests_checkout_first: current branch is a diverged ancestor, clean and quiet", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    git(dir, ["checkout", "-q", "main"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    git(dir, ["checkout", "-q", "feature"]);
    assert.equal(currentBranch(dir), "feature");
    // Round-4/§16: the checkout above itself just wrote a fresh reflog
    // entry -- backdate it so this test exercises the intended "clean,
    // quiet, stale" steady state (§16 R4-04) rather than the artificial
    // "just switched branches this millisecond" instant, which would
    // otherwise read as active via condition (c) and never block.
    backdateReflog(primaryGitDir(dir), 3600);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    const checkoutIdx = decision.reason.indexOf("git checkout main");
    const deleteIdx = decision.reason.indexOf("git branch -d feature");
    assert.ok(checkoutIdx !== -1 && deleteIdx !== -1);
    assert.ok(checkoutIdx < deleteIdx, "checkout must precede the branch delete fix");
  } finally {
    rmTree(dir);
  }
});

test("base_branch_undeterminable_unknown_blocks: no main/master/origin-HEAD", () => {
  const dir = initRepo("trunk");
  try {
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /base branch/i);
  } finally {
    rmTree(dir);
  }
});

test("base_branch_origin_head_dangling_falls_through_to_main", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    // Dangle refs/remotes/origin/HEAD by deleting the tracking ref it points at,
    // while the symbolic ref itself (set by `remote set-head -a` in addBareOrigin) stays.
    git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);

    git(dir, ["branch", "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "must still classify via local main, not report base-undeterminable");
    assert.doesNotMatch(decision.reason, /base branch/i);
    assert.match(decision.reason, /git branch -d oldfeature/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("dirty_linked_worktree_on_stale_branch_is_active_not_stale: supersedes the pre-round-3 uncommitted-changes rule (§15/§16)", () => {
  // Live finding 2026-09-07 (§15), revised by adversary round 4 (§16):
  // this is the guard's OWN real incident shape -- a dirty linked
  // worktree whose branch has zero commits of its own while base
  // advanced (a strict ancestor). It must now ALLOW, never block.
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    fs.writeFileSync(path.join(linked, "dirty.txt"), "uncommitted\n");

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "expected an allow-with-message, not silence");
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /active worktree on merged branch oldfeature/);
    assert.match(decision.systemMessage, /uncommitted changes present/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Bypass
// ═══════════════════════════════════════════════════════════════════════════

test("bypass_env_var_allows: JUDGE_STOP_GUARD=off allows with systemMessage even with stale present", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["branch", "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    const { exitCode, stdout } = runHookInRepo(dir, null, { JUDGE_STOP_GUARD: "off" });
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /bypass/i);
  } finally {
    rmTree(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Injected-dependency tests: deadline / per-call timeout / failures / batching
// ═══════════════════════════════════════════════════════════════════════════

test("git_failure_during_item_classification_unknown_blocks: one branch's merge-base call fails, others classify normally", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["branch", "badbranch"]); // ancestor of base -- would normally be stale via merge-base
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    git(dir, ["checkout", "-q", "-b", "goodbranch"]);
    writeAndCommit(dir, "g.txt", "g\n", "goodbranch work");
    git(dir, ["checkout", "-q", "main"]);

    // Wrap by matching on the actual branch tip hash for badbranch.
    const badTip = git(dir, ["rev-parse", "badbranch"]);
    const wrappedExecGit = (args, cwd, timeoutMs) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === badTip) {
        return { ok: false, status: 128, message: "simulated git failure" };
      }
      return defaultExecGit(args, cwd, timeoutMs);
    };

    const result = evaluateStop(dir, { execGit: wrappedExecGit });
    assert.equal(result.action, "block");
    assert.match(result.reason, /badbranch/);
    assert.match(result.reason, /unknown/);
    // goodbranch is genuinely active (unmerged, no relation to base) --
    // it must not appear anywhere in the reason text at all, since only
    // stale/unknown items are reported.
    assert.doesNotMatch(result.reason, /goodbranch/);
  } finally {
    rmTree(dir);
  }
});

test("git_call_timeout_treated_as_failure_unknown_blocks: one call hangs past its per-call timeout", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["branch", "slowbranch"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    const slowTip = git(dir, ["rev-parse", "slowbranch"]);

    const wrappedExecGit = (args, cwd, timeoutMs) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === slowTip) {
        return { ok: false, timedOut: true };
      }
      return defaultExecGit(args, cwd, timeoutMs);
    };

    const result = evaluateStop(dir, { execGit: wrappedExecGit });
    assert.equal(result.action, "block");
    assert.match(result.reason, /slowbranch/);
    assert.match(result.reason, /timed out/);
  } finally {
    rmTree(dir);
  }
});

test("deadline_exceeded_blocks_with_partial_classification: forced past 20s via injected clock", () => {
  const dir = initRepo("main");
  try {
    for (let i = 0; i < 5; i++) {
      git(dir, ["branch", `branch${i}`]);
    }
    writeAndCommit(dir, "b.txt", "b\n", "advance main");

    let callCount = 0;
    const fakeNow = () => {
      callCount++;
      // First few calls (scope gate, base resolution, worktree list,
      // for-each-ref, tree-set) return "no time elapsed"; after that,
      // jump straight past the deadline so the per-branch loop bails
      // immediately on its very first budget check -- no real waiting.
      return callCount <= 6 ? 0 : 1_000_000;
    };

    const result = evaluateStop(dir, { now: fakeNow, deadlineMs: 20000 });
    assert.equal(result.action, "block");
    assert.match(result.reason, /20-second internal deadline/);
    assert.match(result.reason, /Not yet classified/);
  } finally {
    rmTree(dir);
  }
});

test("batched_git_calls_used_not_per_branch: exactly one for-each-ref and one tree-set call", () => {
  const dir = initRepo("main");
  try {
    for (let i = 0; i < 6; i++) {
      git(dir, ["branch", `branch${i}`]);
    }
    writeAndCommit(dir, "b.txt", "b\n", "advance main");

    let forEachRefHeadsCalls = 0;
    let forEachRefRemotesCalls = 0;
    let treeSetCalls = 0;
    const countingExecGit = (args, cwd, timeoutMs) => {
      if (args[0] === "for-each-ref" && args[args.length - 1] === "refs/heads") forEachRefHeadsCalls++;
      if (args[0] === "for-each-ref" && args[args.length - 1] === "refs/remotes") forEachRefRemotesCalls++;
      if (args[0] === "log" && args.includes("--max-count=500")) treeSetCalls++;
      return defaultExecGit(args, cwd, timeoutMs);
    };

    const result = evaluateStop(dir, { execGit: countingExecGit });
    assert.equal(result.action, "block"); // all 6 branches are ancestor-stale
    assert.equal(forEachRefHeadsCalls, 1, "for-each-ref refs/heads must be called exactly once regardless of branch count");
    assert.equal(forEachRefRemotesCalls, 1, "for-each-ref refs/remotes (§3/§13) must be called exactly once, batched");
    assert.equal(treeSetCalls, 1, "the base tree-set call must be called exactly once regardless of branch count");
  } finally {
    rmTree(dir);
  }
});

test("worktree_missing_locked_prunable_fields_treated_as_false_with_prune_dry_run_cross_check", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    rmTree(linked); // directory gone -> real git will normally report `prunable`.

    const strippingExecGit = (args, cwd, timeoutMs) => {
      const res = defaultExecGit(args, cwd, timeoutMs);
      if (args[0] === "worktree" && args[1] === "list" && res.ok) {
        // Simulate an older git that never emits locked/prunable lines at all.
        const stripped = res.stdout
          .split(/\r?\n/)
          .filter((l) => !l.startsWith("locked") && !l.startsWith("prunable"))
          .join("\n");
        return { ok: true, stdout: stripped };
      }
      return res;
    };

    const result = evaluateStop(dir, { execGit: strippingExecGit });
    assert.equal(result.action, "block");
    assert.match(result.reason, /worktree remove/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("reason_caps_at_40_items: 45 stale items -> first 40 listed, remainder counted", () => {
  const dir = initRepo("main");
  try {
    for (let i = 0; i < 45; i++) {
      git(dir, ["branch", `stale${i}`]);
    }
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.reason, /\.\.\.and 5 more/);
    const lineCount = decision.reason.split("\n").filter((l) => l.startsWith("[branch]")).length;
    assert.equal(lineCount, 40);
  } finally {
    rmTree(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Remote-tracking branch classification (spec §3/§13, adversary round 3 §14)
// ═══════════════════════════════════════════════════════════════════════════

function addSecondRemote(dir, remoteName, branch) {
  const bareDir = mkTmpDir("stop-guard-bare2-");
  git(bareDir, ["init", "-q", "--bare"]);
  git(dir, ["remote", "add", remoteName, bareDir]);
  git(dir, ["push", "-q", remoteName, branch]);
  return bareDir;
}

test("remote_stale_no_local_branch_blocks: merged ref on origin, no tracking local branch", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "feature"]);
    git(dir, ["push", "-q", "origin", "feature"]);
    git(dir, ["branch", "-D", "feature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past feature's tip");
    git(dir, ["push", "-q", "origin", "main"]); // keep origin/main (and origin/HEAD) current -- base resolves via the cached remote-tracking ref.

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /\[remote\] origin\/feature — stale-remote/);
    assert.match(decision.reason, /git fetch --prune origin/);
    assert.match(decision.reason, /git rev-parse --verify -q refs\/remotes\/origin\/feature/);
    assert.match(decision.reason, /git push origin --delete feature/);
    assert.match(decision.reason, /git branch -dr origin\/feature/);
    assert.doesNotMatch(decision.reason, /git branch -[dD] feature\b/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_stale_with_tracking_local_branch_grouped: local branch also stale -> single grouped item", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "feature"]);
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past feature's tip");
    git(dir, ["push", "-q", "origin", "main"]);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    const lines = decision.reason.split("\n");
    const featureLines = lines.filter((l) => l.includes("feature"));
    assert.equal(featureLines.length, 1, "must be exactly one combined item, not a separate branch + remote item");
    assert.match(featureLines[0], /git fetch --prune origin/);
    assert.match(featureLines[0], /git push origin --delete feature/);
    assert.match(featureLines[0], /git branch -dr origin\/feature/);
    assert.match(featureLines[0], /git branch -d feature\b/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_active_unmerged_allows: pushed branch genuinely ahead and unmerged", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_head_detached_excluded_by_name: detached (non-symbolic) origin/HEAD never flagged (R3-01)", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    const oldTip = git(dir, ["rev-parse", "main"]);
    git(dir, ["update-ref", "--no-deref", "refs/remotes/origin/HEAD", oldTip]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past the now-detached origin/HEAD");

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    if (decision) assert.doesNotMatch(decision.reason || decision.systemMessage || "", /origin\/HEAD/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_base_own_tracked_ref_ignored: origin/main never flagged despite being an ancestor of the new local main", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    writeAndCommit(dir, "b.txt", "b\n", "advance local main past origin/main");
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "", "origin/main must be excluded as the base's own tracked ref, never reported stale-remote");
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_no_base_remote_all_foreign_allows: no upstream on local main -> every remote ref is at best foreign", () => {
  const dir = initRepo("main");
  const upstreamBare = mkTmpDir("stop-guard-bare-upstream-");
  try {
    git(upstreamBare, ["init", "-q", "--bare"]);
    git(dir, ["checkout", "-q", "-b", "shared"]);
    writeAndCommit(dir, "s.txt", "s\n", "shared work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "shared"]);
    git(dir, ["remote", "add", "upstream", upstreamBare]);
    git(dir, ["push", "-q", "upstream", "shared"]);
    git(dir, ["branch", "-D", "shared"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past shared's tip");
    // No origin, no upstream configured on local main -- no base remote at all.

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision, "expected an allow-with-message");
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /stale-remote-foreign/);
    assert.match(decision.systemMessage, /upstream\/shared/);
  } finally {
    rmTree(dir);
    rmTree(upstreamBare);
  }
});

test("remote_foreign_remote_merged_ref_allows_with_message: second remote's merged ref is foreign, not blocking", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  let upstreamBare = null;
  try {
    git(dir, ["checkout", "-q", "-b", "shared"]);
    writeAndCommit(dir, "s.txt", "s\n", "shared work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "shared"]);
    upstreamBare = addSecondRemote(dir, "upstream", "shared");
    git(dir, ["branch", "-D", "shared"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past shared's tip");
    git(dir, ["push", "-q", "origin", "main"]);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /upstream\/shared classifies stale-remote-foreign/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
    if (upstreamBare) rmTree(upstreamBare);
  }
});

test("remote_foreign_message_suppressed_when_blocking_findings_exist: foreign note omitted from a block reason", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  let upstreamBare = null;
  try {
    git(dir, ["checkout", "-q", "-b", "shared"]);
    writeAndCommit(dir, "s.txt", "s\n", "shared work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "shared"]);
    upstreamBare = addSecondRemote(dir, "upstream", "shared");
    git(dir, ["branch", "-D", "shared"]);
    git(dir, ["branch", "oldfeature"]); // unrelated, never-pushed stale local branch -> forces a block.
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    git(dir, ["push", "-q", "origin", "main"]);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /oldfeature/);
    assert.doesNotMatch(decision.reason, /upstream\/shared/);
    assert.doesNotMatch(decision.reason, /foreign/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
    if (upstreamBare) rmTree(upstreamBare);
  }
});

test("remote_forremote_atomic_failure_falls_back_to_show_ref: one ref with a missing object does not black out its healthy sibling", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "feature"]);
    git(dir, ["push", "-q", "origin", "feature"]);
    git(dir, ["branch", "-D", "feature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past feature's tip");
    git(dir, ["push", "-q", "origin", "main"]);

    // A remote-tracking ref pointing at a nonexistent object -- git itself
    // refuses `update-ref` to a missing object, so write the loose ref
    // file directly, bypassing that check (this is exactly the scenario
    // round-3 finding R3-02 is built against).
    fs.writeFileSync(
      path.join(dir, ".git", "refs", "remotes", "origin", "ghost"),
      "0123456789abcdef0123456789abcdef01234567\n"
    );

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /\[remote\] origin\/ghost — unknown/);
    assert.match(decision.reason, /\[remote\] origin\/feature — stale-remote/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_tip_equals_base_not_flagged: a foreign remote's ref at exactly base's tip is never flagged", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  let mirrorBare = null;
  try {
    mirrorBare = addSecondRemote(dir, "mirror", "main"); // mirror/main == current main tip, no further advance.
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "", "a remote ref whose tip equals base.tip must never be classified stale-remote(-foreign)");
  } finally {
    rmTree(dir);
    rmTree(bareDir);
    if (mirrorBare) rmTree(mirrorBare);
  }
});

test("remote_refs_counted_in_deadline_reason: deadline forced right after remote-ref enumeration", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "feature"]);
    git(dir, ["push", "-q", "origin", "feature"]);
    git(dir, ["branch", "-D", "feature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");

    let remoteListSeen = false;
    const wrappedExecGit = (args, cwd, timeoutMs) => {
      const res = defaultExecGit(args, cwd, timeoutMs);
      if (args[0] === "for-each-ref" && args[args.length - 1] === "refs/remotes") remoteListSeen = true;
      return res;
    };
    const fakeNow = () => (remoteListSeen ? 1_000_000 : 0);

    const result = evaluateStop(dir, { execGit: wrappedExecGit, now: fakeNow, deadlineMs: 20000 });
    assert.equal(result.action, "block");
    assert.match(result.reason, /remote-list=\d+ ref\(s\)/);
    assert.match(result.reason, /remote-names/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
  }
});

test("remote_worktree_branch_remote_three_way_grouped: linked worktree + stale branch + stale-remote tracking ref, one item", () => {
  const dir = initRepo("main");
  const bareDir = addBareOrigin(dir, "main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeAndCommit(dir, "f.txt", "f\n", "feature work");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "feature"]);
    git(dir, ["push", "-q", "-u", "origin", "feature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main past feature's tip");
    git(dir, ["push", "-q", "origin", "main"]);
    git(dir, ["worktree", "add", "-q", linked, "feature"]);
    backdateReflog(worktreeGitDir(dir, linked), 3600);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    const lines = decision.reason.split("\n");
    const featureLines = lines.filter((l) => l.includes("feature"));
    assert.equal(featureLines.length, 1, "worktree + branch + remote must combine into exactly one item");
    assert.match(featureLines[0], /worktree remove/);
    assert.match(featureLines[0], /git branch -d feature\b/);
    assert.match(featureLines[0], /git push origin --delete feature/);
    assert.match(featureLines[0], /git branch -dr origin\/feature/);
  } finally {
    rmTree(dir);
    rmTree(bareDir);
    rmTree(path.dirname(linked));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Active-worktree carve-out (spec §15/§16, live finding 2026-09-07 + round 4)
// ═══════════════════════════════════════════════════════════════════════════

test("worktree_active_clean_recent_on_behind_branch_allows: freshly-added worktree is recent by default", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    // No backdating -- the worktree add above just wrote a fresh reflog
    // entry, well within the default 30-minute quiet window.
    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.match(decision.systemMessage, /active worktree on merged branch oldfeature/);
    assert.match(decision.systemMessage, /recent worktree activity/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_active_clean_quiet_on_merged_branch_blocks: clean, no own commits, backdated past the quiet window", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    backdateReflog(worktreeGitDir(dir, linked), 3600);

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /oldfeature/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_quiet_window_zero_disables_recency_signal_blocks: JUDGE_STOP_GUARD_QUIET_MINUTES=0", () => {
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    // No backdating -- this worktree IS freshly touched; the env override
    // must still disable the recency signal entirely.
    const { exitCode, stdout } = runHookInRepo(dir, null, { JUDGE_STOP_GUARD_QUIET_MINUTES: "0" });
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /oldfeature/);
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("worktree_active_own_commit_ahead_of_base_allows: unintegrated commit on the worktree's branch (the live-finding trigger shape)", () => {
  // A genuinely unintegrated commit makes the branch table itself classify
  // this branch `active` (row 9) directly -- ancestor/tree-equality/cherry
  // all correctly fail to fire, so classifyBranch never even reaches
  // "stale" for the override (§16) to act on. This is a plain allow with
  // no output, not an allow-with-message: condition (b), once made
  // content-aware (round-4 finding R4-03), is subsumed by the branch
  // table's own natural determination for exactly this shape of input.
  const dir = initRepo("main");
  const linked = path.join(mkTmpDir("stop-guard-linked-parent-"), "wt");
  try {
    git(dir, ["branch", "oldfeature"]);
    git(dir, ["worktree", "add", "-q", linked, "oldfeature"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    writeAndCommit(linked, "own.txt", "own work\n", "unintegrated work in the worktree");
    backdateReflog(worktreeGitDir(dir, linked), 3600); // quiet on recency -- irrelevant here; content is what saves it.

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    assert.equal(stdout, "", "genuinely unintegrated content classifies active via the ordinary branch table, no override needed");
  } finally {
    rmTree(dir);
    rmTree(path.dirname(linked));
  }
});

test("primary_worktree_active_dirty_on_stale_branch_allows_with_message: R4-04 extends the carve-out to the primary worktree", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    git(dir, ["checkout", "-q", "main"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    git(dir, ["checkout", "-q", "feature"]);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted\n");

    const { exitCode, stdout } = runHookInRepo(dir);
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision);
    assert.equal(decision.decision, undefined);
    assert.match(decision.systemMessage, /active worktree on merged branch feature/);
  } finally {
    rmTree(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Bounded re-block (docs/specs/stop-guard-bounded-reblock.md), direct unit
// tests against `applyBoundedReblock` with an injected `fs`/`now`/
// `stateDir` -- mirroring how `deadline_exceeded_blocks_with_partial_
// classification` above injects into `evaluateStop`.
// ═══════════════════════════════════════════════════════════════════════════

function realFsDeps() {
  return {
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    renameSync: (a, b) => fs.renameSync(a, b),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    existsSync: (p) => fs.existsSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    openSync: (p, flags) => fs.openSync(p, flags),
    writeSync: (fd, data) => fs.writeSync(fd, data),
    closeSync: (fd) => fs.closeSync(fd),
  };
}

function mkReblockDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "judge-reblock-unit-"));
}

function oneItemBlock(kind, rawIdentity, line) {
  return { action: "block", reason: line, items: [{ kind, rawIdentity, line }] };
}

function readYieldLogLines(yieldLogPath) {
  if (!fs.existsSync(yieldLogPath)) return [];
  return fs
    .readFileSync(yieldLogPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

test("reblock_three_identical_blocks_then_yield: same item blocked 3x then yields with a durable log line", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 1000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-a", stop_hook_active: false };
    let r;
    for (let i = 0; i < 3; i++) {
      r = applyBoundedReblock(oneItemBlock("worktree", "C:/w/foo", "[worktree:linked] C:/w/foo — stale"), stdinInfo, deps);
      assert.equal(r.action, "block");
      assert.match(r.reason, /C:\/w\/foo — stale/);
    }
    r = applyBoundedReblock(oneItemBlock("worktree", "C:/w/foo", "[worktree:linked] C:/w/foo — stale"), stdinInfo, deps);
    assert.equal(r.action, "allow-message");
    assert.match(r.message, /STALE ITEMS REMAIN/);
    assert.match(r.message, /C:\/w\/foo — stale/);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    assert.match(r.message, new RegExp(yieldLogPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const lines = readYieldLogLines(yieldLogPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].session_id, "sess-a");
    assert.equal(lines[0].strikes, REBLOCK_STRIKE_CAP);
    assert.equal(lines[0].item, computeItemKey("worktree", "C:/w/foo"));
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_per_item_independence: a fresh second item keeps blocking even once the first has reached the cap", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 2000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-b", stop_hook_active: false };
    for (let i = 0; i < 3; i++) {
      applyBoundedReblock(oneItemBlock("branch", "feature-a", "[branch] feature-a — stale"), stdinInfo, deps);
    }
    const r = applyBoundedReblock(
      {
        action: "block",
        reason: "n/a",
        items: [
          { kind: "branch", rawIdentity: "feature-a", line: "[branch] feature-a — stale" },
          { kind: "branch", rawIdentity: "feature-b", line: "[branch] feature-b — stale" },
        ],
      },
      stdinInfo,
      deps
    );
    assert.equal(r.action, "block");
    assert.match(r.reason, /feature-b — stale/);
    assert.doesNotMatch(r.reason, /feature-a — stale/);
    assert.match(r.reason, /1 item\(s\) omitted/);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_churn_does_not_reset_strikes: an item's absence on one call does not reset its count", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 3000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-c", stop_hook_active: false };
    const stuck = () => oneItemBlock("branch", "stuck", "[branch] stuck — stale");
    let r;
    r = applyBoundedReblock(stuck(), stdinInfo, deps); // stuck: strikes 1
    assert.equal(r.action, "block");
    r = applyBoundedReblock(stuck(), stdinInfo, deps); // stuck: strikes 2
    assert.equal(r.action, "block");
    // Churn: "stuck" is absent this call; an unrelated item blocks instead.
    // "stuck"'s stored strike count must be left untouched at 2, not reset.
    r = applyBoundedReblock(oneItemBlock("branch", "other", "[branch] other — stale"), stdinInfo, deps);
    assert.equal(r.action, "block");
    // "stuck" reappears: if its count had survived the churn at 2, this is
    // its 3rd block (pre-increment 2 < 3, still blocks, becomes 3). If the
    // churn had wrongly reset it to 0, this would only be its 1st block --
    // either way this single call still blocks, so it alone doesn't prove
    // non-reset; the NEXT call does (see below).
    r = applyBoundedReblock(stuck(), stdinInfo, deps);
    assert.equal(r.action, "block");
    // Only two calls (this one plus the one before it) have happened for
    // "stuck" since the churn -- under a (buggy) reset-on-absence
    // implementation, "stuck" would be at strikes 2 here, still < cap,
    // and this call would block again. Under the correct
    // never-reset-within-session behavior, "stuck" is now at strikes 3
    // (pre-increment) and this call yields instead.
    r = applyBoundedReblock(stuck(), stdinInfo, deps);
    assert.equal(r.action, "allow-message");
    assert.match(r.message, /stuck — stale/);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_identity_normalization_case_and_separator: case/slash variants of the same path share one item key", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 4000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-d", stop_hook_active: false };
    let r;
    r = applyBoundedReblock(oneItemBlock("worktree", "C:\\dev\\proj\\bar\\", "[worktree:linked] C:\\dev\\proj\\bar\\ — stale"), stdinInfo, deps);
    assert.equal(r.action, "block"); // strikes 1
    r = applyBoundedReblock(oneItemBlock("worktree", "c:/dev/PROJ/bar", "[worktree:linked] c:/dev/PROJ/bar — stale"), stdinInfo, deps);
    assert.equal(r.action, "block"); // strikes 2 -- same key as above despite case/separator differences
    r = applyBoundedReblock(oneItemBlock("worktree", "C:/dev/proj/bar", "[worktree:linked] C:/dev/proj/bar — stale"), stdinInfo, deps);
    assert.equal(r.action, "block"); // strikes 3 (pre-increment was 2, still blocks)
    r = applyBoundedReblock(oneItemBlock("worktree", "C:\\dev\\proj\\BAR", "[worktree:linked] C:\\dev\\proj\\BAR — stale"), stdinInfo, deps);
    assert.equal(r.action, "allow-message"); // a 4th case/separator variant -- still the SAME item key, now yields
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_missing_session_id_blocks_no_state_write", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 5000, fs: realFsDeps() };
    const r = applyBoundedReblock(
      oneItemBlock("branch", "feature", "[branch] feature — stale"),
      { session_id: undefined, stop_hook_active: false },
      deps
    );
    assert.equal(r.action, "block");
    assert.match(r.reason, /session_id missing or malformed/);
    assert.ok(!fs.existsSync(stateDir) || fs.readdirSync(stateDir).length === 0);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_state_write_failure_blocks", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    fsx.writeFileSync = () => {
      throw new Error("ENOSPC: injected");
    };
    const deps = { stateDir, now: () => 6000, fs: fsx };
    const r = applyBoundedReblock(
      oneItemBlock("branch", "feature", "[branch] feature — stale"),
      { session_id: "sess-e", stop_hook_active: false },
      deps
    );
    assert.equal(r.action, "block");
    assert.match(r.reason, /state write failed/);
    assert.match(r.reason, /ENOSPC: injected/);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_yield_log_line_written: well-formed JSON line with every required field", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 7000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-f", stop_hook_active: false };
    // REBLOCK_STRIKE_CAP calls all still block (the call whose increment
    // lands exactly on the cap is itself counted as a block -- see
    // `applyBoundedReblock`'s own comment); one further call is what
    // actually yields.
    for (let i = 0; i < REBLOCK_STRIKE_CAP; i++) {
      const blocked = applyBoundedReblock(oneItemBlock("remote", "origin/gone", "[remote] origin/gone — stale-remote"), stdinInfo, deps);
      assert.equal(blocked.action, "block");
    }
    const yielded = applyBoundedReblock(oneItemBlock("remote", "origin/gone", "[remote] origin/gone — stale-remote"), stdinInfo, deps);
    assert.equal(yielded.action, "allow-message");
    const lines = readYieldLogLines(path.join(stateDir, "stop-stale-worktrees-guard.yields.log"));
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(typeof line.ts, "string");
    assert.equal(line.session_id, "sess-f");
    assert.equal(line.item, computeItemKey("remote", "origin/gone"));
    assert.equal(line.strikes, REBLOCK_STRIKE_CAP);
    assert.match(line.summary, /origin\/gone — stale-remote/);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_env_bypass_writes_no_state: JUDGE_STOP_GUARD=off never reaches the bounded-reblock layer", () => {
  const dir = initRepo("main");
  const stateDir = mkReblockDir();
  try {
    git(dir, ["checkout", "-q", "-b", "stale-branch"]);
    git(dir, ["checkout", "-q", "main"]);
    const { exitCode, stdout } = runHookInRepo(dir, { session_id: "sess-g", stop_hook_active: false, cwd: dir }, {
      JUDGE_STOP_GUARD: "off",
      JUDGE_STOP_GUARD_STATE_DIR: stateDir,
    });
    assert.equal(exitCode, 0);
    const decision = parseDecision(stdout);
    assert.ok(decision && decision.systemMessage);
    assert.match(decision.systemMessage, /bypassed/);
    assert.ok(!fs.existsSync(stateDir) || fs.readdirSync(stateDir).length === 0);
  } finally {
    rmTree(dir);
    rmTree(stateDir);
  }
});

test("reblock_seven_day_sweep_removes_old_state: a backdated state file for a different session is removed", () => {
  const stateDir = mkReblockDir();
  try {
    const stalePath = path.join(stateDir, "stop-stale-worktrees-guard.old-session.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stalePath, JSON.stringify({ items: {} }));
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stalePath, new Date(eightDaysAgo), new Date(eightDaysAgo));
    assert.ok(fs.existsSync(stalePath));

    const deps = { stateDir, now: () => Date.now(), fs: realFsDeps() };
    applyBoundedReblock(
      oneItemBlock("branch", "feature", "[branch] feature — stale"),
      { session_id: "sess-h", stop_hook_active: false },
      deps
    );
    assert.ok(!fs.existsSync(stalePath), "8-day-old state file for a different session should be swept");
    assert.ok(fs.existsSync(path.join(stateDir, "stop-stale-worktrees-guard.sess-h.json")));
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_state_write_atomicity_temp_then_rename: writes a temp file and renames it onto the final path", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const writeTargets = [];
    const renameCalls = [];
    fsx.writeFileSync = (p, data, opts) => {
      writeTargets.push(p);
      fs.writeFileSync(p, data, opts);
    };
    fsx.renameSync = (a, b) => {
      renameCalls.push([a, b]);
      fs.renameSync(a, b);
    };
    const deps = { stateDir, now: () => 8000, fs: fsx };
    applyBoundedReblock(
      oneItemBlock("branch", "feature", "[branch] feature — stale"),
      { session_id: "sess-i", stop_hook_active: false },
      deps
    );
    const finalPath = path.join(stateDir, "stop-stale-worktrees-guard.sess-i.json");
    // A fresh state dir also creates the `.hmac-key` keyfile on this same
    // invocation (docs/specs/hook-state-write-guard.md §3.1), via the
    // identical tmp-then-rename convention -- so this isolates the
    // state-file-specific write/rename pair rather than asserting a total
    // write count across the whole invocation (which now legitimately
    // includes the keyfile's own first-run write too).
    const stateRename = renameCalls.find((r) => r[1] === finalPath);
    assert.ok(stateRename, "expected a rename onto the state file's final path");
    assert.notEqual(stateRename[0], finalPath);
    assert.match(stateRename[0], /\.tmp\./);
    assert.ok(writeTargets.includes(stateRename[0]));
    assert.ok(fs.existsSync(finalPath));
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_deadline_item_collapses_across_steps: different notReached steps share the single 'deadline' item key", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 9000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-j", stop_hook_active: false };
    let r;
    r = applyBoundedReblock(oneItemBlock("deadline", "deadline", "deadline while classifying base-branch-resolution"), stdinInfo, deps);
    assert.equal(r.action, "block");
    r = applyBoundedReblock(oneItemBlock("deadline", "deadline", "deadline while classifying worktree-list"), stdinInfo, deps);
    assert.equal(r.action, "block");
    r = applyBoundedReblock(oneItemBlock("deadline", "deadline", "deadline while classifying branch-list"), stdinInfo, deps);
    assert.equal(r.action, "block"); // pre-increment count was 2 -- still a block, becomes 3
    r = applyBoundedReblock(oneItemBlock("deadline", "deadline", "deadline while classifying remote-list"), stdinInfo, deps);
    assert.equal(r.action, "allow-message");
    assert.match(r.message, /deadline while classifying remote-list/);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_operator_only_item_annotated: a push --delete fix line is annotated as externally visible", () => {
  const findings = [
    {
      kind: "branch",
      name: "old-feature",
      class: "stale",
      evidence: "upstream-tip-ancestor",
      fixLines: ["git branch -D old-feature", "git push origin --delete old-feature"],
    },
  ];
  const { itemsForFindings } = require(HOOK_PATH);
  const items = itemsForFindings(findings);
  assert.equal(items.length, 1);
  assert.match(items[0].line, /externally visible, run it or ask the operator/);
});

test("reblock_stop_hook_active_recorded_not_branched: decision is identical regardless of stop_hook_active", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 10000, fs: realFsDeps() };
    const rTrue = applyBoundedReblock(
      oneItemBlock("branch", "feature", "[branch] feature — stale"),
      { session_id: "sess-k", stop_hook_active: true },
      deps
    );
    assert.equal(rTrue.action, "block");
    const statePath = path.join(stateDir, "stop-stale-worktrees-guard.sess-k.json");
    const stateAfterTrue = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(stateAfterTrue.stop_hook_active_last, true);

    const rFalse = applyBoundedReblock(
      oneItemBlock("branch", "feature", "[branch] feature — stale"),
      { session_id: "sess-k", stop_hook_active: false },
      deps
    );
    assert.equal(rFalse.action, "block");
    const stateAfterFalse = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(stateAfterFalse.stop_hook_active_last, false);
    assert.equal(stateAfterFalse.items[computeItemKey("branch", "feature")].strikes, 2);
  } finally {
    rmTree(stateDir);
  }
});

test("reblock_forty_item_cap_applies_after_yield_filtering: the 40-item cap counts only the still-blocking list", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 11000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-l", stop_hook_active: false };
    // Yield 3 items first (reach 3 strikes each).
    const yielded = ["y1", "y2", "y3"];
    for (let i = 0; i < REBLOCK_STRIKE_CAP; i++) {
      applyBoundedReblock(
        {
          action: "block",
          reason: "n/a",
          items: yielded.map((name) => ({ kind: "branch", rawIdentity: name, line: `[branch] ${name} — stale` })),
        },
        stdinInfo,
        deps
      );
    }
    // Now block on 42 fresh low-strike items alongside the 3 already-yielded ones.
    const freshItems = [];
    for (let i = 0; i < 42; i++) {
      freshItems.push({ kind: "branch", rawIdentity: `fresh-${i}`, line: `[branch] fresh-${i} — stale` });
    }
    const allItems = [
      ...yielded.map((name) => ({ kind: "branch", rawIdentity: name, line: `[branch] ${name} — stale` })),
      ...freshItems,
    ];
    const r = applyBoundedReblock({ action: "block", reason: "n/a", items: allItems }, stdinInfo, deps);
    assert.equal(r.action, "block");
    assert.match(r.reason, /\.\.\.and 2 more/);
    assert.doesNotMatch(r.reason, /y1 — stale/);
    assert.match(r.reason, /3 item\(s\) omitted/);
  } finally {
    rmTree(stateDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveTargetDir (direct unit tests)
// ═══════════════════════════════════════════════════════════════════════════

test("resolveTargetDir: prefers CLAUDE_PROJECT_DIR env over stdin cwd", () => {
  const orig = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = "C:/from-env";
    assert.equal(resolveTargetDir({ cwd: "C:/from-stdin" }), "C:/from-env");
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = orig;
  }
});

test("resolveTargetDir: falls back to stdin cwd when env unset", () => {
  const orig = process.env.CLAUDE_PROJECT_DIR;
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(resolveTargetDir({ cwd: "C:/from-stdin" }), "C:/from-stdin");
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROJECT_DIR = orig;
  }
});

test("resolveTargetDir: falls back to process.cwd() when both unset", () => {
  const orig = process.env.CLAUDE_PROJECT_DIR;
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(resolveTargetDir({}), process.cwd());
  } finally {
    if (orig !== undefined) process.env.CLAUDE_PROJECT_DIR = orig;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Tamper evidence (docs/specs/hook-state-write-guard.md §3), direct unit
// tests against readReblockState/readOrCreateHmacKey/computeMac, plus a
// couple of end-to-end tests through applyBoundedReblock — same
// stateDir/fs-injection conventions as the bounded-reblock section above.
// ═══════════════════════════════════════════════════════════════════════════

test("mac_written_on_every_state_write: written state file's mac verifies against sessionKey + canonical(items)", () => {
  const stateDir = mkReblockDir();
  try {
    const deps = { stateDir, now: () => 5000, fs: realFsDeps() };
    const stdinInfo = { session_id: "sess-mac", stop_hook_active: false };
    applyBoundedReblock(oneItemBlock("branch", "feature-x", "[branch] feature-x — stale"), stdinInfo, deps);

    const statePath = reblockStatePath(stateDir, "sess-mac");
    const written = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(typeof written.mac, "string");
    assert.ok(written.mac.length > 0);

    const keyBytes = fs.readFileSync(hmacKeyPath(stateDir));
    const expected = computeMac(keyBytes, "sess-mac", written.items);
    assert.equal(written.mac, expected);
  } finally {
    rmTree(stateDir);
  }
});

test("mac_verifies_on_normal_read: write then read via the same key -> state as-is, no tamper log line", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const deps = { stateDir, now: () => 5000, fs: fsx };
    const stdinInfo = { session_id: "sess-round", stop_hook_active: false };
    applyBoundedReblock(oneItemBlock("branch", "feature-y", "[branch] feature-y — stale"), stdinInfo, deps);

    const statePath = reblockStatePath(stateDir, "sess-round");
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const state = readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-round",
      sessionIdRaw: "sess-round",
      yieldLogPath,
      now: () => 6000,
    });
    assert.equal(Object.keys(state.items).length, 1);
    assert.equal(Object.values(state.items)[0].strikes, 1);
    assert.equal(readYieldLogLines(yieldLogPath).filter((l) => l.event === "tamper").length, 0);
  } finally {
    rmTree(stateDir);
  }
});

test("valid_round_trip_honored: write, read back immediately, no tampering", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const deps = { stateDir, now: () => 7000, fs: fsx };
    const stdinInfo = { session_id: "sess-rt", stop_hook_active: false };
    applyBoundedReblock(oneItemBlock("worktree", "C:/w/rt", "[worktree:linked] C:/w/rt — stale"), stdinInfo, deps);

    const statePath = reblockStatePath(stateDir, "sess-rt");
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const state = readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-rt",
      sessionIdRaw: "sess-rt",
      yieldLogPath,
      now: () => 7500,
    });
    assert.equal(Object.keys(state.items).length, 1);
    assert.equal(Object.values(state.items)[0].strikes, 1);
    assert.equal(readYieldLogLines(yieldLogPath).length, 0);
  } finally {
    rmTree(stateDir);
  }
});

test("cross_session_replay_of_valid_items_denied: byte-identical items+mac copied into a different session's filename fails verification (A5)", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const deps = { stateDir, now: () => 9000, fs: fsx };
    const stdinA = { session_id: "sess-A", stop_hook_active: false };
    // Strike a real item to the cap under session A so its own state file
    // is fully "legitimately produced" and self-consistent.
    for (let i = 0; i < REBLOCK_STRIKE_CAP; i++) {
      applyBoundedReblock(oneItemBlock("branch", "replay-me", "[branch] replay-me — stale"), stdinA, deps);
    }
    const pathA = reblockStatePath(stateDir, "sess-A");
    const bodyA = fs.readFileSync(pathA, "utf8");

    // Copy the BYTE-IDENTICAL body (items + mac, unmodified) into a
    // DIFFERENT session's own state filename.
    const pathB = reblockStatePath(stateDir, "sess-B");
    fs.writeFileSync(pathB, bodyA);

    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const beforeCount = readYieldLogLines(yieldLogPath).length;
    const stateB = readReblockState(fsx, pathB, {
      keyBytes,
      sessionKey: "sess-B",
      sessionIdRaw: "sess-B",
      yieldLogPath,
      now: () => 9500,
    });
    assert.deepEqual(stateB, { items: {} });
    const after = readYieldLogLines(yieldLogPath);
    assert.equal(after.length, beforeCount + 1);
    assert.equal(after[after.length - 1].event, "tamper");
  } finally {
    rmTree(stateDir);
  }
});

test("keyfile_created_on_first_run: fresh state dir, no .hmac-key -> created, 32 bytes", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    assert.equal(fs.existsSync(hmacKeyPath(stateDir)), false);
    const key = readOrCreateHmacKey(fsx, stateDir);
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, HMAC_KEY_BYTES);
    assert.equal(fs.existsSync(hmacKeyPath(stateDir)), true);
    assert.equal(fs.statSync(hmacKeyPath(stateDir)).size, HMAC_KEY_BYTES);
  } finally {
    rmTree(stateDir);
  }
});

test("keyfile_reused_across_runs: second run's key is byte-identical to the first (not regenerated)", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const key1 = readOrCreateHmacKey(fsx, stateDir);
    const key2 = readOrCreateHmacKey(fsx, stateDir);
    assert.ok(key1.equals(key2));
  } finally {
    rmTree(stateDir);
  }
});

test("keyfile_unreadable_fails_closed: injected read/create failure -> state treated as absent", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    fsx.readFileSync = () => {
      throw new Error("boom");
    };
    fsx.writeFileSync = () => {
      throw new Error("boom");
    };
    fsx.renameSync = () => {
      throw new Error("boom");
    };
    const key = readOrCreateHmacKey(fsx, stateDir);
    assert.equal(key, null);
  } finally {
    rmTree(stateDir);
  }
});

test("keyfile_zero_bytes_fails_closed: 0-byte keyfile is unavailable, not regenerated (A4)", () => {
  const stateDir = mkReblockDir();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(hmacKeyPath(stateDir), Buffer.alloc(0));
    const key = readOrCreateHmacKey(realFsDeps(), stateDir);
    assert.equal(key, null);
    assert.equal(fs.statSync(hmacKeyPath(stateDir)).size, 0); // not silently overwritten
  } finally {
    rmTree(stateDir);
  }
});

test("keyfile_truncated_fails_closed: fewer than 32 bytes -> unavailable (A4)", () => {
  const stateDir = mkReblockDir();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(hmacKeyPath(stateDir), Buffer.alloc(10, 1));
    const key = readOrCreateHmacKey(realFsDeps(), stateDir);
    assert.equal(key, null);
  } finally {
    rmTree(stateDir);
  }
});

test("keyfile_oversized_fails_closed: more than 32 bytes -> unavailable (A4)", () => {
  const stateDir = mkReblockDir();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(hmacKeyPath(stateDir), Buffer.alloc(40, 2));
    const key = readOrCreateHmacKey(realFsDeps(), stateDir);
    assert.equal(key, null);
  } finally {
    rmTree(stateDir);
  }
});

test("forged_strikes_without_mac_reset_and_logged: hand-written state with no mac field treated as absent, one tamper line", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const statePath = reblockStatePath(stateDir, "sess-forged");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        items: { "worktree:x": { kind: "worktree", identity: "x", strikes: 3, first_block_at: "t", last_block_at: "t" } },
      })
    );

    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const state = readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-forged",
      sessionIdRaw: "sess-forged",
      yieldLogPath,
      now: () => 1000,
    });
    assert.deepEqual(state, { items: {} });
    const lines = readYieldLogLines(yieldLogPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "tamper");
  } finally {
    rmTree(stateDir);
  }
});

test("forged_state_wrong_mac_treated_as_absent: a mac value present but not matching its own items", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const statePath = reblockStatePath(stateDir, "sess-wrongmac");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        items: { "branch:x": { kind: "branch", identity: "x", strikes: 3, first_block_at: "t", last_block_at: "t" } },
        mac: "deadbeefdeadbeefdeadbeefdeadbeef",
      })
    );

    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const state = readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-wrongmac",
      sessionIdRaw: "sess-wrongmac",
      yieldLogPath,
      now: () => 1000,
    });
    assert.deepEqual(state, { items: {} });
    assert.equal(readYieldLogLines(yieldLogPath).length, 1);
  } finally {
    rmTree(stateDir);
  }
});

test("pre_change_state_file_no_mac_field_treated_as_tampered: shaped exactly like the pre-this-spec format (explicit backward-compat case)", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const statePath = reblockStatePath(stateDir, "sess-legacy");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        session_id: "sess-legacy",
        stop_hook_active_last: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        items: {
          "branch:legacy": { kind: "branch", identity: "legacy", strikes: 3, first_block_at: "t", last_block_at: "t" },
        },
      })
    );
    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const state = readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-legacy",
      sessionIdRaw: "sess-legacy",
      yieldLogPath,
      now: () => 1000,
    });
    assert.deepEqual(state, { items: {} });
    assert.equal(readYieldLogLines(yieldLogPath).length, 1);
  } finally {
    rmTree(stateDir);
  }
});

test("tamper_log_line_well_formed: exactly one JSON line with event/session/ts fields", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const statePath = reblockStatePath(stateDir, "sess-wf");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ items: {} })); // shape-valid, no mac.
    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-wf",
      sessionIdRaw: "sess-wf",
      yieldLogPath,
      now: () => 4242,
    });
    const lines = readYieldLogLines(yieldLogPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "tamper");
    assert.equal(lines[0].session, "sess-wf");
    assert.equal(typeof lines[0].ts, "string");
    assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  } finally {
    rmTree(stateDir);
  }
});

test("ordinary_first_run_not_logged_as_tamper: no state file exists at all -> zero tamper lines", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const statePath = reblockStatePath(stateDir, "sess-fresh");
    const keyBytes = readOrCreateHmacKey(fsx, stateDir);
    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const state = readReblockState(fsx, statePath, {
      keyBytes,
      sessionKey: "sess-fresh",
      sessionIdRaw: "sess-fresh",
      yieldLogPath,
      now: () => 1,
    });
    assert.deepEqual(state, { items: {} });
    assert.equal(readYieldLogLines(yieldLogPath).length, 0);
  } finally {
    rmTree(stateDir);
  }
});

test("tamper_reset_only_delays_never_grants: forged strikes:3 state is reset, real stale item still blocks from scratch (end-to-end)", () => {
  const stateDir = mkReblockDir();
  try {
    const fsx = realFsDeps();
    const sessionId = "sess-tamper-e2e";
    const statePath = reblockStatePath(stateDir, sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    // Forged: strikes already at the cap, no mac -- an agent trying to
    // force an immediate yield on the very first REAL Stop invocation for
    // this session.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        items: {
          "worktree:c:/w/still-stale": {
            kind: "worktree",
            identity: "c:/w/still-stale",
            strikes: 3,
            first_block_at: "t",
            last_block_at: "t",
          },
        },
      })
    );
    const deps = { stateDir, now: () => 1000, fs: fsx };
    const stdinInfo = { session_id: sessionId, stop_hook_active: false };
    const r = applyBoundedReblock(
      oneItemBlock("worktree", "C:/w/still-stale", "[worktree:linked] C:/w/still-stale — stale"),
      stdinInfo,
      deps
    );
    // The forged strikes:3 was NOT honored -- this invocation still
    // BLOCKS (reset to 0, then incremented to 1 by this real block), never
    // allows on the forged value.
    assert.equal(r.action, "block");
    assert.match(r.reason, /still-stale — stale/);

    const yieldLogPath = path.join(stateDir, "stop-stale-worktrees-guard.yields.log");
    const tamperLines = readYieldLogLines(yieldLogPath).filter((l) => l.event === "tamper");
    assert.equal(tamperLines.length, 1);
  } finally {
    rmTree(stateDir);
  }
});

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

/**
 * Run the hook as a subprocess. `opts.env` is merged over process.env;
 * `opts.cwd` is the child process's own working directory (independent of
 * CLAUDE_PROJECT_DIR / stdin cwd -- used to test the resolution fallback
 * chain itself).
 */
function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(payload || {}),
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
  return runHook(payload || { session_id: "s1", stop_hook_active: false, cwd: repoDir },
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

test("checked_out_branch_stale_suggests_checkout_first: current branch is a diverged ancestor", () => {
  const dir = initRepo("main");
  try {
    git(dir, ["checkout", "-q", "-b", "feature"]);
    git(dir, ["checkout", "-q", "main"]);
    writeAndCommit(dir, "b.txt", "b\n", "advance main");
    git(dir, ["checkout", "-q", "feature"]);
    assert.equal(currentBranch(dir), "feature");

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

test("uncommitted_changes_do_not_change_class: dirty stale worktree still stale, inspect-first text present", () => {
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
    assert.ok(decision);
    assert.match(decision.reason, /worktree remove/);
    assert.match(decision.reason, /status --porcelain/);
    assert.doesNotMatch(decision.reason, /--force/);
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

    let forEachRefCalls = 0;
    let treeSetCalls = 0;
    const countingExecGit = (args, cwd, timeoutMs) => {
      if (args[0] === "for-each-ref") forEachRefCalls++;
      if (args[0] === "log" && args.includes("--max-count=500")) treeSetCalls++;
      return defaultExecGit(args, cwd, timeoutMs);
    };

    const result = evaluateStop(dir, { execGit: countingExecGit });
    assert.equal(result.action, "block"); // all 6 branches are ancestor-stale
    assert.equal(forEachRefCalls, 1, "for-each-ref must be called exactly once regardless of branch count");
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

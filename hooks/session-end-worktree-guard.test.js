"use strict";
// session-end-worktree-guard.test.js
// Tests for the session-end-worktree-guard SessionEnd hook (renamed from
// stop-stale-worktrees-guard.js -- see docs/specs/session-end-worktree-
// guard.md). Most integration tests call the exported `evaluateSessionEnd()`
// in-process against REAL temporary git repositories (fs.mkdtempSync +
// execFileSync('git', ...)) with an injected `sessionIdRaw`/`now`/
// `deadlineMs`/`maxHeals`/`yieldsLogPath` where a test needs deterministic
// control over budget/cap/ownership -- matching the ancestor Stop-guard
// test suite's own pattern of only intercepting what a given test actually
// needs to control, while every git call itself is real.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// MODEL_ROUTING_STATE_DIR (model-routing-guards.state.js's own test-only
// override, spec docs/specs/routing-scorecard.md §2.1 "Test isolation")
// MUST be set before that module (or anything requiring it -- the hook
// itself, agent-tier-ledger.js) is first required: STATE_DIR is a
// module-level constant computed once at require time. Redirecting it to
// a fresh temp dir here means every ledger file this test file's
// in-process `evaluateSessionEnd()` calls read/write (D3 attribution) --
// and the hook's own yields.log default, though every test below also
// passes its own explicit `yieldsLogPath` -- lands under an isolated
// directory instead of this repo's own real `hooks/state`, with no manual
// per-test ledger cleanup required.
const STATE_DIR_OVERRIDE = fs.mkdtempSync(path.join(os.tmpdir(), "seg-state-dir-"));
process.env.MODEL_ROUTING_STATE_DIR = STATE_DIR_OVERRIDE;
process.on("exit", () => {
  try {
    fs.rmSync(STATE_DIR_OVERRIDE, { recursive: true, force: true });
  } catch (_) {
    // best-effort
  }
});

const HOOK_PATH = path.join(__dirname, "session-end-worktree-guard.js");
const guard = require(HOOK_PATH);
const ledger = require(path.join(__dirname, "agent-tier-ledger.js"));
const state = require(path.join(__dirname, "model-routing-guards.state.js"));

// Sanity check: the override above must actually have taken effect on
// every module that reads STATE_DIR, or D3 attribution tests below would
// silently read/write the real hooks/state directory instead.
assert.equal(state.STATE_DIR, STATE_DIR_OVERRIDE, "MODEL_ROUTING_STATE_DIR override did not take effect on model-routing-guards.state.js");

const {
  evaluateSessionEnd,
  resolveTargetDir,
  normalizePathForCompare,
  pathsRelated,
  classifyScope,
  resolveBaseBranch,
  parseWorktreePorcelain,
  classifyBranchForHeal,
  computeWorktreeReachability,
  findInProgressMarker,
  isOwnedByThisSession,
  harnessAgentId,
  rotateYieldsLogIfNeeded,
  defaultFs,
  YIELDS_LOG_MAX_BYTES,
} = guard;

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
  const dir = mkTmpDir("seg-repo-");
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

function addBareOrigin(dir, branch) {
  const bareDir = mkTmpDir("seg-bare-");
  git(bareDir, ["init", "-q", "--bare"]);
  git(dir, ["remote", "add", "origin", bareDir]);
  git(dir, ["push", "-q", "-u", "origin", branch]);
  git(bareDir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  git(dir, ["remote", "set-head", "origin", "-a"]);
  return bareDir;
}

function initRepoWithOrigin(branch) {
  const b = branch || "main";
  const dir = initRepo(b);
  const bareDir = addBareOrigin(dir, b);
  return { dir, bareDir };
}

/** `git worktree list --porcelain` always reports paths with forward
 * slashes; `path.join` on win32 produces backslashes -- normalize before
 * comparing a locally-built path against a yields.log `target` field. */
function toGitPath(p) {
  return p.replace(/\\/g, "/");
}

function worktreeGitDir(worktreePath) {
  return git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
}

function backdateReflog(gitDir, secondsAgo) {
  const reflogPath = path.join(gitDir, "logs", "HEAD");
  const oldTs = Math.floor(Date.now() / 1000) - secondsAgo;
  let content;
  try {
    content = fs.readFileSync(reflogPath, "utf8");
  } catch (_) {
    return;
  }
  // The trailing `\t<message>` is OPTIONAL -- a bare `git worktree add
  // --detach` writes a reflog line with no message at all (no tab), unlike
  // a branched checkout's two-line reflog whose second entry always has
  // one (see parseReflogLastTimestampMs's own matching fix in the hook
  // itself). Requiring a lookahead tab here silently no-ops on a detached
  // worktree's reflog, leaving its timestamp fresh instead of backdated.
  // This regex has no `/m` flag, so a bare `$` only matches the end of the
  // WHOLE (multi-line, trailing-newline-terminated) file content, never
  // the end of an individual line -- `\r?\n` must be spelled out
  // explicitly in the lookahead alongside it.
  content = content.replace(/\d{10,}(?=\s[+-]\d{4}(?:\t|\r?\n|$))/g, String(oldTs));
  fs.writeFileSync(reflogPath, content);
}

function backdateDirMtime(dirPath, secondsAgo) {
  const old = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(dirPath, old, old);
}

const cleanupDirs = [];
const cleanupLedgerSessions = [];
process.on("exit", () => {
  for (const dir of cleanupDirs) rmTree(dir);
  for (const sessionId of cleanupLedgerSessions) cleanupLedgerSession(sessionId);
});

function registerCleanupDir(dir) {
  cleanupDirs.push(dir);
  return dir;
}

function uniqueSession(prefix) {
  return `${prefix || "test"}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanupLedgerSession(sessionId) {
  try {
    const key = ledger.resolveLedgerSessionKey(sessionId, Date.now());
    const p = ledger.ledgerPathForSessionKey(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    // best-effort
  }
}

/** Registers `agentId` as owned by `sessionId` via a real ledger "id"
 * record, exactly the shape agent-tier-ledger.js's own SubagentStart
 * capture writes. */
function registerOwnedAgent(sessionId, agentId) {
  cleanupLedgerSessions.push(sessionId);
  const key = ledger.resolveLedgerSessionKey(sessionId, Date.now());
  ledger.appendIdRecord(key, {
    tool_use_id: `tool-${agentId}`,
    agent_id: agentId,
    name: null,
    rules_version: "test:1",
    ts: new Date().toISOString(),
  });
}

function freshYieldsLogPath() {
  const dir = registerCleanupDir(mkTmpDir("seg-yields-"));
  return path.join(dir, "yields.log");
}

function readYieldsLog(p) {
  try {
    return fs
      .readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

// ─── D9: SessionEnd integration tests ──────────────────────────────────────

test("owned worktree removed without age gate", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("owned-wt");
  registerOwnedAgent(sessionId, "abc123");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "worktree-agent-abc123", wtPath, "main"]);
  registerCleanupDir(wtPath);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.degraded, false);
  assert.equal(summary.healed, 1);
  assert.equal(fs.existsSync(wtPath), false);
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.event === "prune" && l.kind === "worktree" && l.outcome === "pruned"));
});

test("unowned fresh worktree skipped", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("unowned-fresh-wt");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "ordinary-branch", wtPath, "main"]);
  registerCleanupDir(wtPath);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 0);
  assert.equal(fs.existsSync(wtPath), true);
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.event === "prune" && l.target === toGitPath(wtPath) && l.outcome === "skipped:not-owned-and-not-idle"));
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.target === toGitPath(wtPath)));
});

test("unowned idle 61 min worktree removed", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("unowned-idle-wt");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "ordinary-idle-branch", wtPath, "main"]);
  registerCleanupDir(wtPath);

  const gitDir = worktreeGitDir(wtPath);
  backdateReflog(gitDir, 61 * 60);
  backdateDirMtime(gitDir, 61 * 60);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 1);
  assert.equal(fs.existsSync(wtPath), false);
});

// ─── Reachability gate (PR review fix: eligibility never looked at a
// worktree's actual commit content -- an owned-or-idle, clean, detached-
// HEAD worktree sitting on a unique, never-pushed commit was removable
// purely on cleanliness/idleness, silently dropping that commit) ────────

test("reviewer repro: detached worktree, unique never-pushed commit, clean, idle 65min, unowned -> skipped, logged detached_unreachable", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("detached-unreachable");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "--detach", wtPath, "main"]);
  registerCleanupDir(wtPath);
  writeAndCommit(wtPath, "unique.txt", "unique, never-pushed content\n", "unique unpushed commit");

  const gitDir = worktreeGitDir(wtPath);
  backdateReflog(gitDir, 65 * 60);
  backdateDirMtime(gitDir, 65 * 60);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 0);
  assert.equal(fs.existsSync(wtPath), true, "the worktree -- and its unreachable commit -- must survive");
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.event === "prune" && l.target === toGitPath(wtPath) && l.outcome === "skipped:detached_unreachable"));
  assert.ok(
    lines.some((l) => l.event === "session_end_unhealed" && l.target === toGitPath(wtPath) && l.evidence === "detached_unreachable")
  );
});

test("detached worktree whose HEAD equals base tip, clean, idle -> removed", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("detached-at-base-tip");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "--detach", wtPath, "main"]);
  registerCleanupDir(wtPath);
  // No new commit -- HEAD is exactly base's own tip (the trivial
  // self-ancestor case: `merge-base --is-ancestor X X` always succeeds).

  const gitDir = worktreeGitDir(wtPath);
  backdateReflog(gitDir, 65 * 60);
  backdateDirMtime(gitDir, 65 * 60);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 1);
  assert.equal(fs.existsSync(wtPath), false);
});

test("ownership never substitutes for reachability: an OWNED worktree on a branch with unreachable content is still skipped", () => {
  // Ownership (D3) is strictly branch-name-based -- a worktree checked
  // out on `worktree-agent-<id>` where `<id>` is in this session's own
  // ledger. A literally DETACHED worktree can therefore never be "owned"
  // under this design at all (rec.branch is null, so the ownership
  // lookup is never even attempted -- see session-end-worktree-guard.js's
  // D4(i) loop). This test instead exercises the realistic edge case that
  // actually matters: an OWNED, BRANCHED worktree whose content is
  // genuinely unreachable (active, unmerged work) must still never be
  // removed just because it's owned -- the reachability gate in
  // computeWorktreeReachability() applies unconditionally, before the
  // owned-or-idle check ever gets a say.
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("owned-unreachable");
  registerOwnedAgent(sessionId, "ab12ef");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "worktree-agent-ab12ef", wtPath, "main"]);
  registerCleanupDir(wtPath);
  writeAndCommit(wtPath, "unrelated-active.txt", "genuinely unmerged, unrelated content\n", "active unmerged commit");

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 0);
  assert.equal(fs.existsSync(wtPath), true, "owned but unreachable content must survive");
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.event === "prune" && l.target === toGitPath(wtPath) && l.outcome === "skipped:unreachable"));
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.target === toGitPath(wtPath) && l.evidence === "unreachable"));
});

test("dirty worktree skipped even when owned", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("dirty-wt");
  registerOwnedAgent(sessionId, "dead01");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "worktree-agent-dead01", wtPath, "main"]);
  registerCleanupDir(wtPath);
  fs.writeFileSync(path.join(wtPath, "scratch.txt"), "uncommitted\n");

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 0);
  assert.equal(fs.existsSync(wtPath), true);
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.outcome === "skipped:dirty"));
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.evidence === "dirty"));
});

test("worktree containing cwd is skipped and never reported unhealed", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("cwd-inside-wt");

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "ordinary-cwd-branch", wtPath, "main"]);
  registerCleanupDir(wtPath);
  const subDir = path.join(wtPath, "sub");
  fs.mkdirSync(subDir, { recursive: true });

  const yieldsLogPath = freshYieldsLogPath();
  // Resolve target dir to a SUBDIRECTORY of the worktree itself -- the
  // worktree is an ancestor of the resolved target dir.
  const summary = evaluateSessionEnd(subDir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed, 0);
  assert.equal(fs.existsSync(wtPath), true);
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.outcome === "skipped:cwd-related"));
  assert.ok(!lines.some((l) => l.event === "session_end_unhealed" && l.target === wtPath));
});

test("branch heal: ancestor evidence deletes via -d unconditionally", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("ancestor-branch");

  const tip = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["branch", "old-feature", tip]);
  writeAndCommit(dir, "advance.txt", "advance\n", "advance main");
  git(dir, ["push", "-q", "origin", "main"]);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.healed >= 1, true);
  const branches = git(dir, ["branch", "--list", "old-feature"]);
  assert.equal(branches, "");
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.kind === "branch" && l.target === "old-feature" && l.action === "git branch -d" && l.outcome === "pruned"));
});

test("branch heal: tree-equality evidence deletes via -D when owned, no age gate", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("tree-eq-owned");
  registerOwnedAgent(sessionId, "f00d01");

  git(dir, ["checkout", "-q", "-b", "worktree-agent-f00d01"]);
  writeAndCommit(dir, "feature.txt", "feature content\n", "feature commit");
  git(dir, ["checkout", "-q", "main"]);
  // Squash-merge onto main: same tree as the branch tip, but NOT an
  // ancestor (a fresh commit, different history/hash).
  git(dir, ["merge", "-q", "--squash", "worktree-agent-f00d01"]);
  git(dir, ["commit", "-q", "-m", "squash merge feature"]);
  git(dir, ["push", "-q", "origin", "main"]);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  const branches = git(dir, ["branch", "--list", "worktree-agent-f00d01"]);
  assert.equal(branches, "");
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(
    lines.some(
      (l) => l.kind === "branch" && l.target === "worktree-agent-f00d01" && l.action === "git branch -D" && l.outcome === "pruned"
    )
  );
  assert.equal(summary.healed >= 1, true);
});

test("branch heal: tree-equality evidence, unowned, tip too recent -> skipped", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("tree-eq-unowned");

  git(dir, ["checkout", "-q", "-b", "ordinary-feature"]);
  writeAndCommit(dir, "feature2.txt", "feature content 2\n", "feature commit 2");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--squash", "ordinary-feature"]);
  git(dir, ["commit", "-q", "-m", "squash merge feature 2"]);
  git(dir, ["push", "-q", "origin", "main"]);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  const branches = git(dir, ["branch", "--list", "ordinary-feature"]);
  assert.notEqual(branches, "");
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.kind === "branch" && l.target === "ordinary-feature" && l.outcome === "skipped:not-owned-and-too-recent"));
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.target === "ordinary-feature" && l.evidence === "tree-equality"));
});

test("branch heal: gone-upstream alone never deletes, even when owned", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("gone-upstream");
  registerOwnedAgent(sessionId, "beef02");

  git(dir, ["checkout", "-q", "-b", "worktree-agent-beef02"]);
  writeAndCommit(dir, "unrelated.txt", "totally unrelated content\n", "unrelated commit");
  git(dir, ["push", "-q", "-u", "origin", "worktree-agent-beef02"]);
  git(dir, ["push", "-q", "origin", "--delete", "worktree-agent-beef02"]);
  git(dir, ["fetch", "-q", "--prune", "origin"]);
  git(dir, ["checkout", "-q", "main"]);

  const track = git(dir, ["for-each-ref", "--format=%(upstream:track)", "refs/heads/worktree-agent-beef02"]);
  assert.equal(track, "[gone]");

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  const branches = git(dir, ["branch", "--list", "worktree-agent-beef02"]);
  assert.notEqual(branches, "");
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.kind === "branch" && l.target === "worktree-agent-beef02" && l.outcome === "skipped:gone-upstream-only"));
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.target === "worktree-agent-beef02" && l.evidence === "gone-upstream"));
});

test("degraded (fetch to origin fails): only -d ancestor heal runs, -D and worktree heals skipped", () => {
  // No origin remote at all -- `git fetch origin <base>` fails immediately,
  // and base falls back to a local `main`.
  const dir = initRepo("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("degraded");
  registerOwnedAgent(sessionId, "cafe03");

  const tip = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["branch", "old-feature-degraded", tip]);

  git(dir, ["checkout", "-q", "-b", "worktree-agent-cafe03"]);
  writeAndCommit(dir, "feature3.txt", "feature 3\n", "feature commit 3");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--squash", "worktree-agent-cafe03"]);
  git(dir, ["commit", "-q", "-m", "squash merge feature 3"]);

  const wtPath = path.join(dir, "..", `seg-wt-${Date.now()}`);
  git(dir, ["worktree", "add", "-b", "worktree-agent-deadbeef04", wtPath, "main"]);
  registerCleanupDir(wtPath);
  registerOwnedAgent(sessionId, "deadbeef04");

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath });

  assert.equal(summary.degraded, true);
  // ancestor -d still ran despite degraded:
  assert.equal(git(dir, ["branch", "--list", "old-feature-degraded"]), "");
  // owned tree-equality -D did NOT run:
  assert.notEqual(git(dir, ["branch", "--list", "worktree-agent-cafe03"]), "");
  // owned worktree removal did NOT run:
  assert.equal(fs.existsSync(wtPath), true);

  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.kind === "branch" && l.target === "worktree-agent-cafe03" && l.outcome === "skipped:degraded"));
  assert.ok(lines.some((l) => l.kind === "worktree" && l.target === toGitPath(wtPath) && l.outcome === "skipped:degraded"));
});

test("heal cap: stops after maxHeals attempts, remaining logged skipped:cap", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("cap");

  const tip = git(dir, ["rev-parse", "HEAD"]);
  const names = [];
  for (let i = 0; i < 4; i++) {
    const name = `old-feature-cap-${i}`;
    git(dir, ["branch", name, tip]);
    names.push(name);
  }
  // Advance base past every branch's tip so each one classifies as a real
  // `ancestor` (a branch whose tip already equals base's own tip is a
  // trivial self-match, not evidence of staleness).
  writeAndCommit(dir, "advance-cap.txt", "advance\n", "advance main past cap branches");
  git(dir, ["push", "-q", "origin", "main"]);

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath, maxHeals: 2 });

  assert.equal(summary.healed, 2);
  const lines = readYieldsLog(yieldsLogPath);
  const capSkips = lines.filter((l) => l.outcome === "skipped:cap");
  assert.equal(capSkips.length, 2);
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.evidence === "heal-cap-reached"));
});

test("budget exhaustion: remaining items skipped:budget and logged unhealed", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  const sessionId = uniqueSession("budget");

  const tip = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["branch", "old-feature-budget", tip]);
  writeAndCommit(dir, "advance-budget.txt", "advance\n", "advance main past budget branch");
  git(dir, ["push", "-q", "origin", "main"]);

  // Calibrated against this exact fixture shape (one origin-backed repo, no
  // linked worktrees, one extra branch): a normal run makes exactly 12
  // `now()` calls (budget start + per-call remaining() checks through
  // scope/base/fetch-refresh/worktree-list/for-each-ref/tree-set/ledger/
  // nowMs-capture) before the branch heal loop's own first budget check
  // (call #13). Held constant here (rather than re-derived) so that very
  // first per-item budget check already reads exhausted.
  const SETUP_CALLS = 12;
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls > SETUP_CALLS ? 10_000_000 : 0;
  };

  const yieldsLogPath = freshYieldsLogPath();
  const summary = evaluateSessionEnd(dir, { sessionIdRaw: sessionId, yieldsLogPath, now, deadlineMs: 1000 });

  assert.equal(summary.healed, 0);
  const lines = readYieldsLog(yieldsLogPath);
  assert.ok(lines.some((l) => l.outcome === "skipped:budget"));
  assert.ok(lines.some((l) => l.event === "session_end_unhealed" && l.evidence === "budget-exhausted"));
});

test("yields.log rotates to .1 when it exceeds 1 MB before an append", () => {
  const dir = registerCleanupDir(mkTmpDir("seg-rotate-"));
  const yieldsLogPath = path.join(dir, "yields.log");
  fs.writeFileSync(yieldsLogPath, "x".repeat(YIELDS_LOG_MAX_BYTES + 1));
  const rotatedPath = `${yieldsLogPath}.1`;
  fs.writeFileSync(rotatedPath, "old-rotation-content");

  const fsx = defaultFs();
  rotateYieldsLogIfNeeded(fsx, yieldsLogPath);

  assert.equal(fs.existsSync(yieldsLogPath), false);
  assert.equal(fs.existsSync(rotatedPath), true);
  assert.notEqual(fs.readFileSync(rotatedPath, "utf8"), "old-rotation-content");
});

test("exit 0 even when git itself fails (not a repo)", () => {
  const dir = registerCleanupDir(mkTmpDir("seg-notrepo-"));
  const result = execFileSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ session_id: uniqueSession("notrepo"), cwd: dir }),
    encoding: "utf8",
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir }),
  });
  assert.equal(result, "");
});

test("exit 0 in the ordinary healthy-repo case, subprocess invocation", () => {
  const { dir } = initRepoWithOrigin("main");
  registerCleanupDir(dir);
  let code = 0;
  try {
    execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ session_id: uniqueSession("subproc-ok"), cwd: dir, reason: "clear" }),
      encoding: "utf8",
      env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir }),
      timeout: 30000,
    });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 0);
});

// ─── Ported classifier unit tests (kept and adapted) ───────────────────────

test("resolveTargetDir prefers CLAUDE_PROJECT_DIR, then stdin cwd, then process.cwd()", () => {
  const origEnv = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = "/from/env";
    assert.equal(resolveTargetDir({ cwd: "/from/stdin" }), "/from/env");
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(resolveTargetDir({ cwd: "/from/stdin" }), "/from/stdin");
    assert.equal(resolveTargetDir({}), process.cwd());
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;
  }
});

test("normalizePathForCompare is case/separator insensitive on win32-shaped input", () => {
  assert.equal(normalizePathForCompare("C:\\Foo\\Bar\\"), normalizePathForCompare("c:/foo/bar"));
});

test("pathsRelated: equal, ancestor, descendant, and unrelated paths", () => {
  assert.equal(pathsRelated("/a/b", "/a/b"), true);
  assert.equal(pathsRelated("/a/b", "/a/b/c"), true);
  assert.equal(pathsRelated("/a/b/c", "/a/b"), true);
  assert.equal(pathsRelated("/a/b", "/a/other"), false);
  assert.equal(pathsRelated(null, "/a/b"), false);
});

test("classifyScope: not a repo -> out-of-scope", () => {
  const budget = guard.makeBudget(() => 0, 20000);
  const execGit = (args) => ({ ok: false, status: 128 });
  const result = classifyScope("/nonexistent", execGit, budget);
  assert.equal(result.status, "out-of-scope");
});

test("classifyScope: in a real work tree -> in-scope", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  const budget = guard.makeBudget(() => 0, 20000);
  const result = classifyScope(dir, guard.defaultExecGit, budget);
  assert.equal(result.status, "in-scope");
});

test("parseWorktreePorcelain: parses primary + linked records with locked/prunable flags", () => {
  const stdout =
    "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
    "worktree /repo-linked\nHEAD def456\nbranch refs/heads/feature\nlocked\n\n";
  const records = parseWorktreePorcelain(stdout);
  assert.equal(records.length, 2);
  assert.equal(records[0].worktree, "/repo");
  assert.equal(records[1].locked, true);
  assert.equal(records[1].branch, "refs/heads/feature");
});

test("findInProgressMarker detects a rebase-merge marker", () => {
  const dir = registerCleanupDir(mkTmpDir("seg-marker-"));
  fs.mkdirSync(path.join(dir, "rebase-merge"));
  const label = findInProgressMarker(dir, fs);
  assert.equal(label, "rebase in progress");
});

test("findInProgressMarker returns null when nothing is present", () => {
  const dir = registerCleanupDir(mkTmpDir("seg-marker-none-"));
  assert.equal(findInProgressMarker(dir, fs), null);
});

test("classifyBranchForHeal: ancestor evidence", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  const tip = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["branch", "ancestor-branch", tip]);
  writeAndCommit(dir, "more.txt", "more\n", "advance");
  const baseTip = git(dir, ["rev-parse", "HEAD"]);
  const base = { name: "main", tip: baseTip, treeSet: new Set() };
  const budget = guard.makeBudget(() => 0, 20000);
  const branch = { name: "ancestor-branch", tip, tree: "", trackRaw: "" };
  const result = classifyBranchForHeal(branch, base, guard.defaultExecGit, dir, budget);
  assert.equal(result.evidence, "ancestor");
});

test("classifyBranchForHeal: active branch (unrelated, unmerged) evidence is null", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  git(dir, ["checkout", "-q", "-b", "active-branch"]);
  const tip = writeAndCommit(dir, "active.txt", "active content\n", "active commit");
  git(dir, ["checkout", "-q", "main"]);
  const baseTip = git(dir, ["rev-parse", "HEAD"]);
  const base = { name: "main", tip: baseTip, treeSet: new Set() };
  const budget = guard.makeBudget(() => 0, 20000);
  const branch = { name: "active-branch", tip, tree: git(dir, ["rev-parse", "HEAD^{tree}"]), trackRaw: "" };
  const result = classifyBranchForHeal(branch, base, guard.defaultExecGit, dir, budget);
  assert.equal(result.evidence, null);
});

test("harnessAgentId / isOwnedByThisSession", () => {
  assert.equal(harnessAgentId("worktree-agent-abc123"), "abc123");
  assert.equal(harnessAgentId("ordinary-branch"), null);
  const owned = new Set(["abc123"]);
  assert.equal(isOwnedByThisSession("worktree-agent-abc123", owned), true);
  assert.equal(isOwnedByThisSession("worktree-agent-zzz999", owned), false);
  assert.equal(isOwnedByThisSession("ordinary-branch", owned), false);
});

test("resolveBaseBranch: falls back to local main with no remote configured", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  const budget = guard.makeBudget(() => 0, 20000);
  const result = resolveBaseBranch(dir, guard.defaultExecGit, budget);
  assert.equal(result.ok, true);
  assert.equal(result.base.name, "main");
});

test("computeWorktreeReachability: detached HEAD with no commits ahead of base is reachable (self-ancestor)", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  const baseTip = git(dir, ["rev-parse", "HEAD"]);
  const base = { name: "main", tip: baseTip, treeSet: new Set() };
  const budget = guard.makeBudget(() => 0, 20000);
  const rec = { worktree: dir, head: baseTip, branch: null };
  const result = computeWorktreeReachability(rec, base, [], guard.defaultExecGit, dir, budget);
  assert.equal(result.reachable, true);
});

test("computeWorktreeReachability: detached HEAD ahead of base with no branch to substitute is detached_unreachable", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  const baseTip = git(dir, ["rev-parse", "HEAD"]);
  const aheadTip = writeAndCommit(dir, "ahead.txt", "ahead\n", "ahead of base");
  const base = { name: "main", tip: baseTip, treeSet: new Set() };
  const budget = guard.makeBudget(() => 0, 20000);
  const rec = { worktree: dir, head: aheadTip, branch: null };
  const result = computeWorktreeReachability(rec, base, [], guard.defaultExecGit, dir, budget);
  assert.equal(result.reachable, false);
  assert.equal(result.evidence, "detached_unreachable");
});

test("computeWorktreeReachability: branched HEAD not itself an ancestor, but tree-equality evidence substitutes", () => {
  const dir = initRepo("main");
  registerCleanupDir(dir);
  git(dir, ["checkout", "-q", "-b", "feature-tree-eq"]);
  const featureTip = writeAndCommit(dir, "feature.txt", "feature content\n", "feature commit");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--squash", "feature-tree-eq"]);
  const baseTip = git(dir, ["commit", "-q", "-m", "squash merge feature"]) || git(dir, ["rev-parse", "HEAD"]);
  const resolvedBaseTip = git(dir, ["rev-parse", "HEAD"]);
  const treeSetRaw = git(dir, ["log", "--max-count=500", "--format=%T", resolvedBaseTip]);
  const base = { name: "main", tip: resolvedBaseTip, treeSet: new Set(treeSetRaw.split(/\r?\n/).filter(Boolean)) };
  const budget = guard.makeBudget(() => 0, 20000);
  const branches = [
    {
      name: "feature-tree-eq",
      tip: featureTip,
      tree: git(dir, ["rev-parse", `${featureTip}^{tree}`]),
      trackRaw: "",
    },
  ];
  const rec = { worktree: dir, head: featureTip, branch: "refs/heads/feature-tree-eq" };
  const result = computeWorktreeReachability(rec, base, branches, guard.defaultExecGit, dir, budget);
  assert.equal(result.reachable, true);
});

"use strict";
// session-end-worktree-guard.js
// SessionEnd hook (renamed from stop-stale-worktrees-guard.js, formerly a
// Stop hook -- see docs/specs/session-end-worktree-guard.md for the full
// design and docs/specs/stop-stale-worktrees-guard.md for the classifier
// this file's ancestor/tree-equality/cherry/gone-upstream evidence kinds
// were adversaried under).
//
// OWNER DECISION (this file): the stale-worktree/branch guard moves from
// Stop (every turn, blocking) to SessionEnd (once per session, NEVER
// blocking). Instead of demanding the agent clean up before it can end its
// turn, this hook heals what it can prove is safe to heal on its own, and
// records what it can't. There is no state file, no strike counter, no
// HMAC, no v2 migration, no per-session "already reported" bookkeeping --
// none of that machinery makes sense once the hook only ever runs once (at
// most) per session and never blocks anything.
//
// Ported, unchanged in spirit, from the Stop-guard classifier this file
// replaces (see the spec's re-triage table for how each retained piece
// maps to a design letter below):
//   - resolveTargetDir's three-level waterfall (CLAUDE_PROJECT_DIR -> stdin
//     cwd -> process.cwd()).
//   - resolveBaseBranch's origin/HEAD -> local main -> local master
//     waterfall.
//   - The 20-second internal wall-clock budget (makeBudget/gitCall), now
//     bounding heal work instead of a blocking classification pass.
//   - classifyScope's total classification of "is this even a repo".
//   - The evidence kinds a branch or worktree can carry: ancestor,
//     tree-equality, cherry, branch-gone-upstream (`[gone]` upstream
//     track), and unknown/detached. The active-worktree override concept
//     survives as this file's own D4(i) eligibility gate (clean +
//     owned-or-idle) rather than the old quiet-window/unintegrated-commit
//     mechanism -- see the spec's re-triage table.
//
// Deliberately NOT ported: blocking output, strikes/yield/re-block state,
// per-session state file read/write, HMAC tamper evidence, v2 schema
// migration, harness_managed reporting state, remote-tracking-ref
// (refs/remotes/*) classification (stale-remote/stale-remote-foreign),
// systemMessage output. This hook never prints a JSON decision and never
// blocks -- see D5/D7 below and the new spec.
//
// Design (docs/specs/session-end-worktree-guard.md D1-D9):
//   D2  Inputs: session_id + cwd from the SessionEnd payload (any `reason`
//       field is ignored -- this hook runs regardless of why the session
//       ended). `git fetch origin <base>` with a 5s cap runs before
//       classification; a failure sets `degraded = true` for this
//       invocation (no other refs are pruned by this call).
//   D3  Attribution: this session's own agent-tier-ledger file(s) name the
//       agent ids this session spawned (via `Agent`, worktree-isolated). A
//       branch named `worktree-agent-<id>` (or a worktree checked out on
//       one), where `<id>` is in that set, is "owned by this session".
//   D4  Heal order, bounded by the 20s budget and a 10-heal cap, every
//       attempt logged to yields.log:
//         (i)   linked worktrees -- eligible if not primary, not
//               ancestor/descendant/equal to cwd (realpath, case-folded),
//               clean, no in-progress marker, not locked, no index.lock,
//               AND (owned by this session OR idle >= 60 min by BOTH the
//               gitdir entry's own mtime AND its logs/HEAD reflog's last
//               timestamp -- never index mtime). `git worktree remove`,
//               no --force. Skipped entirely when degraded.
//         (ii)  local branches with no attached worktree: ancestor
//               evidence -> `git branch -d` unconditionally; tree-equality
//               or cherry evidence -> `git branch -D`, gated on owned OR
//               tip commit age >= 30 min, and skipped when degraded;
//               gone-upstream alone never deletes anything.
//         (iii) `git fetch --prune origin`, 5s cap, log-only on failure,
//               never used as evidence for (i)/(ii).
//   D5  Everything still stale after heals gets one
//       `{event:"session_end_unhealed",...}` yields.log line plus a
//       one-line stderr summary. Exit 0 always; never blocks; never prints
//       a JSON decision.
//   D6  yields.log rotates to `.1` (replacing any prior `.1`) when it
//       exceeds 1 MB, checked before every append.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { STATE_DIR } = require("./model-routing-guards.state.js");
const agentTierLedger = require("./agent-tier-ledger.js");

const RULES_VERSION = "session-end-worktree-guard:1";

const INTERNAL_DEADLINE_MS = 20000;
const MAX_HEALS = 10;
const IDLE_WORKTREE_MS = 60 * 60 * 1000;
const IDLE_BRANCH_MS = 30 * 60 * 1000;
const FETCH_BASE_TIMEOUT_MS = 5000;
const FETCH_PRUNE_TIMEOUT_MS = 5000;
const YIELDS_LOG_MAX_BYTES = 1 * 1024 * 1024;
const YIELDS_LOG_PATH = path.join(STATE_DIR, "session-end-worktree-guard.yields.log");

// Attribution (D3) -- structurally identical regex to the Stop guard's
// former `harness_managed` exemption; repurposed here for OWNERSHIP, not
// exemption from healing.
const HARNESS_BRANCH_RE = /^worktree-agent-([0-9a-f]+)$/;

// In-progress-operation markers (unchanged from the ported classifier),
// checked under a worktree's own git dir before that worktree is
// considered for removal.
const IN_PROGRESS_MARKERS = [
  { rel: "rebase-merge", label: "rebase in progress" },
  { rel: "rebase-apply", label: "rebase in progress" },
  { rel: "MERGE_HEAD", label: "merge in progress" },
  { rel: "CHERRY_PICK_HEAD", label: "cherry-pick in progress" },
  { rel: "BISECT_START", label: "bisect in progress" },
  { rel: "REVERT_HEAD", label: "revert in progress" },
];

// Unit-separator control character (0x1F) -- can never legitimately appear
// in a ref name, commit hash, or tree hash, so splitting on it is always
// unambiguous.
const FIELD_SEP = "\x1f";
const FER_FORMAT =
  "%(refname:short)" + FIELD_SEP + "%(objectname)" + FIELD_SEP + "%(tree)" + FIELD_SEP + "%(upstream:track)";

// ─── Target directory resolution (ported, unchanged) ──────────────────────

function resolveTargetDir(parsed) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  if (parsed && typeof parsed.cwd === "string" && parsed.cwd.trim() !== "") return parsed.cwd;
  return process.cwd();
}

// ─── Path normalization / containment (ported + new D4(i) containment) ────

function normalizePathForCompare(p) {
  if (typeof p !== "string" || p === "") return null;
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (s === "") s = "/";
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

/**
 * Realpath a directory, case-folded on win32 (spec D4(i)). Returns null if
 * the path doesn't resolve (e.g. already removed).
 */
function realpathCaseFolded(fsx, p) {
  try {
    const rp = fsx.realpathNativeSync(p);
    return process.platform === "win32" ? rp.toLowerCase() : rp;
  } catch (_) {
    return null;
  }
}

/** True if `a` and `b` (already realpath'd/case-folded) are equal, or one
 * is an ancestor of the other. */
function pathsRelated(a, b) {
  if (a === null || b === null) return false;
  const an = a.replace(/\\/g, "/").replace(/\/+$/, "");
  const bn = b.replace(/\\/g, "/").replace(/\/+$/, "");
  if (an === bn) return true;
  if (bn.startsWith(an + "/")) return true;
  if (an.startsWith(bn + "/")) return true;
  return false;
}

// ─── Budget / deadline (ported, unchanged) ─────────────────────────────────

function makeBudget(now, totalMs) {
  const start = now();
  return { remaining: () => totalMs - (now() - start) };
}

// ─── git subprocess wrapper (ported, + stderr capture for yields.log) ─────

function defaultExecGit(args, cwd, timeoutMs) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: Math.max(1, Math.floor(timeoutMs)),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, notFound: true };
    const timedOut = !!(err && (err.killed === true || err.signal));
    let stderr = "";
    if (err && typeof err.stderr === "string") stderr = err.stderr;
    else if (err && err.stderr && typeof err.stderr.toString === "function") stderr = err.stderr.toString("utf8");
    return {
      ok: false,
      timedOut,
      status: err && typeof err.status === "number" ? err.status : null,
      stdout: err && typeof err.stdout === "string" ? err.stdout : "",
      stderr,
      message: err && err.message,
    };
  }
}

function gitCall(execGit, args, cwd, budget) {
  const remaining = budget.remaining();
  if (remaining <= 0) return { ok: false, deadlineExpired: true };
  return execGit(args, cwd, remaining);
}

function callFailed(res) {
  return !res.ok && (res.timedOut || res.deadlineExpired);
}

function firstErrorLine(res) {
  const text = (res && (res.stderr || res.message)) || "";
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line || "unknown error";
}

// ─── Scope gate (ported, unchanged) ────────────────────────────────────────

function classifyScope(targetDir, execGit, budget) {
  const step2 = gitCall(execGit, ["rev-parse", "--is-inside-work-tree"], targetDir, budget);
  if (!step2.ok) {
    if (step2.notFound) return { status: "out-of-scope" };
    if (callFailed(step2)) return { status: "unknown", reason: "scope check timed out" };
    return { status: "out-of-scope" };
  }
  if (step2.stdout.trim() === "true") return { status: "in-scope" };

  const step3 = gitCall(execGit, ["rev-parse", "--is-bare-repository"], targetDir, budget);
  if (!step3.ok) {
    if (callFailed(step3)) return { status: "unknown", reason: "scope check timed out" };
    return { status: "out-of-scope" };
  }
  return { status: "out-of-scope" };
}

// ─── Base branch resolution (ported, unchanged) ────────────────────────────

function resolveBaseBranch(targetDir, execGit, budget) {
  const symRes = gitCall(execGit, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], targetDir, budget);
  if (callFailed(symRes)) return { ok: false, deadlineExpired: true };
  if (symRes.ok) {
    const target = symRes.stdout.trim();
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(target);
    if (m) {
      const verify = gitCall(execGit, ["rev-parse", "--verify", "-q", target], targetDir, budget);
      if (callFailed(verify)) return { ok: false, deadlineExpired: true };
      if (verify.ok) {
        return { ok: true, base: { name: m[1], tip: verify.stdout.trim(), ref: target } };
      }
    }
  }
  for (const candidate of ["main", "master"]) {
    const verify = gitCall(execGit, ["rev-parse", "--verify", "-q", `refs/heads/${candidate}`], targetDir, budget);
    if (callFailed(verify)) return { ok: false, deadlineExpired: true };
    if (verify.ok) {
      return { ok: true, base: { name: candidate, tip: verify.stdout.trim(), ref: `refs/heads/${candidate}` } };
    }
  }
  return { ok: false, reasonText: "no base branch determinable" };
}

// ─── Worktree porcelain parsing (ported, unchanged) ───────────────────────

function parseWorktreePorcelain(stdout) {
  const lines = stdout.split(/\r?\n/);
  const records = [];
  let cur = null;
  for (const line of lines) {
    if (line === "") {
      if (cur) records.push(cur);
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { worktree: null, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    }
    const spaceIdx = line.indexOf(" ");
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
    switch (key) {
      case "worktree": cur.worktree = rest; break;
      case "HEAD": cur.head = rest; break;
      case "branch": cur.branch = rest; break;
      case "detached": cur.detached = true; break;
      case "bare": cur.bare = true; break;
      case "locked": cur.locked = true; break;
      case "prunable": cur.prunable = true; break;
      default: break;
    }
  }
  if (cur) records.push(cur);
  return records;
}

function shortBranchName(refLine) {
  if (typeof refLine !== "string") return refLine;
  return refLine.replace(/^refs\/heads\//, "");
}

function resolveGitDir(execGit, worktreePath, budget) {
  const res = gitCall(execGit, ["rev-parse", "--absolute-git-dir"], worktreePath, budget);
  if (res.ok) return { ok: true, gitDir: res.stdout.trim() };
  if (callFailed(res)) return { ok: false, deadlineExpired: true };
  const res2 = gitCall(execGit, ["rev-parse", "--git-dir"], worktreePath, budget);
  if (!res2.ok) return callFailed(res2) ? { ok: false, deadlineExpired: true } : { ok: false };
  let gd = res2.stdout.trim();
  if (!path.isAbsolute(gd)) gd = path.resolve(worktreePath, gd);
  return { ok: true, gitDir: gd };
}

function findInProgressMarker(gitDir, fsx) {
  for (const marker of IN_PROGRESS_MARKERS) {
    try {
      if (fsx.existsSync(path.join(gitDir, marker.rel))) return marker.label;
    } catch (_) {
      // Treat a probe error as "marker absent".
    }
  }
  return null;
}

function parseForEachRef(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      return { name: parts[0] || "", tip: parts[1] || "", tree: parts[2] || "", trackRaw: parts[3] || "" };
    });
}

function parseReflogLastTimestampMs(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const m = /\s(\d{10,})\s+[+-]\d{4}\t/.exec(last);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000;
}

/**
 * `git merge-base --is-ancestor A B`: exit 0 = ancestor (positive, not a
 * failure); exit 1 = not an ancestor (a valid negative result, not a
 * failure -- `--is-ancestor`'s documented convention); anything else
 * (including a per-call timeout) is a real failure.
 */
function isAncestor(execGit, cwd, budget, maybeAncestor, ref) {
  const res = gitCall(execGit, ["merge-base", "--is-ancestor", maybeAncestor, ref], cwd, budget);
  if (res.ok) return { result: true };
  if (callFailed(res)) return { failure: true, timedOut: !!res.timedOut, deadlineExpired: !!res.deadlineExpired };
  if (res.status === 1) return { result: false };
  return { failure: true };
}

function cherryAllApplied(execGit, cwd, budget, baseRef, branchRef) {
  const res = gitCall(execGit, ["cherry", baseRef, branchRef], cwd, budget);
  if (!res.ok) {
    return callFailed(res) ? { failure: true, timedOut: !!res.timedOut, deadlineExpired: !!res.deadlineExpired } : { failure: true };
  }
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { result: false };
  return { result: lines.every((l) => l.startsWith("-")) };
}

/**
 * Branch evidence classification for D4(ii). Deliberately DIFFERENT order
 * from the old blocking guard's `classifyBranch`: ancestor/tree-equality/
 * cherry are checked FIRST (content-equivalence evidence, strong enough to
 * delete on), and `[gone]` upstream-track is checked LAST, purely
 * informational -- "gone-upstream alone never deletes" (D4). Returns
 * `{ evidence: "ancestor"|"tree-equality"|"cherry"|"gone-upstream"|null }`
 * (null = active/base, nothing to heal) or `{ evidence: "unknown",
 * failure: true }` on a git-call failure.
 */
function classifyBranchForHeal(branch, base, execGit, cwd, budget) {
  if (branch.name === base.name) return { evidence: null };
  if (branch.tip === base.tip) {
    // Trivial self-match: never evidence of staleness on its own (matches
    // the ported classifier's row-6/row-8 guard against a fresh branch
    // whose tip already equals base's tip).
    if (branch.trackRaw === "[gone]") return { evidence: "gone-upstream" };
    return { evidence: null };
  }

  const anc = isAncestor(execGit, cwd, budget, branch.tip, base.tip);
  if (anc.failure) return { evidence: "unknown", failure: true };
  if (anc.result) return { evidence: "ancestor" };

  if (base.treeSet.has(branch.tree)) return { evidence: "tree-equality" };

  const cherryRes = cherryAllApplied(execGit, cwd, budget, base.tip, branch.tip);
  if (cherryRes.failure) return { evidence: "unknown", failure: true };
  if (cherryRes.result) return { evidence: "cherry" };

  if (branch.trackRaw === "[gone]") return { evidence: "gone-upstream" };
  return { evidence: null };
}

// ─── Attribution (D3) ───────────────────────────────────────────────────

/**
 * Reads THIS session's own agent-tier-ledger file (never every session's
 * file -- see agent-tier-ledger.js's own `readAllRecords`, which is
 * deliberately NOT used here) and collects every `kind:"id"` record's
 * `agent_id`. Any failure (missing file, unreadable, malformed line)
 * yields an empty set -- fails toward "nothing is owned", never toward
 * over-crediting ownership.
 */
function collectOwnedAgentIds(sessionIdRaw, now, fsx) {
  const ids = new Set();
  try {
    const sessionKey = agentTierLedger.resolveLedgerSessionKey(sessionIdRaw, now());
    const p = agentTierLedger.ledgerPathForSessionKey(sessionKey);
    const raw = fsx.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (obj && obj.kind === "id" && typeof obj.agent_id === "string" && obj.agent_id !== "") {
        ids.add(obj.agent_id);
      }
    }
  } catch (_) {
    // No ledger file for this session (or unreadable) -- empty set.
  }
  return ids;
}

function harnessAgentId(branchShortName) {
  const m = HARNESS_BRANCH_RE.exec(branchShortName || "");
  return m ? m[1] : null;
}

function isOwnedByThisSession(branchShortName, ownedAgentIds) {
  const id = harnessAgentId(branchShortName);
  return !!id && ownedAgentIds.has(id);
}

// ─── yields.log (D5/D6) ─────────────────────────────────────────────────

function rotateYieldsLogIfNeeded(fsx, yieldsLogPath) {
  try {
    const st = fsx.statSync(yieldsLogPath);
    if (st.size > YIELDS_LOG_MAX_BYTES) {
      const rotated = `${yieldsLogPath}.1`;
      try {
        fsx.unlinkSync(rotated);
      } catch (_) {
        // No prior .1 -- fine.
      }
      fsx.renameSync(yieldsLogPath, rotated);
    }
  } catch (_) {
    // File doesn't exist yet -- nothing to rotate.
  }
}

function appendYieldLogLine(fsx, yieldsLogPath, obj) {
  try {
    fsx.mkdirSync(path.dirname(yieldsLogPath), { recursive: true });
    rotateYieldsLogIfNeeded(fsx, yieldsLogPath);
    const fd = fsx.openSync(yieldsLogPath, "a");
    try {
      fsx.writeSync(fd, JSON.stringify(obj) + "\n");
    } finally {
      fsx.closeSync(fd);
    }
  } catch (_) {
    // Best-effort only -- never affects the exit code (D5: exit 0 always).
  }
}

function defaultFs() {
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    statSync: (p) => fs.statSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    renameSync: (a, b) => fs.renameSync(a, b),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    openSync: (p, flags) => fs.openSync(p, flags),
    writeSync: (fd, data) => fs.writeSync(fd, data),
    closeSync: (fd) => fs.closeSync(fd),
    realpathNativeSync: (p) => fs.realpathSync.native(p),
  };
}

// ─── Idle computation (D4(i)/(ii)) ─────────────────────────────────────────

/** Both signals must independently indicate >= 60 min idle (D4(i)); either
 * missing/unreadable -> not idle (fails toward NOT healing). */
function isWorktreeIdle(gitDir, fsx, nowMs) {
  let gitDirMtime;
  try {
    gitDirMtime = fsx.statSync(gitDir).mtimeMs;
  } catch (_) {
    return false;
  }
  if (!(nowMs - gitDirMtime >= IDLE_WORKTREE_MS)) return false;

  let reflogTs;
  try {
    reflogTs = parseReflogLastTimestampMs(fsx.readFileSync(path.join(gitDir, "logs", "HEAD"), "utf8"));
  } catch (_) {
    reflogTs = null;
  }
  if (typeof reflogTs !== "number") return false;
  return nowMs - reflogTs >= IDLE_WORKTREE_MS;
}

function branchAgeMs(execGit, cwd, budget, tip, nowMs) {
  const res = gitCall(execGit, ["log", "-1", "--format=%ct", tip], cwd, budget);
  if (!res.ok) return null;
  const sec = parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(sec)) return null;
  return nowMs - sec * 1000;
}

// ─── Top-level evaluation (single entry point) ────────────────────────────

/**
 * `deps` (all optional, for test injection): `{ execGit, now, deadlineMs,
 * fs, sessionIdRaw, yieldsLogPath, maxHeals }`. Never throws; always
 * returns a summary object. Never blocks, never prints a JSON decision --
 * the hook's own `main()` is responsible for any stderr summary line.
 */
function evaluateSessionEnd(targetDir, deps) {
  deps = deps || {};
  const execGit = deps.execGit || defaultExecGit;
  const now = deps.now || Date.now;
  const deadlineMs = typeof deps.deadlineMs === "number" ? deps.deadlineMs : INTERNAL_DEADLINE_MS;
  const fsx = deps.fs || defaultFs();
  const sessionIdRaw = deps.sessionIdRaw;
  const yieldsLogPath = deps.yieldsLogPath || YIELDS_LOG_PATH;
  const maxHeals = typeof deps.maxHeals === "number" ? deps.maxHeals : MAX_HEALS;
  const budget = makeBudget(now, deadlineMs);

  const summary = { skipped: null, degraded: false, healed: 0, unhealed: 0, logged: [] };

  const scope = classifyScope(targetDir, execGit, budget);
  if (scope.status !== "in-scope") {
    summary.skipped = scope.status === "unknown" ? "scope-unknown" : "out-of-scope";
    return summary;
  }

  const baseResult = resolveBaseBranch(targetDir, execGit, budget);
  if (!baseResult.ok) {
    summary.skipped = "base-branch-undeterminable";
    return summary;
  }
  let base = baseResult.base;

  // D2: fetch the base ref before classification, 5s cap, independent of
  // the main 20s budget. Failure -> degraded (gates D4(i) entirely and
  // D4(ii)'s -D path; D4(ii)'s -d path still runs against whatever base
  // tip is already locally known).
  let degraded = false;
  const fetchRes = execGit(["fetch", "origin", base.name], targetDir, FETCH_BASE_TIMEOUT_MS);
  if (!fetchRes.ok) {
    degraded = true;
  } else {
    const refreshed = resolveBaseBranch(targetDir, execGit, budget);
    if (refreshed.ok) base = refreshed.base;
  }
  summary.degraded = degraded;

  if (budget.remaining() <= 0) return summary;

  const wtListRes = gitCall(execGit, ["worktree", "list", "--porcelain"], targetDir, budget);
  if (!wtListRes.ok) return summary;
  const records = parseWorktreePorcelain(wtListRes.stdout);

  const ferRes = gitCall(execGit, ["for-each-ref", "--format=" + FER_FORMAT, "refs/heads"], targetDir, budget);
  if (!ferRes.ok) return summary;
  const branches = parseForEachRef(ferRes.stdout);

  const treeSetRes = gitCall(execGit, ["log", "--max-count=500", "--format=%T", base.tip], targetDir, budget);
  if (!treeSetRes.ok) return summary;
  base.treeSet = new Set(treeSetRes.stdout.split(/\r?\n/).filter(Boolean));

  const ownedAgentIds = collectOwnedAgentIds(sessionIdRaw, now, fsx);

  // Attached-branch map (worktree short branch name -> true). Updated as
  // worktrees are removed below, so a branch freed up by a (i) heal in
  // this SAME pass becomes eligible for a (ii) heal in this same pass.
  const attachedBranches = new Set();
  records.forEach((rec) => {
    if (rec.branch) attachedBranches.add(shortBranchName(rec.branch));
  });

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  let healCount = 0;
  const unhealed = [];

  function logPrune(kind, target, action, outcome) {
    const line = { event: "prune", session_id: sessionIdRaw, ts: nowIso, kind, target, action, outcome };
    appendYieldLogLine(fsx, yieldsLogPath, line);
    summary.logged.push(line);
  }

  // ── D4(i): linked worktrees ──
  const cwdReal = realpathCaseFolded(fsx, targetDir);
  for (let idx = 1; idx < records.length; idx++) {
    const rec = records[idx];
    if (rec.bare || !rec.worktree) continue;

    if (budget.remaining() <= 0) {
      logPrune("worktree", rec.worktree, "git worktree remove", "skipped:budget");
      unhealed.push({ kind: "worktree", target: rec.worktree, evidence: "budget-exhausted", fix: `git worktree remove ${rec.worktree}` });
      continue;
    }
    if (healCount >= maxHeals) {
      logPrune("worktree", rec.worktree, "git worktree remove", "skipped:cap");
      unhealed.push({ kind: "worktree", target: rec.worktree, evidence: "heal-cap-reached", fix: `git worktree remove ${rec.worktree}` });
      continue;
    }

    // Deliberate order: every check here is READ-ONLY of the worktree's
    // own git-dir state (rev-parse, marker existsSync, lock flags, mtime/
    // reflog stat) and runs BEFORE `git status --porcelain` below --
    // `status` can itself refresh the on-disk index (creating/removing a
    // transient index.lock), which bumps the git-dir's own directory
    // mtime and would silently invalidate the idle check if run first.
    // `git status --porcelain` therefore runs LAST, immediately before
    // removal, exactly as D4(i) specifies ("run immediately before
    // removal") -- both for freshness (catch a change that happened
    // during this same pass) and to keep it from corrupting its own
    // eligibility signal.
    let skipReason = null;
    const wtReal = realpathCaseFolded(fsx, rec.worktree);
    if (!skipReason && pathsRelated(wtReal, cwdReal)) skipReason = "cwd-related";

    let gitDir = null;
    if (!skipReason) {
      const gdRes = resolveGitDir(execGit, rec.worktree, budget);
      if (!gdRes.ok) skipReason = "gitdir-unresolvable";
      else gitDir = gdRes.gitDir;
    }
    if (!skipReason) {
      const marker = findInProgressMarker(gitDir, fsx);
      if (marker) skipReason = `in-progress:${marker}`;
    }
    if (!skipReason && rec.locked) skipReason = "locked";
    if (!skipReason) {
      try {
        if (fsx.existsSync(path.join(gitDir, "index.lock"))) skipReason = "index-lock";
      } catch (_) {
        // Not determinable -- treat as absent (matches upstream convention).
      }
    }

    let owned = false;
    if (!skipReason) {
      const brName = rec.branch ? shortBranchName(rec.branch) : null;
      owned = brName ? isOwnedByThisSession(brName, ownedAgentIds) : false;
      if (!owned) {
        const idle = isWorktreeIdle(gitDir, fsx, nowMs);
        if (!idle) skipReason = "not-owned-and-not-idle";
      }
    }

    // Dirty check runs last, immediately before removal (see comment
    // above) -- this is the ONLY check that can still fire after every
    // other eligibility gate has already passed.
    if (!skipReason) {
      const statusRes = gitCall(execGit, ["status", "--porcelain"], rec.worktree, budget);
      if (!statusRes.ok) skipReason = "status-check-failed";
      else if (statusRes.stdout.trim() !== "") skipReason = "dirty";
    }

    if (skipReason) {
      logPrune("worktree", rec.worktree, "git worktree remove", `skipped:${skipReason}`);
      // "cwd-related" means this worktree IS where the session lives --
      // never a stale candidate, so it's excluded from D5's unhealed
      // report entirely. Every other skip reason (dirty, not idle/owned,
      // locked, in-progress, an error resolving its git dir, etc.) is a
      // worktree this hook could not prove safe to remove, which D5 wants
      // recorded as still-unhealed.
      if (skipReason !== "cwd-related") {
        unhealed.push({ kind: "worktree", target: rec.worktree, evidence: skipReason, fix: `git worktree remove ${rec.worktree}` });
      }
      continue;
    }

    if (degraded) {
      logPrune("worktree", rec.worktree, "git worktree remove", "skipped:degraded");
      unhealed.push({ kind: "worktree", target: rec.worktree, evidence: owned ? "owned" : "idle", fix: `git worktree remove ${rec.worktree}` });
      continue;
    }

    healCount++;
    const rmRes = gitCall(execGit, ["worktree", "remove", rec.worktree], targetDir, budget);
    if (rmRes.ok) {
      logPrune("worktree", rec.worktree, "git worktree remove", "pruned");
      summary.healed++;
      if (rec.branch) attachedBranches.delete(shortBranchName(rec.branch));
    } else {
      logPrune("worktree", rec.worktree, "git worktree remove", `failed:${firstErrorLine(rmRes)}`);
      unhealed.push({ kind: "worktree", target: rec.worktree, evidence: owned ? "owned" : "idle", fix: `git worktree remove ${rec.worktree}` });
    }
  }

  // ── D4(ii): local branches with no attached worktree ──
  for (const br of branches) {
    if (br.name === base.name) continue;
    if (attachedBranches.has(br.name)) continue;

    if (budget.remaining() <= 0) {
      logPrune("branch", br.name, "git branch -d/-D", "skipped:budget");
      unhealed.push({ kind: "branch", target: br.name, evidence: "budget-exhausted", fix: `git branch -D ${br.name}` });
      continue;
    }
    if (healCount >= maxHeals) {
      logPrune("branch", br.name, "git branch -d/-D", "skipped:cap");
      unhealed.push({ kind: "branch", target: br.name, evidence: "heal-cap-reached", fix: `git branch -D ${br.name}` });
      continue;
    }

    const ev = classifyBranchForHeal(br, base, execGit, targetDir, budget);
    if (ev.evidence === "unknown") {
      logPrune("branch", br.name, "git branch -d/-D", "skipped:classification-failed");
      unhealed.push({ kind: "branch", target: br.name, evidence: "unknown", fix: "inspect manually" });
      continue;
    }
    if (ev.evidence === null) continue; // active/base -- not stale, no log line.
    if (ev.evidence === "gone-upstream") {
      logPrune("branch", br.name, "git branch -D", "skipped:gone-upstream-only");
      unhealed.push({ kind: "branch", target: br.name, evidence: "gone-upstream", fix: `git branch -D ${br.name}  # gone-upstream alone is not sufficient evidence for auto-heal` });
      continue;
    }

    const owned = isOwnedByThisSession(br.name, ownedAgentIds);

    if (ev.evidence === "ancestor") {
      healCount++;
      const res = gitCall(execGit, ["branch", "-d", br.name], targetDir, budget);
      if (res.ok) {
        logPrune("branch", br.name, "git branch -d", "pruned");
        summary.healed++;
      } else {
        logPrune("branch", br.name, "git branch -d", `failed:${firstErrorLine(res)}`);
        unhealed.push({ kind: "branch", target: br.name, evidence: "ancestor", fix: `git branch -d ${br.name}` });
      }
      continue;
    }

    // tree-equality or cherry -> -D, gated.
    let eligible = owned;
    if (!eligible) {
      const ageMs = branchAgeMs(execGit, targetDir, budget, br.tip, nowMs);
      eligible = ageMs !== null && ageMs >= IDLE_BRANCH_MS;
    }
    if (!eligible) {
      logPrune("branch", br.name, "git branch -D", "skipped:not-owned-and-too-recent");
      unhealed.push({ kind: "branch", target: br.name, evidence: ev.evidence, fix: `git branch -D ${br.name}` });
      continue;
    }
    if (degraded) {
      logPrune("branch", br.name, "git branch -D", "skipped:degraded");
      unhealed.push({ kind: "branch", target: br.name, evidence: ev.evidence, fix: `git branch -D ${br.name}` });
      continue;
    }
    healCount++;
    const res = gitCall(execGit, ["branch", "-D", br.name], targetDir, budget);
    if (res.ok) {
      logPrune("branch", br.name, "git branch -D", "pruned");
      summary.healed++;
    } else {
      logPrune("branch", br.name, "git branch -D", `failed:${firstErrorLine(res)}`);
      unhealed.push({ kind: "branch", target: br.name, evidence: ev.evidence, fix: `git branch -D ${br.name}` });
    }
  }

  // ── D4(iii): fetch --prune origin -- log-only, never evidence ──
  const pruneRes = execGit(["fetch", "--prune", "origin"], targetDir, FETCH_PRUNE_TIMEOUT_MS);
  if (pruneRes.ok) {
    logPrune("remote", "origin", "git fetch --prune origin", "pruned");
  } else {
    logPrune("remote", "origin", "git fetch --prune origin", `failed:${firstErrorLine(pruneRes)}`);
  }

  // ── D5: unhealed items ──
  for (const u of unhealed) {
    appendYieldLogLine(fsx, yieldsLogPath, {
      event: "session_end_unhealed",
      session_id: sessionIdRaw,
      ts: nowIso,
      kind: u.kind,
      target: u.target,
      evidence: u.evidence,
      fix: u.fix,
    });
  }
  summary.unhealed = unhealed.length;

  return summary;
}

module.exports = {
  RULES_VERSION,
  INTERNAL_DEADLINE_MS,
  MAX_HEALS,
  IDLE_WORKTREE_MS,
  IDLE_BRANCH_MS,
  YIELDS_LOG_PATH,
  YIELDS_LOG_MAX_BYTES,
  HARNESS_BRANCH_RE,
  resolveTargetDir,
  normalizePathForCompare,
  realpathCaseFolded,
  pathsRelated,
  makeBudget,
  defaultExecGit,
  gitCall,
  classifyScope,
  resolveBaseBranch,
  parseWorktreePorcelain,
  shortBranchName,
  resolveGitDir,
  findInProgressMarker,
  parseForEachRef,
  parseReflogLastTimestampMs,
  isAncestor,
  cherryAllApplied,
  classifyBranchForHeal,
  collectOwnedAgentIds,
  harnessAgentId,
  isOwnedByThisSession,
  isWorktreeIdle,
  branchAgeMs,
  rotateYieldsLogIfNeeded,
  appendYieldLogLine,
  defaultFs,
  evaluateSessionEnd,
};

// ─── Main ───────────────────────────────────────────────────────────────

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    raw = "";
  }

  let parsed = {};
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object") parsed = p;
  } catch (_) {
    parsed = {};
  }

  // D2: run regardless of any `reason` field on the payload -- never read here.
  const targetDir = resolveTargetDir(parsed);
  const sessionIdRaw = typeof parsed.session_id === "string" ? parsed.session_id : null;

  let summary;
  try {
    summary = evaluateSessionEnd(targetDir, { sessionIdRaw });
  } catch (_) {
    // An unexpected bug in this hook's own code must never fail a
    // SessionEnd invocation -- D5: exit 0 always.
    process.exit(0);
  }

  if (summary && summary.unhealed > 0) {
    process.stderr.write(
      `session-end-worktree-guard: healed ${summary.healed}, ${summary.unhealed} item(s) still stale -- see ${YIELDS_LOG_PATH}\n`
    );
  }

  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    process.exit(0);
  }
}

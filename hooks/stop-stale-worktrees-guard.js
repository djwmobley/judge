"use strict";
// stop-stale-worktrees-guard.js
// Stop hook -- blocks the session from ending while the repo containing the
// resolved project directory (see resolveTargetDir below) has stale
// worktrees or stale local branches. Spec: docs/specs/stop-stale-worktrees-guard.md
// (adversaried two rounds -- see that file's sections 10-11 for the full
// change log this implementation follows).
//
// Design summary (see the spec for the authoritative version):
//   - Plain Node, no dependencies, never runs a git-mutating command --
//     `git worktree remove`, `git branch -d/-D`, `git push origin --delete`
//     etc. appear ONLY as strings inside a block `reason`, never executed.
//   - No network calls. Every git call is scoped to the resolved target
//     directory via `-C` and reasons entirely from local refs (including
//     the upstream-tip check below, which reads the locally cached
//     tracking ref, never a live fetch).
//   - Total classification, never an allow-list: every worktree and every
//     local branch maps to exactly one class; "can't tell" is always a
//     block (friction over silent escape), never a silent allow.
//   - One shared 20-second internal wall-clock deadline (INTERNAL_DEADLINE_MS)
//     covers the scope gate AND the full classification pass. Every
//     individual git subprocess call is given its own `timeout` sized to
//     whatever remains of that budget at the moment it's spawned (see
//     `gitCall`/`makeBudget` below) -- a single hung call can't silently
//     ride past the deadline check. Both the per-call timeout expiry and
//     the between-steps deadline check route to the same UNKNOWN -> block
//     outcome, never a silent allow.
//   - `scripts/install-guards.js` registers this hook with an explicit
//     30-second timeout -- 10s of margin over the internal 20s deadline for
//     this process's own stdout write to complete before any harness-level
//     kill (see hooks/README.md's blind-spots note on this).
//   - No state file, no strike counter, no session-keyed ledger. Every
//     Stop invocation independently re-runs full classification from
//     scratch -- see JUDGE_STOP_GUARD below for the one and only bypass.
//   - Remote-tracking refs (refs/remotes/*, spec section 13, adversaried a
//     third round -- section 14) are a third classification target
//     alongside worktrees and local branches: `stale-remote` (merged into
//     base, on the base's OWN remote only) blocks; `stale-remote-foreign`
//     (merged into base, on any OTHER remote -- the operator has no
//     standing to delete it) allows with a systemMessage instead. Never
//     fetches; an atomically-failing `for-each-ref refs/remotes` (one bad
//     object blacks out the whole call) falls back to `show-ref` plus
//     per-ref `rev-parse --verify` so one corrupt ref can't hide every
//     sibling ref's classification.
//
// Bypass: set JUDGE_STOP_GUARD=off in the hook process's OWN inherited
// environment (not something an agent can set from inside its own shell
// invocation) to skip all scope/classification logic entirely -- allows,
// with a systemMessage stating the bypass is active. Accepted blind spot:
// an agent with write access to .claude/settings.json's "env" block could
// set this itself; closing that is a separate guard's job (see spec's
// section 8 and hooks/README.md).
//
// Output/exit contract -- matched exactly to this repo's `no-punt-guard.js`
// convention (see that file's own header, lines 15-19), not independently
// re-derived from platform docs:
//   - Print JSON {"decision":"block","reason":"<text>"} to STDOUT to block.
//   - Allow -> no output at all, OR (bypass / in-progress-operation only)
//     {"systemMessage":"<text>"} with no "decision" field.
//   - Exit code is always 0 -- the decision field controls blocking, not
//     the exit code. This hook never exits 2.
//
// RULES_VERSION below is a diagnostic/log label only (per spec section 6)
// -- nothing in this guard's behavior depends on it; there is no persisted
// state for it to invalidate.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RULES_VERSION = "stop-stale-worktrees-guard:1";

const INTERNAL_DEADLINE_MS = 20000;
const REASON_ITEM_CAP = 40;

// Field separator for `for-each-ref`/`log` format strings -- a control
// character that can never legitimately appear in a ref name, commit hash,
// or tree hash, so splitting on it is always unambiguous (safer than a
// printable delimiter like tab or comma, which -- while also disallowed in
// ref names -- costs nothing extra to avoid entirely).
const FIELD_SEP = "";
const FER_FORMAT =
  "%(refname:short)" + FIELD_SEP +
  "%(objectname)" + FIELD_SEP +
  "%(tree)" + FIELD_SEP +
  "%(upstream)" + FIELD_SEP +
  "%(upstream:track)" + FIELD_SEP +
  "%(upstream:remotename)";

// refs/remotes/* enumeration format (spec §3 "Remote-tracking branches").
// Full refname (for the `/HEAD`-suffix exclusion and exact-ref-equality
// exclusion) AND short name (for remote-ownership/branch-name extraction,
// §3's whole-ref-path-string principle, round-3 finding R3-07).
const FER_REMOTE_FORMAT =
  "%(refname)" + FIELD_SEP +
  "%(refname:short)" + FIELD_SEP +
  "%(objectname)" + FIELD_SEP +
  "%(tree)";

// Active-worktree carve-out (spec §15, live finding 2026-09-07; revised
// per adversary round 4, spec §16).
const DEFAULT_QUIET_MINUTES = 30;

// In-progress-operation markers, checked in priority order (first match
// wins) under the primary worktree's own git dir. §3's "detached HEAD,
// none of the markers present -> unknown" row is the fallback when none
// of these exist.
const IN_PROGRESS_MARKERS = [
  { rel: "rebase-merge", label: "rebase in progress" },
  { rel: "rebase-apply", label: "rebase in progress" },
  { rel: "MERGE_HEAD", label: "merge in progress" },
  { rel: "CHERRY_PICK_HEAD", label: "cherry-pick in progress" },
  { rel: "BISECT_START", label: "bisect in progress" },
  { rel: "REVERT_HEAD", label: "revert in progress" },
];

// ─── Target directory resolution (spec §2) ────────────────────────────────

/**
 * Three-level chain, each terminal: CLAUDE_PROJECT_DIR env var, then stdin
 * `cwd`, then process.cwd(). Never a raw, unvalidated `cwd` used alone.
 */
function resolveTargetDir(parsed) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  if (parsed && typeof parsed.cwd === "string" && parsed.cwd.trim() !== "") return parsed.cwd;
  return process.cwd();
}

// ─── Path normalization (spec §3 Worktrees, path-comparison note) ────────

/**
 * Normalize a path for STRING-IDENTITY comparison (never for an argument
 * handed to a git subprocess, which keeps its original casing -- git
 * resolves those against the real filesystem itself). Converts separators
 * to a single form, strips trailing separators, and case-folds on Windows
 * (the platform this repo targets; the Windows filesystem is
 * case-insensitive end-to-end).
 */
function normalizePathForCompare(p) {
  if (typeof p !== "string" || p === "") return null;
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (s === "") s = "/";
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

// ─── Budget / deadline (spec §3 Deadline) ─────────────────────────────────

function makeBudget(now, totalMs) {
  const start = now();
  return {
    remaining() {
      return totalMs - (now() - start);
    },
  };
}

// ─── git subprocess wrapper ────────────────────────────────────────────────

/**
 * Default git-call implementation. Returns a total-classification result
 * shape: { ok:true, stdout } on success, or one of:
 *   { ok:false, notFound:true }                — git not on PATH (ENOENT)
 *   { ok:false, timedOut:true, status }         — killed by its own timeout
 *   { ok:false, status, stdout, message }       — ran, exited non-zero
 */
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
    return {
      ok: false,
      timedOut,
      status: err && typeof err.status === "number" ? err.status : null,
      stdout: err && typeof err.stdout === "string" ? err.stdout : "",
      message: err && err.message,
    };
  }
}

/**
 * Every git call in this file goes through here: if the shared budget is
 * already exhausted, the call is never even spawned (deadline-expired
 * result, no OS-level timeout involved); otherwise the call is given a
 * `timeout` sized to whatever remains of the budget at this exact moment
 * (spec §3 Deadline, round-2 finding A4).
 */
function gitCall(execGit, args, cwd, budget) {
  const remaining = budget.remaining();
  if (remaining <= 0) return { ok: false, deadlineExpired: true };
  return execGit(args, cwd, remaining);
}

function callFailed(res) {
  return !res.ok && (res.timedOut || res.deadlineExpired);
}

// ─── Scope gate (spec §2) ──────────────────────────────────────────────────

/**
 * Total classification: { status: "out-of-scope" } | { status: "unknown", reason }
 * | { status: "in-scope" }. Items 1-3 of spec §2 are folded into
 * "out-of-scope" (silent allow); a call that TIMES OUT here (as opposed to
 * cleanly reporting "not a repo") is genuinely uncertain, so it routes to
 * "unknown" (block) rather than a silent allow.
 */
function classifyScope(targetDir, execGit, budget) {
  const step2 = gitCall(execGit, ["rev-parse", "--is-inside-work-tree"], targetDir, budget);
  if (!step2.ok) {
    if (step2.notFound) return { status: "out-of-scope" }; // item 1: git not on PATH
    if (callFailed(step2)) {
      return { status: "unknown", reason: "scope check timed out (git rev-parse --is-inside-work-tree)" };
    }
    return { status: "out-of-scope" }; // item 2: not inside a git work tree
  }
  if (step2.stdout.trim() === "true") return { status: "in-scope" };

  const step3 = gitCall(execGit, ["rev-parse", "--is-bare-repository"], targetDir, budget);
  if (!step3.ok) {
    if (callFailed(step3)) {
      return { status: "unknown", reason: "scope check timed out (git rev-parse --is-bare-repository)" };
    }
    return { status: "out-of-scope" };
  }
  // Either a genuine bare repo (item 3) or the "cwd is inside .git itself"
  // edge case (no work tree, not bare either) -- both lack a "the checked
  // out branch" concept for this guard to evaluate; both out of scope.
  return { status: "out-of-scope" };
}

// ─── Base branch resolution (spec §3 "Base branch") ───────────────────────

/**
 * { ok:true, base:{name,tip,ref} } | { ok:false, reasonText } | { ok:false, deadlineExpired:true }
 */
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
        // viaOriginHead: true -- base's own remote (spec §3, §13) is the
        // literal, hardcoded "origin" this waterfall already assumes.
        return { ok: true, base: { name: m[1], tip: verify.stdout.trim(), ref: target, viaOriginHead: true } };
      }
      // Dangling symref (target ref doesn't actually exist) -- fall through.
    }
  }

  for (const candidate of ["main", "master"]) {
    const verify = gitCall(execGit, ["rev-parse", "--verify", "-q", `refs/heads/${candidate}`], targetDir, budget);
    if (callFailed(verify)) return { ok: false, deadlineExpired: true };
    if (verify.ok) {
      // viaOriginHead: false -- base's own remote (if any) must instead be
      // read off this local branch's own %(upstream:remotename), resolved
      // later once the refs/heads for-each-ref call has run.
      return { ok: true, base: { name: candidate, tip: verify.stdout.trim(), ref: `refs/heads/${candidate}`, viaOriginHead: false } };
    }
  }

  return {
    ok: false,
    reasonText:
      "no base branch determinable: refs/remotes/origin/HEAD is unset or dangling, and neither a local " +
      "main nor master branch exists (fix: `git remote set-head origin -a`, or create a local `main`)",
  };
}

// ─── Worktree porcelain parsing (spec §3 Worktrees) ───────────────────────

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
      cur = {
        worktree: null, head: null, branch: null,
        detached: false, bare: false,
        locked: false, lockedReason: null,
        prunable: false, prunableReason: null,
      };
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
      case "locked": cur.locked = true; cur.lockedReason = rest || null; break;
      case "prunable": cur.prunable = true; cur.prunableReason = rest || null; break;
      default: break; // forward-compat: unknown porcelain field, ignored.
    }
  }
  if (cur) records.push(cur);
  return records;
}

function shortBranchName(refLine) {
  if (typeof refLine !== "string") return refLine;
  return refLine.replace(/^refs\/heads\//, "");
}

// ─── In-progress-operation detection (primary worktree only) ─────────────

function resolveGitDir(execGit, worktreePath, budget) {
  const res = gitCall(execGit, ["rev-parse", "--absolute-git-dir"], worktreePath, budget);
  if (res.ok) return { ok: true, gitDir: res.stdout.trim() };
  if (callFailed(res)) return { ok: false, deadlineExpired: true };
  // Fallback for older git: --git-dir may return a relative path.
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
      // Treat a probe error as "marker absent" -- never lets a real
      // detached-HEAD-with-no-marker case masquerade as in-progress.
    }
  }
  return null;
}

// ─── Branch classification (spec §3 Branches) ─────────────────────────────

function parseForEachRef(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      const upstream = parts[3];
      const upstreamRemoteName = parts[5];
      return {
        name: parts[0] || "",
        tip: parts[1] || "",
        tree: parts[2] || "",
        upstreamRef: upstream && upstream.trim() !== "" ? upstream : null,
        trackRaw: parts[4] || "",
        upstreamRemoteName: upstreamRemoteName && upstreamRemoteName.trim() !== "" ? upstreamRemoteName : null,
      };
    });
}

// ─── Remote-tracking ref enumeration and classification (spec §3 "Remote-
// tracking branches", §13, adversary round 3 §14) ─────────────────────────

function parseForEachRefRemotes(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      return { refname: parts[0] || "", shortName: parts[1] || "", tip: parts[2] || "", tree: parts[3] || "" };
    });
}

// Fallback enumeration format (round-3 finding R3-02, corrected during
// implementation -- see the note below): refname + objectname ONLY, no
// %(tree). `%(objectname)` is the raw SHA stored directly IN the ref, so
// resolving it never requires opening the target object; requesting
// %(tree) is what forces git to load and parse the commit for every ref
// in one for-each-ref invocation, which is the actual mechanism behind
// the atomic, whole-namespace failure this fallback exists to route
// around.
const FER_REMOTE_FALLBACK_FORMAT = "%(refname)" + FIELD_SEP + "%(refname:short)" + FIELD_SEP + "%(objectname)";

function parseForEachRefRemotesFallback(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((l) => l !== "")
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      return { refname: parts[0] || "", shortName: parts[1] || "", tip: parts[2] || "" };
    });
}

/**
 * Enumerates every ref under refs/remotes/*. Fast path: one batched
 * for-each-ref call (rich format, incl. tree). Fallback (round-3 finding
 * R3-02): that call fails ATOMICALLY -- zero rows for the whole namespace,
 * not per-ref -- when even one ref's object is missing/unreadable, since
 * resolving %(tree) requires loading the commit object for every ref in
 * one pass.
 *
 * CORRECTED DURING IMPLEMENTATION, not as originally specified: R3-02's
 * text named `git show-ref` as the safe, non-dereferencing fallback.
 * Verified empirically (git 2.52.0.windows.1) that `git show-ref` ALSO
 * fails atomically on the exact same ref -- `fatal: git show-ref: bad ref
 * ... (<sha>)` -- for every ref in the repo, not just the bad one. The
 * actually-safe primitive is a REDUCED `for-each-ref` call requesting only
 * `%(refname)`/`%(objectname)` (never `%(tree)`), confirmed to succeed
 * against the identical fixture. Fallback here uses that reduced call,
 * then verifies each surviving ref's commit AND tree individually via
 * `git rev-parse --verify` (matching R3-02's per-ref-verify intent); a ref
 * that fails becomes its own isolated `unknown` result instead of taking
 * every sibling ref down with it.
 * Returns { ok:true, refs:[{refname,shortName,tip,tree}], unknownRefs:[{refname,reasonNote,timedOut?}], usedFallback? }
 * or { ok:false, deadlineExpired:true } or { ok:false, message }.
 */
function listRemoteRefs(execGit, cwd, budget) {
  const fast = gitCall(execGit, ["for-each-ref", "--format=" + FER_REMOTE_FORMAT, "refs/remotes"], cwd, budget);
  if (fast.ok) {
    return { ok: true, refs: parseForEachRefRemotes(fast.stdout), unknownRefs: [] };
  }
  if (callFailed(fast)) return { ok: false, deadlineExpired: true };

  const listRes = gitCall(execGit, ["for-each-ref", "--format=" + FER_REMOTE_FALLBACK_FORMAT, "refs/remotes"], cwd, budget);
  if (!listRes.ok) {
    return callFailed(listRes)
      ? { ok: false, deadlineExpired: true }
      : { ok: false, message: listRes.message || "git for-each-ref (fallback enumeration) failed" };
  }

  const refs = [];
  const unknownRefs = [];
  for (const candidate of parseForEachRefRemotesFallback(listRes.stdout)) {
    const { refname, shortName } = candidate;
    if (budget.remaining() <= 0) {
      unknownRefs.push({ refname, reasonNote: "deadline expired during fallback per-ref verification", timedOut: true });
      continue;
    }
    const commitRes = gitCall(execGit, ["rev-parse", "--verify", "-q", refname + "^{commit}"], cwd, budget);
    if (!commitRes.ok) {
      unknownRefs.push({ refname, reasonNote: "object missing or unreadable (fallback verify failed)", timedOut: !!(commitRes.timedOut || commitRes.deadlineExpired) });
      continue;
    }
    const treeRes = gitCall(execGit, ["rev-parse", "--verify", "-q", refname + "^{tree}"], cwd, budget);
    if (!treeRes.ok) {
      unknownRefs.push({ refname, reasonNote: "tree object missing or unreadable (fallback verify failed)", timedOut: !!(treeRes.timedOut || treeRes.deadlineExpired) });
      continue;
    }
    refs.push({ refname, shortName, tip: commitRes.stdout.trim(), tree: treeRes.stdout.trim() });
  }
  return { ok: true, refs, unknownRefs, usedFallback: true };
}

/**
 * Determines which configured remote owns `shortName` (e.g. "origin/main")
 * by longest-matching-prefix against the known remote name list -- never
 * by splitting the ref path itself (round-3 finding R3-07: a remote name
 * may legitimately contain "/"). Returns the remote name, or null if no
 * configured remote's name is a prefix (e.g. a stale cached ref from a
 * since-removed remote).
 */
function remoteForRef(shortName, remoteNames) {
  let best = null;
  for (const name of remoteNames) {
    const prefix = name + "/";
    if (shortName.startsWith(prefix) && (!best || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * Classifies one refs/remotes/* ref against `base`. First match wins, per
 * spec §3 "Remote-tracking branches". Returns one of:
 *   { class:"excluded" }
 *   { class:"active-remote" }
 *   { class:"stale-remote"|"stale-remote-foreign", evidence, owner }
 *   { class:"unknown", reasonNote, timedOut? }
 */
function classifyRemoteRef(ref, base, baseRemoteName, remoteNames, excludedRefName, execGit, cwd, budget) {
  if (ref.refname.endsWith("/HEAD")) return { class: "excluded" }; // structural name-suffix match (R3-01) -- never symref detection.
  if (excludedRefName && ref.refname === excludedRefName) return { class: "excluded" };
  if (ref.tip === base.tip) return { class: "excluded" }; // mandatory tip-equality guard -- closes the §12 bug for remote refs too.

  const anc = isAncestor(execGit, cwd, budget, ref.tip, base.tip);
  if (anc.failure) {
    return { class: "unknown", reasonNote: "git merge-base --is-ancestor failed", timedOut: !!(anc.timedOut || anc.deadlineExpired) };
  }
  let evidence = null;
  if (anc.result) {
    evidence = "ancestor";
  } else if (base.treeSet.has(ref.tree)) {
    evidence = "tree-equality";
  } else {
    const cherryRes = cherryAllApplied(execGit, cwd, budget, base.tip, ref.tip);
    if (cherryRes.failure) {
      return { class: "unknown", reasonNote: "git cherry failed", timedOut: !!(cherryRes.timedOut || cherryRes.deadlineExpired) };
    }
    if (cherryRes.result) evidence = "cherry";
  }
  if (!evidence) return { class: "active-remote" };

  const owner = remoteForRef(ref.shortName, remoteNames);
  const isBaseRemote = !!baseRemoteName && owner === baseRemoteName;
  return { class: isBaseRemote ? "stale-remote" : "stale-remote-foreign", evidence, owner: owner || "(unrecognized remote)" };
}

/**
 * Fix sequence, verbatim, spec §13 (round-3 findings R3-03/R3-04) -- base
 * remote only. `remoteRef.shortName` is e.g. "origin/feature"; the branch
 * part is extracted by stripping the KNOWN `remoteName + "/"` prefix
 * (never by guessing where the remote name ends -- R3-07).
 */
function buildRemoteFixLines(remoteRef, remoteName) {
  const branchPart = remoteRef.shortName.slice(remoteName.length + 1);
  return [
    `git fetch --prune ${remoteName}  # the ref may already be gone on the server`,
    `git rev-parse --verify -q refs/remotes/${remoteRef.shortName}  # re-check after fetch --prune -- if this now fails, the ref is already gone; skip the push --delete below`,
    `git push ${remoteName} --delete ${branchPart}  # externally visible: deletes the branch on the remote`,
    `git branch -dr ${remoteRef.shortName}  # fallback if push --delete is refused (no push rights) -- local only: recurs after the next fetch until the branch is actually gone server-side`,
  ];
}

// A branch classified via §3 Branches row 6 may already carry its own
// "git push origin --delete <name>" line; when that branch is grouped
// with an independently-classified stale-remote finding (§13), the new
// remote fix sequence above supersedes it -- strip it to avoid emitting
// the same remote mutation twice.
function stripRedundantPushDeleteLine(fixLines) {
  return fixLines.filter((l) => !/^git push \S+ --delete /.test(l));
}

// ─── Active-worktree carve-out (spec §15/§16) ──────────────────────────────

function getQuietWindowMs(env) {
  const raw = (env || process.env).JUDGE_STOP_GUARD_QUIET_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_QUIET_MINUTES * 60000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_QUIET_MINUTES * 60000;
  return n * 60000;
}

/**
 * Round-4 finding R4-03: a bare `git rev-list --count base..HEAD` reads a
 * fully rebase/squash-merged branch (rewritten hashes, content already
 * landed) as "active" forever. Reuses the exact same three detectors the
 * branch table itself uses (ancestor / tree-equality / cherry) so
 * condition (b) only fires for content genuinely NOT YET integrated into
 * base by any known signature -- any git-call failure along the way is
 * treated as "not a signal" (false), never as a reason to call the
 * worktree active, matching this guard's friction-over-silent-escape
 * default: an uncertain integration check still leaves the branch's own
 * classifyBranch pass (run later, independently) to reach its own
 * unknown/block verdict if the same calls fail there too.
 */
function hasUnintegratedCommits(execGit, worktreePath, base, budget) {
  const headRes = gitCall(execGit, ["rev-parse", "--verify", "-q", "HEAD"], worktreePath, budget);
  if (!headRes.ok) return false;
  const tip = headRes.stdout.trim();
  if (tip === base.tip) return false;

  const anc = isAncestor(execGit, worktreePath, budget, tip, base.tip);
  if (anc.failure) return false;
  if (anc.result) return false; // fast-forward-integrated already.

  const treeRes = gitCall(execGit, ["rev-parse", "--verify", "-q", "HEAD^{tree}"], worktreePath, budget);
  if (treeRes.ok && base.treeSet && base.treeSet.has(treeRes.stdout.trim())) return false; // squash-integrated.

  const cherryRes = cherryAllApplied(execGit, worktreePath, budget, base.tip, tip);
  if (cherryRes.failure) return false;
  if (cherryRes.result) return false; // rebase-integrated.

  return true; // genuinely has commits not yet integrated into base.
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
 * Condition (c), revised per round-4 finding R4-02: uses ONLY the
 * timestamp recorded in `logs/HEAD`'s (the reflog) own last line -- never
 * a file mtime for HEAD/index -- plus `COMMIT_EDITMSG`'s mtime. `index`
 * was dropped entirely: `git status` (which condition (a) must run on
 * every invocation) rewrites the on-disk index whenever its stat cache is
 * out of date, including from a cosmetic mtime touch with no content
 * change -- using index mtime as a recency signal is self-refreshing,
 * potentially even by this guard's own prior run. The reflog is written
 * only by real ref-moving operations (checkout/commit/reset/merge), never
 * by `status`. Round-4 finding R4-06: a future/skewed mtime is clamped to
 * "not recent" (never fresh) by requiring a non-negative delta.
 */
function isWorktreeRecentlyActive(gitDir, fsx, nowMs, quietWindowMs) {
  if (!(quietWindowMs > 0)) return false;
  let newest = -Infinity;
  try {
    const content = fsx.readFileSync(path.join(gitDir, "logs", "HEAD"), "utf8");
    const ts = parseReflogLastTimestampMs(content);
    if (typeof ts === "number" && ts > newest) newest = ts;
  } catch (_) {
    // reflog absent/unreadable -- not a signal.
  }
  try {
    const st = fsx.statSync(path.join(gitDir, "COMMIT_EDITMSG"));
    if (st && typeof st.mtimeMs === "number" && st.mtimeMs > newest) newest = st.mtimeMs;
  } catch (_) {
    // absent -- not a signal.
  }
  if (newest === -Infinity) return false;
  const delta = nowMs - newest;
  return delta >= 0 && delta <= quietWindowMs;
}

/**
 * Spec §15/§16: for ANY worktree (primary or linked, round-4 finding
 * R4-04) whose checked-out branch would otherwise classify `stale`,
 * checks whether the worktree itself is active via any of (a) dirty,
 * (b) unintegrated commits, (c) recent reflog/commit activity. Returns
 * { active: true, reason } or { active: false }.
 */
function detectWorktreeActivity(execGit, worktreePath, base, budget, fsx, quietWindowMs) {
  const statusRes = gitCall(execGit, ["status", "--porcelain"], worktreePath, budget);
  if (statusRes.ok && statusRes.stdout.trim() !== "") {
    return { active: true, reason: "uncommitted changes present" };
  }
  if (hasUnintegratedCommits(execGit, worktreePath, base, budget)) {
    return { active: true, reason: "has commits not yet integrated into base" };
  }
  const gitDirRes = resolveGitDir(execGit, worktreePath, budget);
  if (gitDirRes.ok && isWorktreeRecentlyActive(gitDirRes.gitDir, fsx, Date.now(), quietWindowMs)) {
    return { active: true, reason: "recent worktree activity" };
  }
  return { active: false };
}

/**
 * `git merge-base --is-ancestor A B`: exit 0 = A is an ancestor of (or
 * equal to) B (an expected positive result, not a failure); exit 1 = A is
 * NOT an ancestor (an expected NEGATIVE result, also not a failure -- this
 * is `--is-ancestor`'s documented convention); anything else (including a
 * per-call timeout) is a real failure.
 */
function isAncestor(execGit, cwd, budget, maybeAncestor, ref) {
  const res = gitCall(execGit, ["merge-base", "--is-ancestor", maybeAncestor, ref], cwd, budget);
  if (res.ok) return { result: true };
  if (callFailed(res)) return { failure: true, timedOut: !!res.timedOut, deadlineExpired: !!res.deadlineExpired };
  if (res.status === 1) return { result: false };
  return { failure: true };
}

/**
 * `git cherry <base> <branch>`: every output line starts with "-" (already
 * applied) or "+" (not yet applied); an empty result means zero commits to
 * compare (never counts as "all applied"). A non-zero exit (bad ref, etc.)
 * is a real failure.
 */
function cherryAllApplied(execGit, cwd, budget, baseRef, branchRef) {
  const res = gitCall(execGit, ["cherry", baseRef, branchRef], cwd, budget);
  if (!res.ok) {
    return callFailed(res)
      ? { failure: true, timedOut: !!res.timedOut, deadlineExpired: !!res.deadlineExpired }
      : { failure: true };
  }
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { result: false };
  return { result: lines.every((l) => l.startsWith("-")) };
}

function getUpstreamTip(execGit, cwd, budget, upstreamRef) {
  const res = gitCall(execGit, ["log", "-1", "--format=%H" + FIELD_SEP + "%T", upstreamRef], cwd, budget);
  if (!res.ok) {
    return callFailed(res)
      ? { ok: false, timedOut: !!res.timedOut, deadlineExpired: !!res.deadlineExpired }
      : { ok: false };
  }
  const [hash, tree] = res.stdout.trim().split(FIELD_SEP);
  if (!hash || !tree) return { ok: false };
  return { ok: true, hash, tree };
}

const STALE_FIX = (name, evidence) =>
  `git branch -D ${name}  # squash-merged: -d will refuse; evidence: ${evidence}`;

/**
 * Classifies one local branch against `base` (`{name, tip, treeSet}`).
 * First match wins, per spec §3 Branches' numbered table (rows 1-9).
 * Returns one of:
 *   { class:"ok", row, evidence? }
 *   { class:"active", row:9 }
 *   { class:"stale", row, evidence, fixLines:[...] }
 *   { class:"unknown", reasonNote, timedOut? }
 */
function classifyBranch(branch, base, execGit, cwd, budget) {
  if (branch.name === base.name) return { class: "ok", row: 1 };

  if (branch.trackRaw === "[gone]") {
    return { class: "stale", row: 2, evidence: "gone-upstream", fixLines: [STALE_FIX(branch.name, "gone-upstream")] };
  }

  // Rows 3-5 compare the LOCAL tip against base; a branch reset exactly to
  // base's own tip is never "squash/rebase-merged content" in the sense
  // these three detectors test for (a trivial self-match would otherwise
  // fire on every branch reset to base -- that case belongs to rows 7/8
  // instead, and to row 6 below via the UPSTREAM ref's tip, which is
  // exactly the round-2 A1 scenario this guard is built to catch).
  const tipEqualsBase = branch.tip === base.tip;

  if (!tipEqualsBase) {
    const anc = isAncestor(execGit, cwd, budget, branch.tip, base.tip);
    if (anc.failure) {
      return { class: "unknown", reasonNote: "git merge-base --is-ancestor failed", timedOut: !!(anc.timedOut || anc.deadlineExpired) };
    }
    if (anc.result) {
      return { class: "stale", row: 3, evidence: "ancestor", fixLines: [`git branch -d ${branch.name}`] };
    }

    if (base.treeSet.has(branch.tree)) {
      return { class: "stale", row: 4, evidence: "tree-equality", fixLines: [STALE_FIX(branch.name, "tree-equality")] };
    }

    // Use base.tip (the resolved commit, not base.name) -- base.name is a
    // bare ref name that git resolves fresh against the LOCAL branch of
    // that name, which can have moved on independently of the resolved
    // base (e.g. when the base came from a remote-tracking ref that
    // hasn't been re-fetched). Every detector must compare against the
    // SAME resolved base commit consistently.
    const cherryRes = cherryAllApplied(execGit, cwd, budget, base.tip, branch.tip);
    if (cherryRes.failure) {
      return { class: "unknown", reasonNote: "git cherry failed", timedOut: !!(cherryRes.timedOut || cherryRes.deadlineExpired) };
    }
    if (cherryRes.result) {
      return { class: "stale", row: 5, evidence: "cherry", fixLines: [STALE_FIX(branch.name, "cherry")] };
    }
  }

  // Row 6: the branch's LOCAL tip didn't fire (or was skipped because it
  // equals base's tip) -- check the UPSTREAM ref's own cached tip instead.
  if (branch.upstreamRef) {
    const upTip = getUpstreamTip(execGit, cwd, budget, branch.upstreamRef);
    // Same trivial-self-match guard as the local-tip rows above: a branch
    // whose upstream happens to BE the base's own remote-tracking ref
    // (e.g. `git worktree add -b feature origin/main`, before any commits
    // of its own) has upTip.hash === base.tip, and `merge-base
    // --is-ancestor X X` always exits 0 -- without this guard every such
    // fresh branch would misclassify as stale via a false "ancestor"
    // match on its very first Stop invocation.
    if (upTip.ok && upTip.hash !== base.tip) {
      const anc2 = isAncestor(execGit, cwd, budget, upTip.hash, base.tip);
      if (anc2.failure) {
        return { class: "unknown", reasonNote: "upstream-tip ancestor check failed", timedOut: !!(anc2.timedOut || anc2.deadlineExpired) };
      }
      let evidence = null;
      if (anc2.result) {
        evidence = "upstream-tip-ancestor";
      } else if (base.treeSet.has(upTip.tree)) {
        evidence = "upstream-tip-tree-equality";
      } else {
        const cherry2 = cherryAllApplied(execGit, cwd, budget, base.tip, upTip.hash);
        if (cherry2.failure) {
          return { class: "unknown", reasonNote: "upstream-tip cherry check failed", timedOut: !!(cherry2.timedOut || cherry2.deadlineExpired) };
        }
        if (cherry2.result) evidence = "upstream-tip-cherry";
      }
      if (evidence) {
        return {
          class: "stale",
          row: 6,
          evidence,
          fixLines: [
            STALE_FIX(branch.name, evidence),
            `git push origin --delete ${branch.name}  # operator-confirmed: mutates the remote, run only after manual review`,
          ],
        };
      }
    }
    // upTip resolution failure for a reason OTHER than a timeout (e.g. a
    // stale cached tracking ref that no longer resolves at all) is not a
    // classification failure for the WHOLE branch -- row 6 simply doesn't
    // fire, and rows 7-9 still apply normally below.
    if (!upTip.ok && (upTip.timedOut || upTip.deadlineExpired)) {
      return { class: "unknown", reasonNote: "upstream-tip lookup failed", timedOut: true };
    }
  }

  if (tipEqualsBase) {
    if (!branch.upstreamRef) return { class: "ok", row: 7, evidence: "empty-local" };
    return { class: "ok", row: 8 };
  }

  return { class: "active", row: 9 };
}

// ─── Worktree classification (spec §3 Worktrees) ──────────────────────────

const INSPECT_FIRST = (p) => `git -C ${p} status --porcelain  # inspect for uncommitted changes before removing`;

/**
 * Returns { findings, inProgressMessage, activeMessages, checkedOutMap, consumedRemoteRefs }.
 * `checkedOutMap`: Map<branchShortName, { isPrimary: boolean }> for every
 * worktree record that has a `branch` line (detached records excluded).
 * `remoteByTrackingBranchName`/`baseRemoteName` (spec §13): used to append
 * a grouped stale-remote fix onto a covered branch's combined item
 * (three-way grouping, round-3 finding R3-05). `quietWindowMs` (spec §15):
 * used by the active-linked-worktree carve-out.
 */
function classifyWorktrees(records, branchResultsByName, execGit, targetDir, budget, fsx, remoteByTrackingBranchName, baseRemoteName) {
  remoteByTrackingBranchName = remoteByTrackingBranchName || new Map();
  const findings = [];
  let inProgressMessage = null;
  const activeMessages = [];
  const checkedOutMap = new Map();
  const consumedRemoteRefs = new Set();

  records.forEach((rec, idx) => {
    if (rec.branch) checkedOutMap.set(shortBranchName(rec.branch), { isPrimary: idx === 0 });
  });

  // One batched cross-check for older-git compatibility (missing
  // locked/prunable porcelain fields) -- never mutates anything.
  const pruneRes = gitCall(execGit, ["worktree", "prune", "--dry-run", "--verbose"], targetDir, budget);
  const pruneOutputNorm = pruneRes.ok ? normalizePathForCompare(pruneRes.stdout) || "" : "";

  records.forEach((rec, idx) => {
    if (idx === 0) {
      // ── Primary ──
      if (rec.bare) return; // defensive: a bare primary has no branch/dir concept to evaluate.
      if (!rec.branch) {
        const gitDirRes = resolveGitDir(execGit, rec.worktree, budget);
        if (gitDirRes.ok) {
          const marker = findInProgressMarker(gitDirRes.gitDir, fsx);
          if (marker) {
            inProgressMessage = `${marker} in the primary worktree — stopping is allowed, but confirm this was intentional.`;
            return;
          }
        }
        findings.push({
          kind: "worktree", role: "primary", path: rec.worktree, class: "unknown",
          text: `primary worktree ${rec.worktree} is at a detached HEAD with no in-progress git operation detected`,
          fixLines: null,
        });
        return;
      }
      // On a branch: round-4 finding R4-04 extends the active-worktree
      // carve-out to the primary worktree too -- the override already
      // happened at branch-classification time (evaluateStop), so all
      // that's left here is surfacing the informational message when it
      // did. Otherwise that branch's own staleness, if any, is reported
      // separately via the branch table (still leads with `git checkout
      // <base>` for a genuinely clean, quiet, stale primary branch -- the
      // original incident class R4-04 preserves).
      {
        const primaryName = shortBranchName(rec.branch);
        const primaryRes = branchResultsByName.get(primaryName);
        if (primaryRes && primaryRes.viaWorktreeActivity) {
          activeMessages.push(`active worktree on merged branch ${primaryName} (${primaryRes.activityReason}); clean up when done`);
        }
      }
      return;
    }

    // ── Linked ──
    const dirExists = fsx.existsSync(rec.worktree);
    const pruneHit =
      pruneOutputNorm !== "" &&
      (() => {
        const n = normalizePathForCompare(rec.worktree);
        return !!n && pruneOutputNorm.includes(n);
      })();
    const isPrunableStale = rec.prunable === true || !dirExists || pruneHit;

    if (isPrunableStale) {
      const fixLines = [INSPECT_FIRST(rec.worktree)];
      if (rec.locked) fixLines.push(`git worktree unlock ${rec.worktree}`);
      fixLines.push(`git worktree remove ${rec.worktree}`, "git worktree prune");
      findings.push({
        kind: "worktree", role: "linked", path: rec.worktree, class: "stale",
        evidence: rec.prunable ? "prunable" : (!dirExists ? "missing-directory" : "prune-dry-run"),
        fixLines,
      });
      return;
    }

    if (!rec.branch) {
      findings.push({
        kind: "worktree", role: "linked", path: rec.worktree, class: "unknown",
        text: `linked worktree ${rec.worktree} is at a detached HEAD`,
        fixLines: null,
      });
      return;
    }

    const name = shortBranchName(rec.branch);
    const branchRes = branchResultsByName.get(name);

    // Spec §15/§16 (live finding 2026-09-07, adversary round 4): the
    // active-worktree override already happened at branch-classification
    // time (evaluateStop) -- a branch whose worktree is active never
    // reaches this guard's own ancestor/tree/cherry/gone rows at all
    // (round-4 finding R4-01: gating only HERE, after the fact, would
    // leave the branch independently re-reported via branchFindings).
    // All that's left here is surfacing the informational message.
    if (branchRes && branchRes.viaWorktreeActivity) {
      activeMessages.push(`active worktree on merged branch ${name} (${branchRes.activityReason}); clean up when done`);
      return;
    }

    if (branchRes && branchRes.class === "stale") {
      const fixLines = [INSPECT_FIRST(rec.worktree)];
      if (rec.locked) fixLines.push(`git worktree unlock ${rec.worktree}`);
      fixLines.push(`git worktree remove ${rec.worktree}`);

      let branchFixLines = branchRes.fixLines;
      let evidence = branchRes.evidence;
      const groupedRemote = remoteByTrackingBranchName.get(name);
      if (groupedRemote && baseRemoteName) {
        fixLines.push(...buildRemoteFixLines(groupedRemote, baseRemoteName));
        branchFixLines = stripRedundantPushDeleteLine(branchFixLines);
        consumedRemoteRefs.add(groupedRemote.refname);
        evidence = `${evidence}+remote-${groupedRemote.evidence}`;
      }
      fixLines.push(...branchFixLines);

      findings.push({
        kind: "worktree", role: "linked", path: rec.worktree, class: "stale",
        evidence: `branch-${evidence}`, fixLines, coveredBranch: name,
      });
      return;
    }
    if (branchRes && branchRes.class === "unknown") {
      findings.push({
        kind: "worktree", role: "linked", path: rec.worktree, class: "unknown",
        text: `linked worktree ${rec.worktree}'s checked-out branch ${name} could not be classified`,
        fixLines: null,
      });
      return;
    }
    // ok: not prunable, dir exists, branch is base/empty-local/active.
  });

  return { findings, inProgressMessage, activeMessages, checkedOutMap, consumedRemoteRefs };
}

// ─── Reason text assembly ──────────────────────────────────────────────────

function formatFinding(f) {
  let line;
  if (f.kind === "worktree") line = `[worktree:${f.role}] ${f.path} — ${f.class}`;
  else if (f.kind === "remote") line = `[remote] ${f.refname} — ${f.class}`;
  else line = `[branch] ${f.name} — ${f.class}`;
  if (f.evidence) line += ` (evidence: ${f.evidence})`;
  if (f.text) line += `: ${f.text}`;
  if (f.note) line += ` [${f.note}]`;
  if (f.fixLines && f.fixLines.length > 0) {
    line += ` — fix: ${f.fixLines.join(" ; ")}`;
  } else {
    line += " — no fix offered, inspect manually";
  }
  return line;
}

function buildBlockedReason(findings) {
  const capped = findings.slice(0, REASON_ITEM_CAP);
  const lines = capped.map(formatFinding);
  if (findings.length > REASON_ITEM_CAP) {
    lines.push(`...and ${findings.length - REASON_ITEM_CAP} more`);
  }
  return (
    "Stop blocked by stop-stale-worktrees-guard: the repo has stale worktrees " +
    "and/or stale local branches. Resolve each item below (or explain why it " +
    "is genuinely not stale) before ending the session:\n" +
    lines.join("\n")
  );
}

function buildUnknownReason(label, detail) {
  return `Stop blocked by stop-stale-worktrees-guard: classification could not complete (${label}). ${detail}`;
}

function buildDeadlineReason(classified, notReached) {
  const classifiedText = classified.length
    ? classified.map((c) => `${c.kind}:${c.id}=${c.class}`).join(", ")
    : "(none)";
  const notReachedText = notReached.length
    ? notReached.map((c) => `${c.kind}:${c.id}`).join(", ")
    : "(none)";
  return (
    "Stop blocked by stop-stale-worktrees-guard: classification did not finish within the " +
    "20-second internal deadline. Already classified: " + classifiedText +
    ". Not yet classified: " + notReachedText + "."
  );
}

// ─── Top-level evaluation (spec §2-§4, single entry point) ────────────────

/**
 * The single entry point both `main()` and the test suite use. `deps` is
 * entirely optional and exists for test injection:
 *   { execGit, now, deadlineMs, fs: { existsSync } }
 * Returns exactly one of:
 *   { action: "allow" }
 *   { action: "allow-message", message }
 *   { action: "block", reason }
 */
function evaluateStop(targetDir, deps) {
  deps = deps || {};
  const execGit = deps.execGit || defaultExecGit;
  const now = deps.now || Date.now;
  const deadlineMs = typeof deps.deadlineMs === "number" ? deps.deadlineMs : INTERNAL_DEADLINE_MS;
  const fsx = deps.fs || {
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => fs.statSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
  };
  const budget = makeBudget(now, deadlineMs);
  const quietWindowMs = getQuietWindowMs(deps.env);

  const scope = classifyScope(targetDir, execGit, budget);
  if (scope.status === "out-of-scope") return { action: "allow" };
  if (scope.status === "unknown") return { action: "block", reason: buildUnknownReason("scope-gate", scope.reason) };

  const classified = [];
  const notReached = [];

  const baseResult = resolveBaseBranch(targetDir, execGit, budget);
  if (baseResult.deadlineExpired) return { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "base-branch-resolution" }]) };
  if (!baseResult.ok) return { action: "block", reason: buildUnknownReason("base-branch-undeterminable", baseResult.reasonText) };
  const base = baseResult.base;
  classified.push({ kind: "step", id: "base-branch-resolution", class: base.name });

  if (budget.remaining() <= 0) return { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "worktree-list" }, { kind: "step", id: "branch-list" }]) };

  const wtListRes = gitCall(execGit, ["worktree", "list", "--porcelain"], targetDir, budget);
  if (!wtListRes.ok) {
    return callFailed(wtListRes)
      ? { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "worktree-list" }]) }
      : { action: "block", reason: buildUnknownReason("worktree-list-failed", wtListRes.message || "git worktree list --porcelain failed") };
  }
  const records = parseWorktreePorcelain(wtListRes.stdout);
  classified.push({ kind: "step", id: "worktree-list", class: `${records.length} record(s)` });

  const ferRes = gitCall(execGit, ["for-each-ref", "--format=" + FER_FORMAT, "refs/heads"], targetDir, budget);
  if (!ferRes.ok) {
    return callFailed(ferRes)
      ? { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "branch-list" }]) }
      : { action: "block", reason: buildUnknownReason("branch-list-failed", ferRes.message || "git for-each-ref failed") };
  }
  const branches = parseForEachRef(ferRes.stdout);
  classified.push({ kind: "step", id: "branch-list", class: `${branches.length} branch(es)` });

  const treeSetRes = gitCall(execGit, ["log", "--max-count=500", "--format=%T", base.tip], targetDir, budget);
  if (!treeSetRes.ok) {
    return callFailed(treeSetRes)
      ? { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "base-tree-set" }]) }
      : { action: "block", reason: buildUnknownReason("base-tree-set-failed", treeSetRes.message || "git log --format=%T on the base branch failed") };
  }
  base.treeSet = new Set(treeSetRes.stdout.split(/\r?\n/).filter(Boolean));
  classified.push({ kind: "step", id: "base-tree-set", class: `${base.treeSet.size} tree(s)` });

  // ── Active-worktree pre-pass (spec §15/§16, round-4 finding R4-01/R4-04)
  // Computed BEFORE branch classification, for every worktree (primary or
  // linked) with a checked-out branch, so an active worktree's branch can
  // be overridden to `active` before it ever reaches the ancestor/tree/
  // cherry/gone rows -- fixing it only after the fact (inside
  // classifyWorktrees) would leave the branch independently re-reported
  // via branchFindings (R4-01).
  const activeInfoByBranchName = new Map();
  for (const rec of records) {
    if (rec.bare || !rec.branch) continue;
    if (budget.remaining() <= 0) break; // deadline pressure: fail toward NOT overriding (still-safe stale/unknown path).
    const activity = detectWorktreeActivity(execGit, rec.worktree, base, budget, fsx, quietWindowMs);
    if (activity.active) activeInfoByBranchName.set(shortBranchName(rec.branch), activity.reason);
  }

  const branchResultsByName = new Map();
  for (const br of branches) {
    if (budget.remaining() <= 0) {
      notReached.push({ kind: "branch", id: br.name });
      continue;
    }
    let result = classifyBranch(br, base, execGit, targetDir, budget);
    if (result.class === "stale" && activeInfoByBranchName.has(br.name)) {
      result = { class: "active", row: 9, viaWorktreeActivity: true, wouldHaveBeenEvidence: result.evidence, activityReason: activeInfoByBranchName.get(br.name) };
    }
    branchResultsByName.set(br.name, result);
    classified.push({ kind: "branch", id: br.name, class: result.class });
  }
  if (notReached.length > 0) {
    return { action: "block", reason: buildDeadlineReason(classified, notReached) };
  }

  // ── Remote-tracking refs (spec §3 "Remote-tracking branches", §13) ──
  const baseBranchRow = branches.find((b) => b.name === base.name);
  const excludedRefName = base.viaOriginHead ? base.ref : (baseBranchRow && baseBranchRow.upstreamRef) || null;
  let baseRemoteName = null;
  let remoteResults = [];

  const remoteEnumRes = listRemoteRefs(execGit, targetDir, budget);
  if (!remoteEnumRes.ok) {
    return remoteEnumRes.deadlineExpired
      ? { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "remote-list" }]) }
      : { action: "block", reason: buildUnknownReason("remote-list-failed", remoteEnumRes.message || "git for-each-ref refs/remotes and its show-ref fallback both failed") };
  }
  classified.push({ kind: "step", id: "remote-list", class: `${remoteEnumRes.refs.length} ref(s)${remoteEnumRes.usedFallback ? " (via fallback)" : ""}` });

  const remoteCandidates = remoteEnumRes.refs;
  const remoteUnknownFromEnum = remoteEnumRes.unknownRefs || [];

  if (remoteCandidates.length > 0 || remoteUnknownFromEnum.length > 0) {
    if (base.viaOriginHead) {
      baseRemoteName = "origin";
    } else if (baseBranchRow && baseBranchRow.upstreamRemoteName) {
      baseRemoteName = baseBranchRow.upstreamRemoteName;
    }

    const remotesListRes = gitCall(execGit, ["remote"], targetDir, budget);
    if (!remotesListRes.ok) {
      return callFailed(remotesListRes)
        ? { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "remote-names" }]) }
        : { action: "block", reason: buildUnknownReason("remote-names-failed", remotesListRes.message || "git remote failed") };
    }
    const remoteNames = remotesListRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    classified.push({ kind: "step", id: "remote-names", class: `${remoteNames.length} remote(s)` });

    const remoteNotReached = [];
    for (const ref of remoteCandidates) {
      if (budget.remaining() <= 0) {
        remoteNotReached.push({ kind: "remote", id: ref.shortName });
        continue;
      }
      const result = classifyRemoteRef(ref, base, baseRemoteName, remoteNames, excludedRefName, execGit, targetDir, budget);
      remoteResults.push(Object.assign({ refname: ref.refname, shortName: ref.shortName }, result));
      classified.push({ kind: "remote", id: ref.shortName, class: result.class });
    }
    for (const u of remoteUnknownFromEnum) {
      const shortName = u.refname.replace(/^refs\/remotes\//, "");
      remoteResults.push({ refname: u.refname, shortName, class: "unknown", reasonNote: u.reasonNote, timedOut: u.timedOut });
      classified.push({ kind: "remote", id: shortName, class: "unknown" });
    }
    if (remoteNotReached.length > 0) {
      return { action: "block", reason: buildDeadlineReason(classified, remoteNotReached) };
    }
  }

  const remoteByRefname = new Map(remoteResults.map((r) => [r.refname, r]));
  const branchByUpstreamRef = new Map();
  for (const br of branches) {
    if (br.upstreamRef) branchByUpstreamRef.set(br.upstreamRef, br.name);
  }
  const remoteByTrackingBranchName = new Map();
  for (const br of branches) {
    if (!br.upstreamRef) continue;
    const rr = remoteByRefname.get(br.upstreamRef);
    if (rr && rr.class === "stale-remote") remoteByTrackingBranchName.set(br.name, rr);
  }

  if (budget.remaining() <= 0) {
    return { action: "block", reason: buildDeadlineReason(classified, [{ kind: "step", id: "worktree-classification" }]) };
  }

  const wtOutcome = classifyWorktrees(records, branchResultsByName, execGit, targetDir, budget, fsx, remoteByTrackingBranchName, baseRemoteName);

  const coveredBranches = new Set(
    wtOutcome.findings.filter((f) => f.coveredBranch).map((f) => f.coveredBranch)
  );

  const branchFindings = [];
  for (const [name, res] of branchResultsByName) {
    if (res.class !== "stale" && res.class !== "unknown") continue;
    if (coveredBranches.has(name)) continue; // already fully reported via its linked worktree's combined fix.

    if (res.class === "unknown") {
      branchFindings.push({
        kind: "branch", name, class: "unknown",
        text: `${res.reasonNote}${res.timedOut ? " (timed out)" : ""}`,
        fixLines: null,
      });
      continue;
    }

    const co = wtOutcome.checkedOutMap.get(name);
    let checkoutLine = null;
    let branchFix = res.fixLines.slice();
    if (co && co.isPrimary) checkoutLine = `git checkout ${base.name}`;

    let evidence = res.evidence;
    const parts = [];
    if (checkoutLine) parts.push(checkoutLine);
    const groupedRemote = remoteByTrackingBranchName.get(name);
    if (groupedRemote && baseRemoteName && !wtOutcome.consumedRemoteRefs.has(groupedRemote.refname)) {
      parts.push(...buildRemoteFixLines(groupedRemote, baseRemoteName));
      branchFix = stripRedundantPushDeleteLine(branchFix);
      wtOutcome.consumedRemoteRefs.add(groupedRemote.refname);
      evidence = `${evidence}+remote-${groupedRemote.evidence}`;
    }
    parts.push(...branchFix);

    branchFindings.push({ kind: "branch", name, class: "stale", evidence, fixLines: parts });
  }

  // ── Standalone remote-tracking-ref findings and foreign-remote messages
  // (spec §13, round-3 finding R3-03) ──
  const remoteFindings = [];
  const foreignMessages = [];
  for (const r of remoteResults) {
    if (r.class === "excluded" || r.class === "active-remote") continue;

    if (r.class === "unknown") {
      remoteFindings.push({
        kind: "remote", refname: r.shortName, class: "unknown",
        text: `${r.reasonNote}${r.timedOut ? " (timed out)" : ""}`,
        fixLines: null,
      });
      continue;
    }

    if (r.class === "stale-remote-foreign") {
      foreignMessages.push(
        `${r.shortName} classifies stale-remote-foreign (evidence: ${r.evidence}) on remote "${r.owner}" — ` +
        `allowed, no fix offered: this is not the base's own remote, the operator has no standing to delete it here.`
      );
      continue;
    }

    // r.class === "stale-remote" (base remote)
    if (wtOutcome.consumedRemoteRefs.has(r.refname)) continue; // absorbed into a worktree/branch grouped item above.
    const trackingBranchName = branchByUpstreamRef.get(r.refname);
    const trackingResult = trackingBranchName ? branchResultsByName.get(trackingBranchName) : null;
    if (trackingResult && trackingResult.class === "stale") continue; // handled by the branchFindings grouping loop above.

    const fixLines = buildRemoteFixLines(r, baseRemoteName);
    let note = null;
    if (trackingResult && trackingResult.class === "active") {
      note = `tracking local branch ${trackingBranchName} is active and untouched (§9 open question 2 lean)`;
    }
    remoteFindings.push({ kind: "remote", refname: r.shortName, class: "stale-remote", evidence: r.evidence, fixLines, note });
  }

  const allFindings = [...wtOutcome.findings, ...branchFindings, ...remoteFindings];

  if (allFindings.length === 0) {
    const messages = [];
    if (wtOutcome.inProgressMessage) messages.push(wtOutcome.inProgressMessage);
    if (wtOutcome.activeMessages && wtOutcome.activeMessages.length) messages.push(...wtOutcome.activeMessages);
    if (foreignMessages.length) messages.push(...foreignMessages);
    if (messages.length) return { action: "allow-message", message: messages.join("\n") };
    return { action: "allow" };
  }

  return { action: "block", reason: buildBlockedReason(allFindings) };
}

// Export pure functions for unit-test isolation.
module.exports = {
  RULES_VERSION,
  INTERNAL_DEADLINE_MS,
  REASON_ITEM_CAP,
  resolveTargetDir,
  normalizePathForCompare,
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
  isAncestor,
  cherryAllApplied,
  getUpstreamTip,
  classifyBranch,
  classifyWorktrees,
  buildBlockedReason,
  buildUnknownReason,
  buildDeadlineReason,
  evaluateStop,
  FER_REMOTE_FORMAT,
  FER_REMOTE_FALLBACK_FORMAT,
  parseForEachRefRemotes,
  parseForEachRefRemotesFallback,
  listRemoteRefs,
  remoteForRef,
  classifyRemoteRef,
  buildRemoteFixLines,
  stripRedundantPushDeleteLine,
  getQuietWindowMs,
  isWorktreeRecentlyActive,
  hasUnintegratedCommits,
  parseReflogLastTimestampMs,
  detectWorktreeActivity,
};

// ─── Main ───────────────────────────────────────────────────────────────────

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

  // Bypass: read from the process's own inherited environment only -- an
  // agent cannot set this from inside its own shell tool call and have it
  // affect THIS process's env (accepted .claude/settings.json gap: §4/§8).
  if (process.env.JUDGE_STOP_GUARD === "off") {
    process.stdout.write(JSON.stringify({
      systemMessage: "stop-stale-worktrees-guard bypassed via JUDGE_STOP_GUARD=off.",
    }) + "\n");
    process.exit(0);
  }

  const targetDir = resolveTargetDir(parsed);

  let result;
  try {
    result = evaluateStop(targetDir, {});
  } catch (_) {
    // An unexpected bug in THIS guard's own code (not a classified git
    // failure -- those are returned, never thrown) must never brick every
    // unrelated session's Stop event. Fail open, matching every other
    // guard in this repo's own top-level catch convention.
    process.exit(0);
  }

  if (result.action === "block") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }) + "\n");
  } else if (result.action === "allow-message") {
    process.stdout.write(JSON.stringify({ systemMessage: result.message }) + "\n");
  }
  // action === "allow": no output.

  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    process.exit(0);
  }
}

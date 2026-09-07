# judge — `stop-stale-worktrees-guard.js`

**Audience:** a fresh Claude Code session in this repo, authoring from this
spec. Follows the numbering/conventions of
`docs/specs/pr2-agent-model-routing-guard.md`. Read `hooks/no-punt-guard.js`
first — the only other `Stop`-event guard here, and the direct template for
this guard's stdin-parse / stdout-decision shape (its 3-strike loop pattern
is explicitly NOT followed here — see §4).

*Revised after adversary round 1 (`.git/tmp/pr3-adversary-r1.md`, 17
findings — see §10) and adversary round 2 (`.git/tmp/pr3-adversary-r2.md`,
12 findings — see §11).*

## 1. Purpose

`hooks/stop-stale-worktrees-guard.js` is a `Stop` hook (main-agent turns
only — this event never fires for `SubagentStop`) that blocks the session
from ending while the repo containing the resolved project directory (§2)
has stale worktrees or stale local branches. On block, `reason` names every
offending item, its class, and the exact cleanup command; the agent acts on
it or explains why it's declining.

Plain Node, no dependencies, never executes a git-mutating command (`git
worktree remove`, `git branch -d`/`-D`, `git push origin --delete`, etc.
appear only as strings in `reason`), no network calls. Git calls are
batched (§3) rather than issued per branch wherever possible, and the whole
classification pass is bounded by an internal 20-second deadline (§3,
"Deadline"), with every individual subprocess call itself given a
`timeout` sized to the remaining budget so a single hung call can't consume
the deadline unnoticed (closes round-2 finding A4). `scripts/install-guards.js`
registers this hook with an **explicit 30-second timeout** (§6) — per
Claude Code's documented hook contract, the platform default hook timeout
is 600 seconds and a timed-out hook's output is discarded, which the
harness then treats as an allow. Both the shorter explicit registration and
the internal 20s deadline exist specifically so that a stuck classification
pass fails into this guard's own UNKNOWN-block path (§2.4) well before
either timeout could turn "stuck" into a silent allow.

Registered in `scripts/install-guards.js`'s `GUARDS` array as the next entry
(14th overall, after the three `agent-model-routing-guard*` rows):
`{ id: 'stop-stale-worktrees-guard', file: 'stop-stale-worktrees-guard.js',
event: 'Stop', matcher: null, timeout: 30 }` — same shape as the existing
`no-punt-guard` row, plus the explicit `timeout` field.

## 2. Scope gate

**Resolving the target directory.** Before anything else, resolve the
directory this invocation evaluates, in order: (1) the `CLAUDE_PROJECT_DIR`
environment variable — documented by Claude Code as provided to every hook
invocation, naming the project root the session was launched against; (2)
if unset, the `cwd` field from stdin; (3) if that's also absent,
`process.cwd()`. All of §2–§3 below operate against this resolved
directory, never against a raw, unvalidated `cwd`.

This three-level chain closes two separate round-2 findings: preferring
`CLAUDE_PROJECT_DIR` means an agent whose own process `cwd` has wandered
into a scratch/tmp directory (an entirely ordinary thing to do mid-session)
no longer scopes the guard out of its own project just by not being there
when it stops (R2-A3/R2-C1); the `process.cwd()` last resort covers an
invocation where stdin omits `cwd` entirely (R2-C3).

Total classification, in order, each terminal:

1. `git` not on `PATH` → **out of scope** → exit 0, no output.
2. The resolved target directory is not inside a git work tree
   (`git rev-parse --is-inside-work-tree`) → **out of scope** → exit 0.
3. `git rev-parse --is-bare-repository` is `true` → **out of scope** →
   exit 0. A bare repo has no worktree-of-record and no "the checked-out
   branch" concept for this guard to evaluate.
4. It IS an in-scope, non-bare repo but classification can't complete —
   base branch undeterminable, any §3 git call fails or times out, porcelain
   output doesn't parse, or the internal 20-second deadline (§3) expires
   before classification finishes → **UNKNOWN** → **block**, `reason`
   names exactly what failed and (for a deadline/call-timeout expiry) what
   was and wasn't classified yet. Friction over silent escape.
5. Otherwise, run §3.

No remote configured at all is not a scope exclusion: base-branch
resolution (§3) falls straight to a local `main`/`master` and classification
proceeds normally. A submodule checkout is in scope like any other repo,
evaluated relative to the resolved target directory (superproject or
submodule, whichever contains it).

"Out of scope" (1–3) and "UNKNOWN" (4) are different outcomes: the first
three aren't this guard's business; the fourth is, and it failed at it.

## 3. Classification tables

**Base branch:** try, in order: `refs/remotes/origin/HEAD`'s symbolic
target — but only if that target ref actually exists locally; if it doesn't
(dangling symref), fall through instead of failing — then local `main`,
then local `master`. If no remote is configured at all, skip straight to
local `main`/`master`. None resolve → UNKNOWN (§2.4), `reason` names the fix
(`git remote set-head origin -a`, or create a local `main`).

**Deadline:** an internal wall-clock budget of **20 seconds** measured from
hook start (comfortably inside the 30-second explicit registered timeout —
§1, §6). Two enforcement layers, not one:
- Between steps, the loop checks elapsed time; if the budget is exhausted,
  it stops and blocks immediately with a reason stating classification
  timed out and listing which items were already classified (with class)
  and which weren't reached.
- **Every individual git subprocess call is invoked with its own `timeout`
  option**, sized to whatever remains of the 20s budget at the moment it's
  spawned. A single slow or hung call (e.g. AV-scanned `git.exe` on
  Windows, or `cherry`/`rev-list` against an unusually large diff) is
  killed and treated as that item's call failing — routing to the
  per-item `unknown → block` outcome (§3 Branches) or, if it's the last
  budget available, the overall deadline-block above — rather than being
  allowed to silently ride past the deadline check because the loop never
  got to recheck the clock (closes round-2 finding A4).

This is never a silent allow — both paths are §2.4 UNKNOWN outcomes,
produced by the hook's own code before any OS-level kill could occur.

**Batching.** To keep the common case well under budget as branch count
grows, git calls are batched rather than issued once per branch: one
`git for-each-ref refs/heads` call retrieves all branch metadata in one
shot; one `git rev-list --max-count=500 <base>` call retrieves the base's
candidate tree set once, compared in-process against each branch's tip
tree for the tree-equality detector — not re-run per branch. The only
per-branch subprocess calls remaining are `merge-base --is-ancestor`
(cheap, one rev-walk) and, only for branches rows 2–3 didn't already
resolve, `git cherry <base> <branch>` (the most expensive detector, tried
last and only when needed).

### Worktrees (`git worktree list --porcelain`)

First record = primary; every other = linked. Before any path comparison
(primary-record identification against the resolved target directory,
worktree-directory-exists checks), normalize both sides: convert
separators to a single form, resolve case-insensitively on Windows, strip
trailing separators, and resolve to a realpath where the directory exists.

**In-progress-operation check (primary worktree only):** before falling
back to "detached HEAD → unknown", check whether any of these markers
exist under the primary worktree's `.git` dir: `rebase-merge/`,
`rebase-apply/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_START`,
`REVERT_HEAD`. If any is present, classify **in-progress-operation** — this
is deliberate mid-flight git state, not an abandoned worktree.

| Class | Evidence | Fix / result |
|---|---|---|
| in-progress-operation → **allow** | primary record, detached HEAD, AND one of the markers above present | no block; `systemMessage` names the operation (e.g. "rebase in progress", "cherry-pick in progress") so the agent's decision to stop is visible, not silently accepted |
| unknown → block | primary record, detached HEAD, none of the markers present | none offered — inspect manually |
| ok | primary record, on a branch | — |
| stale | `prunable` line, or the worktree dir no longer exists, or `git worktree prune --dry-run` lists it | `git worktree remove <path>`; `git worktree prune` |
| unknown → block | linked, detached HEAD (no `branch` line) | none offered — inspect manually |
| stale | linked, branch classifies stale per branch table | if `locked` is present (or absent-field-as-false plus a `prune --dry-run` hit indicates a lock), fix leads with `git worktree unlock <path>`; then `git worktree remove <path>`, then the branch's own delete fix |
| ok | linked, not prunable, dir exists, branch is base, empty-local, or active | — |

The in-progress-operation check applies to the primary worktree only, per
scope decision — a linked worktree mid-rebase is not given the same
treatment and still falls to the ordinary linked-detached-HEAD row; see §8.

`locked`/`prunable` fields are absent on older git porcelain output; treat
an absent field as `false`, and additionally run
`git worktree prune --dry-run` as a cross-check for `prunable` on every
worktree regardless of whether the field was present.

Uncommitted changes never change a worktree's class. The fix text always
says to run `git -C <path> status --porcelain` and inspect first; never
defaults to `--force`.

### Branches (`git for-each-ref refs/heads`, incl. `%(upstream:track)`)

Applies to every local branch, including the checked-out one. For a branch
with a configured, non-`[gone]` upstream, the three content detectors
(ancestor, tree-equality, cherry) are evaluated against **both** the local
tip and the upstream ref's cached tip; whichever of the two is more
indicative of staleness determines the branch's class and evidence bucket
— rows 3–5 below already cover "local tip fires"; row 6 exists
specifically for "local tip doesn't fire, but the upstream ref's tip does"
(e.g. the local branch was reset to base after a squash-merge, but the
remote branch — and its locally cached tracking ref — still holds the
pre-squash commits, which independently match the squash-merge or
rebase-merge signature against base). This closes round-2 finding A1,
where such a branch was permanently invisible to every round-1 detector.

First match wins, in this order:

| Order | Class | Evidence | Delete command in `reason` |
|---|---|---|---|
| 1 | ok | is the base branch | — |
| 2 | stale | `%(upstream:track)` = `[gone]` | `git branch -D <name>  # squash-merged: -d will refuse; evidence: gone-upstream` |
| 3 | stale | local tip is an ancestor of base (`merge-base --is-ancestor` exits 0) AND local tip != base tip | `git branch -d <name>` (git can verify ordinary ancestry itself, so `-d` succeeds) |
| 4 | stale | local tip's tree equals the tree of any commit in `git rev-list --max-count=500 <base>` (squash-merge signature) | `git branch -D <name>  # squash-merged: -d will refuse; evidence: tree-equality` |
| 5 | stale | `git cherry <base> <branch>` on the local tip reports every commit already applied (all lines start with `-`), ≥1 commit (rebase-merged signature) | `git branch -D <name>  # squash-merged: -d will refuse; evidence: cherry` |
| 6 | stale | upstream configured, not gone, the **upstream ref's tip is not itself equal to base's tip** (a trivial self-match guard — without it a branch whose upstream happens to BE base's own remote-tracking ref, e.g. freshly created via `git worktree add -b <name> origin/main` with no commits of its own yet, would have upstream-tip == base-tip, and `merge-base --is-ancestor X X` trivially returns true; this is not evidence of staleness, it's row 7/8 territory), and the **upstream ref's tip** (not the local tip — rows 3–5 already ruled the local tip out) independently satisfies the ancestor, tree-equality, or cherry detector against base | `git branch -D <name>  # squash-merged: -d will refuse; evidence: upstream-tip-<ancestor\|tree-equality\|cherry>`, then on its own line `git push origin --delete <name>` — labeled in `reason` as an **operator-confirmed step**: it mutates the remote, is externally visible, and this guard only ever emits fix text, never runs anything |
| 7 | ok (`empty-local`) | local tip == base tip AND no upstream configured | — (a fresh branch about to receive work; never suggest deleting it) |
| 8 | ok | local tip == base tip AND upstream present, not gone, AND (the upstream tip equals base's own tip — the trivial self-match case row 6 excludes — OR the upstream tip does not independently satisfy row 6's detectors) | — |
| 9 | active | none of the above matched | none |

Any git failure (including a per-call timeout, §3 Deadline) while
classifying a given branch makes that one item **unknown → block**; other
items still classify normally.

If the **checked-out** branch classifies stale (rows 2–6 — row 7
"empty-local" is `ok`, so a just-created branch never triggers this), fix
leads with `git checkout <base>`, then that row's fix (both lines, for
row 6).

## 4. Bypass and loop behavior

No state file, no strike counter, no session-keyed ledger, no finding-set
hash. **Every Stop invocation independently re-runs full classification
(§2–§3) from scratch; if any stale or unknown item exists, the guard
blocks — every time, regardless of `stop_hook_active` or how many times it
has already blocked this session.** A human operator can always terminate
the session from outside; a silent yield after N identical blocks is not an
acceptable trade for that, and a design that counts identical retries as
"good enough" rewards ending the turn without acting exactly as much as it
rewards a real fix attempt.

**Bypass:** `JUDGE_STOP_GUARD=off`, read from the hook process's
environment as it was inherited from the Claude Code launch — not from a
value set by an agent's own shell invocation. When set, skip §2–§3
entirely, allow, `systemMessage` states the bypass is active.

**Accepted blind spot:** an agent with ordinary write access to the
project's `.claude/settings.json` could add an `"env": {"JUDGE_STOP_GUARD":
"off"}` block to that file; the harness would then feed that value into the
hook's process environment on the next launch, which is indistinguishable
from a genuine operator-set env var once inherited. This is a real gap —
recorded here rather than solved here, since closing it (e.g. a separate
guard restricting writes to `.claude/settings.json`'s `env` block) is
outside this file's scope. See §8.

Removing all state-file/counter/hash machinery resolves, by construction,
five of round 1's findings: **A3** (poisoned state file forcing a
premature yield — there is no state file to poison), **A4** (three free
passive retries as a designed escape hatch — there is no retry counter to
exploit), **A5** (whole-set hashing making the loyal-yield signal gameable
by unrelated repo churn — there is no hash), **C1** (missing-`session_id`
pooling unrelated sessions' strike counts — there is no session-keyed
state to pool), and **C2** (a broken state directory silently and
permanently disabling the only escape valve — there is no escape valve to
disable). **C3** (`stop_hook_active` gating ambiguity) is also resolved:
§5 states explicitly that the field is logged, never branched on.

## 5. I/O contract

**Stdin:** `session_id` (informational/diagnostic only — not used for any
loop key, since there is no loop state), `stop_hook_active` (informational
only — never gates allow/block for this guard; do not copy
`no-punt-guard.js`'s unconditional-allow-on-true pattern here despite it
being this guard's template for other shape decisions), `cwd` (used only as
the second-priority source for the target directory, §2).

**Stdout/exit contract — matched exactly to this repo's proven
`hooks/no-punt-guard.js` convention**, rather than independently
reverifying Claude Code's current documented Stop-hook JSON schema (closes
round-2 finding C2: this repo already has a deployed, working example of
the accepted shape, which is a stronger source of truth than re-reading
docs). Cited directly from `no-punt-guard.js` lines 15–19:

> - Print JSON `{"decision":"block","reason":"<text>"}` to STDOUT to block.
> - The "reason" text is fed back to the model as a correction.
> - Exit code is always 0 (the decision field controls blocking, not exit code).
> - Produce NO output at all to allow the stop.

This guard follows that shape identically (see its concrete implementation
at `no-punt-guard.js` lines 412–424): block → one line,
`{"decision":"block","reason":"<text>"}`, reason listing each item with
class, evidence, and fix command, capped at the first 40 items with a
trailing count of any remainder (e.g. "...and 12 more"). Allow → no output,
or (bypass or in-progress-operation only) `{"systemMessage":"<text>"}` with
no `decision` field. **Exit code is always `0`.**

For the record (not used by this guard, to stay consistent with
`no-punt-guard.js`): per Claude Code's documented hook contract, exit
code `2` also forces a block regardless of stdout JSON, with the reason
text becoming the shown message. This guard deliberately never exits `2` —
one blocking convention per hook is easier to reason about and test than
two paths that both mean "block."

**Timeout note (§1, §6):** per Claude Code's documented hook contract, the
platform default hook timeout is 600 seconds and a hook that is killed for
exceeding its timeout has its output discarded — the harness then treats
that the same as a normal no-output allow. This is exactly why §1/§6
register this hook with an explicit, much shorter 30-second timeout and
why §3 additionally enforces a 20-second internal deadline: neither the
platform default nor an unbounded classification loop is an acceptable way
to reach "done."

**Operational note:** Stop hooks are picked up by Claude Code's file
watcher, not a session-start snapshot — an edit to
`hooks/stop-stale-worktrees-guard.js` takes effect on the very next Stop
invocation without restarting the session (relevant to anyone iterating on
this guard's implementation).

## 6. Install and files touched

- `hooks/stop-stale-worktrees-guard.js` + `.test.js` (new).
- `scripts/install-guards.js`: one new `GUARDS` entry, including the
  explicit `timeout: 30` field (§1); bump any hardcoded array-length
  assertion in `test/install-guards.test.js`.
- `hooks/README.md`: new `### stop-stale-worktrees-guard.js` section
  (event, blocks, depends-on, blind spots) in the existing per-guard format.
- `README.md`: update `## Status`'s PR-sequencing note.
- No `local-policy.js` change — no machine-specific config needed;
  `JUDGE_STOP_GUARD` is a one-off env-var bypass, not a durable setting.
- No `RULES_VERSION`/`GUARD_VERSION` constant is required by this spec —
  unlike Hook 2's tier ledger, there is no persisted state to invalidate on
  a logic change. A version constant may still be added purely for log/
  diagnostic labeling if the implementer finds it useful, but nothing in
  this guard's behavior depends on it.

## 7. Test matrix

`node:test`, real temp git repos (`fs.mkdtempSync` + `execFileSync('git', ...)`),
following `no-punt-guard.test.js`'s subprocess pattern.

| Test | Fixture | Expected |
|---|---|---|
| `scope_not_a_repo_allows` | temp dir, no `.git` | exit 0, no output |
| `scope_no_git_on_path` | `PATH` stripped | exit 0, no output |
| `scope_bare_repo_allows` | `git init --bare` | exit 0, no output |
| `scope_no_remote_uses_local_base` | no remote, local `main` present | classifies normally against local `main` |
| `scope_submodule_in_scope` | repo with a submodule checkout, target dir inside submodule | classifies the submodule repo normally |
| `scope_resolves_via_claude_project_dir_over_cwd` | `CLAUDE_PROJECT_DIR` set to the repo; stdin `cwd` and `process.cwd()` both point elsewhere (e.g. a scratch tmp dir) | classifies the `CLAUDE_PROJECT_DIR` repo, not the scratch dir |
| `scope_falls_back_to_stdin_cwd_when_project_dir_unset` | `CLAUDE_PROJECT_DIR` unset, stdin `cwd` set | classifies via stdin `cwd` |
| `scope_falls_back_to_process_cwd_when_both_unset` | neither `CLAUDE_PROJECT_DIR` nor stdin `cwd` present | classifies via `process.cwd()` |
| `worktree_primary_ok` | single worktree, on base | allow |
| `primary_worktree_detached_head_unknown_blocks` | primary checked out at detached HEAD, no in-progress markers | block, unknown, no fix offered |
| `primary_worktree_mid_rebase_allows_with_system_message` | primary detached HEAD, `.git/rebase-merge/` present | allow, `systemMessage` names "rebase in progress" |
| `primary_worktree_mid_cherry_pick_allows_with_system_message` | primary detached HEAD, `CHERRY_PICK_HEAD` present | allow, `systemMessage` names "cherry-pick in progress" |
| `worktree_prunable_blocks` | linked worktree dir deleted | block, `remove`/`prune` |
| `worktree_detached_unknown_blocks` | linked, detached HEAD | block, unknown, no fix offered |
| `worktree_stale_branch_blocks` | linked worktree on ancestor branch | block, both fixes |
| `worktree_locked_stale_fix_prepends_unlock` | linked, locked, branch stale | block, fix leads with `git worktree unlock` |
| `worktree_missing_locked_prunable_fields_treated_as_false_with_prune_dry_run_cross_check` | porcelain output without `locked`/`prunable` lines, dir removed | still detected stale via `prune --dry-run` |
| `worktree_active_allows` | linked, unmerged, no upstream | allow |
| `path_normalization_windows_case_and_separator_match` | worktree path differs from target directory only by case/separator | still matched as the same path |
| `branch_ancestor_stale` | fast-forward-merged branch, tip != base | block, `-d` |
| `branch_empty_local_allows` | new branch off base, zero commits, no upstream | allow (`empty-local`) |
| `branch_squash_merged_remote_kept_stale` | squash-merged into base, remote branch NOT deleted (`track` empty, not `[gone]`) | block, tree-equality evidence, `-D` with comment |
| `branch_rebase_merged_stale` | rebased onto base then merged (rewritten hashes, not an ancestor) | block via `git cherry`, `-D` with comment |
| `branch_upstream_gone_stale` | `[gone]` upstream (simulated) | block, `-D` with comment |
| `branch_reset_to_base_with_stale_upstream_squash_signature_stale` | local branch reset to base's tip after a squash-merge; upstream ref still holds pre-reset, already-squash-merged commits | block, evidence `upstream-tip-tree-equality`, `-D` + `git push origin --delete` on its own line |
| `branch_active_no_upstream` | unpushed commits, no upstream | allow |
| `branch_active_upstream_present` | tracking live remote, ahead, upstream tip also unmerged | allow |
| `branch_upstream_equals_base_tip_empty_local_not_stale` | fresh branch whose upstream is set directly to base's own remote-tracking ref (e.g. via `worktree add -b <name> origin/main`), no commits of its own yet | allow — row 6's trivial self-match guard prevents `merge-base --is-ancestor X X` from misclassifying this as stale |
| `git_failure_during_item_classification_unknown_blocks` | one branch's `merge-base`/`cherry` call forced to fail | that item unknown, block; other items classify normally |
| `git_call_timeout_treated_as_failure_unknown_blocks` | one git call hangs past its per-call timeout | that item unknown, block; reason distinguishes timeout from a hard failure |
| `checked_out_branch_stale_suggests_checkout_first` | current branch is ancestor (has diverged history, not empty-local) | block, leads with `checkout <base>` |
| `base_branch_undeterminable_unknown_blocks` | no main/master/origin-HEAD | block, names failure |
| `base_branch_origin_head_dangling_falls_through_to_main` | `origin/HEAD` points at a ref that doesn't exist locally; local `main` present | resolves to `main`, classifies normally |
| `uncommitted_changes_do_not_change_class` | dirty stale worktree | still stale; inspect-first text |
| `deadline_exceeded_blocks_with_partial_classification` | classification forced past 20s (e.g. injected delay) | block, timeout-named reason, lists classified vs. not-yet-classified |
| `batched_git_calls_used_not_per_branch` | repo with several branches | exactly one `for-each-ref` and one `rev-list` invocation observed, not one per branch |
| `bypass_env_var_allows` | `JUDGE_STOP_GUARD=off`, stale present | allow, `systemMessage` notes bypass |
| `reason_caps_at_40_items` | 45 stale items | first 40 listed, "and 5 more" |

## 8. Blind spots

- **Rebase-merged / squash-merged edge cases beyond §3 rows 4–6's reach.**
  A squash whose matching base commit falls outside the 500-commit
  `rev-list` window still misclassifies as `active`.
- **One extra commit on top of already-squashed content defeats rows
  4–5 (round-2 finding A2), by design, not by oversight.** A single
  trivial commit (e.g. a whitespace-only change) added after a branch's
  content was already squash-merged changes its tip tree and breaks the
  "every line is `-`" all-applied condition for `git cherry`, so the
  branch reads as `active`. This is accepted, not fixed: the threat model
  this guard is built for is a **forgetful agent** leaving stale branches
  and worktrees behind by inattention, not an **adversarial** one
  deliberately constructing inputs to evade staleness detection. Closing
  this would require content-similarity heuristics (e.g. a diff-size
  threshold) that risk new false positives for a threat this guard isn't
  trying to defeat.
- **`rev-list --max-count=500` cost/coverage tradeoff.** Reduced to one
  call per invocation (§3 Batching) rather than one per branch, but the
  window size itself is still a bounded-read tradeoff, not validated
  against a large real repo's history depth.
- **Very large branch counts can still exhaust the 20s deadline.**
  Batching (§3) removes the dominant round-1 cost driver (one `rev-list`
  call total instead of one per branch), but `merge-base --is-ancestor`
  and, for unresolved branches, `git cherry` remain per-branch. A repo with
  many thousands of active (never-merged) branches — where every branch
  falls through to the `cherry` check — could still hit the deadline on
  every Stop call. The only documented escape remains the global
  `JUDGE_STOP_GUARD=off` bypass, which disables all staleness detection,
  not just the expensive path. A per-item cost cache was considered and
  rejected: §4 deliberately holds no state across invocations for tamper-
  safety reasons, and that constraint is in direct tension with amortizing
  cost across calls. Accepted, not closed (round-2 finding B4).
- **Stdout flush timing under a hard process kill (round-2 finding A5).**
  Node's write of the `reason` JSON to a Windows pipe is not guaranteed to
  be synchronously flushed before process exit; a block payload written
  right as the 20s deadline path or an external kill fires could in theory
  arrive truncated, which downstream would look like no-decision → allow.
  Mitigated, not eliminated: the 40-item reason cap keeps the payload
  small, and there's a 10-second margin between the 20s internal deadline
  and the 30s explicit registered timeout for the write to complete before
  any harness-level kill. Not verified against the real harness under
  load.
- **Stale worktrees of a different repo.** Only the repo containing the
  resolved target directory is inspected; a stale worktree elsewhere on
  disk is invisible here.
- **Work only on a remote, never fetched.** Classification is entirely
  local-ref-based (including the upstream-tip check in §3 row 6, which
  reads the locally cached tracking ref, not a live fetch); this guard
  never runs `git fetch`.
- **TOCTOU.** Each invocation is an independent, fresh, point-in-time
  snapshot (no cached state carries forward), which narrows — but does not
  eliminate — the window: another process can still mutate a worktree or
  branch between the `list` and `for-each-ref` calls inside one
  invocation.
- **Git version differences.** Tables assume documented `git worktree list
  --porcelain` / `for-each-ref` behavior; absent `locked`/`prunable` fields
  are treated as `false` and cross-checked via `prune --dry-run` (§3), but
  this hasn't been validated against every git version's exact field set —
  confirm against the CI runner's actual git version before treating §3 as
  exhaustive.
- **`JUDGE_STOP_GUARD` via `.claude/settings.json`'s `env` block.** The
  bypass is honored purely because the harness feeds process env from that
  file at launch; an agent with write access to that file can set it
  itself, functioning as exactly the file-based ack the process-env design
  choice was meant to avoid. No guard in this repo currently restricts
  writes to that file. Accepted, not closed (§4).
- **Wrong base branch when a stale local `main` exists but the repo's real
  integration branch is something else** (e.g. `develop`), and
  `origin/HEAD` was never set — including the fork-workflow variant (round-2
  finding B3) where `origin` is the contributor's own fork and the real
  upstream integration branch lives on a differently-named remote entirely,
  so even a correctly-set `origin/HEAD` points at the wrong project's
  default branch. §3's base-branch waterfall has no way to verify the
  chosen ref is actually the team's live integration target. Accepted,
  not closed.
- **Concurrently-open worktree with no git-visible "in use" signal.** A
  linked worktree that classifies `stale` per §3 but is at this moment open
  in another session purely for read-only inspection is still reported
  stale — git exposes no "a process has this open" signal to check
  against. Accepted, not closed.
- **In-progress-operation check is primary-worktree-only.** A linked
  worktree that is itself mid-rebase/mid-cherry-pick (git supports
  per-worktree rebase state) is not given the same allow-with-message
  treatment and still falls to the ordinary linked-detached-HEAD
  `unknown → block` row. Scoped this way per the operative decision for
  this revision; not evaluated against how common a mid-operation linked
  worktree is in practice.
- **Claude Code's exact current Stop-hook JSON schema is not independently
  reverified against docs** — this spec instead anchors to
  `no-punt-guard.js`'s proven, deployed convention (§5). If that guard's
  contract is ever found to be stale against a platform change, this
  guard's contract is stale in the same way, at the same time, which is an
  acceptable shared-fate tradeoff for consistency.

## 9. Open questions

1. **`-d` vs `-D` for stale-branch fixes generally:** git may refuse `-d`
   on a squash- or rebase-merged branch since git can't itself verify the
   content is fully merged by ordinary ancestry. **Resolved this
   revision** (round-2 finding B2): §3's branch table now selects the
   delete command by evidence bucket — ancestor rows use `-d` (git can
   verify these itself), every other stale row (`gone`, tree-equality,
   cherry, upstream-tip-merged) leads with `-D` plus an inline comment
   explaining why `-d` would fail. No remaining open fork here.

*(No unresolved forks remain after round 2; all round-1 and round-2
findings were dispositioned as fixed or accepted blind spots — see §10,
§11.)*

## 10. Adversary round 1 change log

| Finding | Resolution | Spec section | Rationale |
|---|---|---|---|
| A1 | fixed | §3 Branches (row 4) | Tree-equality-against-last-500-base-commits check catches a squash-merge whose remote branch was kept, independent of upstream-track state. |
| A2 | fixed | §3 Branches (row 7) | New `empty-local` class: tip==base + no upstream is `ok`, not `stale`, so a just-created branch is never targeted for deletion. |
| A3 | fixed (by construction) | §4 | No state file exists to poison — the guard reclassifies from scratch every invocation. |
| A4 | fixed (by construction) | §4 | No retry counter exists — passive no-op retries never earn an allow. |
| A5 | fixed (by construction) | §4 | No finding-set hash exists to be perturbed by unrelated repo churn. |
| A6 | accepted blind spot | §4, §8 | Process-env bypass is still forgeable via a `.claude/settings.json` `env` edit; closing it needs a separate guard, out of scope here. |
| A7 | fixed | §3 Deadline | Internal deadline makes the hook emit its own UNKNOWN block before an OS-level timeout kill could produce a silent allow; round 2 hardened this further with per-call timeouts (§11 R2-A4). |
| B1 | fixed | §3 Branches (row 7) | Same fix as A2 — the same evidence and the same class. |
| B2 | fixed | §3 Worktrees, §8 | Locked linked worktrees are classified by branch as before, but the fix now prepends `git worktree unlock <path>`. |
| B3 | accepted blind spot | §8 | No git-native way to verify a resolved `main`/`master` is the real integration branch; documented as a named limitation, later extended by round-2 finding B3 (fork workflows). |
| B4 | accepted blind spot | §8 | Git has no "in use by another session" signal to check against; nothing to implement. |
| B5 | fixed | §3 Worktrees | All path comparisons normalize separators/case and strip trailing separators before equality checks (Windows-safe). |
| C1 | fixed (by construction) | §4 | No session-keyed state exists to pool across sessions. |
| C2 | fixed (by construction) | §4 | No escape valve/state write exists to be disabled by a write failure. |
| C3 | fixed | §5 | Spec states explicitly that `stop_hook_active` is logged only, never branched on, and calls out the template guard's opposite pattern by name. |
| C4 | fixed (by construction) | §4 | No hash-based dedup exists for Unicode variants to defeat. |

## 11. Adversary round 2 change log

| Finding | Resolution | Spec section | Rationale |
|---|---|---|---|
| R2-A1 | fixed | §3 Branches (row 6) | Detectors now also run against the upstream ref's cached tip, catching a branch reset to base whose remote copy still carries an already-squash-merged signature; fix text adds the operator-confirmed remote delete step. |
| R2-A2 | accepted blind spot | §8 | A single trivial commit on top of already-merged content defeats content-equivalence detectors by design; this guard's threat model is a forgetful agent, not an evading one, so no heuristic was added. |
| R2-A3 | fixed | §2 | Target directory now resolves via `CLAUDE_PROJECT_DIR` first, closing the plain-`cd`-elsewhere scope-out gap, which was cheaper to trigger than the accepted env-var bypass. |
| R2-A4 | fixed | §3 Deadline | Every git subprocess call now carries its own `timeout` sized to the remaining budget, so one hung call can no longer ride past the deadline check unnoticed. |
| R2-A5 | accepted blind spot | §8 | Stdout flush-before-exit isn't guaranteed on a Windows pipe under a hard kill; mitigated by the 40-item cap and a 10s margin between the internal deadline and the registered timeout, not eliminated. |
| R2-B1 | fixed | §3 Worktrees | New `in-progress-operation` class for the primary worktree checks the standard git state markers before falling back to bare "detached → unknown"; allows with a naming `systemMessage` instead of blocking a mid-rebase/mid-cherry-pick/mid-bisect/mid-revert handoff with no guidance. |
| R2-B2 | fixed | §3 Branches, §9 | Delete command is now chosen by evidence bucket: ancestor rows get `-d` (git can self-verify), every other stale row leads with `-D` plus an inline comment explaining why `-d` would fail, instead of repeating a command that predictably fails every cycle. |
| R2-B3 | accepted blind spot | §8 (extends B3) | Fork-workflow repos where `origin` is the contributor's fork, not the real integration remote, share round 1's B3 failure mode via a different, common setup; no git-native fix, documented alongside it. |
| R2-B4 | accepted blind spot (mitigated) | §3 Batching, §8 | Batching removes the dominant per-branch cost driver (`rev-list`), but per-branch `merge-base`/`cherry` calls still scale with branch count; a very-large-branch-count repo can still hit the deadline every call, with only the global bypass as an escape — an architectural tension with §4's no-persisted-state design, not resolved here. |
| R2-C1 | fixed | §2 | Same defect and same fix as R2-A3 — the `CLAUDE_PROJECT_DIR`-first resolution order closes both framings of the gap at once. |
| R2-C2 | fixed | §5 | Output contract is now pinned to `no-punt-guard.js`'s exact, deployed, cited convention rather than an independently-reverified reading of platform docs. |
| R2-C3 | fixed | §2 | Three-level fallback (`CLAUDE_PROJECT_DIR` → stdin `cwd` → `process.cwd()`) means a missing stdin `cwd` no longer leaves the guard without a target directory. |

## 12. Author smoke-run finding

During implementation, a real smoke run of the finished hook against a
live repo (`CLAUDE_PROJECT_DIR` pointed at this guard's own linked
development worktree) produced a **false positive**: the hook blocked,
flagging the guard's own in-progress feature branch as stale via
`evidence: upstream-tip-ancestor`.

- **Cause:** the branch had been created via `git worktree add -b <name>
  origin/main` — its upstream was set directly to the BASE's own
  remote-tracking ref, with no commits of its own yet. §3 Branches row 6
  (as originally written) checked whether the upstream ref's tip
  satisfies the ancestor/tree-equality/cherry detectors against base with
  no guard against the upstream tip being IDENTICAL to base's own tip.
  Since `git merge-base --is-ancestor X X` always exits 0 (a commit is
  trivially an ancestor of itself), every such freshly-created,
  not-yet-diverged branch tracking base's own remote ref misclassified as
  stale on its very first `Stop` invocation.
- **Fix:** row 6 (§3 Branches) now requires the upstream ref's tip to be
  **unequal** to base's tip before running any of the three detectors
  against it — the same trivial-self-match exclusion rows 3–5 already
  apply to the LOCAL tip. A branch in this state now correctly falls
  through to row 8 (`ok`). See §3's row 6/row 8 text above (both updated
  to reflect this) and the code's own comment at the guard clause
  immediately before row 6's detector calls.
- **Regression test:** `branch_upstream_equals_base_tip_empty_local_not_stale`
  (§7) — a fresh branch whose upstream is set directly to `origin/main`,
  no divergence yet, must allow.

This finding and fix predate the PR's initial submission; this section
exists so the spec's own record matches what the shipped code does,
rather than describing only the pre-fix row 6 behavior.

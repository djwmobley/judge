# judge — `stop-stale-worktrees-guard.js`

**Audience:** a fresh Claude Code session in this repo, authoring from this
spec. Follows the numbering/conventions of
`docs/specs/pr2-agent-model-routing-guard.md`. Read `hooks/no-punt-guard.js`
first — the only other `Stop`-event guard here, and the direct template for
this guard's stdin-parse / stdout-decision shape (its 3-strike loop pattern
is explicitly NOT followed here — see §4).

*Revised after adversary round 1 (`.git/tmp/pr3-adversary-r1.md`, 17
findings — see §10), adversary round 2 (`.git/tmp/pr3-adversary-r2.md`,
12 findings — see §11), and adversary round 3 on §13's remote-tracking
classification (`.tmp-adv-findings-r3.md`, 7 findings — see §14).*

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
(`git remote set-head origin -a`, or create a local `main`). This
resolution also determines, for §13, which single remote-tracking ref (if
any) is excluded as "the ref the base branch tracks": the literal
`refs/remotes/origin/HEAD` target when that path resolved base, or the
local base branch's own configured `%(upstream)` ref when base instead
resolved to local `main`/`master`.

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

Remote-tracking refs (§13) are subject to this identical deadline
mechanism, on equal footing with worktrees and local branches — classified
in the same loop, against the same shared budget, never a separate
allotment. A deadline-expiry `reason` enumerates remote-tracking refs
exactly as it does branches (classified-so-far with class, not-yet-reached
by name), and its timeout text states the remote-ref count explicitly
(e.g., "23 of 51 remote-tracking refs classified before the deadline").

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

The same batching principle extends to §13: one additional `git
for-each-ref refs/remotes` call retrieves every remote-tracking ref's
metadata in one shot (mirroring the `refs/heads` call above); `base.treeSet`
(from the single `rev-list`/`log` call already made for local branches) is
reused as-is, never recomputed per remote or per ref. Only `merge-base
--is-ancestor` and, when needed, `git cherry` remain per-ref, exactly as
for local branches.

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
| ok | primary record, on a branch, AND that branch is not active-via-worktree (below) | — |
| stale | `prunable` line, or the worktree dir no longer exists, or `git worktree prune --dry-run` lists it | `git worktree remove <path>`; `git worktree prune` |
| unknown → block | linked, detached HEAD (no `branch` line) | none offered — inspect manually |
| ok (active) → **allow, never blocks** | primary OR linked (round-4 finding R4-04, §16), checked-out branch would otherwise classify stale per §3 Branches, BUT the worktree is active (§15/§16): dirty (`git status --porcelain` non-empty), OR its branch has ≥1 commit genuinely unintegrated into base (round-4 finding R4-03: the same ancestor/tree-equality/cherry detectors §3 Branches uses, not a bare `rev-list --count`), OR its `logs/HEAD` reflog / `COMMIT_EDITMSG` activity is within the quiet window (default 30 min, `JUDGE_STOP_GUARD_QUIET_MINUTES`, `0` disables this one signal; round-4 finding R4-02 dropped `HEAD`/`index` mtimes from this signal — see §16) | no block; `systemMessage` line: "active worktree on merged branch `<name>`; clean up when done" |
| stale | linked, branch classifies stale per branch table, AND none of the active signals above fire (clean, no commits ahead of base, and quiet) | if `locked` is present (or absent-field-as-false plus a `prune --dry-run` hit indicates a lock), fix leads with `git worktree unlock <path>`; then `git worktree remove <path>`, then the branch's own delete fix |
| ok | linked, not prunable, dir exists, branch is base, empty-local, or active | — |

The in-progress-operation check applies to the primary worktree only, per
scope decision — a linked worktree mid-rebase is not given the same
treatment and still falls to the ordinary linked-detached-HEAD row; see §8.
**The active-worktree determination itself (round-4 finding R4-01, §16)
happens BEFORE branch classification, not inside this table** — it
overrides a branch's own class to `active` up front (§3 Branches) so an
active worktree's branch never reaches the ancestor/tree/cherry/gone rows
at all and can never be independently re-reported via the branch table;
this table's own rows above merely surface the resulting informational
message. A branch with no worktree at all still classifies purely by §3
Branches, unaffected.

`locked`/`prunable` fields are absent on older git porcelain output; treat
an absent field as `false`, and additionally run
`git worktree prune --dry-run` as a cross-check for `prunable` on every
worktree regardless of whether the field was present.

**Uncommitted changes never change a worktree's class — except as of the
round-3 live finding (§15), where a dirty working tree is itself one of
three signals that makes a LINKED worktree on an otherwise-stale branch
classify `active` instead.** For every other case (a `prunable`/missing-
directory worktree, a detached-HEAD worktree, or a clean quiet worktree
whose branch classifies stale), this sentence still holds as originally
written: the fix text always says to run `git -C <path> status
--porcelain` and inspect first; never defaults to `--force`.

### Branches (`git for-each-ref refs/heads`, incl. `%(upstream:track)`)

**Active-worktree override, evaluated first (round-4 finding R4-01, §16).**
Before rows 1–9 below ever run for a given branch, an earlier pass (§3
Worktrees' active-worktree carve-out, §15/§16) has already determined,
for every worktree with a checked-out branch, whether that worktree is
active. If it is, that branch's classification is overridden to `active`
directly — it never reaches rows 2–6 at all, regardless of what its
content would otherwise indicate. This exists specifically because
gating the carve-out only inside the worktree table (the naive reading of
"a worktree is active") leaves the branch itself independently
re-evaluated and re-reported via this table's own `branchFindings`
consumer, reproducing the exact incident the carve-out was built to fix.

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

### Remote-tracking branches (`git for-each-ref refs/remotes`)

One batched `git for-each-ref --format=<name>|<objectname>|<tree>
refs/remotes` call (§3 Batching) enumerates every ref under
`refs/remotes/<remote>/*` across every configured remote in a single shot —
total classification, no allow-list: every such ref maps to exactly one row
below, in order, first match wins. All matching in this section — the
`/HEAD` exclusion, the base's-own-ref exclusion, and grouping by tracking
relationship (§13) — operates on **whole ref-path strings** (exact
`refname` equality, or a suffix match on the literal string `/HEAD`);
never by decomposing a ref into a remote-name segment and a branch-name
segment, which would break for a remote name containing `/` (e.g. `git
remote add team/fork <url>`) or non-ASCII characters (e.g. `réseau`) —
both real, achievable git states (round-3 finding R3-07).

**The base's own remote** (used by exclusion item 2 below and by the
stale-remote / stale-remote-foreign split): the remote-name segment of
`refs/remotes/<remote>/HEAD`'s target when that path resolved base (Base
branch, above), or the remote-name segment of the local base branch's own
configured `%(upstream)` ref when base instead resolved to local
`main`/`master` with an upstream configured. **If the local base branch
has no configured upstream at all, there is no base remote** — every
remote-tracking ref in the repo, on every remote, then classifies at best
`stale-remote-foreign` (informational only, never blocking); this is
intentional, not a degraded mode — the "operator has no standing to
delete it" rationale behind `stale-remote-foreign` (below) applies equally
to every remote when none is distinguished as canonical.

**Exclusions (structural, never by name pattern):**

1. Any ref whose `refname` ends in the literal string `/HEAD`, for every
   remote — a **name-suffix match**, checked regardless of whether that
   ref is currently a symbolic ref or a detached (`git update-ref
   --no-deref`) ordinary ref pointing directly at a commit (round-3 finding
   R3-01). `git symbolic-ref`-based detection is deliberately not used
   here: a detached `refs/remotes/origin/HEAD` is a real, reachable state
   (verified empirically in R3-01) that would otherwise fall through to
   full classification and, after a stale/divergent commit, could emit a
   nonsensical `git push origin --delete HEAD` fix line for a branch that
   doesn't exist.
2. The ref that IS the base's own remote's `HEAD`-target or configured
   upstream (defined above). No ref is excluded by this item if there is
   no base remote — item 3 below still protects that case.
3. **Mandatory tip-equality guard, additional to item 2, never a substitute
   for it:** any candidate ref whose tip equals `base.tip` is excluded
   outright, before any content detector runs, regardless of whether item 2
   already named it by ref path. This closes, for remote refs, the exact
   bug recorded in §12 — `merge-base --is-ancestor X X` and the
   tree/cherry detectors all trivially succeed against a ref that IS the
   base's own tip, and name-based exclusion alone is one misconfigured or
   fork-shaped remote away from missing that case. The check is one string
   comparison against an already-resolved value, not an extra git call.

**Enumeration failure fallback (round-3 finding R3-02).** The batched
`for-each-ref refs/remotes` call above requires an object lookup per ref
(to resolve `%(tree)`) and fails **atomically** — zero rows for the entire
namespace, not per-ref — when any one ref in `refs/remotes/*` points at a
missing or unreadable object (verified empirically: a single
`refs/remotes/origin/ghost` written directly at a nonexistent sha blacks
out classification of every other, healthy remote ref alongside it). When
this batched call fails, fall back to: (a) a REDUCED `git for-each-ref`
call requesting only `%(refname)`/`%(objectname)` (never `%(tree)`) to
enumerate every `refs/remotes/*` ref by name and stored SHA without
dereferencing any object; then (b) for each enumerated ref, `git
rev-parse --verify -q <ref>^{commit}` to confirm the commit object
resolves, then `git rev-parse --verify -q <ref>^{tree}` to confirm the
tree resolves and obtain it. A ref that fails (a) or (b) classifies
**unknown → block** individually, per row 5 below; every sibling ref that
passes classifies normally — restoring row 5's per-ref isolation promise
even though the fast batched path can't itself deliver it.

**Corrected during implementation, not as originally specified:** this
fallback was first specified (and orchestrator-decided) as `git show-ref`
for step (a), on the assumption that a plain ref listing never
dereferences an object. Verified empirically against git
2.52.0.windows.1: `git show-ref` **also** fails atomically on the exact
same fixture — `fatal: git show-ref: bad ref refs/remotes/origin/ghost
(<sha>)`, with zero output for every ref in the repo, not just the bad
one — this git version validates every ref's target even for a bare
listing command. The reduced `for-each-ref` call above (refname +
objectname only, no tree atom) was verified against the identical
fixture to succeed, returning the bad ref's raw stored SHA without
attempting to open it — `%(objectname)` is the value stored directly IN
the ref, never requiring the target object to be opened, whereas
`%(tree)` requires loading and parsing the full commit. This is the
actual mechanism this fallback needs, and is used in the shipped
implementation instead of `show-ref`.

This fallback is deliberately scoped to `refs/remotes` only;
`refs/heads` (local branches) has the identical atomic-failure exposure
and is not given the same fallback in this revision — see §8.

| Order | Class | Evidence | Result |
|---|---|---|---|
| — | (excluded) | ref name ends in `/HEAD` (any remote, symref or detached), the base's own tracked/upstream ref, or tip == `base.tip` | not classified, not listed |
| 1 | stale-remote | ref is on the base's own remote AND its tip is an ancestor of `base.tip` (`merge-base --is-ancestor`), tip != `base.tip` | fix sequence, §13; **blocks** |
| 2 | stale-remote | ref is on the base's own remote AND its tip's tree ∈ `base.treeSet` (reused from the Branches table above, not recomputed) | fix sequence, §13; **blocks** |
| 3 | stale-remote | ref is on the base's own remote AND `git cherry <base.tip> <ref-tip>` reports every commit already applied, ≥1 commit | fix sequence, §13; **blocks** |
| 4 | stale-remote-foreign | ref is on any remote OTHER than the base's own remote (or there is no base remote) AND satisfies rows 1–3's detector logic against `base.tip`/`base.treeSet` | **allows**, `systemMessage` names it (§13) — no fix offered: the operator has no standing to delete a branch on a remote that isn't the base's own (round-3 finding R3-03) |
| 5 | unknown → block | any git call for this ref fails or times out, including a ref whose object is missing (including via the fallback path above) | none offered — inspect manually |
| 6 | active-remote → ok | none of the above | — (someone else's unmerged work is never flagged) |

Same three detectors, same order, as this section's Branches rows 3–5 —
deliberately reused rather than reinvented (both for the base-remote and
foreign-remote branches of row 1–4), so a reviewer who already understands
that table reads this one for free. Grouping with a tracking local branch,
the exact fix-command sequence, the `stale-remote-foreign` reporting
mechanics, the no-network consequence, and three-way grouping with a
linked worktree are specified in full in §13.

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

Remote-tracking-ref findings (§13) share this exact list, cap, and format —
a `stale-remote` item grouped with a tracking local branch (§13) counts as
one item toward the 40-item cap, not two (and a three-way worktree grouping,
§13 round-3 revision, counts as one item as well), matching what the agent
actually needs to act on. `stale-remote-foreign` items (§13, round-3
revision) never appear in a block `reason` at all — they carry no fix, so
they are reported only via the allow-side `systemMessage` channel below,
and only when the overall result is otherwise a clean allow (§13). §13
introduces no new stdin fields and no new output shape beyond folding
`stale-remote-foreign` lines into the existing `systemMessage` channel; it
is scoped, invoked, and reported through the identical `-C <targetDir>` /
batched-call / `reason`-string machinery already specified above.

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
- **Primary prevention vs. backstop:** this repo has GitHub's
  `delete_branch_on_merge` repository setting enabled, which auto-deletes a
  PR's remote branch on merge in the overwhelming common case. §13's
  remote-tracking-ref classification is the backstop for what that setting
  doesn't catch — an unmerged/abandoned branch pushed but never PR'd, a
  merge performed outside GitHub's UI, or a repo/org where the setting is
  later turned off — not the primary mechanism, and this guard never
  assumes the setting is on.

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
| `dirty_linked_worktree_on_stale_branch_is_active_not_stale` | dirty linked worktree, branch otherwise stale (§15) | allow, `systemMessage` names it active — never block (supersedes the pre-round-3 `uncommitted_changes_do_not_change_class` expectation) |
| `worktree_active_dirty_on_merged_branch_allows_with_message` | linked worktree, branch merged into base (ancestor), worktree has uncommitted changes | allow, `systemMessage`: "active worktree on merged branch ... clean up when done" |
| `worktree_active_clean_recent_on_behind_branch_allows` | linked worktree, branch behind/merged, clean, admin files freshly touched (within default 30-minute quiet window) | allow (recency signal) |
| `worktree_active_clean_quiet_on_merged_branch_blocks` | linked worktree, branch merged, clean, admin files backdated past the quiet window, zero commits ahead of base | block, stale, combined fix (all three active signals absent) |
| `worktree_quiet_window_zero_disables_recency_signal_blocks` | same fixture as the clean-recent case above, but `JUDGE_STOP_GUARD_QUIET_MINUTES=0` | block — the recency signal is disabled, and (a)/(b) don't independently fire |
| `worktree_active_own_commit_ahead_of_base_allows` | linked worktree, branch has a genuinely unintegrated commit not in base | allow, no output — round-4 finding R4-03 makes this content-aware, so the branch table's own row 9 (`active`) already covers it directly; no override/message needed (unlike the dirty and recency signals, which DO need the override since they fire on branches the branch table would otherwise call `stale`) |
| `deadline_exceeded_blocks_with_partial_classification` | classification forced past 20s (e.g. injected delay) | block, timeout-named reason, lists classified vs. not-yet-classified |
| `batched_git_calls_used_not_per_branch` | repo with several branches | exactly one `for-each-ref` and one `rev-list` invocation observed, not one per branch |
| `remote_stale_no_local_branch_blocks` | remote-tracking ref on the base's own remote, merged into base, no local branch tracks it | block, fix sequence verbatim (`fetch --prune`, verify, `push --delete`), no `-dr`/local-delete lines needed unless push is refused |
| `remote_stale_with_tracking_local_branch_grouped` | remote-tracking ref on the base's own remote is stale AND a local branch tracks it (also stale) | single grouped `reason` item, full fix sequence, local delete included |
| `remote_stale_tracking_local_branch_active_note_only` | base-remote stale-remote ref tracked by a local branch that is itself `active` | single grouped item, remote-side fix sequence only, note that the local branch is active/untouched, no local-delete line |
| `remote_active_unmerged_allows` | remote-tracking ref with unmerged, non-stale content | active-remote, allow |
| `remote_head_symref_excluded_by_name` | `origin/HEAD` present as a normal symref among remote refs | never classified or listed as its own item |
| `remote_head_detached_excluded_by_name` | `git update-ref --no-deref refs/remotes/origin/HEAD <divergent-sha>` — a detached, non-symbolic `origin/HEAD` whose tip would otherwise match a stale signature | still excluded by the `/HEAD` name-suffix match (round-3 R3-01); never listed, no `push --delete HEAD` fix line emitted |
| `remote_base_own_tracked_ref_ignored` | the ref base resolved via (e.g. `origin/main`) | excluded by name, never listed |
| `remote_no_base_remote_all_foreign_allows` | base resolves to local `main` with no configured upstream; a remote ref elsewhere is merged into base | no base remote determinable; that ref classifies `stale-remote-foreign`, not `stale-remote` — allow with `systemMessage`, never block |
| `remote_foreign_remote_merged_ref_allows_with_message` | second remote (`upstream`), not the base's own remote, has a ref merged into base | classified `stale-remote-foreign`; overall result allows, `systemMessage` names the ref and remote, no fix text offered |
| `remote_foreign_message_suppressed_when_blocking_findings_exist` | a foreign-remote merged ref coexists with an unrelated blocking finding (e.g. a stale local branch) | block `reason` lists only the blocking item(s); the foreign-remote note is omitted from this invocation's output entirely |
| `remote_base_remote_push_delete_refused_falls_back_to_branch_dr` | base-remote `stale-remote` finding, `push --delete` step simulated as refused | fix sequence's step 4 offers `git branch -dr <remote>/<branch>` with the recurrence-after-next-fetch note |
| `remote_fix_sequence_reverify_step_present` | base-remote `stale-remote` finding | fix sequence includes the `rev-parse --verify` re-check line between `fetch --prune` and `push --delete` |
| `remote_ref_missing_object_unknown_blocks` | a single remote-tracking ref's object corrupted/missing | unknown, block |
| `remote_forremote_atomic_failure_falls_back_to_show_ref` | `refs/remotes/origin/ghost` points at a nonexistent object alongside otherwise-healthy sibling remote refs, forcing the batched `for-each-ref refs/remotes` call to fail atomically | reduced-format `for-each-ref` + per-ref `rev-parse --verify` fallback invoked (not `show-ref` — see §3's implementation-time correction); `ghost` classifies unknown individually; every healthy sibling ref classifies normally, not blacked out |
| `remote_tip_equals_base_not_flagged` | a remote ref (any remote) whose tip equals `base.tip`, not excluded by name (e.g. base resolved to local `main`, ref has no configured upstream link to it) | tip-equality guard fires; not classified stale-remote |
| `remote_refs_counted_in_deadline_reason` | deadline forced to expire mid remote-ref classification | reason lists remote-ref count reached/not-reached, same shape as branches |
| `remote_worktree_branch_remote_three_way_grouped` | linked worktree checked out on a branch that is stale AND tracks a base-remote `stale-remote` ref | single combined worktree `reason` item carrying worktree-remove, branch-delete, and the remote fix sequence; no standalone branch or branch+remote item emitted for the same branch |
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
  trying to defeat. §13 reuses these identical three detectors against
  remote-tracking-ref tips (round-3 finding R3-06), so this exact gap
  applies equally to `stale-remote`/`stale-remote-foreign` detection: one
  trivial commit added on top of already-merged content after a branch was
  pushed reads that remote ref as `active-remote`, not stale.
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
  never runs `git fetch`. §13's `stale-remote` classification inherits this
  identically — a branch already deleted on the server but not yet locally
  pruned still shows `stale-remote` until someone runs `git fetch --prune
  <remote>` (the fix sequence's own first step, §13), and there is no
  guarantee any given Stop invocation happens after a recent fetch.
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
  not closed. §13 inherits this identically, in a round-3-revised shape:
  the same misidentified-base risk now determines the `stale-remote` /
  `stale-remote-foreign` split — a genuinely-foreign branch on a
  misidentified "base remote" could be confidently offered a delete-and-
  push fix, while the team's real integration remote's own stale branches
  are demoted to informational-only `stale-remote-foreign` notes. Still no
  git-native way to verify the choice; still accepted, not closed.
- **Grouped stale-remote/local-branch item when the local branch is
  `active`, not `stale`.** §13's grouping is written to always append the
  local branch's own delete command when one applies; when the tracking
  local branch classifies `active` there is no such command to append, and
  the exact wording for that case is not yet operator-confirmed — see §9
  open question 2.
- **Atomic-failure fallback is asymmetric (round-3 finding R3-02).** Only
  `refs/remotes` got a reduced-format-`for-each-ref`-plus-per-ref-verify
  fallback (§3; corrected during implementation from the originally
  specified `git show-ref`, which was verified to fail atomically too) for
  the "one bad object blacks out the whole batched call" failure mode;
  `git for-each-ref refs/heads` (local branches) has the identical
  exposure — one corrupted local branch ref can still collapse ALL
  local-branch classification into a single generic `branch-list-failed`
  block with no per-item detail — and was not given the same fallback in
  this revision. Accepted, not closed; scoped this way per the round-3
  orchestrator decision, which addressed remotes only.
- **Fallback enumeration has no cross-invocation cache.** If
  `for-each-ref refs/remotes` keeps failing on every Stop call (e.g. a
  permanently corrupted ref nobody has cleaned up), every invocation pays
  the full per-ref reduced-enumeration + `rev-parse --verify` (×2) cost
  instead of the one batched call — the same architectural tension as R2-B4
  (§4's no-persisted-state design has no way to remember "the fast path
  is broken, skip straight to the fallback"). Accepted, not closed.
- **`git branch -dr` is a local-only workaround, not a real fix (round-3
  finding R3-03).** The fix sequence's step 4 fallback clears this
  checkout's own blocking finding by deleting the local cached
  remote-tracking ref, but does nothing server-side. If the operator never
  gains push rights on that remote, the identical finding reappears every
  time this checkout later fetches from it and the tracking ref is
  re-created — an operator without push rights can silence the guard
  locally forever, on a loop, without the actual remote branch ever being
  deleted. This is the accepted trade-off for closing R3-03's "permanent
  block with zero escape" failure mode; the server-side staleness itself
  remains a real, un-remediated gap outside this guard's reach.
- **Active-linked-worktree carve-out (§15) makes almost any squash/rebase-
  merged worktree read as active indefinitely.** Condition (b) ("≥1 commit
  not in base") fires for practically every squash/rebase-merged branch,
  since its original pre-squash commits routinely remain on the branch
  even after the content is fully integrated via a different commit on
  base. Accepted exactly as specified by the §15 operator directive; see
  §15 for the full disclosure, including condition (a)'s narrower
  equivalent (a stray untracked file keeping a dead worktree "active"
  forever).
- **Detached-HEAD worktree at a remote-tracking ref's commit.** A linked
  worktree checked out in detached mode directly at a commit that also
  happens to be a `stale-remote` ref's tip is not cross-referenced against
  §13's classification — it is evaluated purely by this section's
  Worktrees detached-HEAD row (`unknown → block`, no fix offered), and the
  remote ref is separately reported as `stale-remote` with no link drawn
  between the two, unlike the local-branch grouping case. Accepted, not
  closed — the same class of gap as the existing 'concurrently-open
  worktree' and 'in-progress-operation is primary-only' entries above.
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

*(No unresolved forks remained after round 2 for the original scope; §13
below introduces one new, genuinely unresolved fork — item 2.)*

2. **Grouping when the tracking local branch is not itself stale.** §13's
   grouping rule (a `stale-remote` ref is listed even when a local branch
   tracks it, but grouped under one item) is written for the common case
   where the local branch is also stale. It's genuinely unresolved whether
   grouping should still apply, unchanged, when the local branch classifies
   `active` (e.g. it has unpushed commits ahead, but its own upstream ref's
   cached tip independently satisfies a stale-remote detector) — there is
   no local-branch delete step to append in that case. **Recommended
   lean:** group unconditionally by tracking relationship (the tracking
   relationship, not co-staleness, is what makes two items "the same fix
   target" for the agent reading `reason`), but only emit the local
   branch's own delete command as an appended fix line when the local
   branch's own class is `stale`; when it's `active`, the grouped item
   shows only the remote-side fix sequence plus a short note that the
   local branch itself is still active and untouched. §3 and §13 are
   written to this lean already; flagged here as pending operator
   confirmation rather than treated as fully closed, since — unlike item
   1's `-d`/`-D` fork — it has not been through an adversary round.

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

## 13. Remote-tracking branch classification

**Operator directive driving this section:** no stale branches are to be
left anywhere in the repo, remote included — closing the gap in §1–§12
where only local branches and worktrees were evaluated and a merged or
rebase-merged feature branch could be deleted locally while its remote
copy (kept alive by a reviewer's fork, a slow CI mirror, or simply
`delete_branch_on_merge` not having run yet — see §6) sat unflagged
forever.

**Scope.** Every ref under `refs/remotes/<remote>/*`, across every
configured remote, is now a first-class classification target alongside
worktrees and local branches (§3). The mechanics — eligible refs, the two
structural exclusions, the mandatory tip-equality guard, the three-detector
table, and the resulting `stale-remote` / `unknown` / `active-remote`
classes — are specified in §3's "Remote-tracking branches" subsection;
this section covers everything that subsection defers: grouping, fix text,
the consequence of never fetching, and the multi-remote caveat.

**Grouping with a tracking local branch.** A `stale-remote` ref (base
remote only — `stale-remote-foreign` is never grouped, since it never has
a fix to group toward) is listed even when a local branch tracks it —
deleting only the local branch leaves the remote copy behind — but the two
are grouped under one `reason` item, identified by the tracking
relationship (`%(upstream)` on the local branch matching the remote ref,
from the already-batched `refs/heads` call), so the agent reads one fix
sequence instead of two unrelated-looking findings for what is really one
piece of stale work. Grouping is keyed on the tracking relationship
itself, not on the local branch also being stale — per §9 open question
2's recommended lean, a grouped item whose tracking local branch classifies
`active` (not `stale`) shows only the remote-side fix sequence below plus
a short note that the local branch itself is active and untouched; the
local branch's own delete command is appended only when that branch's own
class is `stale`. This lean is applied throughout this section but is not
yet operator-confirmed (§9).

**Three-way grouping — linked worktree + its checked-out branch + that
branch's stale-remote tracking ref (round-3 finding R3-05).** §3
Worktrees' `coveredBranches` mechanism already absorbs a linked worktree's
stale checked-out branch into the worktree's own single combined `reason`
item (suppressing that branch's standalone entry). This absorption now
extends one level further: when the absorbed branch is ALSO the tracking
local branch of a `stale-remote` (base-remote) finding, that remote's fix
sequence is appended as the combined worktree item's final leg (after the
worktree-remove and branch-delete lines), and the standalone
branch+remote grouped item (above) is suppressed entirely for that branch
— never emitted a second time. This avoids the exact duplicate-delete-
command outcome R3-05 flagged: one worktree, one `reason` item, one
ordered fix sequence, regardless of how many of the three layers (worktree,
branch, remote) are stale simultaneously.

**Fix sequence, verbatim, in this order, in the (possibly grouped) item's
`reason` text — base remote only:**

1. `git fetch --prune <remote>` — the ref may already be gone on the
   server; classification is cache-only (below), so this is always listed
   first, regardless of local-branch presence or class.
2. **Re-verify before proceeding (round-3 finding R3-04):** `git
   rev-parse --verify -q refs/remotes/<remote>/<branch>` — if step 1's
   fetch already pruned the ref locally (someone deleted it server-side
   first), this no longer resolves and the finding is already gone; skip
   step 3 entirely rather than running it against a target step 1 just
   proved absent. Only proceed to step 3 if this still resolves.
3. `git push <remote> --delete <branch>` — labeled in `reason` as
   **"externally visible: deletes the branch on the remote"**.
4. **Fallback when step 3 is refused (round-3 finding R3-03):** `git
   branch -dr <remote>/<branch>` — deletes only the LOCAL cached copy of
   the remote-tracking ref, always executable by the agent regardless of
   push rights on `<remote>`. Labeled in `reason` with an explicit
   recurrence note: this does not delete the server-side branch, so the
   exact same finding reappears the next time this checkout fetches from
   `<remote>` and re-populates the tracking ref — it is a workaround for
   "permanently blocked, no push rights" (R3-03's original failure mode),
   not a substitute for the actual remote delete.
5. The tracking local branch's own delete command (its own
   evidence-appropriate `-d`/`-D`, per §3 Branches' row selection) —
   appended only when a local branch tracks this ref AND that branch's own
   class is `stale` (§9 open question 2's lean); omitted entirely for a
   `stale-remote` ref with no tracking local branch, and also omitted
   (replaced by the active-branch note above) when the tracking local
   branch is itself `active`.

The guard never runs any of these lines — §1's "never executes a
git-mutating command" applies identically here; `git fetch --prune` and
step 2's `rev-parse --verify` are read-only/read-remote in spirit but are
still never invoked by the guard itself, only ever printed as fix text, to
keep exactly one rule ("this hook's own process runs zero git-mutating or
git-network calls") rather than a carved-out exception for any one
command.

**Foreign-remote findings: allow with `systemMessage`, never block (round-3
finding R3-03).** A `stale-remote-foreign` item never contributes to a
block — the operator has no standing to delete a branch on a remote that
isn't the base's own, so there is no fix to offer and no reason to hold
the session open over it. Every `stale-remote-foreign` item found in a
given invocation is instead collected into the same informational
`systemMessage` channel already used for the primary worktree's
in-progress-operation note (§3 Worktrees), one line per foreign finding
naming the ref, its remote, and the evidence. This `systemMessage` is only
emitted when the OVERALL result for that invocation is otherwise a clean
allow (no blocking worktree, branch, or base-remote `stale-remote` item
exists) — if any blocking item coexists, the foreign-remote note is
silently omitted from that invocation's output (a block `reason` never
carries an item with no actionable fix) and simply resurfaces on a later
Stop invocation once every blocking item has been resolved and
reclassification runs again (§4, no cached state carries forward).

**No network — cache-only classification, and its consequence.**
Classification never fetches; `refs/remotes/*` reflects whatever was last
fetched into this checkout, by anyone, at any prior time. Consequence,
stated explicitly rather than left implicit: a branch already deleted on
the server but not yet locally pruned still shows `stale-remote` here.
This is not a false positive to be suppressed — the fix sequence above
handles it correctly either way, since step 1 (`fetch --prune`) is listed
unconditionally and first; if the ref is already gone server-side, that
one command clears it, step 2's re-verify confirms it, and the next Stop
invocation (§4, no cached state across invocations) simply no longer
lists it.

**Base-remote determination and the fork-workflow caveat.** "The base's
own remote" (§3, defined there) governs the entire stale-remote /
stale-remote-foreign split; §8's existing fork-workflow entries (B3,
R2-B3) already document that this guard has no git-native way to verify
which remote is the team's real integration target when `origin` is a
contributor's own fork. Round-3's `stale-remote-foreign` class changes
this caveat's shape rather than removing it: a misidentified base remote
now means a genuinely-foreign branch could be confidently offered a
delete-and-push fix (treated as "base remote" when it shouldn't be), while
the team's real integration remote's own stale branches are demoted to
informational-only `stale-remote-foreign` notes. Still accepted, not
closed — see §8.

**Deadline and batching.** Both are shared, not additive — see §3
Deadline's and Batching's updated text above. Remote-tracking refs add
exactly one new batched git call (`for-each-ref refs/remotes`) to the fixed
set already paid once per invocation, with the §3 fallback enumeration
(round-3 finding R3-02) only incurred when that batched call itself fails;
the only calls that still scale with remote-ref count are the same
per-ref `merge-base --is-ancestor` / `git cherry` calls already priced in
for local branches, now doubled in population by however many remote refs
survive the exclusions in §3.

**`GUARDS` array / install-guards.js:** no new entry — this extends the
existing `stop-stale-worktrees-guard` hook's own classification pass
in-place; §6 is otherwise unchanged, aside from its new
`delete_branch_on_merge` note.

## 14. Adversary round 3 change log

| Finding | Resolution | Spec section | Rationale |
|---|---|---|---|
| R3-01 | fixed | §3 Remote-tracking branches | `/HEAD` exclusion is now a structural name-suffix match (`refname` ends in the literal string `/HEAD`), never symref detection — a detached (non-symbolic) `origin/HEAD` is excluded identically to a normal symref, closing the path to a nonsensical `git push origin --delete HEAD` fix line. |
| R3-02 | fixed | §3 Remote-tracking branches, §8 | An atomically-failing `for-each-ref refs/remotes` now falls back to a reduced-format `for-each-ref` enumeration (refname+objectname only, no `%(tree)`, hence no object dereference) plus per-ref `rev-parse --verify`, restoring row 5's per-ref isolation promise. **Corrected during implementation:** the originally specified `git show-ref` was verified (git 2.52.0.windows.1) to fail atomically on the same fixture, contradicting the "no object lookup" assumption behind choosing it. The identical atomic-failure exposure for `refs/heads` (local branches) is left unfixed and newly documented in §8 as an accepted, scope-limited asymmetry. |
| R3-03 | fixed | §3 Remote-tracking branches, §13, §8 | New `stale-remote-foreign` class: merged refs on any remote other than the base's own remote (or when no base remote is determinable) allow with an informational `systemMessage`, never block, since the operator has no standing to delete them. For the base's own remote, the fix sequence gains a `git branch -dr` local-tracking-ref-delete fallback for when `push --delete` is refused — removing the permanent-block failure mode R3-03 identified, at the documented cost (§8) of a local-only workaround that doesn't touch the server. |
| R3-04 | fixed | §13 Fix sequence | A `git rev-parse --verify` re-check step is now specified between `fetch --prune` and `push --delete` — an agent that already pruned a gone ref via step 1 no longer blindly runs step 3 against a target its own re-check just proved absent. |
| R3-05 | fixed | §13, §3 Worktrees | Three-way grouping (linked worktree + its stale checked-out branch + that branch's stale-remote tracking ref) now extends the existing `coveredBranches` absorption mechanism one level further: the remote's fix lines become the combined worktree item's final leg, and the standalone branch+remote grouped item is suppressed for that branch, eliminating the duplicated-delete-command outcome R3-05 flagged. |
| R3-06 | fixed | §8 (rebase/squash-edge-case entry) | One sentence added stating the "one extra trivial commit defeats content-equivalence detectors" gap applies identically to `stale-remote`/`stale-remote-foreign` detection, since §13 reuses the exact same three detectors against remote-ref tips. |
| R3-07 | fixed | §3 Remote-tracking branches | One sentence added stating all matching in this section operates on whole ref-path strings, never a remote-name/branch-name split — closing the documentation gap that could otherwise mislead an implementer into writing a slash-splitting parser that breaks on a multi-segment or non-ASCII remote name. |

## 15. Live finding 2026-09-07

*Revised the same day by adversary round 4 (8 findings against this
section specifically — see §16 for the full change log). §16 is the
authoritative statement of the shipped behavior; this section is kept as
the historical record of the operator directive that started it, with the
factual corrections noted inline where round 4 changed the mechanism.*

**Trigger:** during this PR's own development, the installed
`stop-stale-worktrees-guard` blocked the orchestrator's turn end by
classifying this PR's own linked worktree (branch
`feat/stop-guard-remote-branches`) as stale, evidence `branch-ancestor`.
Cause: the branch was cut from `origin/main` with no commits of its own
while `origin/main` advanced (a separate PR merged in the meantime),
making the branch's tip a strict ancestor of base — §3 Branches row 3
fired correctly by its own logic, but the worktree held active,
uncommitted work the guard had no way to see. A narrower
"behind-base-dirty" fix was proposed and considered, then superseded
before implementation by the broader operator directive below.

**Operator directive: the guard must never block on an ACTIVE linked
worktree.** §3 Worktrees now evaluates, for every LINKED worktree whose
checked-out branch would otherwise classify `stale` per §3 Branches,
whether the worktree itself is active — before applying that stale
classification — via any of:

(a) `git status --porcelain` in the worktree is non-empty (dirty);
(b) its branch has at least one commit not in base
    (`git rev-list --count <base.tip>..HEAD` > 0, run inside the
    worktree, HEAD resolving to that worktree's own checked-out tip) —
    **round-4 finding R4-03 made this content-aware; see §16**, it is no
    longer a bare ancestry count;
(c) the newest mtime among its own administrative files — `HEAD`,
    `index`, `logs/HEAD`, `COMMIT_EDITMSG` — under
    `git -C <worktree> rev-parse --absolute-git-dir` (the identical
    mechanism §3's in-progress-operation check already uses for the
    primary worktree) falls within a **quiet window**, default **30
    minutes**, overridable via `JUDGE_STOP_GUARD_QUIET_MINUTES` (a
    non-negative integer; `0` disables this recency signal entirely,
    leaving only (a) and (b) able to save the worktree) — **round-4
    finding R4-02 dropped `HEAD`/`index` from this list; see §16.**

If any of (a)–(c) holds, the worktree classifies **ok (active)** and
never blocks; every such worktree contributes one informational
`systemMessage` line: "active worktree on merged branch `<name>`; clean
up when done." Only a worktree that is clean, has zero commits of its own
ahead of base, AND is quiet on all three signals still classifies `stale`
as before, with the existing combined fix (§3 Worktrees). As originally
directed this carve-out was linked-worktree-only; **round-4 finding R4-04
extended it to the primary worktree too — see §16.**

**Supersedes, in part, §3 Worktrees' pre-existing "uncommitted changes
never change a worktree's class"** — that statement now holds for every
case EXCEPT a linked worktree whose branch is otherwise stale, where a
dirty working tree is itself one of the three signals that flips the
classification to `active`. The pre-existing regression test
`uncommitted_changes_do_not_change_class` is renamed
`dirty_linked_worktree_on_stale_branch_is_active_not_stale` (§7) and
updated to assert the new, correct behavior on that exact fixture.

**Regression/coverage tests (§7):**
`worktree_active_dirty_on_merged_branch_allows_with_message`,
`worktree_active_clean_recent_on_behind_branch_allows`,
`worktree_active_clean_quiet_on_merged_branch_blocks`,
`worktree_quiet_window_zero_disables_recency_signal_blocks`,
`worktree_active_own_commit_ahead_of_base_allows` (the exact scenario that
triggered this finding).

**Blind spot originally disclosed here, since fixed — see §16 R4-03.**
This section originally flagged condition (b) as a bare ancestry count
that would read almost any squash/rebase-merged branch as permanently
"active." An adversary pass on this section was requested by the operator
before this PR's push, per the note above; its 8 findings (§16) fixed
this specific gap (R4-03) along with two other critical defects the
literal rule-as-specified would have shipped with (R4-01, R4-02) and
extended scope to the primary worktree (R4-04). §16 is the authoritative,
current statement of this feature's behavior and its remaining accepted
blind spots (including condition (a)'s own equivalent gap — a stray
untracked file keeps a worktree "active" forever, which the operator
named as an expected/accepted limitation when directing this rule).

## 16. Adversary round 4 change log

Target: the §15 "active linked worktree" rule, before any code existed
for it (`.git/tmp/pr-active-rule-adversary-r4.md` in the main checkout, 8
findings — read-only per this repo's worktree-isolation guard; the
adversary agent built and ran its scenarios in a separate scratch copy).
R4-01, R4-02, and R4-04 were resolved by explicit orchestrator decision
before implementation; R4-03, R4-05 through R4-08 were dispositioned
during implementation, below.

| Finding | Resolution | Spec section | Rationale |
|---|---|---|---|
| R4-01 | fixed | §3 Branches, §3 Worktrees | The active determination now happens BEFORE branch classification and overrides a branch's own class to `active` directly, rather than being a worktree-table-only short-circuit. Gating only inside `classifyWorktrees` (the literal "a worktree is active" reading) left the branch independently re-reported via `branchFindings`, which has no active-awareness — reproduced empirically against unmodified `main` in the finding. The override fixes every downstream consumer (branch findings, remote grouping, worktree findings) at the source instead of patching each one separately. |
| R4-02 | fixed | §3 Worktrees, §15 | Condition (c) drops `HEAD`/`index` from its file list and reads ONLY the timestamp recorded in `logs/HEAD`'s own last reflog line, plus `COMMIT_EDITMSG`'s mtime. Index mtime was self-refreshing: `git status` (which condition (a) must run every invocation) rewrites the on-disk index whenever its stat cache is out of date, including from a cosmetic touch with no content change — an abandoned worktree merely read over by an IDE/AV/sync tool between Stop calls never went quiet. The reflog is written only by real ref-moving operations, never by `status`. |
| R4-03 | fixed | §3 Worktrees, §15 | Condition (b) now reuses the exact same three detectors the branch table itself uses (ancestor / tree-equality / cherry) instead of a bare `git rev-list --count`, which read a fully rebase/squash-merged branch (content landed, hashes rewritten) as "active" forever — the identical naive-ancestry bug the branch table's own rows 3–5 were built to avoid, reintroduced by this rule as originally specified. Net effect: condition (b), once content-aware, is logically subsumed by the branch table's own row-9 `active` outcome for genuinely unintegrated content — it only still matters as a defense-in-depth check for structural parity with (a)/(c), not as new coverage (confirmed by `worktree_active_own_commit_ahead_of_base_allows`, §7, which allows via the ordinary branch table with no override needed). |
| R4-04 | fixed | §3 Worktrees, §3 Branches | The active-worktree carve-out now applies to the PRIMARY worktree's checked-out branch too, via the same override mechanism as R4-01 (no separate code path needed). A clean, quiet primary worktree on a stale branch still blocks with `git checkout <base>` first, preserving the original incident class this guard exists to catch. |
| R4-05 | accepted | §15 | A stray untracked file (editor swap file, `node_modules/`, a lockfile) keeps `git status --porcelain` non-empty, hence the worktree "active," forever, with no decay. This is the exact example the operator's own directive named as an anticipated limitation when specifying condition (a) — matches this guard's established forgetful-agent, not adversarial-evasion, threat model (§8's R2-A2 precedent). |
| R4-06 | fixed | §3 Worktrees (condition (c)) | A future/skewed file timestamp (clock-skewed VM, extracted archive, container layer) made `now - mtime` negative, which is trivially "within" any positive quiet window unless clamped. `isWorktreeRecentlyActive` now requires a non-negative delta (`delta >= 0 && delta <= quietWindowMs`) — a future timestamp is never treated as recent. |
| R4-07 | accepted | §15 | An agent reading/planning for longer than the quiet window with zero writes, on an otherwise clean, behind/merged branch, eventually loses condition (c) and the worktree becomes stale-eligible mid-session. This is the intended terminal behavior of a quiet-window design, not a defect — a genuinely untouched, content-integrated worktree becoming stale-eligible after enough elapsed silence is the entire point of condition (c); `JUDGE_STOP_GUARD_QUIET_MINUTES` exists precisely so an operator whose workflow includes long silent/reading periods can raise or disable the window. |
| R4-08 | accepted, no change | §15 | Confirmed (did not reproduce): a `fetch` or `checkout` performed in a DIFFERENT worktree never touches this worktree's own `logs/HEAD`/`index` (both live under that worktree's own `.git/worktrees/<id>/`), so cross-worktree activity is correctly invisible to this rule. The finding explicitly recommends NOT widening the file list to shared/common refs (e.g. `.git/logs/refs/remotes/...`) to "fix" this — doing so would reintroduce a version of R4-02's self-refresh problem at repo scope. No change made; documented as a deliberate scope boundary. |

> **SUPERSEDED.** `stop-stale-worktrees-guard.js` moved from a blocking
> `Stop` hook to a non-blocking, once-per-session `SessionEnd` hook
> (`session-end-worktree-guard.js`) — owner decision, see
> `docs/specs/session-end-worktree-guard.md`. The `harness_managed`
> classification, its once-per-session reporting state, and its (never-
> enabled) self-heal proposal are all deleted; the new guard heals
> worktree-agent branches directly under its own ownership/idle rules
> (`docs/specs/session-end-worktree-guard.md` D3/D4) rather than exempting
> them from blocking. Only the `^worktree-agent-[0-9a-f]+$` branch-name
> regex this file introduced survives, repurposed for ownership rather
> than exemption. Kept here as a historical record.

# Spec: `harness_managed` branch classification for `stop-stale-worktrees-guard.js`

*Owner-approved design (D1-D3 below). Follows the conventions of
`docs/specs/stop-stale-worktrees-guard.md` (base classification, §2-§3) and
`docs/specs/stop-guard-bounded-reblock.md` (per-session state, HMAC tamper
evidence). Section 5 (self-heal) is written in full but marked pending
owner decision and is not implemented unless explicitly enabled.*

## 1. Purpose and problem

`Stop` fires at every turn end, not only at session end. The Agent tool's
worktree isolation (`isolation: "worktree"`) creates branches named
`worktree-agent-<id>`; when the spawned agent completes, the harness
removes the worktree but leaves the branch, now merged into base. The base
classification pass (`stop-stale-worktrees-guard.md` §3 Branches) correctly
identifies such a branch as `stale` — typically row 3 (`ancestor`) or row 4
(`tree-equality`) — with evidence and a `git branch -d`/`-D` fix line.

The prescribed fix cannot be carried out by the orchestrator session: its
own shell is blocked by `orchestrator-tool-guard`, and branch deletion is a
confirm-first action outside that guard's allowed surface. The bounded
re-block layer (`stop-guard-bounded-reblock.md`) therefore does exactly
what it was built to do — blocks 3 times, then yields — but the yield is a
consolation prize, not a fix: the `STALE ITEMS REMAIN` summary is reprinted
on every subsequent `Stop` for the life of the session (`stop-guard-
bounded-reblock.md` §3 step 6), and one yields.log line is appended per
item **per yield event**, which — because `applyBoundedReblock` re-enters
step 6 every time `lowStrike` is empty, not only once — means every
post-yield `Stop` on a set containing that item also re-appends a yields.log
line, not just the first. This is noise on top of noise: a condition that
will never be fixed by the agent (it lacks the tool access to fix it) is
reported over and over.

Worse, the branch this pattern flags may not be abandoned at all: a
`worktree-agent-<id>` branch classifies `stale` the moment its content is
an ancestor of base, which can happen while the spawned agent is still
alive and about to be resumed (e.g. via `SendMessage` to continue it) —
the guard has no way to distinguish "this agent finished and its worktree
was cleaned up" from "this agent is mid-task and its worktree was
transiently removed between two Stop invocations."

This spec adds a new classification (D1, §2) that recognizes harness-
managed branches and reports them informationally instead of blocking on
them, tightens the yield-reporting layer to fire exactly once per item
(D2, §4), and specifies — but does not enable — an opt-in self-heal that
prunes genuinely dead harness branches under a narrow, verifiable safety
condition (D3, §5).

## 2. Classification change

**New branch identity test.** A branch's short name (`shortBranchName`,
`hooks/stop-stale-worktrees-guard.js:338`) is tested against
`^worktree-agent-[0-9a-f]+$`. A match is classified `harness_managed`,
subject to the HEAD exemption and scope restriction below. This test is
structural — a fixed regex against the branch's own name, never a lookup
against any external harness state — consistent with this guard's existing
convention of classifying from local git state alone
(`stop-stale-worktrees-guard.md` §1).

**HEAD exemption (owner ruling R1).** The `harness_managed` override never
applies to the branch currently checked out in the primary worktree — i.e.,
current `HEAD`, whether the checkout is on a branch tip exactly or the
worktree happens to also be the one this Stop invocation is running
against. A harness-named branch that is also `HEAD` keeps whatever
classification `classifyBranch` would otherwise assign it (`ok`, `stale`,
`active`, or `unknown`) and, if `stale`, keeps its existing
`git checkout <base>`-prefixed fix line exactly as already produced for any
other primary-worktree stale branch (`hooks/stop-stale-worktrees-guard.js:
1271-1274`, `co.isPrimary` → `checkoutLine`). Rationale: a harness-managed
branch that is also the operator's current `HEAD` is, by definition, the
branch the session is actively sitting on — informational-only,
never-blocking treatment for the one stale-branch finding the operator
cannot avoid noticing (they are on it right now, and staying stopped
leaves it checked out) would suppress the single most actionable finding
this guard can produce. This is a precondition on row 0.5 below, not a
fourth classification outcome: it withholds the `harness_managed` override
so the existing rows 1-9 pipeline applies exactly as it would for a
non-harness-named branch.

**Scope of row 0.5 (owner ruling R2).** `harness_managed` recognition
applies only to a branch that would otherwise produce a *blocking*
(`stale`) item — that is, only when `classifyBranch`'s own result for that
branch is `stale` (rows 2-6). A branch that classifies `ok` (rows 1, 7, 8)
or `active` (row 9) under the existing pipeline is unchanged by this spec:
it is not reclassified `harness_managed`, it does not enter the
`harness_managed` set §3 reports on, and it is not reported by §3's
informational mechanism at all — an `ok`/`active` branch was never
blocking to begin with, so there is nothing for an informational,
non-blocking classification to add. This resolves an ambiguity that an
earlier draft of this insertion point left open (that draft read the regex
match as total regardless of `classifyBranch`'s own result, including
`empty-local`, rows 7/8, and unmerged-`active` branches, row 9); that
reading is superseded by this ruling. Concretely: a harness-managed branch
that is `empty-local` (row 7, e.g. an agent's worktree branch created but
never committed to) or genuinely `active` (row 9, unmerged content, no
worktree — the "agent still working" case discussed in §6's first blind
spot) surfaces exactly as it always has under rows 1-9, with no
`harness_managed` line, no informational report, and no behavior change
from before this spec.

**Total classification, evaluation order.** The full per-branch pipeline,
in order, each terminal — extends the existing pipeline at
`hooks/stop-stale-worktrees-guard.js:1150-1177` without altering any
existing row's own logic:

| Order | Test | Result |
|---|---|---|
| 0 (unchanged) | Active-worktree override (`stop-stale-worktrees-guard.md` §3 Branches, "Active-worktree override" / round-4 R4-01; code: the `activeInfoByBranchName` pre-pass, `hooks/stop-stale-worktrees-guard.js:1150-1163`, applied at `:1172-1174`) | `active`, `viaWorktreeActivity: true` — wins even over a harness-managed name; an attached worktree with activity is live regardless of naming convention |
| 0.5 (new) | **Preconditions, all must hold:** (i) short name matches `^worktree-agent-[0-9a-f]+$`; (ii) no active-worktree override fired for it (row 0 above); (iii) the branch is NOT current `HEAD` in the primary worktree (R1); (iv) `classifyBranch`'s own result for this branch is `stale`, i.e. rows 2-6 — the branch would otherwise produce a blocking item (R2) | `harness_managed` |
| 1-9 (unchanged) | `classifyBranch` (`stop-stale-worktrees-guard.md` §3 Branches rows 1-9; code: `hooks/stop-stale-worktrees-guard.js:726` onward) | unchanged — `ok`/`stale`/`active`/`unknown` per the existing table |

The new test is evaluated in the same loop as the existing active-worktree
override check (`hooks/stop-stale-worktrees-guard.js:1166-1177`), inserted
between the override check (line 1172) and the point where the branch's
classification is finalized for this invocation. Concretely: compute
`classifyBranch` as today, then before recording the result, check in
order: (a) was this branch overridden `active` by worktree activity — if
so keep that result unchanged; (b) is this branch the primary worktree's
checked-out `HEAD` — if so keep `classifyBranch`'s own result unchanged
(R1), regardless of name; (c) does `classifyBranch`'s own result equal
`stale` AND does the name match the harness regex — if both hold, override
to `harness_managed` (R2); (d) else (an `ok`/`active`/`unknown` result, a
non-matching name, or both) keep `classifyBranch`'s own result unchanged.
This ordering means a harness-managed branch is reclassified only when it
would otherwise block — an `empty-local` (row 7) or currently-`active`
(row 9) branch with a matching name is left exactly as `classifyBranch`
found it (R2, above), and the branch currently checked out as `HEAD` is
left exactly as `classifyBranch` found it regardless of its own class (R1,
above).

**Never blocks, never accrues strikes.** `harness_managed` items are never
added to a block `reason` (they are excluded from `findings` the same way
`active`/`active-remote`/`stale-remote-foreign`/`excluded` already are —
`stop-guard-bounded-reblock.md` §3, "never reach this table") and therefore
never enter the bounded-reblock per-item state table (`applyBoundedReblock`,
`hooks/stop-stale-worktrees-guard.js:1638` onward) at all. There is no
`kind: "harness_managed"` row in that table — the reporting mechanism is a
separate, simpler once-per-session set described in §3, not a strike-bearing
item kind. (This never-blocks property is now, by construction of row 0.5's
preconditions above, only ever reached from what would otherwise have been
a `stale` classification — R2 — never from `ok`/`active`/`unknown`, and
never from the branch that is current `HEAD` — R1.)

## 3. Reporting and state changes

**Reported once per session, then only on growth.** On the first `Stop`
where one or more `harness_managed` branches are observed (per §2's row
0.5, preconditioned on R1/R2 — i.e., a branch that is not `HEAD` and would
otherwise have blocked), the `systemMessage` (or, on a clean allow, the
sole allow-side message) gains one informational line naming the count and
the branch names, e.g.:

> `harness-managed branches present (2, informational only, never blocked): worktree-agent-a1b2c3, worktree-agent-d4e5f6`

Capped at the first 20 names with a trailing "...and N more" beyond that
(narrower than the block-reason 40-item cap, since this is informational
and additive to whatever else the message already carries — this display
cap is distinct from, and does not affect, the durable record's own
uncapped name set, R5 below). On every subsequent `Stop` in the same
session, this line is emitted again **only if** the current set of
harness-managed branch names is not a subset of the names already reported
this session — i.e., only when a name appears that was not in any
previously reported set. A branch disappearing (worktree harness cleanup,
or the branch itself deleted) does not trigger a re-report; only new names
do. When the set is unchanged or has only shrunk, no informational line is
added for this signal — consistent with D2's "silent Stop" principle for
the yield layer.

**Durable record on report and on growth (owner ruling R5).** Independently
of the `systemMessage` line above, each time that line fires — the first
report in a session, and each subsequent report triggered by the set
growing — one JSON line is appended to `yields.log`:
`{"event":"harness_managed","session_id":"<raw session_id>","ts":"<ISO
8601>","count":<int>,"names":[...]}`. `names` is the full current
`harness_managed_reported` set (after this invocation's growth is folded
in) — **never** capped at 20; the 20-name cap stated above applies only to
the `systemMessage` display text, never to this durable record. `count` is
`names.length`, included for a log-scanning tool that wants the count
without parsing the array. This uses the same `appendYieldLogLine`
best-effort, swallow-on-failure convention every other yields.log write in
this file already uses (§4/`hook-state-write-guard.md` §3.3) — a failure to
write this line never blocks or alters the already-decided Stop outcome.
No line is written on an invocation where the set is unchanged or has only
shrunk (mirrors the `systemMessage` silence rule above exactly — one
durable-record mechanism, one display mechanism, same trigger condition).

**Implementation clarification: missing `session_id` and state-write
failure, for an invocation with no blocking item at all (added during
implementation; not resolved by the original text above).** Two edge cases
this section did not originally address, because they only arise once
`harness_managed` items can make an invocation's *entire* Stop outcome
non-blocking (`stop-guard-bounded-reblock.md` §3's own missing-`session_id`
and write-failure rules were written when every engaged invocation was, by
definition, a blocking one):

- **Missing/malformed `session_id`.** `stop-guard-bounded-reblock.md` §3
  step 1's fail-closed rule (block, no state read/written) cannot apply
  here — `harness_managed` must never block (§2). Instead: the
  informational line is skipped entirely for this invocation (no
  `systemMessage` line, no state read/written, no durable record) — there
  is no session to scope "already reported" against, and reporting
  unconditionally every invocation would defeat the growth-only rule this
  section exists to add. This can only ever delay a report, never suppress
  it permanently: the next invocation carrying a valid `session_id` reports
  normally.
- **State write failure** (`ENOSPC`, `EACCES`, etc.) on an invocation whose
  outcome would otherwise be a non-blocking harness-managed report: fail
  soft, skip the report for this invocation (no `systemMessage` line, no
  durable record) — `stop-guard-bounded-reblock.md` §2 item 8's
  fail-*closed*-to-a-block rule does not apply here for the identical
  reason (a write failure must never turn a never-blocking signal into a
  block). The next invocation retries the write normally.

**State: extended, not new; schema version 2 (owner ruling R4).** The
existing per-session state file (`stop-guard-bounded-reblock.md` §3,
`<hooks dir>/state/stop-stale-worktrees-guard.<sanitized session_id>.json`)
gains a top-level `v: 2` field, one sibling top-level field
(`harness_managed_reported`), and, per §4/R3 below, two new per-item
fields (`yielded`, `yielded_tip`):

```json
{
  "v": 2,
  "session_id": "<raw session_id, verbatim>",
  "stop_hook_active_last": false,
  "created_at": "<ISO 8601>",
  "updated_at": "<ISO 8601>",
  "items": {
    "branch:some-other-stuck-item": {
      "kind": "branch",
      "identity": "some-other-stuck-item",
      "strikes": 3,
      "first_block_at": "<ISO 8601>",
      "last_block_at": "<ISO 8601>",
      "yielded": true,
      "yielded_tip": "a1b2c3d4e5f6..."
    }
  },
  "harness_managed_reported": ["worktree-agent-a1b2c3", "worktree-agent-d4e5f6"],
  "mac": "<hex HMAC-SHA256>"
}
```

`harness_managed_reported` is a sorted, de-duplicated array of every
branch short name reported in any informational line so far this session
(union across invocations, never pruned within the session — mirroring
`items`' own "never delete on a clean allow" rule, `stop-guard-bounded-
reblock.md` §3). It is read and written by the same `readReblockState`/
state-write path already used for `items`
(`hooks/stop-stale-worktrees-guard.js:1489` onward /
`writeReblockStateAtomic`), not a second file — one state file per
session remains the invariant.

**HMAC coverage, versioned (R4).** Two distinct MAC input formats now
exist, keyed by the state file's own declared `v`:

- **v2** (this spec's own format): `macInputV2 = "2" + "\n" + sessionKey +
  "\n" + canonicalizeItems(items) + "\n" +
  canonicalizeHarnessManaged(harness_managed_reported)`. `canonicalizeItems`
  is unchanged (`hook-state-write-guard.md` §3.2's existing sort-then-
  stringify convention) and, with no special-casing needed, already covers
  the new per-item `yielded`/`yielded_tip` fields the identical way it
  already covers `strikes`/`first_block_at`/`last_block_at`.
  `canonicalizeHarnessManaged` sorts the array and `JSON.stringify`s it.
- **legacy** (no `v` field at all — every state file written before this
  spec): `macInputLegacy = sessionKey + "\n" + canonicalizeItems(items)` —
  the original, pre-this-spec input (`hook-state-write-guard.md` §3.2),
  computed over whatever `items` the file actually contains, with no
  `harness_managed_reported` term at all.

**Reading, total classification of every state file on disk (R4):**

1. File missing, unparseable, or fails the existing object/`items`-shape
   check: absent, `{ items: {} }` — unchanged, not a tamper event
   (`hook-state-write-guard.md` §3.3, first bullet).
2. File shape-checks and declares no `v` field: **legacy.** Verify against
   `macInputLegacy` using the current keyfile. If it verifies: migrate in
   memory — set `v: 2`, default every new v2 field absent from the loaded
   object (`harness_managed_reported: []` if absent; each item's `yielded`/
   `yielded_tip` left absent if absent) — and proceed with the now-v2-shaped
   state for this invocation. **No tamper line is appended for this
   migration**: a verifying legacy file is a normal format transition, not
   tampering. The migrated shape is written back, with a freshly computed
   v2 `mac`, on this invocation's own state write — the same write this
   invocation would make regardless, not an extra one. If the legacy-format
   MAC does **not** verify: tamper, per item 4 below (a legacy file with a
   bad `mac` is exactly as suspect as a v2 file with a bad `mac` — legacy
   status only changes which input the verification runs against, never
   whether a failure counts as tamper).
3. File shape-checks and declares `v: 2`: verify against `macInputV2`.
   Verifies: return as-is. Fails: tamper, per item 4 below.
4. **Tamper (either format's MAC fails under its own declared format):**
   reset to `{ items: {} }` (now also clearing `harness_managed_reported`
   and every item's `yielded`/`yielded_tip`), one
   `{"event":"tamper","session":"<session_id>","ts":"<ISO 8601>"}` line
   appended to `yields.log` — exactly `hook-state-write-guard.md` §3.3's
   existing behavior, now stated to apply identically regardless of which
   format's MAC was being checked.
5. File shape-checks and declares any `v` other than absent or `2` (a
   future or otherwise-unrecognized schema version this code does not know
   how to read): **tamper-equivalent reset**, reason `unknown_schema_
   version` — reset to `{ items: {} }` exactly as item 4, and append one
   `{"event":"tamper","reason":"unknown_schema_version","session":"<session_
   id>","ts":"<ISO 8601>","v":<declared value>}` line to `yields.log`.
   "Logged once" here means once per invocation that encounters the
   unrecognized version (the normal per-invocation append behavior every
   other tamper path already has) — not a new session-level suppression
   mechanism; an unrecognized-version file that keeps being written by
   whatever external process is producing it would keep logging on every
   invocation that reads it, same as a persistently-bad-MAC file already
   would under item 4.

This supersedes the sentence this section previously carried — "it costs
at most one extra state reset per session transitioning across the deploy
boundary, never a forged escape" — which was written for a single-format
MAC input change. The versioned-legacy-migration behavior above means a
session transitioning across *this* spec's deploy boundary now costs
**zero** extra resets in the common case (an in-flight session's existing,
untampered state file: its legacy-format MAC still verifies, so it
migrates silently); the "reset only, never a forged escape" safety
property for a genuinely tampered, malformed, or unrecognized-version file
is unchanged.

## 4. Yield-once semantics

**Problem restated precisely.** `applyBoundedReblock`'s current yield path
(`hooks/stop-stale-worktrees-guard.js:1745-1764`, `stop-guard-bounded-
reblock.md` §3 step 6) runs — and re-emits the full `STALE ITEMS REMAIN`
summary plus one yields.log line per item — on **every** invocation where
`lowStrike` is empty, not only the invocation where an item first crosses
the strike cap. For a session that keeps stopping with the same
already-yielded item present (exactly the harness-managed-branch scenario
in §1, before this spec's §2 classification removes it from the set
entirely — and equally applicable to any other stuck item that isn't
harness-managed), this means the summary and a fresh log line repeat on
every subsequent `Stop`, unbounded for the rest of the session.

**Fix.** Partition `highStrike` (items at or above `REBLOCK_STRIKE_CAP`,
`hooks/stop-stale-worktrees-guard.js:1353`) into `newlyYielded` (this
item's `first_block_at`-to-cap transition happened on *this* invocation —
equivalently, this is the first invocation where this item's stored
strikes reached the cap) and `alreadyYielded` (its strikes reached the cap
on a prior invocation). This requires one new per-item state field,
`yielded: true`, set the invocation an item's strikes first reach
`REBLOCK_STRIKE_CAP` and never cleared within the session except by the
tip-drift rule below (mirrors `harness_managed_reported`'s own "never
pruned within the session" rule, §3, with that one explicit exception). An
item already carrying `yielded: true` from a prior invocation is
`alreadyYielded`; one that reaches the cap this invocation without that
flag set is `newlyYielded`.

**Yield identity additionally binds to content, where a content
discriminator exists (owner ruling R3).** Each item's state entry gains a
second new field, `yielded_tip`: the content discriminator (see table
below) captured the invocation an item's strikes first reach
`REBLOCK_STRIKE_CAP` — the same invocation `yielded: true` is set — and
left unset for an item that has never yielded, or whose kind has no
discriminator.

Before the existing `lowStrike`/`highStrike` partition runs, every item
whose state entry already carries `yielded: true` AND a non-null
`yielded_tip` is additionally tested: does THIS invocation's item carry a
content discriminator (table below) that differs from the stored
`yielded_tip`? If so, this is content drift on an already-yielded item —
for this invocation only, the item is treated as if it had no prior
history at all: its stored `strikes` is treated as `0`, and its `yielded`/
`yielded_tip` fields are cleared as part of this invocation's own state
write. It then enters the normal `lowStrike` path exactly like a
brand-new item — strikes become `1`, it blocks this invocation — and NO
`alreadyYielded` classification applies to it this invocation. It can
accumulate strikes again over subsequent invocations and reach the cap
again on a later one, at which point it yields again: its own fresh
`newlyYielded` classification, its own new yields.log line, its own newly
captured `yielded_tip` (the tip at *this* new yield). An item whose
discriminator matches its stored `yielded_tip` — or which has no
discriminator at all, or whose stored `yielded_tip` is itself unset (a
migrated pre-R3 item, or a kind that never captured one, per §3's legacy-
migration handling — absence here is not evidence of drift, there is
nothing to compare against) — proceeds exactly as before this ruling:
`alreadyYielded`, silent. This tip-drift check is scoped to items that have
already yielded; it does not affect strike accumulation before an item
first reaches the cap — a branch's tip moving between an item's 1st and
2nd block does not reset its partial strike count, only post-yield content
drift creates a new item.

**Content discriminator, by item kind:**

| kind | discriminator | rationale |
|---|---|---|
| `branch` | the branch's current tip commit sha (`br.tip`, already resolved for every branch by `parseForEachRef`, `hooks/stop-stale-worktrees-guard.js:1138` onward) | the item's entire reason for blocking (ancestor/tree-equality/cherry/gone-upstream evidence) is a property of this exact commit; a branch reset, force-pushed, or re-committed to a new tip after already yielding is a materially different situation the operator may now be actively working on — silently treating it as "already handled" would hide exactly the drift D2 exists to surface for every other still-live item |
| `worktree`, when the finding carries a `coveredBranch` (a linked worktree's staleness is reported via its checked-out branch's own evidence, §3 Branches grouping in the base spec) | that covered branch's current tip — identical to the `branch` row above | the worktree finding and its covered branch describe the same underlying content; they share one discriminator rather than two independently-drifting ones |
| `worktree`, with no `coveredBranch` (a prunable/missing-directory/detached-HEAD finding — the finding is about the worktree's own existence or attachment state, not a content-bearing tip) | none — name-only (`path`) identity applies | there is no commit-ish concept for "this worktree is missing" or "this worktree is at a detached HEAD" to drift to; the finding's truth value is binary (still missing / still detached), not content-versioned |
| `remote` | the remote-tracking ref's own current tip (`ref.tip`, from `listRemoteRefs`) | identical reasoning to `branch`: a remote ref can move (force-push, new commits) independently of the item key (`refname`), and its ancestor/tree-equality/cherry evidence is a property of that specific tip |
| `unknown`, `deadline` | none — name-only identity applies | these are classification-failure/budget-exhaustion states, not content states; there is nothing for "tip" to mean for "git merge-base --is-ancestor failed" or "classification did not finish in time" — the same diagnostic condition either keeps recurring (still silently `alreadyYielded`, correctly, per the unchanged pre-R3 behavior) or the item is absent from a later invocation's set entirely, which the reappearance rule below already handles, not this discriminator |

This is additive to item construction: `itemsForFindings` (and the
`unknown`/`deadline` item builders, `itemsForUnknown`/`itemsForDeadline`)
gain an optional `tip` field alongside the existing `kind`/`rawIdentity`/
`line`, populated per the table above where applicable and left absent
otherwise; `applyBoundedReblock`'s partition step reads `item.tip` (when
present) as the content discriminator described here.

- If `lowStrike` is non-empty: **block**, exactly as today (§3 step 5,
  unchanged) — `newlyYielded`/`alreadyYielded` are irrelevant this branch,
  since the invocation isn't yielding at all yet.
- If `lowStrike` is empty and `newlyYielded` is non-empty: **allow**,
  `systemMessage` = the `STALE ITEMS REMAIN` summary, but listing **only**
  `newlyYielded` items (not the full `highStrike` set — dropping
  `alreadyYielded` items from the listed lines entirely). One yields.log
  line is appended per `newlyYielded` item, exactly as today's per-item
  loop already does (`hooks/stop-stale-worktrees-guard.js:1754-1762`) but
  now iterating `newlyYielded` instead of the full `highStrike` array.
  Each such item's state entry is updated with `yielded: true` and
  `yielded_tip` (set to this invocation's `item.tip` when the item's kind
  has a discriminator per the table above, else left unset) as part of
  this same state write.
- If `lowStrike` is empty and `newlyYielded` is also empty (every item in
  the current set was already yielded on a prior invocation, and none of
  them tip-drifted per the rule above): **allow, silent** — exit 0, no
  `systemMessage`, no yields.log write, matching this file's existing
  "produce no output at all to allow the stop" convention
  (`stop-stale-worktrees-guard.md` §5).

**Reappearance is not a new yield — unless content also drifted.** If a
previously-yielded item's identity disappears from a later invocation's
item set and then reappears, its state entry (strikes, `yielded: true`,
`yielded_tip`) is untouched by its absence — consistent with the existing
churn rule (`stop-guard-bounded-reblock.md` §3 step 3, "existing... strike
count... 0 if absent" only applies to items never seen before; an item
with prior history keeps it). On reappearance it is found already at
`strikes >= REBLOCK_STRIKE_CAP` with `yielded: true` already set, so it
classifies `alreadyYielded` immediately — no new strikes accrue, no new
yields.log line, no `systemMessage` mention, exactly as if it had never
left — **unless** the reappeared item's content discriminator (R3, above)
differs from its stored `yielded_tip`, in which case the tip-drift rule
takes precedence over this reappearance rule: the item is treated as new
(fresh strikes, cleared `yielded`/`yielded_tip`), not as a silent
reappearance. Whether an item was continuously present, absent-then-
reappeared, or reappeared with drifted content are independent axes; R3's
tip check is evaluated purely by comparing this invocation's discriminator
to the stored `yielded_tip`, regardless of which of those histories
produced the item currently under evaluation.

**Interaction with §3's harness-managed reporting.** These are two
independent once-per-session mechanisms (D1's name-set report, D2's
yield-once, now content-bound per R3), sharing the same state file but
tracked in separate fields (`harness_managed_reported` vs. each item's
`yielded`/`yielded_tip`) and evaluated on separate axes (branch name vs.
strike-item identity, additionally content for R3) — a `harness_managed`
branch never reaches the strike table at all (§2), so D2/R3's mechanism is
moot for it specifically; D2/R3 exist for every other item kind
(`worktree`/`branch`/`remote`/`unknown`/`deadline`) that still can reach
the cap.

## 5. Self-heal (opt-in, pending owner decision)

**Status: specified in full below; NOT implemented unless the owner
explicitly enables it.** This section exists so the design is on record
and reviewable, not as an instruction to build it in the same change as
§2-§4.

**Trigger.** `STOP_GUARD_PRUNE_HARNESS_BRANCHES=1`, read from the hook
process's environment identically to `JUDGE_STOP_GUARD`
(`stop-stale-worktrees-guard.md` §4) — inherited from the Claude Code
launch, not set by an agent's own shell invocation. Unset or any value
other than the literal string `1`: this section's code path never runs;
behavior is exactly §2-§4.

**Resume-safety disclosure (owner ruling R6).** Enabling self-heal changes
the nature of this spec's own §6 first blind spot ("cannot detect an agent
that is alive but whose worktree was removed") from a reporting gap into
an execution risk. Without self-heal, a live agent's `harness_managed`
branch merely sits unreported (informational-only, §2/§3) until its
worktree reappears or the session ends — the branch itself is untouched,
so a later `SendMessage`-driven resume of that agent still has its work to
resume *from*. With self-heal on, a branch meeting the eligibility
conditions below can be deleted while its owning agent is still alive but
between worktree attachments (e.g. mid-`SendMessage` round trip, or paused
awaiting a tool result) — at that point resuming the agent does not merely
encounter noise, it encounters a **failed resume**: the branch the agent's
next action would have committed to no longer exists. This is a strictly
worse failure mode than the blind spot it replaces, and is precisely why
this section stays opt-in, default off, pending owner decision — the
cooldown precondition below and the ancestor-of-base eligibility condition
are this design's mitigations, not a claim that the risk is eliminated. An
operator enabling `STOP_GUARD_PRUNE_HARNESS_BRANCHES=1` is accepting this
risk in exchange for automatic cleanup; it should not be enabled in any
environment where agents are routinely paused, for longer than the
cooldown window, while genuinely still alive.

**Eligibility, total classification, every harness_managed branch maps to
exactly one outcome:**

| Condition | Outcome |
|---|---|
| No attached worktree for this branch in `git worktree list --porcelain` (reusing the same parsed records already produced for the base classification pass, `stop-stale-worktrees-guard.md` §3 Worktrees — no extra `git worktree list` call) | eligible for pruning, continue to next condition |
| Has an attached worktree | `skipped:worktree-attached` |
| Is an ancestor of `base.tip` (`merge-base --is-ancestor`, reusing the same detector and cached `base` object §3 Branches already computed — no extra classification call beyond what row 3 already ran) | eligible, continue |
| Is not an ancestor of `base.tip` (its content isn't actually merged — e.g. the spawned agent's work was abandoned mid-task, not completed) | `skipped:unmerged` |
| Is the current `HEAD` (checked out in the primary worktree, detached or not) | `skipped:is-head` |
| **(new, R6) Branch tip commit time is less than `STOP_GUARD_PRUNE_COOLDOWN_MIN` minutes old** — read from the hook process's own inherited environment, same convention as `JUDGE_STOP_GUARD_QUIET_MINUTES` (`getQuietWindowMs`: parse, clamp to non-negative, default on anything unparseable); default `30` minutes when unset. Tip commit time is read via `git log -1 --format=%ct <tip>` (committer date, seconds since epoch) against the same `budget`/`gitCall` machinery every other classification call already uses. | `skipped:cooldown` |
| Passes all four checks above | pruned (attempt `git branch -d <name>`) |

The cooldown exists specifically for the resume-safety disclosure above: a
branch whose tip was committed moments ago is more likely to belong to an
agent still actively working (a fresh commit is recent activity), so
giving it a minimum age before it becomes prune-eligible narrows — without
eliminating — the window in which self-heal could delete a genuinely live
agent's branch.

**Execution.** For each eligible branch, **immediately before** issuing
the `git branch -d <name>` call, re-run the worktree-attachment check
(the eligibility table's first condition, above) against a freshly-fetched
`git worktree list --porcelain` — **not** the cached record from this
invocation's classification pass at the top of the run (a deliberate
exception to that same first condition's own "reusing the same parsed
records ... no extra `git worktree list` call" note — that note describes
the *initial* eligibility pass; this final pre-delete gate is intentionally
a fresh call, since reusing the stale record would defeat the purpose of a
re-check). This narrows the race where an agent attaches a worktree to
this branch in the interval between this invocation's classification pass
and its self-heal pass — both share the one invocation's ~20-second
budget, but a concurrent Agent tool call attaching a worktree is not bound
by that budget. If the re-check finds an attachment that wasn't there
moments ago, the branch is re-classified `skipped:worktree-attached` for
this invocation and `git branch -d` is never invoked.

This re-check is a **best-effort narrowing of the race window, not a
closure of it** — a worktree could still attach in the instant between the
re-check and the delete call itself. The actual last line of defense is
`git branch -d`'s own refusal: git will not delete a branch that is
checked out in any worktree, including one attached after this guard's own
last check, because `-d` independently re-verifies at the moment it runs,
inside git's own process, against git's own live worktree-administration
state — a check this guard's own re-check narrows the window ahead of but
cannot fully replace.

For each eligible branch surviving the re-check, run
`git -C <targetDir> branch -d <name>` — **never `-D`**: `-d` itself
refuses to delete a branch git can't verify is fully merged, which is the
same safety property row 3's ancestor detector already established before
offering `-d` as a *manual* fix line, now exercised as an executed command
instead of a suggested one. Each call is given a `timeout` sized to
whatever remains of the existing per-invocation budget
(`stop-stale-worktrees-guard.md` §3 "Deadline") — no separate budget is
introduced; if the shared budget is already exhausted by the time
self-heal would run (it runs after classification, using whatever
remains), remaining branches classify `skipped:deadline` rather than
attempting a call outside the budget.

**Outcome recording.** Each branch's outcome — `pruned`,
`skipped:worktree-attached`, `skipped:unmerged`, `skipped:is-head`,
`skipped:cooldown`, `skipped:deadline`, or `failed:<stderr first line>` (a
`-d` refusal for any reason not already ruled out above, e.g. a race where
the branch gained an unmerged commit between classification and the delete
call) — is included in the §3 informational line for that invocation
(appended to, or replacing, the plain name list when self-heal is on) and
as one `{"event":"prune", "ts":..., "session_id":..., "branch":<name>,
"outcome":<outcome>}` line appended to `yields.log` per branch attempted
(pruned, skipped, or failed all get a line — a `skipped` is still a
decision worth a durable record, not silently dropped).

**Fail-soft, unconditionally.** A `git branch -d` failure (nonzero exit,
thrown error, timeout) is caught and recorded as `failed:<...>` — it never
throws out of `applyBoundedReblock`'s caller, never blocks, never changes
the Stop decision from what §2-§4 would otherwise produce. Self-heal can
only remove `harness_managed` items from a future invocation's set (by
deleting the branch git-side, so it no longer appears in the next
`for-each-ref refs/heads` call) or leave the set unchanged; it can never
add friction beyond what §2-§4 already impose.

**Header sentence update.** `hooks/stop-stale-worktrees-guard.js:10-12`
currently reads:

> `Plain Node, no dependencies, never runs a git-mutating command --`
> `` `git worktree remove`, `git branch -d/-D`, `git push origin --delete` ``
> `etc. appear ONLY as strings inside a block `reason`, never executed.`

This spec requires that sentence be revised, when and only when this
section is implemented, to state the single opt-in exception precisely —
substantively:

> Plain Node, no dependencies, never runs a git-mutating command **except
> one narrow, opt-in exception**: with `STOP_GUARD_PRUNE_HARNESS_BRANCHES=1`
> set, `git branch -d` (never `-D`, never `git worktree remove`, never `git
> push --delete`) is executed against harness-managed branches meeting the
> §5 eligibility conditions in `docs/specs/stop-guard-harness-branches.md`;
> every other mutating command remains a string inside a block `reason`,
> never executed, exactly as before. Default off.

## 6. Blind spots

- **Cannot detect an agent that is alive but whose worktree was removed.**
  §2's classification is purely name-pattern-based; it cannot query
  whether the agent identified by `<id>` in `worktree-agent-<id>` is still
  running, suspended, or resumable. A branch this spec reports as
  `harness_managed` (never blocking) may belong to a live, about-to-be-
  resumed agent, or to one that finished cleanly and left the branch
  behind by inattention — the two are indistinguishable from git state
  alone. This is the same class of gap already accepted in
  `stop-stale-worktrees-guard.md` §8's "Concurrently-open worktree with no
  git-visible 'in use' signal" entry (around that file's line 718) — this
  spec extends that identical accepted gap to a branch with no worktree at
  all, where even the (already-insufficient) worktree-based activity
  signals of §3/§15/§16 of that file have nothing to inspect. With §5's
  opt-in self-heal enabled, this stops being a purely informational gap —
  see §5's "Resume-safety disclosure" (R6), which states explicitly that
  self-heal converts this exact blind spot into a possible failed resume,
  not merely a noisy one.
- **Non-branch-content items keep name-only yield identity (R3
  boundary).** §4's content-discriminator table gives `branch`,
  `worktree`-with-`coveredBranch`, and `remote` items a tip-based check
  that turns post-yield content drift into a new, re-blockable item —
  but a plain `worktree` finding with no `coveredBranch` (prunable,
  missing-directory, or detached-HEAD), and every `unknown`/`deadline`
  item, have no such discriminator by design (§4's table states why: none
  of these have a content-ish "tip" to compare). For these kinds
  specifically, R3 changes nothing: once yielded, they stay silently
  `alreadyYielded` for the rest of the session even if the underlying
  situation would look "new" to a human (e.g. a worktree directory is
  removed, a fresh one is manually created at the same path in a state
  that would independently classify prunable again). Accepted, not
  closed — extending a content discriminator to a path-identity-only
  finding would require inventing a proxy for "content" where none
  structurally exists (a directory has no analogue to a commit tip), and
  the original reappearance-is-not-a-new-yield rule (§4) already covers
  the case where the same path's finding disappears and comes back
  unchanged.
- **Regex may miss future harness naming.** `^worktree-agent-[0-9a-f]+$`
  is exact-matched against today's naming convention. A future harness
  version that changes the id format (uppercase hex, a prefix/suffix, a
  different delimiter) produces branches this spec's regex does not match
  — they fall through to ordinary `stale` classification and reproduce
  the original §1 problem for that new naming shape. Accepted, not closed:
  narrowing the regex to exactly today's known format was deliberate (a
  looser pattern risks misclassifying a human-named branch as harness-
  managed, per the next bullet), at the cost of needing this file updated
  if the harness's naming convention changes.
- **`systemMessage` model-visibility open question, carried over
  unresolved.** Whether Claude Code's Stop-hook `systemMessage` field
  reaches the model's context or is transcript/UI-only is still not
  confirmed (`stop-guard-bounded-reblock.md` §7 item 3, carried forward
  verbatim here) — this spec's §3 informational line and §4's yield
  summary both depend on that same open channel for anything beyond the
  durable yields.log record. No code in this spec depends on the answer
  either way, consistent with that spec's own framing.
- **A human branch deliberately named `worktree-agent-*` is exempted from
  blocking, not by mistake — but only when it would otherwise have
  blocked, and never while it is `HEAD`.** A person who happens to name
  their own branch e.g. `worktree-agent-deadbeef` — matching the regex
  without ever having gone through the Agent tool's worktree isolation —
  is silently reclassified `harness_managed` *if and only if* that branch
  would otherwise classify `stale` under rows 2-6 (R2, §2): never blocked,
  never strike-tracked, reported once informationally like any genuine
  harness branch. If instead their coincidentally-named branch is
  `empty-local`, currently active (unmerged commits, no worktree), or is
  the branch they currently have checked out (R1, §2), this exemption does
  not apply at all — it surfaces exactly as an ordinarily-named branch in
  the same state would, with no `harness_managed` involvement. This guard
  has no way to distinguish a coincidentally-named human branch from a
  real harness one within the scope where the exemption does apply; it is
  a structural, name-only test by design, now bounded by R1/R2 rather than
  total across every row (§2). Accepted, not closed — the exposure is
  narrower after R1/R2 than an earlier draft (a stale, non-`HEAD`,
  unusual, harness-convention-mimicking name is the only surface left) and
  the failure direction is "this guard stops nagging about a branch that
  was actually abandoned," not a data-loss or security risk; a person who
  names a branch this way and intends it as ordinary work retains every
  other means of tracking it (their own memory, PR status, `git branch`
  listing) — this guard simply stops being one of those means for a name
  in this shape, and only for a branch it would otherwise have flagged.

### Adversary record

One line per owner ruling applied by this revision, cross-referenced to
where each is specified in full:

- **R1 (HEAD exemption):** a harness-named branch that is also the current
  `HEAD` is never silently exempted from staleness reporting — see §2's
  row-0.5 precondition (iii) and the "HEAD exemption" paragraph.
- **R2 (scope of row 0.5):** `harness_managed` reclassifies a branch only
  when it would otherwise block (`stale`, rows 2-6); `ok`/`active`
  branches with a matching name are left untouched and unreported — see
  §2's row-0.5 precondition (iv) and the "Scope of row 0.5" paragraph.
- **R3 (yield identity binds to tip):** a previously-yielded item whose
  content (branch/covered-branch/remote tip) has moved is treated as a new
  item — fresh strikes, a fresh yield, its own log line — instead of
  staying silently yielded forever; kinds with no content concept
  (`unknown`/`deadline`, tip-less `worktree` findings) keep name-only
  identity, stated explicitly and why — see §4's content-discriminator
  table and this section's "Non-branch-content items" blind spot above.
- **R4 (state schema v2):** state files are versioned (`v: 2`); a
  verifying legacy (unversioned) file migrates silently with no tamper
  line, a v2 file failing its own MAC is tamper, and a file declaring an
  unrecognized version is a tamper-equivalent reset logged as
  `unknown_schema_version` — see §3's "HMAC coverage, versioned" and
  "Reading, total classification" subsections.
- **R5 (durable record for the informational report):** every first
  report and every growth of the `harness_managed` set is durably logged
  to `yields.log` with the full, uncapped name set; the 20-name cap
  remains a display-only limit on `systemMessage` — see §3's "Durable
  record on report and on growth" paragraph.
- **R6 (self-heal disclosure/cooldown/re-check):** self-heal is disclosed
  as converting a reporting blind spot into a failed-resume risk for a
  live agent; pruning additionally requires the branch's tip to be at
  least `STOP_GUARD_PRUNE_COOLDOWN_MIN` minutes old, and re-checks
  worktree attachment immediately before the delete call, with git's own
  `-d` refusal as the final backstop — see §5's "Resume-safety
  disclosure," the eligibility table's cooldown row, and "Execution."

## 7. Tests

`node:test`, following the existing suite's patterns — real temp git repos
for classification-shape tests (`stop-stale-worktrees-guard.md` §7's
convention), direct calls into `applyBoundedReblock`/`evaluateStop` with
injected `fs`/`now`/`execGit`/`stateDir` for state-and-timing tests
(`stop-guard-bounded-reblock.md` §8's convention).

| Test | Fixture | Expected |
|---|---|---|
| `harness_branch_never_blocks` | branch `worktree-agent-a1b2c3`, merged into base (ancestor) | allow (or block only if an unrelated non-harness item is also present) — never appears in a block `reason` |
| `harness_branch_report_once` | one harness-managed branch, two sequential `Stop` calls, same state dir | first call's message names it; second call (same name, no new names) emits no informational line for this signal |
| `harness_branch_report_again_only_when_set_grows` | first call reports `worktree-agent-aaa`; second call has `worktree-agent-aaa` and `worktree-agent-bbb` present | second call's message names only `worktree-agent-bbb` (or both, per chosen wording) — not silently omitted, and not `aaa` re-flagged as if new |
| `harness_branch_shrinking_set_no_new_report` | first call reports `aaa` and `bbb`; second call only `aaa` present (bbb's branch deleted externally) | second call emits no informational line for this signal |
| `harness_branch_active_worktree_override_wins` | branch name matches harness regex AND has an attached, active (dirty or unmerged-content) worktree | classifies `active` via the worktree override, not `harness_managed` |
| `yield_summary_emitted_once` | one stuck non-harness item, 4 identical `Stop` calls (blocks 1-3, yields on 4) then a 5th call with the same item still present | call 4 emits the summary and one yields.log line; call 5 is silent (exit 0, no output, no new log line) |
| `yields_log_one_line_per_item_per_session` | two items reach the cap on the same invocation, then 3 more identical invocations | exactly 2 yields.log lines total across all 5 invocations, not 2×N |
| `silent_stop_after_yield_no_output` | an already-fully-yielded item set, one more `Stop` call | exit 0, no stdout at all |
| `yield_reappearance_no_new_strikes_no_new_line` | item yields, disappears for one call, reappears | no strike increment on the disappearance call; reappearance call is silent (already yielded), no new yields.log line |
| `hmac_covers_harness_managed_reported_field` | a state file whose `harness_managed_reported` array is modified in place without recomputing `mac` | next read treats the whole state as tampered (fail-closed reset to `{items:{}}`, `harness_managed_reported` also reset), same as an `items`-tamper case |
| `legacy_state_file_without_harness_field_loads` | a state file from before this spec (`items` and `mac` present, no `v` field, no `harness_managed_reported`, `mac` valid under the legacy two-part input) | loads without throwing; classified legacy (R4), verifies under `macInputLegacy`, and migrates in memory to `v:2` with `harness_managed_reported: []` defaulted — **no** tamper line is appended this invocation, superseding this row's pre-R4 expectation ("treated as MAC-mismatch"), which described the format-change behavior this spec's R4 replaces |
| `harness_head_branch_still_blocks_with_checkout_fix` | branch `worktree-agent-a1b2c3` is checked out as `HEAD` in the primary worktree AND independently classifies `stale` (ancestor) under rows 2-6 | blocks with the ordinary `stale` reason, including the `git checkout <base>` fix line — never reclassified `harness_managed`, never appears in the informational report (R1) |
| `harness_ok_row_branch_not_reported` | branch `worktree-agent-a1b2c3`, `empty-local` (row 7, never committed to) — not `HEAD`, no worktree activity | classifies `ok` per row 7, unchanged from pre-spec behavior; no `harness_managed` line in `systemMessage`, no entry added to `harness_managed_reported` (R2) |
| `harness_yield_same_name_new_tip_reblocks` | a non-harness stuck branch item reaches the cap and yields at tip `A`; the branch is then force-pushed/reset to a new tip `B` while its short name is unchanged; next `Stop` | this invocation treats the item as new — stored strikes reset, `yielded`/`yielded_tip` cleared, blocks again (not silent); a later invocation reaching the cap again appends a fresh yields.log line and records a fresh `yielded_tip` = `B` (R3) |
| `harness_yield_same_name_same_tip_silent` | the same stuck branch item yields at tip `A`; the branch is untouched (still at tip `A`) across a following `Stop` | silent (exit 0, no stdout, no new yields.log line) — classifies `alreadyYielded`, discriminator matches stored `yielded_tip` (R3) |
| `legacy_v1_state_bad_mac_still_tamper` | a state file with no `v` field, `items`+`mac` present, `mac` does NOT verify under `macInputLegacy` (e.g. hand-edited `items`) | reset to `{ items: {} }` (fail-closed); one `{"event":"tamper",...}` line appended to `yields.log` — legacy status changes which input is checked, never whether a failure counts as tamper (R4) |
| `unknown_schema_version_reset_logged_once` | a state file declaring `v: 3` (or any value other than absent or `2`) | reset to `{ items: {} }`; one `{"event":"tamper","reason":"unknown_schema_version",...}` line appended to `yields.log` for this invocation (R4) |
| `harness_managed_durable_record_on_first_report_and_growth_only` | first `Stop` reports one harness-managed branch; second `Stop` (same state dir) adds a second, newly-named harness-managed branch; third `Stop` (same state dir) repeats the same two names with nothing new | first and second calls each append one `{"event":"harness_managed",...}` line to `yields.log`; third call appends none — mirrors the existing `systemMessage` growth-only trigger exactly (R5) |
| `harness_managed_display_cap_does_not_affect_recorded_set` | 25 harness-managed branches present on the first `Stop` | `systemMessage` names only the first 20 plus "...and 5 more"; the appended `yields.log` line's `names` array and the state file's `harness_managed_reported` array both contain all 25, uncapped (R5) |
| `selfheal_off_by_default` | `STOP_GUARD_PRUNE_HARNESS_BRANCHES` unset, harness-managed merged branch with no worktree | branch still exists after the run; no `git branch -d` invoked (asserted via an injected `execGit` spy) |
| `selfheal_skipped_worktree_attached` | env set, harness-managed branch WITH an attached worktree | outcome `skipped:worktree-attached`; branch untouched |
| `selfheal_skipped_is_head` | env set, harness-managed branch is current `HEAD` (e.g. detached at its tip in the primary worktree) | outcome `skipped:is-head`; branch untouched |
| `selfheal_skipped_unmerged` | env set, harness-managed branch NOT an ancestor of base (agent's work abandoned mid-task) | outcome `skipped:unmerged`; branch untouched, no `-d` attempted (which would have refused anyway, but the check short-circuits before the call) |
| `selfheal_skipped_cooldown` | env set, harness-managed branch, no worktree, ancestor of base, not HEAD, but tip committed more recently than `STOP_GUARD_PRUNE_COOLDOWN_MIN` (default 30) minutes ago | outcome `skipped:cooldown`; branch untouched, no `-d` attempted (R6) |
| `selfheal_recheck_catches_late_worktree_attachment` | env set, harness-managed branch eligible at classification time (no attached worktree, cooldown satisfied); injected `execGit`/`fs` simulate a worktree becoming attached to that branch between classification and the immediate pre-delete re-check | outcome `skipped:worktree-attached`, produced by the re-check rather than the original classification pass; `git branch -d` never invoked for this branch (R6) |
| `selfheal_prunes_eligible_branch` | env set, harness-managed branch, no worktree, ancestor of base, not HEAD, cooldown satisfied | `git branch -d` invoked; outcome `pruned`; yields.log gets one `event:"prune"` line |
| `selfheal_failure_is_fail_soft` | env set, injected `execGit` throws on the `branch -d` call for an otherwise-eligible branch | outcome `failed:<...>`; Stop decision otherwise unaffected (still allow if nothing else blocks); no exception propagates |

## 8. Interaction with existing accepted gaps

- **`stop-stale-worktrees-guard.md` §8, "Concurrently-open worktree with no
  git-visible 'in use' signal"** (around line 718-722): unchanged in
  substance, but this spec's §2 makes the analogous gap explicit for
  branches with no worktree at all (§6, first bullet) — the existing entry
  covered "is someone reading this worktree right now"; this spec's gap
  covers "is the agent that owned this branch still alive," a strictly
  wider question the base guard was never positioned to answer either.
  Not closed by this spec; the informational-only, never-blocking
  treatment in §2 is this spec's answer to living with the gap rather than
  resolving it.
- **`stop-guard-bounded-reblock.md` §6, "Session-scoped non-blocking pass,
  concretely"** (line 329 onward): that entry describes the pre-this-spec
  behavior where a yielded item's `systemMessage` and yields.log line
  **repeat on every subsequent Stop**. §4 of this spec directly narrows
  that behavior: the `systemMessage` and log line now fire once, at first
  yield, per item, per session — the entry's own wording ("re-emits the
  full `systemMessage`... and appends a fresh line to the durable yields
  log... each time") is superseded by this spec for the reporting
  mechanics; the underlying acceptance itself (an item stops being able to
  `block` after 3 strikes, for the rest of the session, D2 does not change
  this) is unchanged and still applies. R3 refines "once per item, per
  session" to "once per item-*content*, per session" for kinds with a
  content discriminator (§4) — this narrows the acceptance further (a
  drifted item CAN block and yield again), it does not reopen it; for
  kinds without a discriminator (`unknown`/`deadline`, tip-less `worktree`
  findings), the original "once per item, per session" acceptance is
  completely unchanged by R3.
- **`stop-guard-bounded-reblock.md` §6, "Forgeable, unsigned state file"**
  (line 320 onward) / `hook-state-write-guard.md`'s tamper-evidence layer:
  unaffected in kind — `harness_managed_reported`, and now (R4) the state
  file's own `v` field and every item's `yielded_tip`, are folded into the
  same versioned MAC input as `items` (§3), inheriting the identical
  forgetful-agent (not adversarial-agent) threat model and identical
  accepted-gap status; no new gap introduced, no existing one closed. R4's
  legacy-migration path (§3) is a compatibility mechanism, not a
  weakening of this MAC's guarantee: a migrated file still requires its
  ORIGINAL, pre-this-spec MAC to have verified before its contents are
  trusted for this invocation — it is never trusted merely because it
  declares itself legacy.

## 9. Install notes

- `hooks/stop-stale-worktrees-guard.js`: extend the branch-classification
  loop (`:1150-1177`) per §2; extend `readReblockState`/
  `writeReblockStateAtomic`/`computeMac` per §3; restructure the yield
  branch of `applyBoundedReblock` (`:1745-1764`) per §4. §5's self-heal, if
  and when enabled, adds one new function (e.g. `pruneHarnessBranches`)
  called after classification, gated on `STOP_GUARD_PRUNE_HARNESS_BRANCHES`,
  and the header comment update specified in §5.
- No new files: this spec extends `hooks/stop-stale-worktrees-guard.js` and
  its existing test file, and the existing per-session state file shape —
  no new hook registration, no new `GUARDS` entry, no new script.
- `scripts/install-guards.js`: no change — this spec does not add a new
  hook, only extends the behavior of the already-registered
  `stop-stale-worktrees-guard` entry.
- `hooks/README.md`: the existing `### stop-stale-worktrees-guard.js`
  section's blind-spots list should gain the §6 entries here on
  implementation; not required for this spec document itself.
- §5 is not installed by this spec. If and when the owner enables it: bump
  any version/changelog note this repo conventionally uses for a guard
  gaining a new mutating capability, and update the header sentence exactly
  as §5 specifies — do not implement §5's code without also making that
  header edit in the same change, since an unedited header would then be
  factually false about the file's own behavior.

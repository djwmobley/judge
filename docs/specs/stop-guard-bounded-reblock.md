# Spec: Bounded re-block for `stop-stale-worktrees-guard.js`

*Revised after adversary round 2 on this spec itself
(`.git/tmp/bounded-reblock-adversary.md` in the main checkout, BR-01..08 —
see the change log, §9). This revision replaces round 1's whole-item-set
fingerprint (§2 as originally handed off) with a per-item strike counter —
the round-1 design is preserved below only where round 2 left it
unchanged.*

## 1. Incident

**judge session 3404e0ef**: 19 identical blocks, 01:43-01:47 on 2026-09-07,
caused by a since-fixed active-worktree misclassification — the guard kept
re-blocking on an item that was never actually stale, with no mechanism to
recognize "I already said this" or stop repeating it.

**claude-memory session**: 10 blocks in 3 clusters while a subagent was
already deleting the flagged worktrees/branches — genuine remediation was in
flight, but the guard couldn't distinguish "nothing is happening" from "the
fix is one turn away." The orchestrator's own shell is blocked by
`orchestrator-tool-guard`, so remediation here is *always* asynchronous. A
guard that assumes remediation completes in one turn is structurally wrong.

## Root cause

- Never reads `stop_hook_active` from Stop-hook stdin, so it can't tell a
  fresh Stop attempt from a repeat of the same chain.
- Keeps no state between invocations "by design" (`stop-stale-worktrees-
  guard.md` §4) — deliberate after that spec's own round-1 findings
  (A3-A5, C1-C3) showed a naive whole-run strike counter was gameable. That
  fix removed the gameable counter but also removed any bound on repetition.
- Fires synchronously with no cooldown and no wall-clock awareness, so a
  fast retry loop (incident 1) and genuine async remediation (incident 2)
  look identical to it.
- Partial fix lines recovered from a stopped author agent
  (`stop-guard-bounded-reblock.partial-diff.patch`, sibling file, reference
  only — not applied verbatim) assumed the guard executes and persists
  state in one continuous run — they add per-block `items` structure
  (reused below, §3) but never touch `stop_hook_active`, session-keyed
  state, or the yield path.

## 2. Owner ruling (binding — this revision implements it verbatim)

A first draft of this spec (whole-item-set SHA-256 fingerprint, §3
`os.tmpdir()`-based state, a single blocks-count-of-4 cutoff) went through
an adversary pass (`bounded-reblock-adversary.md`, BR-01..08) that found
five BLOCKER-severity defects in that design — most critically, BR-02:
fingerprinting the *whole item set* means ordinary background churn (an
unrelated scratch branch, a second session's work) perturbs the hash and
resets the counter, so a genuinely-stuck item can never accumulate 3
*consecutive* identical whole-set matches and the bound this spec exists to
add could never actually trigger. The owner reviewed all eight findings and
ruled as follows; every clause below is binding on this revision (§9 maps
each finding to its resolution):

1. **Per-item, not per-set, strikes** (closes BR-02/BR-06). Strikes are
   counted **per item**, keyed by item identity, never by a hash of the
   whole finding set. Every Stop invocation that blocks increments the
   strike of every item present in that invocation's block reason. An item
   that reaches 3 strikes is removed from the block `reason` and instead
   listed in a human-facing yield summary. The guard keeps blocking while
   at least one item in the current set has fewer than 3 strikes; once
   every item still present has 3 or more, it allows, emits the summary as
   `systemMessage`, and appends one durable log line per yielded item
   (§5). A new item (new identity) starts at 0 and blocks normally.
2. **Item identity** (closes BR-03). Identity is **class plus normalized
   path-or-ref-name only** — never the git step that produced it, the
   evidence class, or timing. Normalization reuses this file's own
   `normalizePathForCompare()` uniformly (case-fold on win32, separators to
   `/`, trailing separator stripped) for every identity string, path or
   name alike. `unknown` items keep their specific path-or-ref
   (`unknown:<path-or-ref>`, or `unknown:<fixed-diagnostic-label>` for a
   process-level failure with no natural path/ref — scope-gate,
   worktree-list-failed, etc., all fixed strings from this file's own code,
   never git output). `deadline` items collapse to the single literal
   `deadline`, regardless of which step the deadline expired on — this is
   the one deliberate exception to "keep the specific name," because the
   step that happens to be running when a shared wall-clock budget expires
   is inherently nondeterministic near the boundary (BR-03) and must not be
   allowed to look like a different item every cycle.
3. **State location and integrity** (closes BR-01, BR-04, BR-11-class gap).
   State lives at `<hooks dir>/state/stop-stale-worktrees-guard.<sanitized
   session_id>.json` — the same directory and `sanitizeForFilename`
   convention `hooks/agent-tier-ledger.js` already uses, **not**
   `os.tmpdir()`. The state directory is created on first run by the write
   path itself: `writeReblockStateAtomic` calls `fsx.mkdirSync(stateDir,
   { recursive: true })` before writing the temp file, with no separate
   directory-creation step anywhere else in this layer — a `mkdirSync`
   failure there is caught by that same function's surrounding try/catch
   and surfaces as an ordinary write failure (§2 item 8), not a distinct
   error path. Writes are atomic (temp file in the same directory, then
   `fs.renameSync`). **Accepted, not closed:** the fingerprint/strike state
   is a plain, unsigned JSON file; an agent (or any subagent whose shell
   isn't guard-blocked) with ordinary file access to this directory can
   read it, predict what a future invocation would write, and pre-write a
   forged `strikes: 3` record to force an immediate yield. This guard's
   threat model, stated identically in `stop-stale-worktrees-guard.md` §8
   (R2-A2, R4-05) and reaffirmed by ruling here, is a **forgetful agent**
   leaving work unresolved by inattention, not an **adversarial** one
   deliberately forging state to escape a block it wants to avoid; closing
   the forgeability gap (e.g., an HMAC keyed off something outside the
   agent's writable surface) was considered and rejected as
   disproportionate to that threat model. State files older than 7 days
   are swept on every run (reusing
   `model-routing-guards.state.js`'s `cleanupOldStateFiles`), fail-soft —
   a sweep failure never affects the current decision.
4. **Durable yield record, not systemMessage alone** (closes BR-07). A
   yield appends one JSON-line record per yielded item to
   `<hooks dir>/state/stop-stale-worktrees-guard.yields.log` (§5) —
   `systemMessage` names this path explicitly. **Do not assume
   `systemMessage` reaches the model** (open question 3, carried forward,
   unresolved — see §7); the log file is what makes a headless/CI/
   scheduled-agent run leave a record at all, independent of whether any
   model ever sees the allow-side message.
5. **No cross-session carryover; fail closed on a missing session key**
   (closes BR-05, resolves original open question 2). Strikes never reset
   *within* a session — an item that goes quiet and later recurs keeps its
   accumulated count, it does not start over at 0 just because it briefly
   disappeared (see §3's "churn" test). A yield marker never carries into
   a different `session_id`; a new session starts every item at 0. This is
   a **known, accepted, session-scoped silent-pass**: once an item yields,
   it is not re-armed for the remainder of that same session even if it
   recurs 50 more times — see §6 Blind spots for the concrete case. The
   owner's ruling is that this is an acceptable bound (the exposure is
   capped at one session's worth, not permanent) given a genuinely fresh
   session is the natural, agent-uncontrollable reset point, and "friction
   is cheap" for that fresh start. **Missing or malformed `session_id`
   fails closed:** treated as unknown state, the guard blocks with a
   `reason` naming the missing field, no state is read or written for that
   invocation — see §4.
6. **Operator-only items get no special path** (resolves original open
   question 1). An item whose fix includes an externally-visible mutation
   (`git push <remote> --delete ...`) follows the identical per-item
   3-strike accounting as any other item; its line in `reason` (and in the
   eventual yield summary) is annotated **"(externally visible, run it or
   ask the operator)"** so an agent that can act on it is prompted to, and
   an agent that can't (no push rights, or an operator directive to leave
   remote deletes to a human) has a self-explanatory reason to leave it for
   the yield instead of retrying it uselessly.
7. **`stop_hook_active` is diagnostic-only.** Read from stdin and recorded
   in state (last-seen value) for anyone debugging a state file later; it
   never changes the block/allow decision. A block is a block whether this
   is a fresh Stop attempt or a repeat of the same chain — consistent with
   `stop-stale-worktrees-guard.md` §5's existing rule for the base
   classification, extended here to the bounded-reblock layer too.
8. **State write failure fails closed.** If the atomic state write itself
   fails (`ENOSPC`, `EACCES`, a read-only redirected state directory, or
   any other `fs` error), the guard blocks — `reason` names the state path
   and the underlying error — rather than letting an unwritable state
   directory silently and permanently disable the accounting (the same
   failure direction the base guard's own G3/C2 history already rejects).
   This applies whether the write failure occurs on an ordinary block or
   at the moment every remaining item would otherwise have reached the
   yield threshold — an unpersisted increment must never be trusted to
   justify an allow. `JUDGE_STOP_GUARD=off` is unchanged and, as before,
   skips this entire layer, including sweeping and every state write.
9. **Everything shipped in PR #8 stays intact.** The active-worktree
   carve-out (§15/§16 of `stop-stale-worktrees-guard.md`) and the
   remote-tracking-ref classification (§3/§13) are unchanged by this spec.
   This document adds a layer on top of an unchanged classification pass;
   every existing exported function in `stop-stale-worktrees-guard.js`
   keeps its current signature and behavior. The only classification-layer
   change is additive: each block-producing return site now *also* carries
   a per-item breakdown (`items`) alongside the exact same `reason` string
   it already produced, so the new layer has something to key strikes on
   without altering what any existing caller already receives.

## 3. Item identity and the per-item state table

Every `action: "block"` outcome from the unchanged classification pass
(`stop-stale-worktrees-guard.md` §2-§4/§13) is paired with a list of items,
one per thing that invocation is blocking on:

| Source | `kind` | `rawIdentity` (before normalization) | Notes |
|---|---|---|---|
| A worktree/branch/remote finding (`buildBlockedReason`'s `findings`) | `worktree` \| `branch` \| `remote` | the finding's `path`, `name`, or `refname` | one item per finding already in `reason`; a grouped combined item (worktree+branch+remote, §13) is still exactly one item, matching the existing 1-item-per-`reason`-line rule |
| A finding whose own `class` is `unknown` (detached-HEAD worktree, unclassifiable branch/ref) | `unknown` | the same `path`/`name`/`refname` | kept specific, **not** collapsed to a bare `unknown` bucket — collapsing would let two genuinely different unresolvable items alias onto one shared counter and let an unrelated flapping unknown mask a persistently stuck one, reintroducing BR-02's exact failure at the "unknown" bucket specifically |
| A process-level failure (`buildUnknownReason`: scope-gate, worktree-list-failed, branch-list-failed, base-branch-undeterminable, base-tree-set-failed, remote-list-failed, remote-names-failed) | `unknown` | the fixed diagnostic `label` string this file's own code already passes to `buildUnknownReason` | the label is one of this file's own constants, never git output — safe to key on directly, and stable across invocations of the same failure mode |
| A deadline expiry (`buildDeadlineReason`, any step) | `deadline` | the literal string `"deadline"` | collapsed regardless of which step timed out (§2 item 2) |

**Item key** = `` `${kind}:${normalizePathForCompare(rawIdentity) || ""}` ``.
Because `kind` is drawn from a small fixed enum never influenced by git
output, a colon or substring inside `rawIdentity` cannot alias one kind's
key onto another's — delimiter injection is closed by construction, not by
escaping.
`active`, `active-remote`, `stale-remote-foreign`, and `excluded` items
never reach this table — they never appear in a block `reason` in the
first place (base classification, unchanged), so there is no unreachable
enum value to track (this also closes BR-08: this design keys on item
*kind*, not an evidence-class bucket, so BR-08's dead `active`-bucket
concern doesn't arise here at all).

**Per-session state file** —
`<hooks dir>/state/stop-stale-worktrees-guard.<sanitized session_id>.json`:

```json
{
  "session_id": "<raw session_id, verbatim>",
  "stop_hook_active_last": false,
  "created_at": "<ISO 8601, first write>",
  "updated_at": "<ISO 8601, this write>",
  "items": {
    "<itemKey>": {
      "kind": "worktree",
      "identity": "<normalized identity>",
      "strikes": 2,
      "first_block_at": "<ISO 8601>",
      "last_block_at": "<ISO 8601>"
    }
  }
}
```

**Decision procedure, given the current invocation's item list `I` (always
non-empty when the base classification action is `"block"`):**

1. Missing/malformed `session_id` on stdin (not a string, or blank after
   the existing Unicode-strip check already used elsewhere in this repo's
   hooks) → **block**, `reason` = the original classification reason plus
   one appended line naming the missing field and stating that
   bounded-reblock tracking is disabled for this invocation; **no state is
   read or written.** This is the one case where every block behaves
   exactly as the pre-this-spec guard did — unconditionally, every time.
2. Otherwise, sweep state files older than 7 days (fail-soft), then read
   this session's state file. Any read/parse failure, a non-object body,
   or a missing/non-object `items` field is treated identically to "file
   absent": start from `{ items: {} }`. This is a safe-direction fallback
   — it can only ever *reset* progress toward a yield, never accelerate
   one, so a corrupted or tampered-toward-escape file can't force a
   premature allow this way (only a forged, well-formed `strikes >= 3`
   record can, per §2 item 3's accepted gap).
3. For every item in `I`: look up its **existing** (pre-this-invocation)
   strike count (0 if absent). Partition `I` on that pre-increment value:
   `highStrike` = existing count already >= 3 (exhausted by a prior
   invocation — left untouched, no further increment, since the decision
   for it is already settled); `lowStrike` = existing count < 3 — record it
   back with count+1, `first_block_at` preserved from the existing entry
   (or set to now, if new), `last_block_at` set to now. This is what makes
   "3 identical blocks, then a yield" land exactly on the 4th invocation
   for a single stuck item: the invocation whose increment brings a count
   to exactly 3 is still counted as a block (its *pre*-increment count was
   2, which is `< 3`) — the cap check that turns it into a yield only
   applies starting the *next* time that item is seen.
4. Write the updated state file atomically. **On write failure:** block,
   `reason` = the original classification reason plus one line naming the
   state path and the write error (§2 item 8) — regardless of what step 5
   below would otherwise have decided.
5. If `lowStrike` is non-empty: **block.** `reason` is rebuilt from only
   the `lowStrike` items' own lines (the exact same per-item text the base
   classification already produced — worktree/branch/remote items keep
   their original `formatFinding` line, including the fix commands;
   unknown/deadline items keep their original full message), re-applying
   the existing 40-item cap (`REASON_ITEM_CAP`) to this filtered list, not
   to the raw pre-filter list — an item beyond the raw 40th position must
   still be able to accumulate its own strikes even though it wasn't shown
   this cycle. If `highStrike` is also non-empty this cycle, `reason`
   gains one trailing line: `"(N item(s) omitted here after reaching the
   3-block cap; see the eventual yield summary or
   <yields-log-path>.)"` — purely informational, so an agent (or a human
   reading the transcript) isn't confused by the count not matching what
   it saw on an earlier turn.
6. If `lowStrike` is empty (every item in `I` has reached 3+ strikes):
   **allow**, with `systemMessage` = a "STALE ITEMS REMAIN" summary
   listing every `highStrike` item's line and strike count, plus the
   literal yields-log path; append one JSON-line record per yielded item
   to the yields log (§5, best-effort — a log-write failure does not
   revert this allow, since the authoritative state file already
   persisted the strike counts that justified it).

**Never delete the state file on a clean allow.** Unlike the withdrawn
round-1 design, an item's strike history is not reset just because, on
some later invocation, the overall result happens to have zero stale
items — that would let an item's count silently reset every time it
happens to intermix with a fully-resolved cycle before recurring, which is
exactly the kind of churn-driven reset BR-02 exists to prevent, generalized
from "the whole set changed" to "the item was briefly absent." The file is
only ever removed by the 7-day sweep.

## 4. Missing-`session_id` fail-closed path — worked example

`stdin.session_id` is `undefined`, `""`, or not a string. The base
classification still runs unchanged and may find zero, one, or many stale
items. If it finds zero, this spec has nothing to do (the base guard
already allows). If it finds any, the bounded-reblock layer never engages
the per-item table at all — the invocation behaves exactly as if this spec
did not exist: `reason` = the original classification text (with the same
40-item cap logic it already had, unmodified) plus:

> `[stop-guard-bounded-reblock] session_id missing or malformed on stdin: bounded re-block tracking disabled for this invocation (fail-closed). Every block behaves as an unconditional block until a valid session_id is present.`

No file is opened, read, or written for this call. This mirrors the
original G1 rule from the round-1 draft, restated here to close BR-04's
gap: the full classification `(missing session_id, item(s) present)` is
now an explicitly-named branch, not an inferred one.

## 5. Yield log format

`<hooks dir>/state/stop-stale-worktrees-guard.yields.log` — append-only,
one JSON object per line, written via a single `O_APPEND` `writeSync`
(same atomicity convention `agent-tier-ledger.js` and
`model-routing-guards.state.js` already use for their own append-only
files — never a read-modify-write). Not rotated or size-capped: this is a
durable audit trail, not a debug log, and the expected event rate (a
handful of yields per stuck item per session) is low; unbounded growth
over a very long-lived install is an accepted blind spot (§6).

```json
{"ts":"<ISO 8601>","session_id":"<raw session_id>","item":"<kind>:<normalized identity>","strikes":3,"summary":"<the item's own reason line, including class, evidence, and fix commands verbatim>"}
```

One line per yielded item, per yield event (an invocation yielding on 3
items writes 3 lines). A write failure here is swallowed (best-effort,
never reverts the already-decided allow — §3 step 6); this is the one
place in this spec where a failure is *not* fail-closed, because the
authoritative decision was already made and persisted in the state file
before this log write is attempted.

## 6. Blind spots

- **Forgeable, unsigned state file (§2 item 3).** An agent with ordinary
  file access to `<hooks dir>/state/` can read the current strike counts
  and write a forged record claiming `strikes: 3` for an item it wants to
  stop being blocked on, jumping straight to a premature yield without
  ever having attempted a fix. Accepted per this guard's established
  forgetful-agent threat model (§2 item 3); not closed by this revision.
  See `docs/specs/hook-state-write-guard.md` for a follow-on spec that
  closes most of this gap via a write-denial PreToolUse hook plus a
  tamper-evident MAC on the state file itself.
- **Session-scoped non-blocking pass, concretely.** Once an item reaches 3
  strikes, this guard never `block`s on it again **for the rest of that
  session** (§3 step 6), even if the exact same Stop chain repeats 50 more
  times — only the `block` `reason` text stops naming it (§3 step 5's
  `highStrike` items are collapsed to a one-line omitted-count footer
  there, not dropped from the record entirely). **Superseded:** this
  bullet's own next two sentences, as originally written here, claimed the
  allow-side `systemMessage` "STALE ITEMS REMAIN" summary and the durable
  yields-log line ("§5) each time") both re-emit on EVERY subsequent Stop
  for the rest of the session. `docs/specs/stop-guard-harness-branches.md`
  §4 (D2/R3) fixes exactly this: the summary and the yields-log line now
  fire once, at the invocation an item's strikes first reach the cap, per
  item, per session — later invocations where that same item is still
  present are silent (exit 0, no `systemMessage`, no yields-log write) —
  **unless** the item's content has since drifted (a branch/covered-
  worktree/remote item whose tip has moved), in which case it is treated
  as a fresh item and can block, and yield, again. See that spec's §4 for
  the full mechanics and §8 for this exact supersession note. **A concrete
  input that passes this guard but shouldn't:** a forgetful agent leaves
  one stale linked worktree in place for an entire long session; it gets
  blocked, yields after the 3rd identical block, and from that point the
  agent can end its turn as many times as it likes for the rest of the
  session with that exact worktree still sitting there — surfaced ONCE in
  the allow-side summary and the yields log (not repeatedly, per the
  supersession above), but never again forcing a `block`, so nothing
  compels the agent to act on it. Only a brand-new `session_id` clears
  this.
- **`stop_hook_active`-driven cycle amplification (BR-07/round-1 finding
  #9), not specifically bounded.** A *different* Stop hook's own block/
  retry cadence can burn through this guard's 3-strike budget on a
  genuinely unfixed item purely by causing more Stop cycles per unit time,
  independent of how much real remediation time has passed. This spec
  does not add a wall-clock floor (the round-1 draft considered one and
  the round-2 adversary pass did not press it as a blocker); a fast enough
  cycle rate could still reach yield well before async remediation
  (incident 2's own scenario) plausibly finishes. Accepted, not closed —
  the owner's ruling (§2) treats "friction is cheap, a session boundary
  resets it" as sufficient mitigation rather than adding time-based logic
  on top of the count-based one.
- **Whether `systemMessage` reaches the model at all is still unconfirmed**
  (original open question 3, restated). This spec's answer is to not
  depend on it — the durable yields log (§5) is the record of record for
  a headless/CI run regardless of the answer — but the human-facing
  summary itself may never be seen by anything, model or transcript-only
  UI, depending on platform behavior not verified by this pass.
- **Branch/ref names are case-folded on Windows identically to paths**
  (§3's identity rule reuses `normalizePathForCompare` uniformly). Git
  branch and ref names are case-sensitive by git's own rules; two
  distinctly-named branches differing only by case (`Feature-X` vs
  `feature-x`) would collide onto the same item key. This repo's own
  documented target platform is Windows (case-insensitive end-to-end,
  same rationale `normalizePathForCompare`'s own comment already states
  for paths), so this is treated as consistent with an existing accepted
  convention rather than a new gap — but it is a genuine, if narrow,
  expansion of that function's use into a domain (ref names) it wasn't
  originally written for.
- **A branch/worktree rename, or an evidence-class boundary (e.g. the
  quiet-window line) flipping between calls, produces a new item identity
  and therefore a spurious strike reset for what is effectively the same
  underlying item.** This causes one extra block cycle, never a silent
  allow — accepted as safe-direction noise.
- **Unbounded yields-log growth** (§5) over a long-lived, never-restarted
  install. Accepted given the expected low event rate; no rotation is
  applied so the record stays complete rather than lossy.
- **7-day sweep boundary on a still-open, very long session.** A session
  running longer than 7 days would have its own state file swept out from
  under it, silently resetting every item's strike count to 0 on the next
  block. Accepted as an edge case far outside normal session lifetimes,
  consistent with the same sweep convention `agent-tier-ledger.js` already
  uses for its own state.

## 7. Open questions

1. **(Resolved this revision.)** Original Q1 — cross-session re-block for
   operator-only items — resolved by owner ruling §2 item 6: operator-only
   items get the identical per-item accounting, annotated in `reason`.
2. **(Resolved this revision.)** Original Q2 — whether a yield marker
   should persist into a resumed session — resolved by owner ruling §2
   item 5: it does not; a new `session_id` always starts at 0.
3. **(Still open, unresolved.)** Whether Claude Code's Stop-hook
   `systemMessage` field is fed back into the model's context or is
   transcript/UI-only. Neither this pass nor the round-2 adversary pass
   could confirm this by reading code; it decides how much weight the
   yield summary itself carries beyond the durable log (§5, §6). **Lean:**
   assume it is *not* model-visible (the conservative, already-adopted
   default per §2 item 4) until a platform-doc read or an empirical
   harness run settles it — no code in this spec depends on the answer
   either way, so this is not a blocking fork for implementation, only for
   how much operators should trust the in-transcript message alone.

## 8. Test matrix (adds to `stop-stale-worktrees-guard.md` §7, unchanged
there)

`node:test`, following the existing suite's real-temp-git-repo pattern
where classification is involved; the bounded-reblock layer itself is
exercised via direct calls to its own exported function with injected
`fs`/`now`/`stateDir`, mirroring how `deadline_exceeded_blocks_with_partial_
classification` already injects `execGit`/`now` into `evaluateStop`.

| Test | Fixture | Expected |
|---|---|---|
| `reblock_three_identical_blocks_then_yield` | one stale item, session_id fixed, called 4 times in sequence against the same state dir | blocks 1-3 name the item; call 4 allows, `systemMessage` names the item and the yields-log path, one JSON line appended to the log |
| `reblock_per_item_independence` | item A blocked 2x (2 strikes), then item B newly appears on the 3rd call alongside A | A reaches 3 strikes and would be omittable, but B is fresh (1 strike) — overall result still blocks, `reason` lists B (and, per the omission-trailer rule, notes A was omitted) |
| `reblock_churn_does_not_reset_strikes` | item A blocked twice, absent on call 3 (some unrelated item B present instead), then A reappears on call 4 | A's stored strike count is 2 after call 1-2, untouched by call 3 (A absent, B tracked separately), and increments to 3 (yields) on call 4 — not reset to 1 |
| `reblock_identity_normalization_case_and_separator` | the same worktree path presented with different case and separator style across two calls (Windows) | both calls increment the SAME item key, not two different ones |
| `reblock_missing_session_id_blocks_no_state_write` | stdin `session_id` omitted, one stale item | blocks, reason names the missing field, no file created in the state dir |
| `reblock_state_write_failure_blocks` | `fs.writeFileSync`/`renameSync` injected to throw | blocks, reason names the state path and the injected error, regardless of strike count |
| `reblock_yield_log_line_written` | one item reaches 3 strikes | exactly one well-formed JSON line appended to the yields log with `ts`, `session_id`, `item`, `strikes`, `summary` |
| `reblock_env_bypass_writes_no_state` | `JUDGE_STOP_GUARD=off`, stale item present | allow via the existing bypass path; no file created or modified under the state dir |
| `reblock_seven_day_sweep_removes_old_state` | a state file for an unrelated session_id backdated past 7 days via injected `fs.statSync`/mtime | that file is removed on the next run; the current session's own file is unaffected |
| `reblock_state_write_atomicity_temp_then_rename` | injected `fs.writeFileSync`/`renameSync` spies | write targets a temp path first, then `renameSync`s it onto the final state path — never writes the final path directly |
| `reblock_deadline_item_collapses_across_steps` | deadline expires on different steps across two calls (base-branch-resolution, then worktree-list) | both calls increment the SAME `deadline` item key, not two |
| `reblock_operator_only_item_annotated` | a branch/remote item whose fix includes `git push <remote> --delete` | its line in `reason` (and, once yielded, in the summary) carries the "(externally visible, run it or ask the operator)" suffix |
| `reblock_stop_hook_active_recorded_not_branched` | `stop_hook_active` toggled true/false across calls, item otherwise identical | decision and strike count are identical either way; state file's `stop_hook_active_last` reflects the most recent value |
| `reblock_forty_item_cap_applies_after_yield_filtering` | 42 low-strike items plus 3 already-yielded (high-strike) items in one invocation | `reason` shows the first 40 of the 42 low-strike items plus "...and 2 more" — the cap counts only the filtered list, not the raw 45 |

## 9. Adversary change log (round 2, BR-01..08)

| Finding | Sev | Resolution | Section | Rationale |
|---|---|---|---|---|
| BR-01 | BLOCKER | accepted, not closed | §2 item 3, §6 | Unsigned state is forgeable by an agent with directory access; closing it (HMAC or similar) was rejected as disproportionate to this guard's forgetful-agent, not adversarial-agent, threat model — same precedent as `stop-stale-worktrees-guard.md` R2-A2/R4-05. |
| BR-02 | BLOCKER | fixed | §2 item 1, §3 | Replaced the whole-item-set fingerprint with a per-item strike table keyed on item identity — ordinary membership churn in unrelated items can no longer perturb a persistent item's own count. |
| BR-03 | BLOCKER | fixed | §2 item 2, §3 | `deadline` items collapse to one literal identity regardless of which step timed out; `unknown` items keep their specific path/ref (a deliberate, narrower fix than the adversary's proposed bucket-only identity for both classes — see BR-03's own row below for why `unknown` was NOT collapsed the same way). |
| BR-04 | BLOCKER | fixed | §3 (decision procedure), §4 | The `(session_id validity, state-presence, item overlap)` classification is now total and explicit: missing/malformed session_id (§4), state absent-or-corrupt (§3 step 2, treated identically), and every item's fresh-vs-recurring status (§3 step 3) are each a named branch, not an inferred gap. |
| BR-05 | MAJOR | accepted per owner ruling, mitigated by session-scoping | §2 item 5, §6 | The owner explicitly declined the adversary's proposed session-lifetime yield cap, ruling instead that a per-item silent-pass is acceptable for the remainder of the CURRENT session only, since a new session_id is a natural, agent-uncontrollable reset boundary. Documented in Blind spots with the concrete failing input, per this project's canon on disclosing known gaps rather than silently shipping them. |
| BR-06 | MAJOR | fixed by construction | §3 (decision procedure), §9 note | The per-session, per-item model has no time-based staleness field at all (no "state older than N hours" check) — a session's state is scoped for the session's whole lifetime and only ever removed by the file-mtime-based 7-day sweep, not a self-reported timestamp a clock-skew could corrupt. There is nothing for a backward clock jump to defeat. |
| BR-07 | BLOCKER | fixed | §2 item 4, §5 | A durable append-only yields log at a fixed, `systemMessage`-stated path is now the record of record for a yield, independent of whether `systemMessage` itself ever reaches the model (open question 3, still unresolved but no longer load-bearing). |
| BR-08 | MINOR | not applicable by design | §3 | This design keys item identity on structural *kind* (worktree/branch/remote/unknown/deadline), never on an evidence-class bucket — there is no `coarseBucket` enum for an unreachable `active` value to occupy in the first place. |

## 10. Handoff status

Not authored by claude-memory; the fix belongs to the judge project by
owner ruling. A stopped author agent's worktree (`judge-stopguard`, branch
`fix/stop-guard-bounded-reblock`) produced one uncommitted, partial diff
with no commits ahead of `origin/main` and no remote branch or PR —
preserved verbatim at the sibling `.partial-diff.patch` file, reference
only, not applied verbatim (its `items`-extraction shape is reused in
spirit, per §2 item 9, but its whole-set-fingerprint framing is
superseded by this revision).

This revision (round 2) supersedes the original round-1 draft that a
dedicated adversary pass reviewed before any of it was implemented — see
§9's change log for the full disposition of that pass's 8 findings. No
code exists yet for either draft; `hooks/stop-stale-worktrees-guard.js`'s
classification pass (worktrees, branches, remote-tracking refs) is
entirely unaffected and unchanged by this spec (§2 item 9).

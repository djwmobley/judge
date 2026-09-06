# judge PR 2 — port `agent-model-routing-guard.js`

**Audience:** a fresh Claude Code session in the local `judge` repo checkout
with no memory of the source repo. Read this whole file before writing code.

## 0. TL;DR

Port a private hook, `agent-model-routing-guard.js` (+ its test file), from
`~/.claude/hooks/` (NOT from any git repo — see §2) into the `judge` repo,
following the exact process PR #1 (merge `b8657b82a6e752854f1176192d257d81047b6e88`)
used for the other nine guards. The guard enforces: every `Agent`/`SendMessage`
dispatch must declare a real model tier on the `model` field (no absent/
wrong-value dispatch, ever); a `planning`-tier dispatch needs a standalone
`PLAN-ONLY:` line unless its `subagent_type` is on a small exempt list;
every dispatch needs a standalone `REPORT CAP: N words` line; `subagent_type:
"fork"` is blocked unconditionally, unicode-smuggling included. **The single
hardest problem in this port is not mechanical**: the guard's core branching
compares the private source's hardcoded model literals, and judge's own
`test/test-public-scan.js` fails the build on those exact literals anywhere
in a tracked file (`test/test-public-scan.js:64-67`). §4 and §6 spell out how
to resolve that without weakening the guard.

## 1. Purpose and non-goals

**Purpose:** stop a dispatch (`Agent` tool, or `SendMessage` to a
teammate/subagent) that violates the Model Routing rule — the orchestrator
tier delegates instead of drafting; the planning tier only ever returns a
plan; every dispatch report is capped; a `fork` subagent never masquerades
as a fresh tier. This is Hook 1 of a two-hook family; Hook 2
(`orchestrator-tool-guard.js`, already in judge) enforces the sibling rule
for `Read`/`Bash`/`Write`/`Edit`.

**Non-goals:** this port does not touch `orchestrator-tool-guard.js`'s own
logic; does not build the §17 "agnostic model-routing harness" (`route_resolve`,
`routing_profile_*`, `usage_*` MCP tools) — that is a different subsystem
living in `claude-memory`'s `scripts/lib/route-resolve.js` and friends, audited
separately in `docs/notes/2026-09-06-s17-routing-gap-audit.md`. That audit is
**not** the motivation for this guard and should not be cited as history for
it (see §8). Do not build the larger "routing guard + resolver + policy
schema + identity ledger" PR that an earlier planning note
(`project_judge_repo_design.md`) once called "PR 2" — this task supersedes
that framing; PR 2 here is exactly the guard port described above.

## 2. History

- **Never in claude-memory's git history.** `git log --all --diff-filter=A
  --name-only -- 'hooks/*'` shows exactly three files ever added under
  `hooks/`: `agent-adversary-floor.js`/`.test.js` (PR #147, 2026-07-26),
  `hooks/hooks.json` (2026-05-18), `pr-independence.js`/`.test.js` (PR #52,
  2026-05-18). `agent-model-routing-guard.js` is not among them, ever. It
  lives only at `~/.claude/hooks/agent-model-routing-guard.js` (mtime
  2026-09-06) — private, user-scope, never committed anywhere.
- **claude-memory PR #257** (`4cf6ace`, 2026-09-06) removed
  `agent-adversary-floor.js`/`.test.js` and `pr-independence.js`/`.test.js`
  from `hooks/` plus their `hooks/README.md` sections, `MANIFEST.md`
  entries, `CONTRIBUTING.md` Step 10, and two CI steps, because judge PR #1
  shipped the same logic publicly. **No exact analog exists for
  `agent-model-routing-guard.js`** — there was never a committed copy to
  remove; §5 step 8 covers the actual claude-memory follow-up here.
- **judge PR #1** (`b8657b8`, merged 2026-09-06) ported nine guards plus the
  shared plumbing files `model-routing-guards.{state,unicode,log,exempt,rules,paths}.js`,
  `hooks/lib/local-policy.js`, `hooks/local-policy.example.json`,
  `docs/independence.md`, `test/test-public-scan.js`, and
  `scripts/install-guards.js`. It did **not** port `agent-model-routing-guard.js`
  itself — judge currently has 9 registered guards
  (`scripts/install-guards.js:52-77`), and this PR brings it to 10.
- **Judge's copies of the shared unicode/exempt helpers are stale relative
  to the private source** — ported before later hardening rounds on the
  private hook. `diff` shows judge's `hooks/model-routing-guards.unicode.js`
  still strips only `\p{Mn}` and has **no `stripInvisible` export at all**;
  the source at `~/.claude/hooks/model-routing-guards.unicode.js:53-57,92-95`
  strips the full `\p{M}` class (`Mn+Mc+Me`) via `stripNormalize` and adds a
  narrower `stripInvisible` (Cf/Cc only) for the exempt-type allow compare.
  `model-routing-guards.exempt.js` differs only in comment wording (judge
  says "planning-tier-row"; the source's own comment for the same row uses
  its private hardcoded tier literal instead — logic identical).
  `model-routing-guards.log.js` is byte-identical.
- **A prose mention does exist, in a gitignored/untracked local file, not
  git history.** claude-memory's `.gitignore` line 52 excludes
  `/CONSOLIDATION-RUNBOOK.md` from version control (confirmed: the file is
  absent from a fresh worktree checkout of the same repo), so its mention of
  `agent-model-routing-guard.js` does not contradict "never in claude-memory's
  git history." That file's §17.7 item I (2026-09-06) reads: "Live guard fix
  2026-09-06: agent-model-routing-guard.js blocks subagent_type "fork"
  unconditionally... Adversary open items carried to judge PR 2: REPORT CAP
  inside fences/quotes escapes the regex; SendMessage has no per-agent tier
  ledger; case-sensitivity of model arg is an owner call." These three items
  are folded into §5 step 1's required attack classes below. All three are
  now closed by owner decision, recorded in §4 and cross-referenced in §5's
  Adversary findings subsection: the REPORT CAP/PLAN-ONLY fence-and-quote
  escape is closed by the exactly-once bare-standalone-line rule (decision
  D2); the missing per-agent tier ledger is closed by the ledger design
  added to this PR's scope (decision D3); and the model-literal
  case-sensitivity question is closed by making the comparison
  case-insensitive via a strip/normalize-then-lowercase fold applied to
  both the config key and the dispatch value (decision D1).
- The CLAUDE.md model-routing rule (the orchestrator tier orchestrates, the
  planning tier plans under a succinct brief, the drafting tier drafts, the
  mechanical tier does mechanical lookups; reviewers are always
  `model: <drafting-tier-literal>`, never model-less) is what the guard
  encodes.
  claude-memory's CLAUDE.md cites "§17 B1 model/routing overrides" (PR #241)
  and "fork block + split normalization (52/52)" as this rule's evolution —
  unverified against actual commit diffs (§8) — but per the point above, the
  `.js` file itself was built and hardened entirely outside git.

## 3. Current behavior spec (source: `~/.claude/hooks/agent-model-routing-guard.js`)

Wired today as a `PreToolUse` hook, matcher `Agent|SendMessage`, in the
user's own hook configuration (shape only, per task constraints: an
event→matcher→command entry, not the literal settings path). Reads one JSON
object from stdin (`{tool_name, tool_input}`), writes findings to stderr,
exits 0 (allow) or 2 (block). Never writes to stdout.

**Fail-open is narrow** (`agent-model-routing-guard.js:15-18,65-68,235-253`):
only a stdin-read failure, a `JSON.parse` failure, or a parsed-non-object
payload exit 0 without evaluation. Everything else — including a
missing/empty `tool_name` or any internal exception after a successful
parse — is a named **block**, never fail-open (`:280-293`).

Two independent normalization keys are used, stripped in *opposite*
directions on purpose (`:99-117`, doc comment `model-routing-guards.unicode.js:69-95`):
- `blockKey` = `stripNormalize` (Cf + Cc + full `\p{M}` + Z-collapse, then
  trim) — used **only** for the fork gate. Safe to over-strip because it can
  only ever *add* blocks.
- `allowKey` = `stripInvisible` (Cf/Cc only, no marks, no case-fold, then
  trim) — used **only** for the `EXEMPT_TYPES` lookup. Must under-strip
  because it can *grant* an allow; a mark-decorated impostor
  (`"Exṕlore"`) must not fold into a real exempt name.

| Input shape (`tool_name` / `tool_input`) | Result | Exit | Finding id |
|---|---|---|---|
| stdin unreadable, invalid JSON, or parses to non-object | allow (fail-open) | 0 | — |
| `tool_name` missing/empty, or anything other than `Agent`/`SendMessage` | block | 2 | `unexpected_tool_name` |
| `tool_input` is `null`/non-object | treated as `{}` → falls through per-field rules below | 2 (Agent: no model) | varies |
| Agent, `subagent_type` normalizes (blockKey) to exactly `"fork"` (trim; case-sensitive; invisible/combining chars stripped first) | block, short-circuits every other check | 2 | `fork_subagent_forbidden` |
| Agent, `subagent_type` = `"Fork"` (wrong case) or any non-"fork" string | not a fork; falls through to model branch | varies | varies |
| Agent, `model` absent, or (after the strip+fold+lowercase pipeline, §4 D1) empty, or not resolvable to a configured `model_tiers` entry (wrong type, whitespace, array, number, any unconfigured string) | block, unconditional — no exemption of any kind | 2 | `model_missing_or_invalid` |
| Agent, `model` resolves to the `drafting` or `mechanical` tier | model check passes; still needs REPORT CAP line | 0/2 | `report_cap_missing_or_invalid` if absent |
| Agent, `model` resolves to the `planning` tier, prompt has standalone `PLAN-ONLY: no writes, no edits, no shell; return a plan only.` line (trailing period optional) | planning check passes | 0/2 | needs REPORT CAP too |
| Agent, `model` resolves to the `planning` tier, no PLAN-ONLY line, `subagent_type` (allowKey) in `PINNED_EXEMPT_TYPES` (`Explore`, `Plan`, `claude-code-guide`, `plugin-dev:plugin-validator`, `plugin-dev:skill-reviewer`) | planning check passes via exemption | 0/2 | needs REPORT CAP too |
| Agent, `model` resolves to the `planning` tier, no PLAN-ONLY line, `subagent_type` not exempt | block | 2 | `planning_prose_missing` |
| `prompt`/`message` field > 100,000 chars | block, skips regex entirely | 2 | `oversized_field` |
| no standalone `REPORT CAP: N words` line, `1 <= N <= 500` (mid-sentence mention doesn't count; `\d{1,3}` bounds N to ≤ 999 syntactically, then range-checked) | block | 2 | `report_cap_missing_or_invalid` |
| SendMessage, any `message` shape — model rules never apply, only the REPORT CAP floor | allow/block per cap line only | 0/2 | `report_cap_missing_or_invalid` |
| `EXEMPT_TYPES` drift (the file's own snapshot vs. `agent-adversary-floor.js`'s live export disagree in membership) | exempt set forced to `[]` for that run (never widens) | — | logged, not a finding |

**Target-only refinements decided for this port (owner decisions D1/D2; not
present in the source's behavior described above):** the `model` comparison
against `model_tiers` keys is case-insensitive in judge's ported guard —
apply the existing strip/normalize helper then `toLowerCase()` to both
sides — whereas the table above shows the private hook's current
case-sensitive literal match. Separately, the REPORT CAP and PLAN-ONLY line
match is tightened beyond the source's plain `^...$` `/m` regex: a match
only counts if it is a bare standalone line (optional leading whitespace
only; no blockquote marker; no list marker; not inside a fenced code
block). Fence tracking follows CommonMark exactly (owner decision A7,
folded in this revision): a fence opens on a line with up to 3 leading
spaces followed by 3 or more identical backtick or tilde characters and an
optional info string; it closes only on a later line with the same fence
character, a run at least as long as the opener's, and nothing else on the
line but whitespace; an unclosed fence runs to the end of the text; a fence
that appears inside a blockquote is still a fence for this purpose. Before
any REPORT CAP/PLAN-ONLY/RECIPIENT TIER bare-line matching runs, the text is
normalized (owner decision A8): CRLF and lone CR are converted to LF, then
the invisible-character strip is applied to each line — so two otherwise-
identical lines that differ only in invisible characters count as two
separate matches, not one. Zero qualifying matches still blocks. Two or more
qualifying lines — valid or invalid content, counted the same way,
including two lines that differ only in stripped invisible characters — now
also blocks, with a distinct finding (`report_cap_ambiguous` /
`plan_only_ambiguous`) rather than accepting the first or last. A line
inside a fence or a blockquote is illustrative, not the dispatch's own
commitment, and no longer satisfies or defeats the requirement. The
`RECIPIENT TIER:` declaration line (§4's ledger subsection) follows the
identical post-normalization bare-line rule (owner decision A9): trimmed,
case-insensitive match of the literal `RECIPIENT TIER:` followed by one of
the three tier names (folded the same way as a `model_tiers` value, §4 D1),
an optional single trailing period, and nothing else, exactly once.

**Known undetectable case** (documented, not a bug): a homoglyph
(different-codepoint, visually-identical character, e.g. Cyrillic "о" for
Latin "o") is not stripped by either normalization function and will not
match `"fork"`/`PINNED_EXEMPT_TYPES`/the regex lines, **nor the
`RECIPIENT TIER:` line's tier name** — this is a genuine blind spot of the
guard itself, not just of this port.

## 4. Target shape in judge

Add one new entry to `GUARDS` in `scripts/install-guards.js:52-77`:
`{ id: 'agent-model-routing-guard', file: 'agent-model-routing-guard.js', event: 'PreToolUse', matcher: 'Agent|SendMessage' }`
— tenth guard, same shape as the `agent-adversary-floor`/`agent-permission-preflight`
entries already there. Add a `### agent-model-routing-guard.js` section to
`hooks/README.md` following the existing per-guard format (event, blocks,
depends-on). Per the ledger addition (owner decision D3, detailed later in
this section), a second `GUARDS` entry is also needed —
`{ id: 'agent-model-routing-guard-ledger', file: '<same or sibling file,
per D3>', event: 'PostToolUse', matcher: 'Agent' }` — bringing the total to
eleven entries, not ten; §7's acceptance criteria is updated accordingly.

**The literal-model-string problem (must be resolved, not routed around):**
`test/test-public-scan.js:64-67,87` bans the four model-family names and any
pattern shaped like a model-version identifier (letters followed by a
trailing digit segment), case-insensitive substring match, no allowlist for
real content (`:93-99` — that allowlist is for the scanner's own self-test
only). The source's branching on its own hardcoded model literals
(`:136-138`) and ~40 test-file literals cannot ship verbatim. Per
`project_judge_repo_design.md`/`project_one_public_project_scope.md`:
**"hard-coded model name = merge blocker."** Resolve by extending the local-
policy mechanism (`hooks/lib/local-policy.js:34-71`,
`hooks/local-policy.example.json`) with a new key, `model_tiers`: an object
mapping the operator's real model literal(s) to one of `"planning"` /
`"drafting"` / `"mechanical"` (README's tier vocabulary,
`hooks/README.md:16-22`). `local-policy.example.json` ships a **placeholder**
(e.g. `"<your-planning-tier-model-name>": "planning"`), never a real model
string — the example is scanned too. `loadLocalPolicy()` gains this fourth
field, falling back to `{}` like the other three fall back to their
defaults. When `model_tiers` is empty/absent, every dispatch blocks on
`model_missing_or_invalid` — consistent with the guard's existing
fail-closed posture (absent model already blocks unconditionally, `:141-146`),
so this is the expected state until the operator configures
`local-policy.json`, not a new failure mode. Test fixtures must use fake
tier-literal strings (e.g. `"planning-model-x"`); check every new/ported
test string against the scanner before calling the port done.

**Case-fold and shape-validation algorithm for `model_tiers` (owner decision
D1):** comparison is case-insensitive — apply the guard's existing unicode
strip/normalize helper, then `toLowerCase()`, to both the `model_tiers`
config key and the dispatch's `model` value before comparing.
`loadLocalPolicy()` performs this same fold on every `model_tiers` key at
load time, not at each call site. If two keys collide after folding (e.g.
two literals differing only by case, or by a stripped invisible/combining
character), the *entire* `model_tiers` field is invalid for that load and
falls back to `{}` — fail closed, not last-key-wins. A `model_tiers` key
that folds to the empty string (e.g. a literal made up entirely of
invisible/combining characters) is treated the same way (owner decision
A1): the *entire* field is invalid and falls back to `{}`, not merely
dropped as one empty-keyed entry. On the dispatch side, a `model` value
that folds, via the same strip+fold+`toLowerCase()` pipeline, to the empty
string is `model_missing_or_invalid` — the same finding as an absent
`model` field, not a distinct case. `model_tiers` must also satisfy
`typeof === 'object' && !Array.isArray(...) && ... !== null`; any other
shape (array, string, number, `null`) falls back to `{}`, exactly like the
three fields `loadLocalPolicy()` already validates
(`hooks/lib/local-policy.js:60-76`, confirmed on read: today's fields are
`roots`, `gated_extensions`, `exempt_types`, each independently defaulted —
`model_tiers` becomes the fourth field, added the same way). Every tier
*value* goes through the identical strip+fold+`toLowerCase()` pipeline used
for keys, after an initial `.trim()` (owner decision A2) — so casing of the
tier name in config (e.g. mixed-case variants of `planning`/`drafting`/
`mechanical`) does not matter — and must equal exactly one of `planning`,
`drafting`, or `mechanical` once folded; a non-string tier value, or any
string that still fails to match after that fold, invalidates the *whole
field* (fall back to `{}`), not just that one entry. Separately:
`JSON.parse` resolves a duplicate `model` key inside the
dispatch's own `tool_input` last-wins before the guard ever sees the
payload, so the guard evaluates only the single already-resolved value —
noted for the adversary record (§5) as a non-issue, not a code change.

### Per-agent tier ledger (PR 2 scope addition — owner decision D3, amended)

D3 adds a second guard registration and a small persistent ledger so a
`SendMessage` dispatch can be checked against the tier the recipient was
actually spawned with, closing the "no per-agent tier ledger" adversary
item (§2).

- **Capture.** New `PostToolUse` registration, matcher `Agent`, same guard
  file (`hooks/agent-model-routing-guard.js`), branching on
  `hook_event_name` at the top of the handler rather than a second file —
  the author may instead split capture into a sibling
  `hooks/agent-tier-ledger.js` if that proves cleaner; either way, state
  the chosen layout in the PR description and in `hooks/README.md`. From
  `tool_input`: `model`, `subagent_type`, `description`. From
  `tool_response`: the spawned agent's id and display name. From top
  level: `session_id`. The resolved tier (via `model_tiers`) is stored
  alongside the raw model literal, never in place of it.
- **REQUIRED VERIFICATION STEP for the author.** The exact field path of
  the agent id inside the `Agent` tool's `PostToolUse` `tool_response` is
  unverified as of this spec. Before wiring capture, the author must
  register the hook, run one real dispatch, capture the raw payload to the
  debug log, and document the confirmed field path in this spec and in
  `hooks/README.md`. If the id field is absent from the observed payload,
  capture logs a warning once per process and records nothing for that
  dispatch; a `SendMessage` naming that recipient then falls to the
  "unknown recipient" branch below, same as if no `Agent` dispatch had
  ever been captured.
- **Record shape — metadata only (amended by the coordinator after D3).** A
  ledger record carries exactly: agent id, display name, raw model
  literal, resolved tier, `subagent_type`, `description`, `session_id`, an
  ISO timestamp, and `rules_version` (below). It never stores the prompt
  body, the `message` body, or any tool result, under any circumstance.
  This is a hard rule, not a size-tuning choice: the ledger exists to
  support live enforcement lookups, not audit or replay, and must stay
  small and cheap to append/scan on every dispatch. A future audit or
  replay use case is explicitly out of scope for this PR (see Retention,
  below) and must not be used to justify widening the record shape later
  without a fresh spec.
- **`rules_version` (amended by the coordinator after D3).** A string: the
  guard file's own exported version constant, plus a short hash — the
  first 12 hex characters of a sha256 digest of the local-policy file's
  raw bytes at the moment of capture. If no local-policy file is present
  at capture time, the hash component is the literal string `nopolicy`
  rather than a hash of nothing. Rationale: a later audit comparing a
  dispatch's guardrails against what the recipient actually did needs to
  discard records written under rules that have since changed; tagging
  the rules version at write time avoids a migration pass later. The hash
  is computed once, at `PostToolUse` capture time — a distinct read of the
  policy file from whatever `PreToolUse` read enforced the dispatch itself
  (owner decision A3); §8 documents the accepted gap this opens.
  `rules_version` is recorded but not evaluated by any PR 2 lookup or
  block decision — see Retention below and the Blind spots this revision
  reports (§8).
- **Storage.** `hooks/state/agent-tier-ledger.<sanitized session_id>.jsonl`,
  reusing `STATE_DIR`, `sanitizeForFilename`, `resolveSessionKey`, and
  `cleanupOldStateFiles` from `hooks/model-routing-guards.state.js`
  (confirmed real exports on read) — the same two-step key derivation
  `orchestrator-tool-guard`'s ledger already uses:
  `sanitizeForFilename(resolveSessionKey(session_id, now).key)`. **Caveat
  found on read, not assumed:** `cleanupOldStateFiles` today hardcodes its
  own module-level `LEDGER_PREFIX` (`"orchestrator-tool-guard."`) and
  `LEDGER_SUFFIX` (`".ledger"`) — it does not currently accept a
  prefix/suffix parameter, so it cannot sweep an `agent-tier-ledger.*.jsonl`
  file as written. The author must generalize `cleanupOldStateFiles` to
  take a prefix/suffix (or equivalent glob) argument, defaulting to
  today's constants so Hook 2's existing sweep behavior and tests are
  unchanged, then call it a second time with the new prefix/`.jsonl`
  suffix for the 7-day ledger sweep. `ledgerPathForKey`/
  `appendLedgerRecord`/`readLedgerCount` are tab-delimited and
  prefix-bound to the orchestrator ledger; the new ledger is JSONL (one
  `JSON.stringify`'d record per line) and needs its own append/read
  functions, only reusing the four helpers named above. Append is one
  `O_APPEND` `writeSync` per record — no read-modify-write, same TOCTOU
  rationale already documented in `model-routing-guards.state.js`'s header
  comment.
- **Reader.** Parses the whole file; the last record per agent id wins (a
  later append supersedes an earlier one for the same id). Malformed lines
  (bad JSON, or missing a required field) are skipped and logged once per
  read call, never once per bad line.
- **Retention (amended by the coordinator after D3).** Stays at the
  operational 7-day sweep already used for Hook 2's ledger — no change to
  that window. The audit/replay use case implied by `rules_version` and
  any retention beyond 7 days are explicitly **out of scope** for PR 2;
  the record shape above (metadata only, `rules_version` included) is the
  *only* accommodation made for that future use, not a promise of when or
  whether it ships.
- **Lookup on `SendMessage` `PreToolUse`.** Reads every
  `agent-tier-ledger.*.jsonl` file in the state directory, not only the
  current session's file, and merges the resulting records before matching
  (owner decision A4) — capture still appends only to the current session's
  own file, per Storage above; lookup is the read side that widens. Strip/
  normalize and trim the `to` field; match, in order, exact agent id, then
  exact display name, then normalized display name, across the merged set.
  Multiple ledger records matching with differing tiers is ambiguous, not a
  pick-first, whether those records came from one file or several.
- **Total classification of `to`:** non-string or blank-after-strip → BLOCK
  (`recipient_invalid`). Resolves to exactly one record whose `tier` field
  is present and equals `planning` → the `message` must carry both a
  PLAN-ONLY line and a REPORT CAP line. Resolves to exactly one record
  whose `tier` field is present and equals `drafting` or `mechanical` →
  REPORT CAP only. Resolves to exactly one record whose `tier` field is
  present but is not one of the three valid tier names — including an
  empty string — → BLOCK (`ledger_record_tier_invalid`, owner decision A5);
  this is a fourth, terminal branch, distinct from both a clean resolution
  and the unknown branch below, and does not fall through to a declared
  `RECIPIENT TIER` line. Ambiguous (2+ differing-tier matches) or no match
  at all → the
  **unknown branch**: REPORT CAP is required plus exactly one bare
  standalone line `RECIPIENT TIER: <planning|drafting|mechanical>` (same
  bare-line rules as the REPORT CAP/PLAN-ONLY lines above — no fence, no
  blockquote, no list marker, exactly once); that declared tier's rules
  are then enforced. A ledger record, when one unambiguously resolves,
  **always overrides** a declared `RECIPIENT TIER` line — the declaration
  is a fallback for the unknown branch only, never a way to self-report
  around an actual ledger record. A missing declaration in the unknown
  branch → BLOCK (`recipient_tier_unknown`). Every declaration is logged
  regardless of outcome.
- **Tests to add** (names, node:test): `capture_records_agent_id_and_tier`,
  `capture_missing_tool_response_id_records_nothing`, `lookup_by_id_exact`,
  `lookup_by_name_exact`, `lookup_ambiguous_name_two_tiers_blocks`,
  `sendmessage_to_planning_without_plan_only_blocks`,
  `sendmessage_to_drafting_cap_only_allows`,
  `unknown_recipient_without_declared_tier_blocks`,
  `unknown_recipient_with_declared_tier_allows`,
  `ledger_record_overrides_declared_tier`, `concurrent_appends_no_lost_record`,
  `stale_ledger_pruned_after_7_days`, `blank_or_invisible_to_blocks`, and
  (coordinator amendment) `ledger_record_carries_rules_version_and_no_bodies`
  — asserting the record contains only the nine listed metadata fields and
  none of `prompt`, `message`, or any tool-result content.
- **Files touched by the ledger addition, beyond §4's guard-port list
  above:** either `hooks/agent-model-routing-guard.js` gains the
  `PostToolUse` branch, or a new `hooks/agent-tier-ledger.js` is added —
  author's call, stated in the PR description; `hooks/model-routing-guards.state.js`
  (generalize `cleanupOldStateFiles`, per the Storage caveat above);
  `scripts/install-guards.js` (second `GUARDS` entry, `PostToolUse`/
  `Agent`, same or sibling file); `hooks/README.md` (new ledger subsection
  under the guard's existing section, or its own section if capture lives
  in a sibling file). The test-count arithmetic in §5 step 3 is updated to
  include the ledger tests above.

Upgrade `model-routing-guards.unicode.js` in judge to match the source:
widen `stripNormalize` to full `\p{M}` and add `stripInvisible`
(`~/.claude/hooks/model-routing-guards.unicode.js:53-57,92-95`). Confirm
this doesn't regress `orchestrator-tool-guard.js`'s existing tests, which
also call `stripNormalize` — the widening only ever strips *more*, but
re-run the full suite to confirm rather than assuming. `exempt.js` needs no
functional change (comment-only diff); leave judge's "planning-tier-row"
wording as-is.

## 5. Work path

1. **Spec-adversary pass BEFORE authoring** (matcher/gate: canon requires
   this against the spec, not the code). Dispatch a fresh
   `model: <drafting-tier-literal>` agent against §3's table. Required
   attack classes: invisible/format chars (zero-width space, BOM) in
   `subagent_type` and the PLAN-ONLY/REPORT CAP lines; combining marks
   (Mn/Mc/Me) decorating `"fork"` and an exempt-type name; casing variants
   (`"Fork"`, and a mixed-case variant of the `planning` tier name);
   whitespace runs;
   JSON key aliasing (`Model`, nested `tool_input.model`); model-name
   aliasing under the new `model_tiers` config (two literals mapped to the
   same tier; a literal mapped to an invalid tier); zero-width-decorated
   `subagent_type` variants of `"fork"`; **the three items already known and
   carried over from the private source's own adversary log (§2): a
   PLAN-ONLY/REPORT CAP line wrapped in a code fence or quoted block (the
   regex is `^...$` under `/m` and is not fence/quote-aware, so a wrapped
   line may fail to match when it should, or a quoted example may match when
   it shouldn't); SendMessage has no per-agent tier ledger to check a
   declared tier against actual prior usage; and whether the `model`
   comparison should ever be case-insensitive is an open owner call, not
   resolved by this port** — confirm each lands in the right §3 bucket, not
   just "blocked somewhere." Fix the spec against findings first. The
   ledger addition (owner decision D3) brings its own required attack
   classes, run against §4's ledger design before it is authored: an agent
   id colliding in display name with a different tier's agent
   (ambiguous-name resolution); a `to` value that is a real id for one
   session but a stale/pruned id after the 7-day sweep; concurrent `Agent`
   dispatches racing the append-then-scan ledger the same way Hook 2's
   tally once raced (see `model-routing-guards.state.js`'s header
   comment); and a blank or invisible-character `to` value. §4's ledger
   subsection folds each into its total classification and its test list.

   **Adversary findings resolved in this revision:**
   1. PLAN-ONLY laundered inside a fenced example — closed by D2
      (bare-standalone-line rule, fence-tracked).
   2. Case-fold collision between two `model_tiers` keys after folding —
      closed by D1 (whole-field invalidation to `{}` on collision).
   3. `SendMessage` to a never-spawned target bypassing model rules —
      closed by D3's unknown-recipient branch (declared `RECIPIENT TIER`
      line required, or block).
   4. Conflicting multiple `REPORT CAP` lines — closed by D2's
      exactly-once rule (2+ matches blocks as `report_cap_ambiguous`).
   5. `model_tiers` malformed sub-shape (array, string, `null`) — closed
      by D1's shape guard (fall back to `{}`).
   6. Blockquote-depth ambiguity in line matching — closed by D2 (no
      blockquote marker accepted at any depth).
   7. Duplicate JSON `model` keys in the dispatch payload — closed by D1's
      note that `JSON.parse` already resolves this last-wins before the
      guard runs; no guard-side change needed, only documented.

   **Adversary findings, round 2.** A further pass, run after D1-D3 shipped,
   found ten more gaps; each is closed by one of the amendments folded into
   §3/§4 of this revision (A1-A9 below; A10 is this list itself, not a
   technical closure):
   1. A `model_tiers` config key that folds to the empty string silently
      vanished as a dict entry instead of failing loudly, and a dispatch
      `model` value that folds to the empty string (e.g. all invisible
      characters) had undefined handling — both closed by A1
      (`model_tiers_empty_key_after_fold_invalidates`): the whole field
      falls back to `{}` on the config side, and an empty-after-fold
      `model` is `model_missing_or_invalid` on the dispatch side, the same
      finding as an absent `model`.
   2. Tier casing in config (e.g. a mixed-case variant of `planning`) was
      unspecified — closed by A2 (`tier_value_case_insensitive`): tier
      values are folded through the same strip+trim+lowercase pipeline as
      keys before comparison; a non-string value still invalidates the
      whole field.
   3. `rules_version`'s hash is read at a different moment (`PostToolUse`
      capture) than the policy that was actually enforced
      (`PreToolUse`) — closed by A3: documented as an accepted limitation
      in §8, not a code fix.
   4. Ledger lookup scoped to only the current session's file missed a
      recipient spawned earlier or by another session on the same
      machine — closed by A4 (`lookup_merges_all_session_files`): lookup
      now reads and merges every `agent-tier-ledger.*.jsonl` file in the
      state directory; capture still writes only its own file.
   5. A cross-process append racing the 7-day sweep's unlink of an
      already-stale file could lose a record — closed by A6: the sweep now
      skips any file whose mtime is within 60 seconds of now, and the
      residual race is documented as an accepted limitation in §8.
   6. A resolved ledger record whose `tier` field is present but corrupted
      or blank was not classified — closed by A5
      (`ledger_record_tier_invalid_blocks`): BLOCK
      (`ledger_record_tier_invalid`), a fourth branch distinct from a clean
      resolution and from the unknown branch.
   7. Fence-boundary edge cases (fence length matching on close, tilde vs.
      backtick, a fence nested inside a blockquote) were unspecified —
      closed by A7 (`fence_commonmark_length_matching`): CommonMark's exact
      fence-open/fence-close rule is adopted.
   8. CRLF and lone-CR line endings could make one physical line and its
      normalized twin count as either one match or two, inconsistently —
      closed by A8 (`crlf_normalized_before_bare_line_match`): line endings
      are normalized to LF, then each line has invisible characters
      stripped, before any bare-line count runs.
   9. Two REPORT CAP/PLAN-ONLY lines differing only in invisible characters
      could silently deduplicate into one match instead of blocking as
      ambiguous — closed by A8
      (`duplicate_cap_lines_differing_by_invisibles_ambiguous`): after
      normalization the two lines are distinct and both count.
   10. The `RECIPIENT TIER:` declaration line had no exact grammar, so
       trailing text, missing colon spacing, or casing variants were
       unspecified — closed by A9 (`recipient_tier_line_exact_match_rules`):
       trimmed, case-insensitive literal `RECIPIENT TIER:`, one of the
       three tier names folded like a `model_tiers` value, an optional
       single trailing period, nothing else, exactly once; the §3
       homoglyph blind-spot note now covers this line too.
2. Author under worktree isolation (`isolation: "worktree"`), fresh branch
   off `main`: copy both files, apply the `model_tiers` parameterization
   (§4), implement the per-agent tier ledger (capture, storage, lookup —
   §4's ledger subsection, including the required `cleanupOldStateFiles`
   generalization and the REQUIRED VERIFICATION STEP), upgrade
   `model-routing-guards.unicode.js`, add the `GUARDS` entries (guard port
   plus ledger capture) and `hooks/README.md` sections, and hand-check
   `test/test-public-scan.js` against every ported file (it's a floor, not
   a guarantee).
3. Tests: source has 52 `test(...)` cases (`grep -c '^test(' *.test.js`).
   Judge's baseline is 692/692 (`npm test`) + 59/59 standalone
   (`scripts/run-tests.js:19`). Expect 692+52=**744** node:test passes —
   confirm by running it, don't assume. The ledger addition (§4, owner
   decision D3) adds 14 more named `test(...)` cases (13 from D3 plus the
   coordinator-amended `ledger_record_carries_rules_version_and_no_bodies`),
   so the working total becomes 692+52+14=**758** node:test passes. The
   round-2 adversary closures above add 8 more named `test(...)` cases
   (`model_tiers_empty_key_after_fold_invalidates`,
   `tier_value_case_insensitive`, `lookup_merges_all_session_files`,
   `ledger_record_tier_invalid_blocks`, `fence_commonmark_length_matching`,
   `crlf_normalized_before_bare_line_match`,
   `duplicate_cap_lines_differing_by_invisibles_ambiguous`,
   `recipient_tier_line_exact_match_rules`), bringing the working total to
   692+52+14+8=**766** node:test passes — this arithmetic is a planning
   estimate only; the final number is confirmed by running `npm test`,
   never assumed, exactly as the 744 and 758 figures above already
   required.
4. Run `node --test test/test-public-scan.js` explicitly and read its
   output.
5. Author opens the PR (`gh pr create`) against this repo's `main`. This
   is Agent-invocation #1; it never reviews/approves/merges its own PR.
6. **Independent approver** — a separate `model: <drafting-tier-literal>`
   invocation with no authoring role — reviews, then `gh pr review --approve` +
   `gh pr merge` as one dispatch (`docs/independence.md` rule 2).
   Foreground-poll `gh pr checks <N>` with `sleep`, never `--watch`.
7. After merge, cite the actual GitHub Actions run URL as green — a local
   `npm test` pass is not "tested green."
8. **claude-memory follow-up** (not a PR #257 mirror — no committed copy
   exists to `git rm`, §2): confirm no `hooks/agent-model-routing-guard.js`
   and no stray reference in a **tracked** doc or `MANIFEST.md` exist there
   (none found as of this spec — `docs/` and `MANIFEST.md` filename- and
   text-searched clean). A prose mention does exist in the gitignored,
   untracked `CONSOLIDATION-RUNBOOK.md` (§2) — that file ships to no one and
   is not part of this repo's git history or its public distribution, so
   there is nothing to `git rm`; no action needed beyond what §2 already
   records. Then confirm the wiring: the user-scope
   hook entry re-points to whatever `install-guards.js` writes under
   `~/.claude/hooks/` — same directory/filename, so its dedupe/re-point
   logic (`scripts/install-guards.js:309-353`) handles it idempotently.
9. **Live verification**: after the owner runs
   `node scripts/install-guards.js` (writes the real
   `~/.claude/settings.json` — not this agent's job), confirm a real
   model-less `Agent` dispatch still exits 2. This checks wiring only;
   logic is already covered by step 3.

## 6. Gotchas

- **REPORT CAP, exact form:** `^REPORT CAP: (\d{1,3}) words$`
  (`agent-model-routing-guard.js:46`) — every dispatch prompt this session
  writes needs this exact standalone line (`1<=N<=500`), or the *live*
  `agent-adversary-floor`/`agent-permission-preflight` guards on this
  machine will block this session's own work.
- **PLAN-ONLY, exact form:** `PLAN-ONLY: no writes, no edits, no shell;
  return a plan only.` (period optional) — only if you dispatch a
  planning-tier agent; the §5 step 1 adversary pass need not be.
- Don't phrase a dispatch as editing the user's settings file directly, or
  as history-rewrite (`git push --force`/`rebase`) — the live
  `agent-permission-preflight` guard blocks both phrasings today.
- Never give the orchestrator tier a Bash call in this workflow — even
  `git status` — per the live `orchestrator-tool-guard`.
- Squash-merge-and-delete-branch fails to delete the branch from a
  detached-HEAD worktree; the approver may need a second explicit deletion.
- No CI run at all on the PR usually means a merge conflict with `main`
  (GitHub silently skips `pull_request` workflows on a CONFLICTING PR), not
  a broken CI.
- Keep the author's worktree alive until the PR is actually MERGED, not
  just opened.
- CRLF: CI runs `windows-latest` deliberately (guards are Windows/
  Git-Bash-specific by design) — don't "fix" line endings toward LF.
- Never write a literal absolute Windows or MSYS home-directory path (drive
  letter + `Users` segment, in either backslash or forward-slash form) into
  any tracked file — banned by the same scanner (`test/test-public-scan.js:79-83`)
  that bans the model-name literals.

## 7. Acceptance criteria

- [ ] `hooks/agent-model-routing-guard.js` + `.test.js` present in judge,
      functionally equivalent to the source's classification table (§3),
      with all real model-literal comparisons routed through a
      `model_tiers`-style local-policy key — zero hard-coded model-family
      literals in any tracked file.
- [ ] `model-routing-guards.unicode.js` upgraded (full `\p{M}` strip +
      `stripInvisible` export); `orchestrator-tool-guard.js`'s existing
      tests still pass unchanged.
- [ ] `local-policy.example.json` and `hooks/lib/local-policy.js` carry the
      new key with placeholder (non-real) values only.
- [ ] `scripts/install-guards.js` `GUARDS` array has 11 entries; the guard
      port wired `PreToolUse` / `Agent|SendMessage`, the ledger capture
      wired `PostToolUse` / `Agent` (owner decision D3).
- [ ] `hooks/README.md` has a new guard section (and a ledger subsection
      or section, per where capture ends up living).
- [ ] `npm test` reports the expected new total (692 + 52 + 14 + 8 = 766,
      confirmed by actually running it, not assumed) and 0 failures;
      standalone 59/59 unaffected.
- [ ] Round-2 adversary closures (A1-A9, §5) covered by their 8 named
      tests, confirmed by actually running `npm test`, not assumed.
- [ ] `node --test test/test-public-scan.js` passes with zero hits.
- [ ] `model_tiers` case-fold, collision, shape-guard, and tier-value
      validation (D1) covered by tests; `local-policy.example.json` still
      ships only placeholder literals.
- [ ] REPORT CAP / PLAN-ONLY exactly-once bare-standalone-line rule (D2,
      fence- and blockquote-aware) covered by tests, including the
      ambiguous-match finding codes.
- [ ] Per-agent tier ledger (D3, amended) implemented: capture, storage,
      lookup, the confirmed `tool_response` agent-id field path
      documented, the record shape holds only metadata (no prompt/message
      bodies), and all 14 ledger test names (§4, §5) passing.
- [ ] Adversary pass ran and is cited (findings + spec fix, or "none
      found") before any code was written.
- [ ] PR authored and merged by two distinct `Agent` invocations
      (author ≠ approver/merger); GitHub Actions run cited green.
- [ ] claude-memory checked for stray references per §5 step 8; none found
      or all removed.
- [ ] Live wiring re-check performed (or explicitly deferred to the owner,
      stated as such) per §5 step 9.

## 8. Blind spots of this spec

- I did not read claude-memory's git history for PR #241 or the "fork
  block + split normalization (52/52)" hardening pass directly (cited only
  via CLAUDE.md's next-session notes) — commit SHAs/diffs unconfirmed; the
  52-test count is independently verified against the live file, the PR
  attribution is not.
- I checked claude-memory's `docs/`/`MANIFEST.md` by filename grep only
  (clean); a follow-up text search of the whole checkout, including
  gitignored local files, found one prose mention in
  `CONSOLIDATION-RUNBOOK.md` (§2) — folded in, so this blind spot is now
  closed for that specific file, but a looser paraphrase elsewhere (in a
  private doc not enumerated here) is still unchecked.
- I did not execute `install-guards.js` or touch any real settings file —
  §5 step 9 is specified but unperformed; the re-point logic is unverified
  once a real `model_tiers` key and dispatch are involved.
- I described the user-scope hook wiring's shape, not its literal content
  (per this task's constraint), so a mismatch against the real JSON is
  possible but unchecked.
- I have not run the adversary pass myself — §5 step 1 is prescribed
  process, not evidence that §3's table is already adversary-hardened for
  judge specifically (only for the private source's own suite, read in
  full).
- This revision does not verify the exact `tool_response` field path for
  the spawned agent id — §4's ledger subsection states this as a REQUIRED
  VERIFICATION STEP for the author, not something this spec confirms.
- The ledger's `rules_version` tag is recorded but never re-checked
  against the *current* `model_tiers` at lookup time: if the operator
  edits `local-policy.json` to remap a model literal to a different tier
  after an agent was spawned, `SendMessage` lookups against that agent's
  existing ledger record keep using the tier recorded at capture time
  until the record ages out of the 7-day sweep. D3 says a ledger record
  always overrides a declared tier; it does not say a ledger record is
  re-resolved against live policy — this spec accepts that gap rather than
  closing it.
- (owner decision A3) `rules_version`'s hash is computed at `PostToolUse`
  capture time, reading the local-policy file as it exists at that
  moment — not as it existed when the paired `PreToolUse` call actually
  enforced the dispatch. A policy file swapped in the narrow window between
  those two reads yields a `rules_version` hash that does not match the
  policy that was actually enforced. This is the operator acting against
  their own audit trail (editing policy mid-dispatch) and is out of scope
  for this PR.
- (owner decision A4) Ledger lookup merges every `agent-tier-ledger.*.jsonl`
  file in the state directory, but capture still writes only to the
  current session's file (Storage, §4). A recipient spawned on a different
  machine, or whose session's ledger file has already been swept past the
  7-day window, is invisible to lookup by design and falls to the unknown
  branch — this is intended (matching Hook 2's existing per-machine,
  per-window ledger scope), not a gap this revision closes.
- (owner decision A6) The 7-day sweep runs before its own append and skips
  any file whose mtime is within 60 seconds of now, but a cross-process
  append that races an unlink of a file already 7 days stale and outside
  that 60-second guard can still lose the one record being appended. This
  residual window is accepted, not closed, by this revision.
- The ledger and its REPORT CAP/PLAN-ONLY/RECIPIENT TIER checks are purely
  structural — required lines present and unambiguous, not that a
  message's content matches the tier's role. Concrete input that passes
  every rule in this spec but shouldn't: a `SendMessage` to a real,
  unambiguous `mechanical`-tier ledger entry, with a well-formed
  `REPORT CAP: 500 words` line, whose `message` body instructs that
  recipient to "draft the incident postmortem and open the PR" — a
  mechanical tier should never draft, but no rule in §3/§4 inspects
  message content against tier semantics, only line presence and the
  tier-appropriate line set. Closing this is out of scope for PR 2.

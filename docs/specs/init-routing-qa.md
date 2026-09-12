# judge — init-time routing Q&A (V7/V8/V9)

**Audience:** a fresh Claude Code session in this repo, authoring from this
spec. Revised after spec-adversary round 1 (G1-G10); implementation may
proceed once this revision is read, per `docs/independence.md`'s "adversary
before author" law. Companion to `docs/specs/routing-scorecard.md` and
`docs/specs/pr2-agent-model-routing-guard.md`; this spec covers only how
the three onboarding answers routing depends on — role taxonomy,
capability tier, cost figures — get into judge's own tables.

## 1. Purpose and ownership

Per decision `routing-home-judge`: **judge owns all routing** —
`model_registry`, `routing_profiles`, `routing_session_overrides`,
`route_resolve`, the review-never-equals-draft identity rule, and the
init-time tier questionnaire this spec describes. Judge owns its own tables
(same Postgres instance `claude-memory` uses, separate schema) and its own
MCP tools and init flow, in `djwmobley/judge`. `claude-memory` stores
memory only and has no routing tables, tools, or init step after this
ships. This supersedes `s17-1-2-init-qa-shape`: the Q&A's interactive
*shape* — three questions, asked once per trigger, never silently seeded —
carries forward unchanged; only the *host* changes, from `handoff_init` to
judge's own init.

## 2. Trigger and re-entry

Per the 2026-07-20 owner directive (runbook §17.1.2): Q&A is interactive,
never silently seeded; skipping is legitimate, not an error — routing stays
inert until answered. Two independent trigger channels apply, no longer
collapsed into one "empty registry" test:

- **Global trigger (Q1 only).** Init, or the first `route_resolve`/
  `routing_profile_set` call against an empty `model_registry` — whichever
  first — asks Q1 once for the registry as a whole. Q1 fires only on an
  empty registry or an explicit re-run (`judge init --routing`); never per
  model.
- **Per-model trigger (Q2/Q3).** Any call that creates a model's row — init's
  registration step, or an MCP call touching a `model_id` with no existing
  row — fires Q2/Q3 for *that model* the moment its row is created,
  regardless of whether the registry was already non-empty. "Registry
  non-empty" is never a reason to skip a new model's own pass; this closes
  the gap where a later-registered model got a silent NULL row with no Q&A
  at all.
- **Empty-registry re-entry / re-run on demand.** Any touch against a
  still-empty registry re-triggers Q1; there is no permanent one-shot
  suppression. `judge init --routing` re-runs the Q&A against a populated
  registry to add or correct answers; idempotent per model (§6).
- **Concurrency.** Two sessions can race the same trigger. judge holds a
  single-writer advisory lock per pass: keyed on the model's identity (§4)
  for a per-model pass, or registry-level for the Q1 pass. A second caller
  hitting a held lock never waits, retries, or overwrites silently — it
  gets `init in progress for <key>` and must retry after the first pass
  completes.
- **Non-interactive/CI.** Prompting requires stdin **and** stdout both
  TTYs; either non-TTY means no prompt. Two flags govern non-interactive
  runs — named explicitly, not reusing `install-guards.js`'s `--force`
  (reserved there for a future "overwrite despite a safety check," not
  seeding): `--skip-routing-qa` declines the Q&A, writing every touched
  field **skipped**; `--answers-file <path>` supplies answers from a file,
  each validated exactly as an interactive answer (§3) — a malformed file
  value is **invalid**, never coerced. Mutually exclusive: both present is
  a hard error at flag-parse time, naming both. No flag, present or
  future, ever seeds a default into role-set, `capability_tier`, or either
  cost column — only *skip* or *supply-from-file*, never *guess*. Piped
  stdin with data, no flag given, is **not** an answer channel — treated
  as no-TTY-no-flag; `--answers-file` is the only non-interactive answer
  path. No flag and no TTY refuses immediately, naming both flags. A
  reported TTY that never answers (a CI pseudo-TTY) gets a bounded
  liveness wait (illustrative 30s) after the question is posed; on
  timeout, treated as no-TTY-no-flag. No input state is left
  unclassified.

## 3. The three questions

Each question, once triggered (§2), resolves to exactly one branch below;
there is no fifth answer-time state. This is distinct from the row-level
lifecycle state (§4), which separately makes "was this ever triggered"
total.

**Explicit tokens.** Two literal, case-sensitive tokens govern every
question; neither is satisfied by a bare Enter/blank line. **Skip token**
— typing `skip` (trimmed, exact) declines a question; blank/Enter alone is
never a decline, it is invalid. **Confirm token** — accepting a pre-filled
re-run suggestion (§6) requires typing `confirm` or making an explicit
edit; blank/Enter alone never confirms, first run or re-run.

**Q1 — role set.** Asked once per global trigger (§2), never per model. A
7-role table (orchestrate, spec, draft/write, read, index, bookkeep,
review/verify) is a pre-filled suggestion, not a default: `confirm` accepts
it verbatim; an explicit edit replaces it. Free-text storage, not a
schema-level enum. Blank/Enter with neither token is **invalid**; `skip`
yields **skipped** (NULL, `qa_state` `asked-and-skipped`, §4).

**Q2 — capability tier.** Asked once per newly-registered model, at that
model's per-model trigger: high / mid / low. Never inferred from name or
vendor string. Equality rule: trim whitespace only, no case-folding, then
must equal exactly one of `high`, `mid`, `low`, byte-for-byte. `High`,
`MID`, or any other casing/spacing is **invalid**, not a fourth tier.
`skip` is the only decline path; blank/Enter with no token is **invalid**.

**Q3 — cost figures.** `cost_in_per_mtok`/`cost_out_per_mtok`, once per
newly-registered model, same per-model pass as Q2, owner-supplied — never
defaulted from bundled price data. Parsing rule: trimmed answer must match
a fixed grammar — digits, an optional single `.` decimal separator,
digits, nothing else: no thousands separators, no locale `,` decimals, no
exponential notation. Value must be finite and non-negative; `-0` is
**invalid**, not zero — a literal "≥ 0" check alone would pass `Infinity`,
`NaN`, exponential input, locale input, and `-0` too, so each is named
**invalid** explicitly. Stored as `NUMERIC`, never a float that can
reintroduce `Infinity` on read. `skip` is the only decline path;
blank/Enter alone is invalid.

**Total classification of every answer to an already-triggered question**
(no allow-list — every input maps to exactly one branch):

| Input state | Branch | Effect |
|---|---|---|
| Valid answer matching the field's grammar (Q1: confirmed/edited non-empty text; Q2: exactly `high`\|`mid`\|`low`, case-sensitive; Q3: finite, non-negative, `.`-separated decimal, not `-0`) | **answered** | Written to the row (§4); `qa_state` → `asked-and-answered`; used by `route_resolve` thereafter. |
| The literal `skip` token (trimmed, exact) | **skipped** | Field left NULL; `qa_state` → `asked-and-skipped`; not an error (§5). |
| Input given but fails that field's grammar (wrong-case/format tier, non-decimal/locale/exponential/`-0`/`Infinity` cost, blank/Enter with no token, empty required Q1 edit) | **invalid** | Re-prompt interactively; via `--answers-file`, fail loudly naming the field and value — never coerced, truncated, or rounded to nearest-valid. |
| No input reaches the question (no TTY, no flag, or no response inside the liveness window, §2) | **invalid** (refuse-to-hang) | Init refuses immediately, naming `--skip-routing-qa` and `--answers-file`. |

Every branch is reachable and terminates; nothing unenumerated falls
through un-routed. §4 makes "was this ever triggered" total separately, so
a NULL value is never the only signal a reader has.

## 4. Storage

Judge-owned tables, same Postgres instance as `claude-memory`, separate
schema. `model_registry` (one row per model, keyed by §4's identity rule)
gains a role-set column (free text, NULL until answered/edited),
`capability_tier` (checked-text high/mid/low, NULL until answered),
`cost_in_per_mtok`/`cost_out_per_mtok` (NUMERIC, NULL until answered) —
plus, per field, a `qa_state` value and an `asked_at` timestamp. `qa_state`
is total over that field's lifecycle:

| `qa_state` | Meaning |
|---|---|
| `never-asked` | Question not yet presented for this row. `asked_at` NULL. |
| `asked-and-answered` | Presented and answered validly (§3); value non-NULL, `asked_at` set. |
| `asked-and-skipped` | Presented and `skip`ped (interactively or via flag); value NULL, `asked_at` set. |

A NULL value alone is ambiguous between `never-asked` and
`asked-and-skipped` — no code path, `route_resolve` (§5) included, may
treat "value is NULL" as sufficient evidence of which; `qa_state` (or
`asked_at`) must be consulted. §2's per-model trigger means `never-asked`
should not occur for Q2/Q3 on any row created after this ships; it stays
named so a row landing there anyway (a bug, a bulk import, an
unanticipated registrar path) is diagnosable, not misread as a deliberate
skip. Never zero-cost, never "assume low tier," never coerced anywhere in
the read path.

**Model identity key.** The key for `model_registry`, and for every lookup
`route_resolve`/`routing_profile_set`/the Q&A perform against it, is the
exact `model_id` string, trimmed of leading/trailing whitespace only,
compared byte-for-byte, case-sensitive. No case-folding, no vendor-prefix
stripping, no alias table: `claude-sonnet-5`, `Claude-Sonnet-5`, and
`anthropic/claude-sonnet-5` are three distinct keys. A registration naming
an existing key **updates that row**, never inserts a second; a key
differing by even one byte or case is, by design, a different model with
its own `never-asked` Q2/Q3 until its own trigger fires. Deliberate
simplicity, not an oversight — alias resolution is a separate,
separately-adversaried future feature (§8). Same explicit rule for every
other key: **role-set** is free text, never a lookup key, so only re-run's
"no change" check (§6) applies — byte-for-byte after trimming surrounding
whitespace, no reordering/case/synonym-insensitivity. **`capability_tier`**
is compared byte-for-byte against the three lowercase literals, same
function at write and every read, `route_resolve` included.

## 5. `route_resolve` behavior on unconfigured state

Unanswered means unconfigured, never guessed. `route_resolve` reads
`qa_state`, not just the value column, so its error names which history
applies: `asked-and-skipped` hard-errors `"capability_tier skipped for
<model_id> — run routing init Q&A"`; `never-asked` hard-errors
`"capability_tier never asked for <model_id> — run routing init Q&A"`.
Both are hard errors — neither guessed nor defaulted — but the message
names which, so an owner knows whether they declined or the trigger never
reached that model (itself worth investigating per §2). A model missing
cost figures, either `qa_state`, is excluded from least-cost ranking
rather than ranked at an assumed cost — not a hard error, since a
tier-only decision can still resolve — and the exclusion output names the
model and its `qa_state`.

## 6. Invariants

- Never infer `capability_tier` from name, vendor, or other metadata — no
  allow-list of "known" models to pattern-match.
- Never seed cost figures from a bundled price list, cached quote, or
  anything but a direct owner answer; no flag is ever wired to seeding.
- The Q1 suggestion never auto-applies; every registration writes an
  explicit `confirm` or an explicit edit (§3).
- **Re-run pre-fill never presents a placeholder as a prior answer.** For
  `asked-and-answered` fields, re-run shows the existing value pre-filled
  and `confirm` accepts it unchanged. For `asked-and-skipped` or
  `never-asked` fields, re-run has no prior answer and must say so
  visibly ("never answered" / "previously skipped") instead of silently
  rendering the Q1 suggestion, or any placeholder, where a real answer
  would sit — the same explicit confirm-or-edit keystroke §3 requires on a
  first run is required here too.
- Re-run against an already-answered model is idempotent: the same
  confirmed answer re-entered (§4's equality rules) produces no change and
  does not update `asked_at`; existing answers are always the re-run
  starting point, never cleared first.
- Answers survive re-init: re-running init never clears a previously
  answered model's Q1–Q3 columns.
- Concurrent passes never race to silent last-write-wins; the §2 lock and
  error apply to every write path, including re-run.

## 7. Open owner-review points (V7–V9)

- **V7 — role taxonomy.** The 7-role starting set is a suggestion to
  confirm, not a fixed schema. Recommended lean: keep the column
  free-text so an owner can add or rename roles without a migration;
  revisit only if role values start being matched in guard logic.
- **V8 — capability-tier mapping.** Zero defaults for any named model;
  each registration is a per-model owner call. Recommended lean: keep it
  as the registry grows — a vendor-name heuristic is exactly the
  allow-list failure mode judge's design law rejects.
- **V9 — cost figures.** Owner-supplied, never hardcoded; a stale figure
  corrupts least-cost ranking and `cost_delta_usd` telemetry alike.
  Recommended lean: no automatic refresh from any external price source
  in scope; a staleness/re-confirm nudge is a distinct, separately
  adversaried future feature.

## 8. Out of scope

- The `route_resolve` ranking algorithm, review-never-equals-draft rule
  enforcement, and `routing-scorecard.md`'s ledger — own specs.
- Migrating `claude-memory`-side routing code/data into judge — this spec
  covers only the Q&A populating judge's own tables.
- A staleness/re-confirmation nudge for cost figures (V9 lean above).
- Model-alias resolution (§4) — a distinct future spec if ever pursued.
- The concurrency primitive's exact implementation, the liveness timeout's
  default/configurability, and the final CLI wiring of
  `--skip-routing-qa`/`--answers-file` — §2/§6 name requirements
  illustratively; implementation finalizes the code.

## 9. Blind spots of this spec

Authored by reading `docs/specs/session-end-worktree-guard.md` (heading
style), `docs/specs/routing-scorecard.md` (§1-2), and `README.md`, plus a
grep for `model_registry`/`route_resolve`/`routing_profile`/
`capability_tier`/`cost_in_per_mtok`, one hit:
`docs/specs/pr2-agent-model-routing-guard.md`, which says
`route_resolve`/`routing_profile_*`/`usage_*` live in `claude-memory`'s
`scripts/lib/route-resolve.js` — predating and not updated for
`routing-home-judge`. This revision resolves spec-adversary round 1
(G1-G10, `docs/specs/init-routing-qa.adversary.md`) at the text level;
remaining blind spots: (a) no confirmation judge's repo has any
`model_registry` table, MCP tool, or init command yet — §4-5, including
the new `qa_state`/`asked_at` columns and lock primitive, describe a
target shape, not a confirmed schema; (b) whether `route-resolve.js` needs
porting, rewriting, or retiring is undecided; (c) flag names, error
strings, and the 30s liveness timeout are illustrative, read from no
existing judge source; (d) §2/§6 state the lock requirement but don't
choose advisory-lock-vs-version-column, nor analyze whether the global Q1
lock and a per-model Q2/Q3 lock can deadlock; (e) this revision hasn't
itself had a round-2 adversary pass — the next step, not something this
document self-certifies.

## 10. Change log

- Revised after spec-adversary round 1 (G1-G10), 2026-09-11. Adversary
  record kept untracked on disk per the repo's `*.adversary.md` ignore
  rule; findings G1-G10 are summarized in this section.
  - G1: trigger missed newly-registered models on non-empty registry — fixed by §2 per-model trigger.
  - G2: model identity key undefined — fixed by §4 exact byte-for-byte key rule.
  - G3: concurrent inits raced with no locking — fixed by §2 single-writer lock.
  - G4: re-run could auto-apply suggestion for skipped field — fixed by §6 re-run invariant.
  - G5: blank answer ambiguous between decline and invalid — fixed by §3 explicit tokens.
  - G6: "non-negative number" admitted Infinity/locale garbage — fixed by §3 fixed grammar.
  - G7: Q2 case/format equality unstated — fixed by §3 exact-case equality rule.
  - G8: pseudo-TTY/piped stdin unclassified — fixed by §2 liveness-wait rule.
  - G9: skip-flag vs per-field-flag precedence undefined — fixed by §2 mutual-exclusion rule.
  - G10: `--force` naming risked a seeded default — fixed by §2 named non-`--force` flags.

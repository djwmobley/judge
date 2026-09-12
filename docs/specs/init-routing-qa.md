# judge — init-time routing Q&A (V7/V8/V9)

**Audience:** a fresh Claude Code session in this repo, authoring from this
spec. Draft, not yet implemented or adversaried — a spec-adversary round runs
against this document, especially its §3 classification, before any code is
written (`docs/independence.md`'s "adversary before author" law). Companion
to `docs/specs/routing-scorecard.md` (reports on guard decisions after
routing is configured) and `docs/specs/pr2-agent-model-routing-guard.md`
(the tier-routing guard itself); this spec covers only how the three
onboarding answers routing depends on — role taxonomy, capability tier, cost
figures — get into judge's own tables in the first place.

## 1. Purpose and ownership

Per decision `routing-home-judge`: **judge owns all routing** —
`model_registry`, `routing_profiles`, `routing_session_overrides`,
`route_resolve`, the review-never-equals-draft identity rule, and the
init-time tier questionnaire this spec describes. Judge owns its own tables
(same Postgres instance `claude-memory` uses, but a separate schema/table
set) and its own MCP tools and init flow, in `djwmobley/judge`.
`claude-memory` stores memory only — entities, assertions, edges, handoff
state — and has no routing tables, tools, or init step after this ships.
This supersedes decision `s17-1-2-init-qa-shape`, itself marked SUPERSEDED:
"init-time tier Q&A moves to judge's own init (interactive shape retained);
not in handoff init. PR #249 closed." The interactive *shape* of the Q&A —
three questions, asked once, at init, never silently seeded — carries
forward unchanged from the original owner directive; only the *host*
changes, from `claude-memory`'s `handoff_init` to judge's own init.

## 2. Trigger and re-entry

Per the 2026-07-20 owner directive (claude-memory runbook §17.1.2): "V7/V8/V9
are collected via an INTERACTIVE Q&A at init/registration time, never
silently seeded. Trigger: handoff_init, or the first route_resolve/
routing_profile_set touch against an empty model_registry — whichever comes
first. Skipping the Q&A is a legitimate owner choice, not an error; routing
just stays inert until answered." Restated for judge's init:

- **First-run trigger:** judge's own init command, or the first
  `route_resolve` / `routing_profile_set` MCP call against an empty
  `model_registry` — whichever comes first.
- **Empty-registry re-entry:** any later touch against a still-empty
  registry re-triggers the same Q&A; there is no one-shot flag that
  permanently suppresses it once skipped.
- **Re-run on demand:** an explicit `judge init --routing` (or equivalent)
  re-runs the Q&A even against a populated registry, to add or correct a
  model's answers. Re-run is idempotent per model (§6).
- **Non-interactive/CI behavior:** mirrors `scripts/install-guards.js`'s own
  precedent (README.md) — if stdin is not a TTY, the Q&A never prompts. An
  explicit flag (`--yes` / `--skip-routing-qa`, exact name TBD) lets a
  non-interactive run proceed with the registry left unanswered; omitting
  the flag with no TTY refuses immediately rather than hanging. A skip,
  flagged or silent-non-TTY, leaves the registry exactly as unconfigured as
  it was — routing stays inert (§5), never guessed.

## 3. The three questions

Each question is asked once per model being registered, in this order,
during a single Q&A pass.

**Q1 — role set.** A 7-role table (orchestrate, spec, draft/write, read,
index, bookkeep, review/verify) is presented as a **pre-filled suggestion**,
not a default: the owner confirms it as-is, edits any row, or replaces the
set entirely with free text. The suggested set never applies on its own —
there is no "press enter to accept" path that writes roles without an
explicit confirming keystroke. Roles are stored as free-text data, not a
schema-level enum, so an owner-edited set is not a validation failure.

**Q2 — capability tier.** Asked once per *registered model*: high / mid /
low. Never inferred from the model's name or vendor string — a name
containing "haiku," "mini," or "large" carries no weight. Any other input is
invalid, not a fourth tier.

**Q3 — cost figures.** `cost_in_per_mtok` and `cost_out_per_mtok`, once per
registered model, owner-supplied numeric values. Never defaulted from a
price list or vendor page bundled with judge.

**Total classification of every answer state** (no allow-list — every input
maps to exactly one of these four branches, unknown/malformed included):

| Input state | Branch | Effect |
|---|---|---|
| Valid answer given (matches the field's own validation: Q1 non-empty string, Q2 ∈ {high, mid, low}, Q3 non-negative number) | **answered** | Written to the model's row (§4); used by `route_resolve` from that point on. |
| Q&A explicitly skipped for this model (flagged non-interactive run, or owner interactively declines this question) | **skipped** | Field(s) left NULL; model registered but that field is unconfigured — not an error (§5). |
| Input given but fails that field's own validation (non-numeric cost, tier string not in {high, mid, low}, empty required role edit) | **invalid** | Re-prompt in an interactive session; in a non-interactive run, fail the init step loudly — never silently coerced or truncated into a nearest-valid value. |
| No input reaches the question at all (non-TTY, no skip flag given) | **invalid** (refuse-to-hang branch, §2) | Init refuses immediately, naming the skip flag. |

Every branch is reachable and terminates in a defined state; no fifth,
unenumerated input falls through un-routed.

## 4. Storage

Judge-owned tables, same Postgres instance as `claude-memory`, separate
schema. `model_registry` (one row per model) gains (exact column names are
implementation-level, named descriptively here): a role-set column (free
text from Q1, NULL until answered or explicitly edited — never
auto-populated with the suggested 7-role table), `capability_tier`
(checked-text high/mid/low, NULL until Q2 answered), `cost_in_per_mtok` and
`cost_out_per_mtok` (numeric, NULL until Q3 answered). NULL in any of these
columns means exactly one thing: unconfigured. Never zero-cost, never
"assume low tier," never coerced to a default anywhere in the read path.

## 5. `route_resolve` behavior on unconfigured state

"Unanswered means unconfigured, not guessed: `route_resolve` against
missing Q1–Q3 data returns an explicit 'unconfigured — run routing init Q&A'
error, never a guess or a silent fallback." Concretely: a `route_resolve`
call touching a model whose `capability_tier` is NULL hard-errors with that
message ("unanswered = `capability_tier` NULL and `route_resolve`
hard-errors"); a model missing cost figures is excluded from least-cost
ranking rather than ranked at an assumed cost ("unanswered = least-cost
ranking inert for that model"), not a hard error, since a tier-only routing
decision can still resolve without cost data.

## 6. Invariants

- Never infer `capability_tier` from a model's name, vendor, or other
  registered metadata — Q2 has no allow-list of "known" models to
  pattern-match against.
- Never seed `cost_in_per_mtok` / `cost_out_per_mtok` from a bundled price
  list, cached quote, or any source but a direct owner answer.
- The Q1 suggested role set never auto-applies; every registration writes
  an explicit confirmation or an explicit edit.
- Re-running the Q&A against an already-answered model is idempotent: the
  same confirmed answer re-entered produces no change, and existing answers
  are the pre-filled starting point for a re-run, not cleared first.
- Answers survive re-init: running judge's init flow again never clears or
  resets a previously-answered model's Q1–Q3 columns.

## 7. Open owner-review points (V7–V9)

- **V7 — role taxonomy.** The 7-role starting set is a suggestion to
  confirm, not a fixed schema. Recommended lean: keep the column free-text
  so an owner can add or rename roles without a migration; revisit only if
  role values start being matched against in guard logic.
- **V8 — capability-tier mapping.** Zero defaults for any named model; each
  registration is a per-model owner call. Recommended lean: keep it that
  way as the registry grows — a vendor-name heuristic is exactly the
  allow-list failure mode `judge`'s own design law rejects.
- **V9 — cost figures.** Owner-supplied, never hardcoded; a stale figure
  corrupts both least-cost ranking and `cost_delta_usd` telemetry.
  Recommended lean: no automatic refresh from any external price source in
  this spec's scope; a staleness/re-confirm nudge is a distinct,
  separately-adversaried future feature, not part of this Q&A.

## 8. Out of scope

- The `route_resolve` ranking algorithm, the review-never-equals-draft
  identity rule's enforcement, and `routing-scorecard.md`'s decision
  ledger — all covered by their own specs.
- Migrating any `claude-memory`-side routing code or data into judge; this
  spec covers only the Q&A that populates judge's own tables going forward.
- A staleness/re-confirmation nudge for cost figures (V9 lean above).
- The exact non-interactive flag name and init command's full CLI surface —
  named illustratively in §2, finalized at implementation time.

## 9. Blind spots of this spec

This spec was authored by reading `docs/specs/session-end-worktree-guard.md`
(heading style only), `docs/specs/routing-scorecard.md` (§1-2), and
`README.md`, plus a grep of this worktree for `model_registry` /
`route_resolve` / `routing_profile` / `capability_tier` /
`cost_in_per_mtok`, which returned exactly one hit:
`docs/specs/pr2-agent-model-routing-guard.md`, whose own text states that
`route_resolve`, `routing_profile_*`, and `usage_*` are "a different
subsystem living in `claude-memory`'s `scripts/lib/route-resolve.js` and
friends" as of that spec's writing — i.e. that spec predates, and has not
been updated for, the `routing-home-judge` decision this spec is built on.
This means: (a) this author could not verify that judge's repo currently has
any `model_registry` table, MCP tool, or init command at all — §4-5 describe
a target shape, not a confirmed existing schema to extend; (b) whether
`claude-memory`'s existing `route-resolve.js` needs to be ported, rewritten,
or retired was not investigated here and is not decided by this spec; (c)
the exact non-interactive flag name and error-message string in §2/§5 are
illustrative, not read from an existing judge source file, since none was
found; (d) this spec's own §3 classification table has not yet been through
the required spec-adversary round — that round is the next step, not
something this document can self-certify.

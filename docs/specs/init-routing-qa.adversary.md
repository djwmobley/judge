# Adversary: judge — init-time routing Q&A (V7/V8/V9)

**Read:** `docs/specs/init-routing-qa.md` (target), `docs/specs/routing-scorecard.md`
§1-2 (total-classification precedent), `README.md`, `scripts/install-guards.js`
(TTY/`--yes`/`--force` precedent, lines 25-235, 840-870).

## G1 (Critical) — trigger never re-fires once registry is non-empty; NULL becomes un-decidable

§2: "First-run trigger: init, or first `route_resolve`/`routing_profile_set`
touch against an **empty** `model_registry`." §2's re-entry clause only
covers "any later touch against a **still-empty** registry." Sequence:
register model A via init (answered). Registry is now non-empty. Later,
`routing_profile_set` (or any MCP call) touches a brand-new model B — the
registry is not empty, so neither trigger condition fires; B's row is
created (implicitly, by whatever call touched it) with Q1-Q3 NULL, and the
Q&A never ran for B at all. §3's table has no branch for "model created
outside a Q&A pass" — every row assumes the model *went through* one of the
four branches. B's NULL is now ambiguous between §3 row 2 ("skipped") and a
fifth, unenumerated state: never asked. §4's "NULL means exactly one thing:
unconfigured" glosses over this — operationally it means two different
histories with no way to tell them apart later. **Fix:** trigger on "empty
registry OR a row lacking Q1-Q3 for the model being touched," not just
"empty registry."

## G2 (Critical) — model identity key and its equality rule are never stated

§3/§4 say "once per registered model" and "one row per model" but no clause
defines the key: is it a raw string compared byte-for-byte, case-folded, or
vendor-prefix-stripped ("claude-sonnet-5" vs "anthropic/claude-sonnet-5" vs
an alias)? Sequence: model registered as `claude-sonnet-5` (answered,
tier=high). A later call to `route_resolve` names the same physical model
as `Sonnet-5` or `anthropic:claude-sonnet-5`. If the lookup is exact-match,
this is a **false positive** unconfigured error for a model that IS
configured (task-relevant failure §5 explicitly forbids: "never a guess or
silent fallback" — but an identity miss is neither, it's a wrong error). If
the write path instead case-folds on insert but the read path does not (or
vice versa), a duplicate row can be silently created, splitting cost/tier
answers across two "models" that route_resolve treats as distinct. §3's
classification is total over *inputs*, but never total over *identity* —
an unenumerated identity-collision path escapes it entirely. **Fix:** state
the exact key normalization (e.g., case-fold, strip vendor prefix, resolve
aliases against a fixed table) and require `route_resolve`/init to use the
identical normalization function.

## G3 (High) — concurrent inits race with no locking, no distinguishable outcome

§2 allows two independent triggers (init command, or an MCP touch) to fire
the Q&A. Two concurrent sessions both hit an empty registry simultaneously;
both run the Q&A for the same model, both compute an answer, both write.
Nothing in §4/§6 specifies a write-time check (version column, `SELECT ...
FOR UPDATE`, upsert-with-guard). Last write silently wins; the loser's
confirmed answer disappears with no error and no field distinguishing "my
answer was overwritten" from "I skipped." §6's idempotence clause only
covers a **single** actor re-running against its own prior answer — it says
nothing about two actors racing the *same* empty-to-answered transition.
**Fix:** name a concurrency primitive (row lock or optimistic version
check) and define the outcome (second writer errors/re-prompts) explicitly.

## G4 (High) — re-run pre-fill for a still-skipped field can auto-apply the suggestion

§6: "existing answers are the pre-filled starting point for a re-run." For
a model whose Q1 was **skipped** (NULL, never answered), there is no
existing answer to pre-fill — re-run has nothing but the original 7-role
suggestion to show. §3's invariant ("no press-enter-to-accept path... every
registration writes an explicit confirming keystroke") is stated for
first-run only; §6 never restates or re-derives it for the re-run UI. If a
re-run implementation reuses the first-run "confirm/edit" flow verbatim for
a NULL Q1, an owner intending only to fix Q2 who fast-advances through Q1
(believing it's just redisplaying "their" prior value, since that's what
re-run normally does per §6) can commit the raw suggested table with the
same keystroke pattern that legitimately confirms an *existing* answer
elsewhere in the same pass — the spec draws no line between "confirming a
real prior answer" and "confirming a raw suggestion" at re-run time. This
is exactly the path §6's invariant exists to block. **Fix:** re-run must
visibly flag a still-NULL field as "never answered" (not silently show the
suggestion as if pre-filled) and require the same explicit-edit-or-confirm
keystroke §3 requires on first run.

## G5 (Medium-High) — blank/whitespace answer maps to two branches at once

§3 row 2 ("owner interactively declines") and row 3 ("empty required role
edit" = invalid, Q1 only) both plausibly cover a bare Enter with no text.
Nothing states which branch a blank answer takes for Q2/Q3 (row 3 only
names Q1's empty-edit case explicitly). A blank Q2 answer could be read as
"decline" (→ skipped, NULL, no error) or "invalid input" (→ re-prompt/hard
fail) — both are defensible readings of the same input against the current
text. **Fix:** state explicitly, per question, whether a bare-Enter/blank
string is a decline or a validation failure.

## G6 (Medium) — "non-negative number" validation admits garbage that passes literally

Q3's stated rule is "non-negative number." `Number("1e309")` = `Infinity`
(≥ 0 → **answered**, silently poisons least-cost ranking).
`parseFloat("3,14")` = `3` (locale decimal silently truncated, still
"answered," value wrong by ~10x with no error). `-0 ≥ 0` is true. None of
these fail the literal clause "matches the field's own validation:
non-negative number," so all pass §3 row 1 as written while corrupting §5's
ranking exactly as V9 warns against. **Fix:** require finite, and require a
fixed numeric-literal grammar (reject thousands/locale separators) rather
than "numeric" left to whatever parser is chosen.

## G7 (Medium) — Q2 case/format equality never fixed

"high / mid / low" — is "High" normalized or invalid? Undocumented, so two
compliant implementations diverge on the same input. **Fix:** state
case-fold-and-trim before the ∈ {high,mid,low} check.

## G8 (Medium) — pseudo-TTY and piped stdin fall outside §3's stated conditions

§2/install-guards.js precedent checks `stdin.isTTY` only. A CI pseudo-TTY
(isTTY=true, nothing listening) matches neither row 3 (no input given) nor
row 4's "(non-TTY...)" condition — it is TTY-true with no real answerer,
hangs, and violates the spec's own refuse-to-hang design goal: an input
state mapping to zero branches. Separately, piped-stdin-with-valid-answers
is non-TTY, so §2's blanket "never prompts" refuses it even though real
input is present — in tension with row 4's parenthetical, which a reader
could take as scoped to "no data at all." **Fix:** distinguish
"non-TTY-with-data-available" from "non-TTY-with-nothing," and require an
answer-liveness probe (e.g. a short read timeout) rather than isTTY alone.

## G9 (Low-Medium) — skip-flag vs per-field-answer-flag precedence undefined

§2 names only one binary skip flag; nothing rules on
`--skip-routing-qa` combined with a future per-field flag. Same input, two
readings (skipped vs answered). **Fix:** state precedence explicitly now,
even though the flag surface is "TBD" (§8).

## G10 (Low) — `--force` naming collision risks a seeded default

install-guards.js documents `--force` as "kept for a possible future
'overwrite despite a safety check' meaning." If judge's Q&A reuses that
name, an implementer could wire it to "seed a default and proceed" — the
spec's own forbidden outcome — since §2 never explicitly forbids that
reading for whatever flag name is finally chosen. **Fix:** when the flag
surface is finalized, state that no flag may cause a seeded/default value.

Blind spots: this pass reasons only from spec text; it did not read any
implementation code (none exists yet) and cannot verify whether the actual
`route_resolve`/`model_registry` source in `claude-memory` already answers
G2's identity-key question in a way this spec should simply inherit — that
cross-check is out of scope for a spec-level adversary and belongs to
implementation review.

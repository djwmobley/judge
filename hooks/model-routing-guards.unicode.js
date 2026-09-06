"use strict";
// model-routing-guards.unicode.js
// Shared Unicode property-class normalization for both model-routing-guards
// hooks (model-routing-guards.spec.md §2). Full property-class scan, not a
// hand-enumerated denylist — closes B5 (any Cf/Cc/M code point is stripped,
// not just the six characters a prior enumerated list happened to name).

/**
 * stripNormalize(s):
 *   1. Remove every code point matching /[\p{Cf}\p{Cc}\p{M}]/gu (Format,
 *      Control, and the FULL Mark category — Mn nonspacing, Mc spacing
 *      combining, and Me enclosing — e.g. U+0301 combining acute, U+0903
 *      Devanagari sign visarga (Mc), U+20DD combining enclosing circle
 *      (Me)) — deletion, not replacement. Widened from Mn-only to the full
 *      \p{M} class: a spacing (Mc) or enclosing (Me) mark decorating a
 *      blocked-shape string (e.g. "fork" plus a trailing spacing mark) is
 *      exactly the same class of escape as a zero-width/format character
 *      and must be caught the same way for every comparison that can only
 *      ever RESULT IN a block.
 *   2. Collapse every remaining run of one-or-more \p{Z} characters (the
 *      full Separator category) to a single U+0020 ASCII space.
 * Non-string input returns "" — every field this is applied to already
 * resolves to "" when absent/non-string per the spec's "malformed
 * tool_input" rule, so this mirrors that convention defensively.
 *
 * DEVIATION FROM A LITERAL READING (recorded per task instruction; zero-
 * dialog, decided and recorded rather than asked): \n (U+000A) and \r
 * (U+000D) are themselves Unicode category Cc (Control), so a literal
 * "delete every \p{Cc} code point" would strip every line break out of the
 * text BEFORE the exact-standalone-line floor regexes (PLAN_ONLY_LINE_RE /
 * REPORT_CAP_LINE_RE, both anchored with ^...$ under the /m flag) ever see
 * it — collapsing every multi-line prompt into one line and making the /m
 * flag's per-line anchoring permanently inert. That would make every
 * planning-tier/drafting-tier/mechanical-tier dispatch in the spec's own
 * worked test plan block unconditionally (the PLAN-ONLY line and the
 * REPORT CAP line can never coexist on the string once newlines are gone),
 * which contradicts the spec's own worked "-> allow" fixtures. \n and \r
 * are therefore preserved here as the one carve-out from the Cc class;
 * every other Cf/Cc/M code point (including tab, NUL, every zero-width/
 * invisible character, and now every combining/spacing/enclosing mark) is
 * still stripped exactly as specified.
 *
 * NOTE on the PLAN-ONLY/REPORT CAP prose checks this also feeds: widening
 * Mn to the full \p{M} class only ever REMOVES more code points before the
 * PLAN_ONLY_LINE_RE / REPORT_CAP_LINE_RE regexes run — a mark that
 * previously survived inside one of those exact-standalone-line markers
 * and defeated the regex match (blocking the dispatch) is now stripped and
 * the marker recognized (moving that specific case toward ALLOW). This is
 * the same direction-of-travel as the original Mn stripping already had;
 * no test in this suite asserts that a mark-decorated PLAN-ONLY/REPORT CAP
 * line is REQUIRED to stay unrecognized, so this widening does not flip
 * any existing test's expected outcome.
 */
function stripNormalize(s) {
  if (typeof s !== "string") return "";
  const withoutInvisibles = s.replace(/[\p{Cf}\p{Cc}\p{M}]/gu, (ch) => (ch === "\n" || ch === "\r" ? ch : ""));
  return withoutInvisibles.replace(/\p{Z}+/gu, " ");
}

/**
 * True when `s` is empty, or reduces to nothing but a run of the collapsed
 * ASCII space after stripNormalize — the "empty or invisible/whitespace-only"
 * test used by Hook 2's caller-identity classification (§2 case 4) and by
 * every file_path-shape check ("empty after stripNormalize" / blank).
 */
function isBlankAfterStrip(s) {
  return stripNormalize(s).trim() === "";
}

/**
 * stripInvisible(s): removes ONLY \p{Cf} and \p{Cc} (Format and Control)
 * code points — deliberately NOT \p{M} (any mark: Mn nonspacing, Mc spacing
 * combining, Me enclosing — e.g. combining accents) and NOT case-folded,
 * and does not collapse \p{Z} runs.
 *
 * DIRECTION RULE (why this is a separate, narrower helper from
 * stripNormalize rather than one shared function): stripping is fail-safe
 * when it only ever pushes a comparison TOWARD a block — stripNormalize's
 * full Cf/Cc/M removal (the full Mark category: Mn+Mc+Me) is fine for
 * that, because widening what a fork/blocked-shape string can match only
 * ever adds MORE blocks, never fewer.
 * Stripping is NOT fail-safe when it pushes a comparison TOWARD an allow
 * (e.g. an EXEMPT_TYPES membership check) -- \p{M} removal there would let
 * a combining-mark-decorated impostor normalize into a real exempt name
 * and be granted an exemption it was never actually named for. So any
 * comparison that can only ever RESULT IN a block strips aggressively
 * (stripNormalize); any comparison that can RESULT IN an allow strips only
 * the code points that are unconditionally invisible/inert everywhere
 * (Cf/Cc) and leaves every visible-but-decorated character (the full
 * \p{M} class) alone.
 * Non-string input returns "".
 */
function stripInvisible(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\p{Cf}\p{Cc}]/gu, "");
}

module.exports = { stripNormalize, isBlankAfterStrip, stripInvisible };

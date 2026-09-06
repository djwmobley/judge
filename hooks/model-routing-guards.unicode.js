"use strict";
// model-routing-guards.unicode.js
// Shared Unicode property-class normalization for both model-routing-guards
// hooks (model-routing-guards.spec.md §2). Full property-class scan, not a
// hand-enumerated denylist — closes B5 (any Cf/Cc/Mn code point is stripped,
// not just the six characters a prior enumerated list happened to name).

/**
 * stripNormalize(s):
 *   1. Remove every code point matching /[\p{Cf}\p{Cc}\p{Mn}]/gu (Format,
 *      Control, and nonspacing-Mark categories) — deletion, not replacement.
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
 * planning-tier/drafting-tier/mechanical-tier dispatch in the spec's own §8 test plan block
 * unconditionally (the PLAN-ONLY line and the REPORT CAP line can never
 * coexist on the string once newlines are gone), which contradicts the
 * spec's own worked "-> allow" fixtures. \n and \r are therefore preserved
 * here as the one carve-out from the Cc class; every other Cf/Cc/Mn code
 * point (including tab, NUL, and every zero-width/invisible character) is
 * still stripped exactly as specified.
 */
function stripNormalize(s) {
  if (typeof s !== "string") return "";
  const withoutInvisibles = s.replace(/[\p{Cf}\p{Cc}\p{Mn}]/gu, (ch) => (ch === "\n" || ch === "\r" ? ch : ""));
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

module.exports = { stripNormalize, isBlankAfterStrip };

"use strict";
// model-routing-guards.exempt.js
// EXEMPT_TYPES load + drift detection for Hook 1's planning-tier-row OR-clause
// (model-routing-guards.spec.md §3, "B9 — EXEMPT_TYPES drift resolution").
//
// Three independently-maintained copies of the same array exist across
// agent-adversary-floor.js (source of truth), agent-permission-preflight.js
// (its own hand-copied fallback), and this file (a third hand-copied
// fallback + this file's own pinned snapshot for the drift comparison). If
// the required array's CONTENTS (as a set) differ at all from this file's
// own pinned literal, this module reports drift and the caller must treat
// EXEMPT_TYPES as [] for the remainder of the process — friction over
// escape: the comparison can only ever narrow the exemption set, never
// widen it beyond what this file's pinned snapshot already names.

const PINNED_EXEMPT_TYPES = [
  "Explore",
  "Plan",
  "claude-code-guide",
  "plugin-dev:plugin-validator",
  "plugin-dev:skill-reviewer",
];

/**
 * Set-equality (order-independent) between two arrays.
 */
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) {
    if (!sb.has(x)) return false;
  }
  return true;
}

/**
 * Resolve the EXEMPT_TYPES set to use for the planning-tier-row OR-clause carve-out.
 * `requireFn` is injectable for unit-test isolation (defaults to Node's
 * `require`, resolved relative to this file's directory).
 *
 * Returns { exemptTypes: string[], drift: boolean, required: any }:
 *   - require() throws (module missing/broken) -> fall back to the pinned
 *     literal, no drift (mirrors agent-permission-preflight.js's own
 *     require-with-literal-fallback convention; this is a missing-module
 *     condition, not a content-drift condition).
 *   - require() succeeds and its EXEMPT_TYPES set-equals the pinned literal
 *     -> use the pinned literal, no drift.
 *   - require() succeeds but its EXEMPT_TYPES set differs at all (addition,
 *     removal, or membership change under stable length) -> drift:true,
 *     exemptTypes: [] (never trust either list once they disagree).
 */
function resolveExemptTypes(requireFn) {
  const req = requireFn || require;
  let requiredModule;
  try {
    requiredModule = req("./agent-adversary-floor.js");
  } catch (_) {
    return { exemptTypes: PINNED_EXEMPT_TYPES.slice(), drift: false, required: null };
  }
  const required = requiredModule && requiredModule.EXEMPT_TYPES;
  if (!Array.isArray(required) || !sameSet(required, PINNED_EXEMPT_TYPES)) {
    return { exemptTypes: [], drift: true, required: required || null };
  }
  return { exemptTypes: PINNED_EXEMPT_TYPES.slice(), drift: false, required };
}

module.exports = { PINNED_EXEMPT_TYPES, resolveExemptTypes, sameSet };

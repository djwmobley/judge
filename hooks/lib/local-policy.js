"use strict";
// hooks/lib/local-policy.js
//
// Loads the optional, machine-local policy file at
// ~/.claude/hooks/local-policy.json. This is the ONLY place a judge guard
// learns about paths, sandbox roots, gated extensions, exempt types, or
// model-tier mappings that are specific to one machine or one project.
// Every guard in this repo resolves its own install location via
// os.homedir()/__dirname; nothing else in hooks/** hardcodes an
// owner-specific path or a real model-family literal.
//
// Shape (see hooks/local-policy.example.json):
//   {
//     "roots": ["<absolute path>", ...],
//     "gated_extensions": [".ps1", ...],
//     "exempt_types": ["<tool name>", ...],
//     "model_tiers": { "<your real model literal>": "planning|drafting|mechanical", ... }
//   }
//
// Missing file, unreadable file, malformed JSON, or a non-object top level
// all fall back to the conservative default below rather than throwing —
// every guard that calls this must keep working with no local-policy.json
// present at all.
//
// model_tiers fold/validation algorithm (owner decisions D1/A1/A2, judge PR 2):
//   - Every key AND every value goes through foldModelTierToken(): the
//     shared stripNormalize() helper (Cf/Cc/full-\p{M} strip + Z-collapse),
//     then .trim(), then .toLowerCase(). Values get an extra .trim() first
//     (A2) — harmless since the pipeline trims again, kept explicit to
//     match the spec's stated order.
//   - A key that folds to the empty string invalidates the WHOLE
//     model_tiers field, falling back to {} (A1) — not merely dropped as
//     one empty-keyed entry.
//   - A non-string tier value, or a string value that (after the fold)
//     does not equal exactly one of "planning" / "drafting" / "mechanical",
//     invalidates the WHOLE field (D1).
//   - Two keys colliding after folding (e.g. differing only by case, or by
//     a stripped invisible/combining character) invalidates the WHOLE
//     field — fail closed, never last-key-wins (D1).
//   - model_tiers must be a plain object (not null, not an array); any
//     other shape falls back to {}, exactly like the three fields this
//     loader already validated before this PR.
//   - Empty/absent model_tiers is a valid (if maximally strict) resolution:
//     every dispatch's model value then fails to resolve to any tier, so
//     every dispatch blocks on model_missing_or_invalid until the operator
//     configures local-policy.json. This is the guard's existing
//     fail-closed posture, not a new failure mode introduced by this field.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stripNormalize } = require("../model-routing-guards.unicode.js");

const VALID_TIERS = new Set(["planning", "drafting", "mechanical"]);

/**
 * Shared fold pipeline for a model_tiers key, a model_tiers value, or a
 * dispatch's `model` field: stripNormalize (Cf/Cc/full-\p{M} strip +
 * Z-collapse), then trim, then lowercase. Non-string input returns null
 * (the caller decides what that means for its own shape rules) rather than
 * silently coercing to "".
 */
function foldModelTierToken(raw) {
  if (typeof raw !== "string") return null;
  return stripNormalize(raw).trim().toLowerCase();
}

/**
 * Validate + fold a raw model_tiers value from parsed JSON into
 * { "<folded model literal>": "planning"|"drafting"|"mechanical" }, or {}
 * on any shape/fold violation (see algorithm notes above).
 */
function validateModelTiers(rawModelTiers) {
  if (rawModelTiers === null || typeof rawModelTiers !== "object" || Array.isArray(rawModelTiers)) {
    return {};
  }
  const folded = {};
  for (const rawKey of Object.keys(rawModelTiers)) {
    const foldedKey = foldModelTierToken(rawKey);
    if (foldedKey === null || foldedKey === "") {
      // A1: a key that folds to the empty string invalidates the whole field.
      return {};
    }
    const rawValue = rawModelTiers[rawKey];
    if (typeof rawValue !== "string") {
      // Non-string tier value invalidates the whole field.
      return {};
    }
    const foldedValue = foldModelTierToken(rawValue.trim()); // A2: initial trim, then the shared pipeline.
    if (!VALID_TIERS.has(foldedValue)) {
      return {};
    }
    if (Object.prototype.hasOwnProperty.call(folded, foldedKey)) {
      // D1: a fold collision between two distinct raw keys invalidates the
      // whole field — fail closed, never last-key-wins.
      return {};
    }
    folded[foldedKey] = foldedValue;
  }
  return folded;
}

function hooksDir() {
  return path.join(os.homedir(), ".claude", "hooks");
}

function localPolicyPath() {
  return path.join(hooksDir(), "local-policy.json");
}

function defaultPolicy() {
  return {
    roots: [process.cwd()],
    gated_extensions: [],
    exempt_types: [],
    model_tiers: {},
  };
}

function loadLocalPolicy() {
  const defaults = defaultPolicy();

  let raw;
  try {
    raw = fs.readFileSync(localPolicyPath(), "utf8");
  } catch (_) {
    return defaults;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return defaults;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaults;
  }

  return {
    roots:
      Array.isArray(parsed.roots) && parsed.roots.length > 0
        ? parsed.roots.filter((r) => typeof r === "string")
        : defaults.roots,
    gated_extensions: Array.isArray(parsed.gated_extensions)
      ? parsed.gated_extensions.filter((e) => typeof e === "string")
      : defaults.gated_extensions,
    exempt_types: Array.isArray(parsed.exempt_types)
      ? parsed.exempt_types.filter((t) => typeof t === "string")
      : defaults.exempt_types,
    model_tiers: validateModelTiers(parsed.model_tiers),
  };
}

module.exports = {
  hooksDir,
  localPolicyPath,
  loadLocalPolicy,
  defaultPolicy,
  foldModelTierToken,
  validateModelTiers,
  VALID_TIERS,
};

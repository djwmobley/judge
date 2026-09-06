"use strict";
// hooks/lib/local-policy.js
//
// Loads the optional, machine-local policy file at
// ~/.claude/hooks/local-policy.json. This is the ONLY place a judge guard
// learns about paths, sandbox roots, gated extensions, or exempt types that
// are specific to one machine or one project. Every guard in this repo
// resolves its own install location via os.homedir()/__dirname; nothing
// else in hooks/** hardcodes an owner-specific path.
//
// Shape (see hooks/local-policy.example.json):
//   {
//     "roots": ["<absolute path>", ...],
//     "gated_extensions": [".ps1", ...],
//     "exempt_types": ["<tool name>", ...]
//   }
//
// Missing file, unreadable file, malformed JSON, or a non-object top level
// all fall back to the conservative default below rather than throwing —
// every guard that calls this must keep working with no local-policy.json
// present at all.

const fs = require("fs");
const os = require("os");
const path = require("path");

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
  };
}

module.exports = { hooksDir, localPolicyPath, loadLocalPolicy, defaultPolicy };

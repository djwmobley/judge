"use strict";
// test/test-public-scan.js
//
// Greps hooks/** and docs/** case-insensitively for a fixed list of
// owner-identifying and private-project strings and fails the build on any
// hit. This is a floor, not a guarantee: a leak this grep cannot catch —
// e.g. a config literal naming a private database by a name not on this
// list (a schema/table name for an internal tool this repo has never
// mentioned) — would pass silently. The list below is reviewed by hand
// whenever a new file is added to hooks/** or docs/**; it is not a
// substitute for that review.
//
// FORBIDDEN (case-insensitive): djwmo, djwmobley, C:\Users, /c/Users,
// AdvAccel, Advisicon, pipeline_, claudecode, memory-manager, pwa-etl,
// @iadb, world vision, architect_directives, pipeline_architect.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Plain literal substrings (regex-escaped below before joining).
const FORBIDDEN_LITERALS = [
  "djwmo",
  "djwmobley",
  "AdvAccel",
  "Advisicon",
  "pipeline_",
  "claudecode",
  "memory-manager",
  "pwa-etl",
  "@iadb",
  "world vision",
  "architect_directives",
  "pipeline_architect",
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FORBIDDEN_SOURCES = [
  ...FORBIDDEN_LITERALS.map(escapeRegex),
  // C:\Users — one or more literal backslashes, so both a plain-text
  // occurrence (single backslash) and a JS string-literal source
  // occurrence (escaped, double backslash) are caught.
  "C:\\\\+Users",
  // C:/Users — forward-slash Windows form, not in the original list but
  // caught anyway (defense in depth; this scan cannot tell the difference
  // between a real leak and a fixture that forgot to use a fake root).
  "C:/Users",
  // /c/Users — MSYS/POSIX form.
  "/c/Users",
];

const FORBIDDEN_RE = new RegExp(FORBIDDEN_SOURCES.join("|"), "i");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["hooks", "docs"];

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return; // directory doesn't exist yet — nothing to scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

test("public scan: no owner-identifying or private-project strings under hooks/ or docs/", () => {
  const files = [];
  for (const d of SCAN_DIRS) {
    walk(path.join(ROOT, d), files);
  }

  const hits = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (FORBIDDEN_RE.test(line)) {
        hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      }
    });
  }

  assert.deepEqual(hits, [], `forbidden pattern hit(s):\n${hits.join("\n")}`);
});

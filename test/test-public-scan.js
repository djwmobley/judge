"use strict";
// test/test-public-scan.js
//
// Greps the WHOLE tracked repo tree (via `git ls-files`, so untracked
// scratch and node_modules/.git are never in scope) — every .js, .mjs,
// .json, .md, .yml, .yaml, .sh, .ps1, and .txt file — for a fixed list of
// owner-identifying, private-project, and model-family strings, and fails
// the build on any hit. Two independent views of each file are checked:
//
//   1. Line view — the forbidden-pattern regex against each line as-is.
//   2. Concatenation view — the same regex against the WHOLE file with
//      every quote character, `+`, backtick, `$`, `{`, `}`, and run of
//      whitespace removed, so a split literal like `"djwm" + "obley"` or
//      `` `djwm` + `obley` `` still reads as a contiguous match once the
//      joiners are stripped out.
//
// This is a floor, not a guarantee. What it still cannot catch:
//   - An identifier not on either list below — a private tool, database,
//     or table name this repo has never mentioned, so there is nothing to
//     match against.
//   - An encoded string whose bytes never spell the forbidden text at
//     all: base64 (`Buffer.from("ZGp3bW9iamxleQ==", "base64")`), hex,
//     ROT13, a reversed string, or one built from `String.fromCharCode`
//     — every one of these decodes to a real leak at runtime while its
//     on-disk source contains none of the literal or joined-view
//     substrings this scan looks for.
//
// FORBIDDEN (case-insensitive): djwmo, djwmobley, C:\Users, /c/Users,
// C:/Users, AdvAccel, Advisicon, pipeline_, claudecode, memory-manager,
// pwa-etl, @iadb, world vision, architect_directives, pipeline_architect,
// opus, sonnet, haiku, fable, claude-<word>-<digit> (a specific dated
// model handle, e.g. claude-sonnet-5 — not "Claude Code" or "claude.ai",
// neither of which matches this pattern).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// Extensions swept by the whole-repo scan.
const SCANNED_EXTENSIONS = new Set([
  ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".sh", ".ps1", ".txt",
]);

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
  // Model-family tokens: this repo ships tier language (orchestrator /
  // planning / drafting / mechanical tier), never a specific model name.
  "opus",
  "sonnet",
  "haiku",
  "fable",
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
  // C:/Users — forward-slash Windows form.
  "C:/Users",
  // /c/Users — MSYS/POSIX form.
  "/c/Users",
  // A specific dated model handle, e.g. claude-sonnet-5 or
  // claude-opus-4-1 — NOT "Claude Code" (no trailing "-<digit>") and NOT
  // "claude.ai" or "claude-memory" (no digit segment either).
  "claude-[a-z]+-[0-9]",
];
const FORBIDDEN_RE = new RegExp(FORBIDDEN_SOURCES.join("|"), "i");

// Files allowed to contain a literal match, each with a reason. Checked
// against the git-relative path with forward slashes. This is NOT a way
// to suppress a real leak — it exists only for a file that must spell out
// a forbidden token to define or test the scan itself.
const ALLOWLIST = new Map([
  [
    "test/test-public-scan.js",
    "defines the forbidden-pattern list and its own concatenation-evasion " +
      "unit test fixtures — both must spell the patterns out literally to " +
      "have anything to match against.",
  ],
]);

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean);
}

/**
 * Collapse a `+`-based string-concatenation join (the operator and any
 * whitespace/newlines directly around it — this is what stitches a split
 * literal like `"djwm" +\n  "obley"` into one contiguous run), then strip
 * the quote/backtick/`$`/`{`/`}` joiner characters themselves. Whitespace
 * that is NOT adjacent to a `+` is left alone deliberately: stripping all
 * whitespace unconditionally collapses ordinary prose too (e.g. "Claude
 * Code" -> "ClaudeCode", "to push" -> "topush", both of which then
 * collide with an unrelated forbidden token) — the false positives that
 * survived this file's first draft. This narrower rule still catches
 * every concatenation-evasion shape it's meant to catch (see the unit
 * tests below) without also flattening every comment and doc line into
 * one unbroken string.
 */
function stripJoiners(content) {
  return content.replace(/\s*\+\s*/g, "").replace(/['"`${}]/g, "");
}

/**
 * Scan one file's content under both views. Returns an array of
 * { view: 'line'|'concatenation', line: number|null, text: string }.
 */
function scanContent(content) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (FORBIDDEN_RE.test(line)) {
      hits.push({ view: "line", line: i + 1, text: line.trim().slice(0, 200) });
    }
  });
  const joined = stripJoiners(content);
  if (FORBIDDEN_RE.test(joined)) {
    hits.push({ view: "concatenation", line: null, text: "(joined/stripped view matched — see file for the split literal)" });
  }
  return hits;
}

test("public scan: no forbidden pattern anywhere in the tracked repo tree", () => {
  const files = listTrackedFiles().filter((f) => SCANNED_EXTENSIONS.has(path.extname(f)));
  const failures = [];

  for (const rel of files) {
    const relFwd = rel.replace(/\\/g, "/");
    if (ALLOWLIST.has(relFwd)) continue;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue; // defensive; git ls-files always reflects the working tree here
    const content = fs.readFileSync(full, "utf8");
    for (const h of scanContent(content)) {
      failures.push(`${rel}${h.line ? ":" + h.line : ""} [${h.view}]: ${h.text}`);
    }
  }

  assert.deepEqual(failures, [], `forbidden pattern hit(s):\n${failures.join("\n")}`);
});

test("public scan: every ALLOWLIST entry names a tracked file with a non-empty reason", () => {
  const tracked = new Set(listTrackedFiles().map((f) => f.replace(/\\/g, "/")));
  for (const [rel, reason] of ALLOWLIST) {
    assert.ok(tracked.has(rel), `allowlisted path not tracked: ${rel}`);
    assert.ok(typeof reason === "string" && reason.trim().length > 0, `missing reason for ${rel}`);
  }
});

// ── Unit tests for the concatenation-evasion detector ────────────────────────
// These fixtures are built inline as plain strings — this file IS on the
// scan's own allowlist above precisely so these can spell out the evasion
// patterns literally without failing the production check on itself.

test("scanContent: catches a split owner-handle literal joined with +", () => {
  const bad = 'const x = "djwm" + "obley";';
  assert.ok(scanContent(bad).some((h) => h.view === "concatenation"));
});

test("scanContent: catches a split backslash-Users path joined with +", () => {
  const bad = "const y = 'C:\\\\' + 'Users';";
  assert.ok(scanContent(bad).some((h) => h.view === "concatenation"));
});

test("scanContent: a clean fixture produces no hits", () => {
  const clean = 'const message = "hello world";\nfunction ok() { return 1 + 1; }\n';
  assert.equal(scanContent(clean).length, 0);
});

test("scanContent: tier language is never mistaken for a model name", () => {
  const clean = "Delegate to a drafting-tier or mechanical-tier subagent; the orchestrator tier never drafts.";
  assert.equal(scanContent(clean).length, 0);
});

module.exports = { scanContent, stripJoiners, FORBIDDEN_RE, listTrackedFiles, ALLOWLIST, SCANNED_EXTENSIONS };

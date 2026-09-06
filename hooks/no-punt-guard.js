"use strict";
// no-punt-guard.js
// Stop hook -- blocks the agent from ending its turn when the closing message
// defers, hedges, or punts flagged work to "later / your call / next session".
//
// Behavior summary:
//   1. Read + parse stdin.  Fail-open on any error (exit 0, no output).
//   2. If stop_hook_active === true, allow (loop-guard: at most one block per chain).
//   3. Read the JSONL transcript at transcript_path; extract the last assistant
//      message text.  Fail-open if unreadable.
//   4. Scan that text against PUNT_PATTERNS (case-insensitive, high-precision).
//   5. On match -- print {"decision":"block","reason":"..."} to stdout; exit 0.
//   6. No match -- allow (exit 0, no output).
//
// Block protocol (Stop hook contract):
//   - Print JSON {"decision":"block","reason":"<text>"} to STDOUT to block.
//   - The "reason" text is fed back to the model as a correction.
//   - Exit code is always 0 (the decision field controls blocking, not exit code).
//   - Produce NO output at all to allow the stop.
//
// Fail-open philosophy:
//   ANY error (stdin read, JSON parse, transcript read, pattern match) results
//   in a silent allow (exit 0, no stdout).  This hook must never break a session.
//   Precision over recall: false positives that block legitimate closing turns are
//   worse than the occasional punt that slips through.

const fs   = require("fs");
const path = require("path");
const { appendRotating } = require("./model-routing-guards.log.js");

// -- Paths --
// This guard's own install directory. __dirname resolves correctly both in
// an installed ~/.claude/hooks tree and when running the tests straight out
// of this repository's hooks/ directory — no owner-specific path baked in.
const HOOKS_DIR = __dirname;
const DEBUG_LOG = path.join(HOOKS_DIR, "no-punt-guard-debug.log");

// -- Helpers --

function appendDebug(obj) {
  appendRotating(DEBUG_LOG, JSON.stringify(obj));
}

// -- Punt patterns --
//
// Each entry: { re: RegExp, label: string }
//
// Design principles:
//   - Case-insensitive throughout.
//   - Word-bounded or context-constrained to minimize false positives.
//   - The "optional" pattern requires proximity to housekeeping/follow-up nouns
//     to avoid blocking legitimate usage like "the flag is optional".
//   - "feel free to" and "if you'd like" are strong punt signals regardless of context.
//   - The "I/we can/could/will do that later" family requires a future-time qualifier.
//
// To tune: add/remove/edit entries in this array.  Each label is echoed in the
// block reason so the user can identify which pattern fired.

const PUNT_PATTERNS = [
  // -- "your call" --
  // Matches the literal phrase "your call" as a standalone deferral.
  {
    re:    /\byour\s+call\b/i,
    label: "your call",
  },

  // -- "did not force" / "didn't force" --
  // Agent admitting it left something optional/unforced.
  {
    re:    /\bdid\s*n[o']t\s+force\b/i,
    label: "did not force",
  },

  // -- "loose ends" --
  {
    re:    /\bloose\s+ends?\b/i,
    label: "loose ends",
  },

  // -- "optional" near follow-up/housekeeping nouns --
  // Only fires when "optional" appears within 120 chars of a punt-context noun.
  // This avoids flagging "the flag is optional" or "parameter is optional".
  {
    re:    /\boptional\b/i,
    label: "optional (near follow-up/housekeeping)",
    ctx_re: /\b(item|step|follow-?up|housekeeping|cleanup|clean-?up|chore|task)\b/i,
    ctx_window: 120,
  },

  // -- "housekeeping" near undone-work marker --
  // Only fires when "housekeeping" appears within 80 chars of a word signalling
  // remaining/deferred work.  "Done — all housekeeping committed." does NOT fire;
  // "two optional housekeeping items remain" DOES.
  {
    re:    /\bhousekeeping\b/i,
    label: "housekeeping (near undone-work marker)",
    ctx_re: /\b(remaining|pending|left|leftover|outstanding|optional|skip|skipped|deferred|todo|to-?do|still|other|not\s+done|later|two|three|won['']?t)\b/i,
    ctx_window: 80,
  },

  // -- "next session" / "future session" / "later session" --
  {
    re:    /\b(next|future|later)\s+session\b/i,
    label: "next/future/later session",
  },

  // -- "you may want to" / "you might want to" --
  {
    re:    /\byou\s+(may|might)\s+want\s+to\b/i,
    label: "you may/might want to",
  },

  // -- "feel free to" (excluding benign closings like "feel free to ask") --
  // Negative lookahead excludes common courtesy phrases that are not punts.
  // "Feel free to ask if unclear." does NOT fire;
  // "Feel free to run the migration yourself later." DOES.
  {
    re:    /\bfeel\s+free\s+to\s+(?!ask\b|let\s+me\s+know|reach\b|tell\s+me|ping\b|message\b|contact\b|correct\s+me|redirect|clarify)/i,
    label: "feel free to (defer work to user)",
  },

  // -- "if you’d like" / "if you like" / "if you want" / "if you prefer" --
  // Context constraint requires an offer-to-act phrase within 60 chars.
  // "If you’d like to see the diff, here it is." does NOT fire;
  // "If you’d like, I can also wire the second hook." DOES.
  {
    re:    /\bif\s+you['‘’]?d?\s+(like|want|prefer)\b/i,
    label: "if you'd like (offer to do more work)",
    ctx_re: /\b(I\s+can|I\s+could|I['‘’]ll|happy\s+to|i['‘’]?d\s+be\s+happy|let\s+me\s+know|also)\b/i,
    ctx_window: 60,
  },

  // -- "not forced" / "not blocking" / "not in scope" --
  // "done" dropped: "not done" fires on factual past-tense reporting like
  // "that step is not done separately because it's already covered."
  {
    re:    /\bnot\s+(forced|blocking|in\s+scope)\b/i,
    label: "not forced/blocking/in scope",
  },

  // -- "I/we can/could/'ll/will do/handle/address/fix/tackle/revisit/come back to it later" --
  // Handles both contraction forms ("I'll come back to that later") and
  // expanded forms ("I will fix that later", "we can handle it later").
  // Requires a future-time qualifier so plain "I can fix this" does not fire.
  // Pattern: (I|we) followed by either a contraction apostrophe-ll OR whitespace
  // then a modal verb, then the action verb phrase, then the time qualifier.
  {
    re: /\b(I|we)(?:'ll\s+|'ll\s+|\s+(?:can|could|will)\s+)(do|handle|address|fix|tackle|revisit|come\s+back\s+to)\s*(it|that|this|them|those)?\s*(later|next\s+time|in\s+a\s+follow-?up|down\s+the\s+line)\b/i,
    label: "I/we can/will do it later",
  },

  // -- "left it/them/that/this as-is/open/for later/for now" --
  {
    re:    /\bleft\s+(it|them|that|this)\s+(as[\s-]is|open|for\s+(later|now))\b/i,
    label: "left it/them open/for later",
  },

  // -- "leaving it/them/that/this for/as-is/open" --
  {
    re:    /\bleaving\s+(it|them|that|this)\s+(for|as[\s-]is|open)\b/i,
    label: "leaving it/them for/as/open",
  },
];

// -- Pattern matching --

/**
 * Scan `text` against PUNT_PATTERNS.
 * Returns an array of matched { label } objects (may be empty).
 */
function findPuntMatches(text) {
  if (!text || typeof text !== "string") return [];
  const matches = [];

  for (const pat of PUNT_PATTERNS) {
    const m = pat.re.exec(text);
    if (!m) continue;

    // If the pattern has a context-window requirement, verify the surrounding
    // region also matches ctx_re before counting this as a hit.
    if (pat.ctx_re) {
      const start  = Math.max(0, m.index - pat.ctx_window);
      const end    = Math.min(text.length, m.index + m[0].length + pat.ctx_window);
      const region = text.slice(start, end);
      if (!pat.ctx_re.test(region)) continue;
    }

    matches.push({ label: pat.label });
  }

  return matches;
}

// -- Transcript reading --
//
// Production transcript rows look like:
//   { type: "assistant", isSidechain: bool, message: { id, role, content: [blocks] },
//     uuid, parentUuid, ... }
// A single logical assistant turn spans several rows that share message.id
// (e.g. a thinking row, a tool_use row, and a text row). Other row types seen
// in the wild: user, system, mode, bridge-session, attachment, queue-operation,
// file-history-snapshot, last-prompt, atis-latch, ai-title, summary.
//
// The legacy flat { role, content } shape (no `type`, no `message` wrapper) is
// NOT supported/detected here -- it never occurs in production transcripts, and
// treating it as assistant text would risk masking future schema drift instead
// of surfacing it. Such rows fall through to the "other" bucket below and are
// silently ignored, exactly like any other row this function doesn't recognize.

/**
 * Classify one already-JSON.parsed transcript row into a total, order-free
 * shape: { isSidechain, resolvedRole, messageId, textBlocks }.
 * Handles null/non-object input (e.g. a JSON.parse failure) by returning an
 * inert row that contributes to neither the assistant nor the sidechain
 * buckets -- it lands in "other" once grouped.
 */
function classifyRow(obj) {
  if (!obj || typeof obj !== "object") {
    return { isSidechain: false, resolvedRole: null, messageId: null, textBlocks: [] };
  }

  const isSidechain = obj.isSidechain === true;
  const msg = (obj.message && typeof obj.message === "object") ? obj.message : null;
  const resolvedRole = (obj.type === "assistant" || (msg && msg.role === "assistant")) ? "assistant" : null;
  const messageId = (msg && typeof msg.id === "string") ? msg.id : null;

  const textBlocks = [];
  if (msg) {
    const content = msg.content;
    if (typeof content === "string") {
      textBlocks.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          textBlocks.push(block.text);
        }
      }
    }
  }

  return { isSidechain, resolvedRole, messageId, textBlocks };
}

/**
 * Read the JSONL transcript file at `transcriptPath` and return the text of
 * the last assistant turn.  Returns null on any error, on an unreadable/empty
 * file, or when no qualifying assistant turn is found (fail-open).
 *
 * Rows are grouped by message.id, in file order (a row without a message.id
 * forms its own single-row group) -- this reassembles a multi-row turn
 * (thinking + tool_use + text rows sharing one message.id) into one logical
 * turn. Groups are then scanned from the END of the file backwards; sidechain
 * groups (isSidechain === true on any row) and "other" groups (no row in the
 * group resolves to the assistant role -- includes unparsable lines and every
 * unrecognized row type) are transparently skipped while scanning backwards.
 * The first non-skipped group found is decisive:
 *   - if it has at least one text block anywhere in the group, its text
 *     blocks are concatenated (joined with "\n") and returned;
 *   - if it is an assistant group with NO text block anywhere in it (e.g. a
 *     turn that ends on a bare tool_use), this returns null immediately --
 *     it does NOT fall back to an earlier turn's text. A Stop event pertains
 *     to the actual last turn; silently substituting an older turn's text
 *     would check stale content against the punt patterns.
 */
function extractLastAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (_) {
    return null;
  }

  if (!raw || !raw.trim()) return null;

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  const groups = [];
  const groupIndexByKey = new Map();
  let anonCounter = 0;

  for (const line of lines) {
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      obj = null; // unparsable -> classifyRow(null) -> inert -> "other" bucket
    }

    const info = classifyRow(obj);
    const key = (info.messageId !== null) ? ("id:" + info.messageId) : ("anon:" + (anonCounter++));

    let idx = groupIndexByKey.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groups.push({ rows: [] });
      groupIndexByKey.set(key, idx);
    }
    groups[idx].rows.push(info);
  }

  for (let i = groups.length - 1; i >= 0; i--) {
    const rows = groups[i].rows;

    const anySidechain = rows.some((r) => r.isSidechain);
    if (anySidechain) continue; // sidechain group: skip, keep scanning backwards

    const anyAssistant = rows.some((r) => r.resolvedRole === "assistant");
    if (!anyAssistant) continue; // "other" group (incl. unparsable): skip

    const texts = [];
    for (const r of rows) {
      if (r.resolvedRole === "assistant") {
        for (const t of r.textBlocks) texts.push(t);
      }
    }

    if (texts.length > 0) return texts.join("\n"); // assistant-turn-text: decisive
    return null; // assistant-no-text: decisive, do NOT fall back further
  }

  return null; // no qualifying group at all
}

// Export pure functions for unit-test isolation.
module.exports = { findPuntMatches, extractLastAssistantText, PUNT_PATTERNS };

// -- Main --

function main() {
  // Step 1: Read + parse stdin.  Fail-open on any error.
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  if (!parsed || typeof parsed !== "object") {
    process.exit(0);
  }

  // Step 2: Loop guard -- if a prior Stop hook already fired this chain, allow.
  if (parsed.stop_hook_active === true) {
    appendDebug({ ts: new Date().toISOString(), event: "loop_guard_allow" });
    process.exit(0);
  }

  const transcriptPath = parsed.transcript_path || null;

  // Step 3: Determine the last assistant message text.
  // Precedence: a stdin `last_assistant_message` string containing meaningful
  // text wins (per https://code.claude.com/docs/en/hooks); otherwise fall
  // back to parsing the transcript file. "Meaningful" strips ordinary
  // whitespace AND zero-width/BOM characters (U+200B, U+200C, U+200D,
  // U+2060, U+FEFF) before testing length -- plain trim() leaves those
  // characters in place, which would otherwise let a whitespace-only or
  // zero-width-only stdin message masquerade as real text and suppress the
  // transcript fallback.
  let assistantText;
  let source;
  const hasMeaningfulStdinText =
    typeof parsed.last_assistant_message === "string" &&
    parsed.last_assistant_message.replace(new RegExp("[\\s\\u200B\\u200C\\u200D\\u2060\\uFEFF]", "g"), "").length > 0;
  if (hasMeaningfulStdinText) {
    assistantText = parsed.last_assistant_message;
    source = "stdin";
  } else {
    source = "transcript";
    try {
      assistantText = extractLastAssistantText(transcriptPath);
    } catch (_) {
      assistantText = null;
    }
  }

  if (!assistantText) {
    appendDebug({
      ts:    new Date().toISOString(),
      event: "no_assistant_text",
      transcript_path: transcriptPath,
      source: source,
    });
    process.exit(0);
  }

  // Step 4: Scan for punt patterns.
  let matches;
  try {
    matches = findPuntMatches(assistantText);
  } catch (_) {
    process.exit(0);
  }

  appendDebug({
    ts:              new Date().toISOString(),
    event:           matches.length > 0 ? "block" : "allow",
    matched_labels:  matches.map((m) => m.label),
    text_prefix:     assistantText.slice(0, 120),
    source:          source,
  });

  // Step 5: Block if patterns matched.
  if (matches.length > 0) {
    const labels = matches.map((m) => m.label).join(", ");
    const reason =
      "Your closing message defers or hedges flagged work (matched: " + labels + "). " +
      "Before ending the turn: either complete that work now, or state an explicit, " +
      "specific reason it is genuinely out of scope this turn. " +
      "Do not stop having flagged-and-deferred.";

    process.stdout.write(JSON.stringify({ decision: "block", reason: reason }) + "\n");
  }

  // Step 6: Allow (no output already written above) or exit.
  process.exit(0);
}

// Top-level guard: any unexpected throw -- fail-open.
if (require.main === module) {
  try {
    main();
  } catch (_) {
    process.exit(0);
  }
}
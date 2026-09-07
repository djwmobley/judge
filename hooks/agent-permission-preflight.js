"use strict";
// agent-permission-preflight.js
// PreToolUse hook — lints the dispatch prompt/message of an Agent or
// SendMessage call for instructions that would make a subagent trigger a
// permission dialog MID-RUN, and verifies the permission surface (merged
// settings.local.json / settings.json layers) hasn't regressed — BEFORE the
// dispatch happens. A subagent that hits a live permission dialog mid-flight
// with no human present to answer it either stalls indefinitely or fails the
// task; this hook is the pre-flight check that catches the dispatch-time
// conditions that predictably cause that: an instruction that will hit a
// hard-gated action (force-push, interactive git, sudo, settings-file edits,
// a PowerShell-tool call when PowerShell isn't allow-listed, a write outside
// the sandbox roots when the bare tool isn't allow-listed, anything on the
// merged deny list), or a permission-surface regression (a settings layer
// that is present but unparsable, or the baseline "Bash" grant missing) that
// would make otherwise-fine instructions dialog-gate anyway.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Built from a completed spec-adversary pass (P-1..P-10, referenced
// throughout this file) run BEFORE authoring, per this operator's standing
// "adversary before author" rule. The dominant failure mode the adversary
// pass found was NOT under-blocking — it was FALSE POSITIVES: a naive
// keyword scan over the whole prompt text would fire on prose that mentions
// a hazard in order to PROHIBIT it ("never force-push", "NEVER call the
// PowerShell tool" — exactly the boilerplate this operator's own canon
// puts in every zero-dialog dispatch). A hook that blocks the very
// boilerplate meant to prevent the hazard is worse than no hook. The
// governing design decision (P-1) is therefore: match ONLY inside
// code-fenced/backtick spans, or within a short window after a directive
// cue (Run:/Execute:/Then run:/Use:) or a shell-sigil line ($ /> at line
// start) — NEVER a bare prose mention anywhere in the text, and NEVER a
// negation-keyword lookback (lookback logic is itself a source of false
// negatives/positives that the adversary pass rejected outright — context
// SCOPING, not keyword negation, is what makes prohibition-prose naturally
// fall outside the scanned spans, since "Never call the PowerShell tool" is
// not itself a directive cue or a fenced command).
//
// ── WHAT THIS HOOK ENFORCES ─────────────────────────────────────────────────
// For any Agent-tool spawn of a subagent type NOT in the structural exempt
// set (mirrored from agent-adversary-floor.js — see EXEMPT_TYPES below), and
// for EVERY SendMessage call (SendMessage has no subagent_type and is never
// exempt — P-3), the dispatch resolves to exactly one of three outcomes:
//
//   1. ALLOW (clean)        — no findings at all; silent exit 0.
//   2. ALLOW-FAIL-OPEN      — an internal condition made evaluation
//                              impossible (bad stdin, unparseable hook JSON,
//                              missing/non-string prompt field, an internal
//                              exception in this hook's own logic). Exit 0,
//                              but a debug-log line is appended AND a
//                              non-blocking stderr note
//                              "preflight SKIPPED (<reason>)" is written so
//                              the transcript makes the skip visible (P-9).
//                              The settings-file-unparsable case is
//                              EXPLICITLY CARVED OUT of this path — see next
//                              section and P-4/P-10.
//   3. BLOCK                — exit 2, stderr names EVERY finding that fired
//                              (not just the first), so the orchestrator can
//                              rewrite the dispatch and retry in one pass.
//
// There is no fourth path. Findings that can fire (independently, all
// evaluated, all named if the call is blocked) — SKIPPED means "skipped in
// the relaxed branch only"; every finding below still fires in the
// full-check branch. See "PERMISSION-MODE-AWARE RELAXATION" further down
// for what the relaxed branch is and when it applies:
//   - marker-floor:        no zero-dialog/permission-safe marker found
//                           (case-insensitive: "zero-dialog", "permission-
//                           safe", "PERMISSION-SAFE" — all three are the
//                           same case-insensitive match). ANDed with every
//                           other check: marker presence NEVER suppresses a
//                           lint finding (P-2) — it is a floor requirement,
//                           not an escape hatch. SKIPPED in the relaxed
//                           branch — its only purpose is preventing a
//                           permission dialog, which cannot occur under
//                           bypassPermissions.
//   - no-background-floor: no explicit prohibition of background task
//                           creation (e.g. Bash run_in_background) found in
//                           the dispatch text. REINSTATED (mode-gated) —
//                           see "PERMISSION-MODE-AWARE RELAXATION" below for
//                           the full history; fires ONLY in the full-check
//                           branch, using the already-defined/exported
//                           hasNoBackgroundClause and NO_BACKGROUND_PATTERNS.
//                           SKIPPED in the relaxed branch.
//   - settings-unparsable: a settings layer file exists but failed to
//                           JSON.parse. NOT fail-open (P-4/P-10) — see below.
//                           NEVER skipped, in EITHER branch (A2): an
//                           unparsable layer means the deny list (lint-g)
//                           cannot be verified, exactly when lint-g is the
//                           only brake left standing.
//   - settings-bare-bash:  merged allow[] (union of the three layers) does
//                           not contain the literal bare string "Bash".
//                           SKIPPED in the relaxed branch — a dialog-only
//                           gate, moot when no dialog can occur.
//   - lint-a .. lint-g:    the seven prompt-text lints in the header section
//                           "PROMPT LINTS" further down, each context-scoped
//                           per P-1/P-6/P-8 as documented at each function.
//                           Only lint-e (PowerShell-mention-while-not-
//                           allow-listed) is SKIPPED in the relaxed branch;
//                           lint-a/b/c/d/f/g fire in BOTH branches — lint-f
//                           (path outside sandbox) is a blast-radius brake,
//                           not only a dialog gate (A3), and lint-g (deny
//                           list) is kept because deny rules are enforced
//                           even under bypassPermissions per Claude Code's
//                           documented behavior.
//
// ── SETTINGS BASELINE — THREE LAYERS, UNION MERGE ──────────────────────────
// Layers, in the order checked (all are read regardless of order — this is
// a union merge, not a first-match/override chain):
//   1. <cwd>/.claude/settings.local.json
//   2. <cwd>/.claude/settings.json
//   3. ~/.claude/settings.json  (os.homedir())
// `cwd` comes from the hook input JSON's `cwd` field; falls back to
// process.cwd() if absent (mirrors the convention already used by
// pr-independence.js / bash-powershell-guard.js in this directory).
// A MISSING file is an empty layer (allow: [], deny: []) — fine, no finding.
// A PRESENT-BUT-UNPARSABLE file (exists, JSON.parse throws) is its own named
// BLOCK finding naming the exact path, with the message: "settings file
// <path> unparsable — fix it in the MAIN checkout; already-running
// worktree-isolated agents won't see the fix." This is DELIBERATELY NOT
// fail-open (P-4, P-10): a corrupt settings file is exactly the kind of
// permission-surface regression this hook exists to catch, and fail-opening
// past it would silently defeat the hook's own purpose the one time it
// matters most. Merge: union(allow arrays), union(deny arrays); a layer
// contributing neither key is treated as [] for that key (P-5).
//
// ── BARE "Bash" GATE AND ITS SCOPE ──────────────────────────────────────────
// If bare "Bash" (the literal string, not "Bash(*)" or any scoped form — see
// "WHAT THIS HOOK CANNOT ENFORCE" for why the distinction matters in
// practice) is absent from the merged allow[], that is a BLOCK finding — but
// ONLY for dispatches that are not structurally exempt. Agent calls whose
// subagent_type is in EXEMPT_TYPES (mirrored from agent-adversary-floor.js)
// skip this check entirely, same as they skip the marker floor and every
// prompt lint — they are read-only by tool grant, so nothing they do can hit
// a Bash-gated dialog. SendMessage is ALWAYS subject to this check; it has
// no subagent_type to exempt against (P-3).
//
// ── PROMPT LINTS (a)-(g) — CONTEXT SCOPING IS THE WHOLE DESIGN ─────────────
// Six of the seven lints (a, b, d, e, f, g) match ONLY inside:
//   - triple-backtick fenced spans or single-backtick inline spans, OR
//   - the ~60 chars following a directive cue matching
//     /(?:^|\n)\s*(?:Run|Execute|Then run|Use)\s*:/i, OR
//   - a full line beginning with a shell sigil ("$ " or "> " at line start).
// Lint (f) additionally scans a short window around literal "Write"/"Edit"
// keyword occurrences (its own P-8 accommodation — see the lint's own
// comment). Lint (c) is the ONE exception: it scans the FULL raw text,
// because the phrase itself ("edit settings.json") is the hazard regardless
// of fencing — an unfenced instruction to edit the permission surface is
// exactly as dangerous as a fenced one, so narrowing its scope would be a
// self-defeating carve-out, not a safety improvement.
//
// ── PERMISSION-MODE-AWARE RELAXATION (bypassPermissions) ───────────────────
// Current Claude Code docs (verified 2026-08-22 at code.claude.com/docs/en/
// hooks.md) confirm that every hook event's stdin JSON carries a common
// `permission_mode` field, a trusted, harness-controlled string with
// documented values "default", "plan", "acceptEdits", "auto", "dontAsk",
// "bypassPermissions". This operator's sessions default to
// bypassPermissions, a mode where permission dialogs cannot occur at all —
// which makes every dialog-prevention-only check in this file pure friction
// for that mode. This section adds a RELAXED branch that skips exactly the
// findings whose sole purpose is preventing a dialog, and only when the
// dispatch is one this hook can actually attribute to that mode.
//
// Entry condition (the total classification, implemented by the exported
// pure function isRelaxedDispatch — see its own doc comment for the exact
// rule): relaxed ONLY when ALL of (1) permission_mode === "bypassPermissions"
// via a STRICT === comparison — no trim, no case-fold, no substring match;
// any other value, any casing/whitespace variant, a missing field, or a
// non-string value lands in the full-check branch; (2a) tool_name ===
// "SendMessage" (C-1, 2026-08-24, REPLACES the prior A1 rule below) — see
// "SENDMESSAGE RELAXATION (C-1)" further down for the full rationale and
// what stays unlinted; OR (2b) tool_name === "Agent" AND tool_input either
// has NO "isolation" key OR has the exact value "worktree" (A3, amended
// 2026-08-24 operator-directed): a worktree spawn runs in the same local
// harness process and inherits this session's permission mode, so it
// relaxes like an un-isolated spawn — required because standing canon puts
// isolation:"worktree" on EVERY Agent call, which under the old rule made
// the relaxed branch unreachable in practice. Any OTHER isolation value
// (e.g. "remote", empty string, null) still forces full checks: such a spawn
// may execute under a permission regime this event's permission_mode does
// not describe. SendMessage carries no "isolation" concept in this hook's
// model at all — the C-1 rule below is unconditional on that field.
//
// ── SENDMESSAGE RELAXATION (C-1, 2026-08-24, supersedes the prior "A1"
// premise) ───────────────────────────────────────────────────────────────
// PRIOR premise (A1, now retired): SendMessage was hard-coded to full checks
// in every mode because "its permission_mode describes the SENDER's mode,
// but the RECEIVER that actually executes the resumed text may be running
// under any mode, a fact this event carries no information about." Field
// defect: this made a natural marker-less "please continue" resume of a
// worktree-isolated agent block on marker-floor + no-background-floor, and
// the premise became INCOHERENT the moment A3 (above) started relaxing
// worktree Agent *spawns* under bypassPermissions on exactly the opposite
// reasoning: a worktree spawn/resume runs in the SAME local harness process
// and inherits this session's permission mode. A spawn and a resume of that
// same spawned agent cannot coherently sit on opposite sides of that
// premise — every LOCALLY reachable receiver (spawned OR resumed) executes
// inside the same harness process whose mode THIS event reports, and the
// receiver's own spawn already passed this same hook under the mode in
// force. C-1 therefore extends the relaxed branch to SendMessage
// unconditionally (no isolation check — SendMessage has no such field):
// relaxed iff permission_mode === "bypassPermissions" (strict ===) AND
// tool_name === "SendMessage". The skip-set is IDENTICAL to the Agent
// relaxed branch (marker-floor, settings-bare-bash, lint-e, no-background-
// floor) — lint-a/b/c/d/f/g and settings-unparsable still run on every
// resume's text unconditionally, so a resume instructing a fenced force-push
// still blocks (R8c).
//
// Rejected alternative (C-2, documented per operator instruction, NOT
// implemented): require POSITIVE receiver-locality evidence (e.g. probing
// for the existence of a worktree directory named/referenced in the resume)
// before relaxing SendMessage. Rejected because it breaks resume of
// legitimate non-worktree LOCAL agents (this hook has no reliable way to
// enumerate "all locally-reachable receivers" from the SendMessage payload
// alone), and because a genuinely REMOTE receiver's own permissions are
// governed remotely by that receiver's own harness instance regardless of
// what this hook decides — the marker-floor buys nothing there either way,
// so the extra probe would add cost without closing a real gap.
//
// One genuine, accepted loss from C-1 (doctrinal, not a safety loss): under
// bypassPermissions, a SendMessage resume no longer carries the zero-dialog/
// permission-safe marker-floor discipline signal. Since no dialog can occur
// in this mode regardless, this is accepted as friction removed, not
// protection removed.
//
// What the relaxed branch skips: exactly three findings — marker-floor,
// settings-bare-bash, and lint-e (PowerShell-mention-while-not-allow-
// listed) — because each exists solely to prevent a permission dialog,
// which cannot occur under bypassPermissions. Everything else stays active
// in BOTH branches, including settings-unparsable (A2, see above), lint-f
// (A3, a blast-radius brake rather than only a dialog gate), and lint-g
// (deny rules remain enforced even in bypassPermissions mode per the
// docs). The no-background-floor (see the dedicated comment block at
// NO_BACKGROUND_PATTERNS/hasNoBackgroundClause below) is REINSTATED by this
// change but gated the other direction: it fires ONLY in the full-check
// branch, since its hazard was empirically eliminated under bypass (that
// empirical basis is precisely why it was removed on 2026-08-16 — see that
// comment block for the caveat that the basis has not been re-verified
// against the current harness build).
//
// Deliberately-partial modes collapse into full checks (A5/A6): each of
// "acceptEdits", "plan", "auto", and "dontAsk" is a genuinely PARTIAL
// permission mode — none of them is a full dialog-gate equivalent to
// "default", and none is the total dialog-elimination of
// "bypassPermissions" either. This file does not attempt to model the
// partial-relaxation semantics of each one; every value other than the
// exact literal "bypassPermissions" collapses into the full-check branch.
// Friction is the safe direction here: a false "full checks ran when they
// didn't need to" costs a rewrite-and-retry; a false "relaxed when it
// shouldn't have been" would silently skip a dialog-prevention check in a
// mode that can still dialog.
//
// agent-adversary-floor.js, the sibling PreToolUse hook on these same
// dispatches, is mode-blind BY DESIGN (A8): it has no permission_mode
// awareness and none is added here — its blind-spot-clause requirement is
// completely untouched by this change and enforces regardless of mode.
//
// Debug-log implication (A10): every appendDebug entry main() writes for a
// classified dispatch (allow, block, exempt, and any fail-open case where
// parsing got far enough to read the field) now carries the raw observed
// `permission_mode` (or null if absent/non-string) and the resolved
// `branch` ("relaxed" or "full"). This logging can confirm ONLY that THIS
// session's harness build populated (or didn't populate) the field on THIS
// event — it cannot establish what mode any OTHER session, or an isolated
// subagent spawned from this one, is actually running under. Treat the log
// as a local sanity check, never as proof of a fleet-wide invariant.
//
// ── WHAT THIS HOOK CANNOT ENFORCE (be honest about this) ────────────────────
//   - Prose-phrased hazards with no fence, no directive cue, and no shell
//     sigil are DELIBERATELY out of scope for lints a/b/d/e/f/g (this is the
//     P-1 fix, not a gap to be closed later) — but that means a hazard
//     phrased as plain English mid-paragraph ("then push with dash-dash-
//     force to origin") escapes detection by design. The false-negative
//     rate of this deliberate carve-out is UNTESTED beyond the specific
//     fixtures in agent-permission-preflight.test.js.
//   - Whether PreToolUse actually fires for tool_name "SendMessage" in this
//     harness build. Per the same inference agent-adversary-floor.js
//     documents (PreToolUse is described as firing "before any tool runs"
//     with `matcher` tested as a plain regex against `tool_name`, no
//     documented SendMessage carve-out) — this is INFERRED from the
//     documented contract, not empirically confirmed by observing a live
//     PreToolUse:SendMessage event. If the harness does not route
//     SendMessage through PreToolUse, the SendMessage branch is simply dead
//     code — inert, never invoked, never falsely blocking.
//   - Regex forms are verified only against the shapes the P-1..P-10
//     adversary pass explicitly pinned and the fixtures in the paired test
//     file exercise. A sufficiently different phrasing of the same hazard
//     (e.g. a force-push flag spelled out across an env-var-heavy one-liner
//     this file's author didn't anticipate) may not match either lint's
//     context window.
//   - Per-path glob-scoped allow rules (e.g. "Write(//home/example/.claude/
//     hooks/**)") are NOT parsed or evaluated for lint (f). Lint (f) treats
//     ONLY the literal bare-tool-name presence ("Write" / "Edit" exact
//     string) as the covering grant, and the local-policy sandbox-roots
//     list (see hooks/lib/local-policy.js) as the covering location. A
//     settings layer with a scoped grant like "Write(*)" (present in some
//     operators' real settings, NOT the bare
//     "Write" string) does NOT satisfy the bare-token check as currently
//     written — this is a deliberate literal reading of the spec's "bare
//     tool name" language (friction over silent escape), but it means lint
//     (f) will likely fire more often in this real environment than a
//     "does the settings system actually grant this" oracle would predict.
//   - Lint (f)'s sandbox-root check (isWithinSandbox / resolvePathForSandboxCompare)
//     is a PURELY LEXICAL resolution: it collapses "." and ".." segments with
//     path.win32.normalize but never calls fs.realpath. A symlink or NTFS
//     junction/reparse point inside a sandbox root whose target resolves
//     OUTSIDE every root is invisible to this check and is treated as
//     "inside" — same for a Windows 8.3 short-name alias (e.g.
//     "C:\Projects\acct\DEV~1\..\Windows\System32") and for two paths that
//     differ only by case on a case-sensitive volume (e.g. WSL2 ext4) where
//     this hook's lowercase-everything comparison treats them as identical
//     when the filesystem would not. None of these are exercised by this
//     change's tests; they are pre-existing gaps this fix does not close.
//   - That the orchestrator actually rewrites the dispatch correctly after a
//     block, or that a clean ALLOW means the subagent's actual runtime
//     behavior (as opposed to its dispatch TEXT) stays permission-safe —
//     this hook only ever reads the dispatch prompt/message, never what the
//     subagent goes on to actually do.
//   - Multi-turn SendMessage resumes are each scanned independently and
//     fully (no first-turn-only shortcut, per P-7) — but only the field(s)
//     visible on THIS call (`message`, and `prompt` if present) are ever
//     seen; content injected into the subagent's context by prior turns
//     that isn't re-stated in the current call is invisible to this hook.
//   - No lint in this file content-scans PowerShell command BODIES for
//     destructive operations, in EITHER branch. Lint (e) only ever checked
//     whether the literal word "PowerShell" appeared while the tool wasn't
//     allow-listed — it incidentally provided partial friction against
//     PowerShell-borne hazards simply by gating the tool's mention at all,
//     and that incidental friction is now also SKIPPED under
//     bypassPermissions (relaxed branch). Nothing in this file has ever
//     parsed or evaluated PowerShell command text for destructive intent;
//     this is a known residual gap, explicitly out of scope for this
//     change.
//   - PREMISE-DECAY TRIPWIRE (A3/C-1 Tightening-2, 2026-08-24, operator-
//     directed): both A3 (worktree Agent spawns relax) and C-1 (SendMessage
//     resumes relax) share one load-bearing premise — that a worktree-
//     isolated dispatch executes IN-PROCESS with this same harness session,
//     inheriting the SAME permission mode this event reports. If a future
//     harness build executes worktree isolation OUT-OF-PROCESS (a separate
//     process/session with its own permission profile) or grants a distinct
//     permission profile to isolated work, that premise silently breaks and
//     this file would over-relax without any code-level signal that
//     anything changed. This file cannot detect that shift on its own — it
//     has no visibility into how the harness actually executes a spawned or
//     resumed agent. The DEBUG-LOG `branch`/`permission_mode` fields (see
//     "Debug-log implication" above) are the intended drift instrument: a
//     logged `branch:"relaxed"` event that coincides with an OBSERVED
//     permission dialog on that same dispatch is the tripwire, and should be
//     treated as a severity-worthy defect signal against this file's core
//     premise, not merely a one-off surprise to route around.
//
// ── FAIL-OPEN POLICY (deliberate house policy, with one carve-out) ─────────
// On stdin-read failure, hook-JSON parse failure, a non-object parsed
// payload, missing/empty tool_name, a missing/non-string prompt (Agent) or
// message (SendMessage) field, or ANY internal exception in this hook's own
// classification logic: ALLOW, append a debug-log line, AND write the
// non-blocking stderr note "preflight SKIPPED (<reason>)" (P-9) so the skip
// is visible in the transcript, not just in a log file nobody tails. This
// hook gates the Agent/SendMessage tools themselves; a fail-closed bug here
// would deadlock every delegation path in a session. The ONE deliberate
// exception is the settings-file-unparsable condition (see above): that
// specific condition is promoted to a named BLOCK finding, never routed
// through this fail-open path, because it IS the exact permission-surface
// regression this hook exists to catch (P-4/P-10).
//
// No process.platform branching anywhere in this file — capability
// detection only (file existence, field shape, string content), never OS
// branching. Node only, no dependencies.

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { appendRotating } = require("./model-routing-guards.log.js");
const { loadLocalPolicy } = require("./lib/local-policy.js");

// ── Paths ──────────────────────────────────────────────────────────────────
// Debug log lives next to wherever this file itself runs from (__dirname),
// matching the convention used by every other hook in this directory.
const HOOKS_DIR = __dirname;
const DEBUG_LOG = path.join(HOOKS_DIR, "agent-permission-preflight-debug.log");

// ── Helpers: debug log / fail-open note ─────────────────────────────────────

function appendDebug(obj) {
  appendRotating(DEBUG_LOG, JSON.stringify(obj));
}

/**
 * The ONE way any fail-open exit happens in this file (outcome #2, P-9):
 * log it AND surface a non-blocking stderr note, then exit 0.
 */
function allowFailOpen(reason, extra) {
  appendDebug(Object.assign(
    { ts: new Date().toISOString(), event: "fail_open", reason },
    extra || {}
  ));
  try {
    process.stderr.write(`agent-permission-preflight: preflight SKIPPED (${reason})\n`);
  } catch (_) {
    // Never crash trying to report the skip.
  }
  process.exit(0);
}

// ── Structural exempt set — mirrored from agent-adversary-floor.js ─────────
// Per task spec: reuse that file's EXEMPT_TYPES at load time if importable
// (it exports the array and guards main() behind require.main === module,
// so requiring it as a module is safe — no side effects). Falls back to a
// literal mirror, pinned to that file's source as of this writing, if the
// require fails for any reason (file moved/deleted/syntax-broken).
let EXEMPT_TYPES;
try {
  EXEMPT_TYPES = require("./agent-adversary-floor.js").EXEMPT_TYPES;
  if (!Array.isArray(EXEMPT_TYPES) || EXEMPT_TYPES.length === 0) {
    throw new Error("EXEMPT_TYPES missing or empty on required module");
  }
} catch (_) {
  // Mirrors agent-adversary-floor.js EXEMPT_TYPES verbatim (source: the
  // "Structural exempt set (read-only by tool grant)" section of that file).
  // Keep this literal in sync with that file if it changes.
  EXEMPT_TYPES = [
    "Explore",
    "Plan",
    "claude-code-guide",
    "plugin-dev:plugin-validator",
    "plugin-dev:skill-reviewer",
  ];
}

function isExemptType(subagentType) {
  return EXEMPT_TYPES.indexOf(subagentType) !== -1;
}

// ── Marker floor ─────────────────────────────────────────────────────────
// Case-insensitive match covers "zero-dialog", "permission-safe", and
// "PERMISSION-SAFE" as the same regex (the /i flag already subsumes the
// all-caps form — no need for a second literal).
const MARKER_RE = /zero-dialog|permission-safe/i;

// ── No-backgrounding floor (REINSTATED, mode-gated to the full-check branch)
// The finding that consumes hasNoBackgroundClause was removed 2026-08-16
// (under defaultMode bypassPermissions, background task creation no longer
// dialogs, so the floor was moot in that mode) and is REINSTATED here,
// gated so it fires ONLY in the full-check branch (see "PERMISSION-MODE-
// AWARE RELAXATION" above) — in the relaxed branch it is skipped, on the
// same empirical basis that motivated the 2026-08-16 removal. That basis
// (that bypassPermissions eliminates the dialog for run_in_background) has
// NOT been re-verified against the current harness build as of this
// reinstatement; it is carried forward as an inference, not a fresh
// empirical confirmation. The patterns and helper below were kept defined,
// exported, and unit-tested through the removal specifically so this
// reinstatement would not need to reconstruct them.
// Original rationale, still governing the full-check branch:
// Empirical discovery (post-ship): Bash `run_in_background` task creation
// triggers an owner-side approval dialog REGARDLESS of the permissions
// allowlist — no allow-array entry can suppress it, so this is not a
// settings-baseline concern like the Bash/PowerShell checks above, it's a
// pure prompt-text floor: the dispatch must carry an explicit instruction
// not to use it. Same PRESENCE-CHECK shape as the marker floor (never a
// negation lookback, never scoped to fences/cues — this is deliberately the
// one prompt-text floor that, like the marker, is satisfied by presence of
// a PROHIBITION anywhere in the text, not by absence of the word
// "background"). Three independent forms satisfy it:
//   1. a prohibition word (never/no/don't/forbidden) within ~60 chars of
//      "background", either order;
//   2. the literal token "run_in_background" preceded within ~40 chars by
//      never/no/don't.
// A bare, non-prohibiting mention of "background" ("the agent runs in the
// background") does NOT satisfy this — that is the floor working as
// intended: this hook cannot tell whether such a sentence is incidental
// color or actually describes intended behavior, so it treats the absence
// of an explicit prohibition as the absence of the rule.
const NO_BACKGROUND_PATTERNS = [
  /\b(?:never|no|don'?t|forbidden)\b[^.\n]{0,60}\bbackground\b/i,
  /\bbackground\b[^.\n]{0,60}\b(?:forbidden|prohibited|never)\b/i,
];

function hasNoBackgroundClause(text) {
  for (const re of NO_BACKGROUND_PATTERNS) {
    if (re.test(text)) return true;
  }
  const tokenRe = /run_in_background/gi;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const windowStart = Math.max(0, m.index - 40);
    const window = text.slice(windowStart, m.index);
    if (/\b(?:never|no|don'?t)\b/i.test(window)) return true;
  }
  return false;
}

// ── Relaxed-dispatch classifier (total classification, see header) ────────

/**
 * Pure total classification: does this dispatch qualify for the relaxed
 * (bypassPermissions-only) check set? Returns true when:
 *   - permissionMode === "bypassPermissions", STRICT ===. No trim, no
 *     case-fold, no substring test. A missing field, a non-string value,
 *     any other documented mode ("default", "plan", "acceptEdits", "auto",
 *     "dontAsk"), or any casing/whitespace variant of the bypass literal
 *     all fall through to false. This condition is required in EVERY case
 *     below — nothing relaxes outside bypassPermissions.
 *   AND EITHER:
 *   - toolName === "SendMessage" (C-1, 2026-08-24, supersedes the retired
 *     "A1 — SendMessage never relaxed" rule; see the header's "SENDMESSAGE
 *     RELAXATION (C-1)" section for the full rationale). Unconditional on
 *     `toolInput` — SendMessage carries no "isolation" concept in this
 *     hook's model, so there is nothing further to check.
 *   OR
 *   - toolName === "Agent" AND toolInput carries NO "isolation" key at all,
 *     OR carries "isolation" with the exact value "worktree". Presence of
 *     an "isolation" key with any OTHER value — including an empty string —
 *     forces false (A3): an isolated spawn may run under a permission
 *     regime this event's permission_mode does not describe.
 * Any other toolName (Bash, empty string, etc.) falls through to false.
 * This is a TOTAL classification, not an allow-list: every combination of
 * inputs maps to exactly one of {true, false}, and every unrecognized or
 * ambiguous combination maps to false (the safer, full-check branch).
 */
function isRelaxedDispatch(toolName, toolInput, permissionMode) {
  if (permissionMode !== "bypassPermissions") return false;
  // C-1 (2026-08-24): every SendMessage call relaxes unconditionally under
  // bypassPermissions — see the header rationale. No isolation field exists
  // on this tool's input to further gate on.
  if (toolName === "SendMessage") return true;
  if (toolName !== "Agent") return false;
  const input = (toolInput && typeof toolInput === "object") ? toolInput : {};
  // A3 (amended 2026-08-24, operator-directed): "worktree" isolation runs in
  // the SAME local harness process and inherits this session's permission
  // mode, so it relaxes exactly like an un-isolated spawn. Every OTHER
  // isolation value (e.g. "remote", empty string, null — presence with any
  // non-"worktree" value) still forces full checks: those spawns may execute
  // under a permission regime this event's permission_mode does not describe.
  if (
    Object.prototype.hasOwnProperty.call(input, "isolation") &&
    input.isolation !== "worktree"
  ) return false;
  return true;
}

// ── Directive-cue / fence / sigil span extraction (P-1 core mechanism) ─────

/**
 * Extract the CONTENTS of every triple-backtick fenced block and every
 * single-backtick inline span, as an array of independent strings. Kept as
 * separate array entries (never joined into one blob) so a lint's own
 * context window never bleeds across unrelated spans.
 */
function extractCodeSpans(text) {
  const spans = [];
  const fenceRe = /```[^\n]*\n?([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    spans.push(m[1]);
  }
  const withoutFences = text.replace(fenceRe, " ");
  const inlineRe = /`([^`\n]+)`/g;
  while ((m = inlineRe.exec(withoutFences)) !== null) {
    spans.push(m[1]);
  }
  return spans;
}

/**
 * Extract the ~60-char window following each directive cue
 * (Run:/Execute:/Then run:/Use: at line start, case-insensitive).
 */
function extractCueWindows(text) {
  const spans = [];
  const cueRe = /(?:^|\n)[ \t]*(?:Run|Execute|Then run|Use)\s*:/gim;
  let m;
  while ((m = cueRe.exec(text)) !== null) {
    const start = m.index + m[0].length;
    spans.push(text.slice(start, start + 60));
  }
  return spans;
}

/**
 * Extract each full line that begins (after optional leading whitespace)
 * with a shell sigil: "$ " or "> ".
 */
function extractSigilLines(text) {
  const spans = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^[ \t]*[$>][ \t]+/.test(line)) {
      spans.push(line);
    }
  }
  return spans;
}

/**
 * Lint (f) only: a short window around each literal "Write"/"Edit" keyword
 * occurrence, so a path token stated near a Write/Edit instruction in plain
 * prose (not fenced, no directive cue) is still catchable — per spec this
 * lint's hazard is "targeted by Write/Edit instructions", which is a
 * narrower and more specific context class than the generic directive-cue
 * set used by the other lints.
 */
function extractToolTargetWindows(text) {
  const spans = [];
  const re = /\b(?:Write|Edit)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 10);
    spans.push(text.slice(start, m.index + 80));
  }
  return spans;
}

function genericSpans(text) {
  return extractCodeSpans(text)
    .concat(extractCueWindows(text))
    .concat(extractSigilLines(text));
}

function pathTargetSpans(text) {
  return genericSpans(text).concat(extractToolTargetWindows(text));
}

// ── Lint (a): git push force forms ──────────────────────────────────────────
// Context-scoped to a ~40-char window starting at each "git push" match
// (tolerant of line-wraps and env-var prefixes simply because the window is
// a raw character slice — a backslash-newline continuation or a leading
// "FOO=bar " prefix before "git push" doesn't change where "git push" itself
// starts). Matches --force, --force-with-lease(=...)?, and a STANDALONE -f
// token (word-bounded both sides so "-force"/"--force" never double-fires
// through the -f branch, and so an unrelated "-f" outside this window, e.g.
// `curl -f` with no nearby "git push", never matches at all — that's the
// P-6 overreach regression this scoping exists to prevent).
const FORCE_FLAG_RE = /--force(?:-with-lease(?:=\S*)?)?\b|(?<![\w-])-f\b/i;

function scanGitPushForce(spans) {
  const gitPushRe = /git\s+push\b/gi;
  for (const span of spans) {
    gitPushRe.lastIndex = 0;
    let m;
    while ((m = gitPushRe.exec(span)) !== null) {
      const window = span.slice(m.index, m.index + m[0].length + 40);
      if (FORCE_FLAG_RE.test(window)) {
        return {
          fired: true,
          detail: `force-push form detected near "git push": "${window.replace(/\s+/g, " ").trim().slice(0, 80)}". ` +
            `Instead of force-pushing, merge origin/main into the branch to reconcile history.`,
        };
      }
    }
  }
  return { fired: false };
}

// ── Lint (b): interactive git forms ─────────────────────────────────────────
// Same context-scoping approach as (a): a ~40-char window after each
// "git rebase"/"git add" match, tested for -i/--interactive/-p/--patch.
function scanInteractiveGit(spans) {
  const gitCmdRe = /git\s+(?:rebase|add)\b/gi;
  const flagRe = /(?:-i\b|--interactive\b|-p\b|--patch\b)/i;
  for (const span of spans) {
    gitCmdRe.lastIndex = 0;
    let m;
    while ((m = gitCmdRe.exec(span)) !== null) {
      const window = span.slice(m.index, m.index + m[0].length + 40);
      if (flagRe.test(window)) {
        return {
          fired: true,
          detail: `interactive git form detected: "${window.replace(/\s+/g, " ").trim().slice(0, 80)}"`,
        };
      }
    }
  }
  return { fired: false };
}

// ── Lint (c): settings-file edit instruction ────────────────────────────────
// The ONE lint that scans the FULL raw text (not spans) — see header
// comment "PROMPT LINTS" for why. Matches either verb-then-file or
// file-then-verb ordering within a ~40-char window.
const SETTINGS_EDIT_RE =
  /\b(?:edit|modify|write)\b[\s\S]{0,40}?settings(?:\.local)?\.json|settings(?:\.local)?\.json[\s\S]{0,40}?\b(?:edit|modify|write)\b/i;

function scanSettingsEdit(fullText) {
  const m = SETTINGS_EDIT_RE.exec(fullText);
  if (!m) return { fired: false };
  return {
    fired: true,
    detail: `instruction to edit/modify/write settings.json or settings.local.json detected: "${m[0].replace(/\s+/g, " ").trim().slice(0, 80)}"`,
  };
}

// ── Lint (d): sudo ───────────────────────────────────────────────────────────
function scanSudo(spans) {
  for (const span of spans) {
    if (/\bsudo\b/i.test(span)) {
      return { fired: true, detail: `sudo usage detected: "${span.trim().slice(0, 80)}"` };
    }
  }
  return { fired: false };
}

// ── Lint (e): PowerShell tool usage instruction ─────────────────────────────
// Only evaluated at all when "PowerShell" (bare literal) is absent from the
// merged allow[] — see caller.
function scanPowerShellToolUsage(spans) {
  for (const span of spans) {
    if (/\bPowerShell\b/i.test(span)) {
      return {
        fired: true,
        detail: `PowerShell tool usage instruction detected while "PowerShell" is absent from merged allow: "${span.trim().slice(0, 80)}"`,
      };
    }
  }
  return { fired: false };
}

// ── Lint (f): absolute-path-shaped tokens targeted by Write/Edit ───────────
// See header "WHAT THIS HOOK CANNOT ENFORCE" for the documented
// approximation this lint makes (bare-token-only, local-policy sandbox-roots
// list, no glob-scoped-rule parsing).
const PATH_TOKEN_RE = /[A-Za-z]:[\\/][^\s"'`)]+|~[\\/][^\s"'`)]+|\/c\/[^\s"'`)]+/g;

function normalizePathStr(p) {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

// Resolve a path token to a normalized (lowercase, forward-slash,
// dot-segment-collapsed) string suitable for prefix comparison against
// sandbox roots, or return null when the token cannot be safely resolved.
// TOTAL CLASSIFICATION: an unresolvable token is NEVER "inside" a root —
// callers must fold null into "outside every root" (the lint's block
// branch), never "allow". This is the fix for the lexical-startsWith
// evasion (a `C:/Projects/acct/dev/../Windows/System32/x.txt` token starts
// with the `C:/Projects/acct/dev` root as a bare string, yet resolves
// outside every root once `..` is collapsed).
//
// - UNC paths ("\\server\share\..." / "//server/share/...") never resolve
//   under a local drive-letter root; returned as null rather than run
//   through win32 normalization (which accepts them as well-formed and
//   would otherwise produce a string that happens never to match today,
//   but should not be relied on to keep not matching).
// - Drive-relative paths ("C:foo.txt" — a drive letter with no separator
//   immediately after the colon) resolve against the current directory OF
//   THAT DRIVE, which this process has no reliable way to know; returned
//   as null rather than guessed at.
// - Everything else (a native Windows absolute path, or the "/c/..."
//   POSIX/MSYS drive form already rewritten to "c:/...") is run through
//   path.win32.normalize to collapse "." and ".." segments — purely
//   lexical, no filesystem access. This does NOT resolve symlinks or
//   junctions (no fs.realpath): this hook has never done that here, and
//   this fix does not change that posture — see the header section "WHAT
//   THIS HOOK CANNOT ENFORCE" for the documented blind spot.
function resolvePathForSandboxCompare(p) {
  if (typeof p !== "string" || p === "") return null;
  let s = p.replace(/\\/g, "/");
  // Normalize "/c/..." form to "c:/..." so it resolves on equal footing
  // with native Windows absolute paths.
  s = s.replace(/^\/([A-Za-z])\//, "$1:/");

  if (/^\/\//.test(s)) return null; // UNC — never a local drive-letter root
  if (/^[A-Za-z]:[^/]/.test(s)) return null; // drive-relative "C:foo.txt"

  let resolved;
  try {
    resolved = path.win32.normalize(s);
  } catch (_) {
    return null;
  }
  resolved = resolved.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return resolved || null;
}

// Sandbox roots are machine/project-specific, so they never live in this
// file: they come from the optional ~/.claude/hooks/local-policy.json
// (hooks/lib/local-policy.js). Absent that file, the only root is cwd.
// Roots get the SAME dot-collapsing resolution as candidate tokens (a root
// sourced from local-policy.json or a symlinked cwd/tmpdir could otherwise
// itself contain an un-collapsed "..", silently widening or narrowing the
// prefix check). An unresolvable root is dropped rather than kept in its
// raw lexical form — it can never safely anchor a prefix match.
function buildSandboxRoots(cwd) {
  const policy = loadLocalPolicy();
  const roots = [];
  const pushRoot = (raw) => {
    const resolved = resolvePathForSandboxCompare(raw);
    if (resolved) roots.push(resolved);
  };
  pushRoot(cwd);
  for (const root of policy.roots) {
    pushRoot(root);
  }
  try {
    const tmp = os.tmpdir();
    if (tmp) pushRoot(tmp);
  } catch (_) {
    // ignore
  }
  return roots;
}

function isWithinSandbox(pathToken, sandboxRoots) {
  const norm = resolvePathForSandboxCompare(pathToken);
  // Unresolvable token (UNC, drive-relative, or any other resolution
  // failure) is never "inside" a root — total-classification default is
  // block, never allow.
  if (norm === null) return false;
  // Separator-boundary equality/prefix check: `root` must equal the
  // candidate exactly, or be followed immediately by "/" — never a bare
  // string prefix. This is what stops a root `c:/projects/acct/dev` from
  // matching a sibling directory `c:/projects/acct/development/...`.
  return sandboxRoots.some((root) => root && (norm === root || norm.startsWith(root + "/")));
}

function scanAbsolutePathTargets(spans, sandboxRoots, mergedAllow) {
  for (const span of spans) {
    const re = new RegExp(PATH_TOKEN_RE.source, "g");
    let m;
    while ((m = re.exec(span)) !== null) {
      const token = m[0];
      if (isWithinSandbox(token, sandboxRoots)) continue;
      const mentionsWrite = /\bWrite\b/.test(span);
      const mentionsEdit = /\bEdit\b/.test(span);
      const writeAbsent = mentionsWrite && mergedAllow.indexOf("Write") === -1;
      const editAbsent = mentionsEdit && mergedAllow.indexOf("Edit") === -1;
      if (writeAbsent || editAbsent) {
        return {
          fired: true,
          detail: `absolute path outside sandbox roots ("${token}") targeted by a ${writeAbsent ? "Write" : "Edit"} ` +
            `instruction, and bare "${writeAbsent ? "Write" : "Edit"}" is absent from merged allow`,
        };
      }
    }
  }
  return { fired: false };
}

// ── Lint (g): merged-deny-list patterns (hardened spec B, 2026-08-24) ──────
// Field defect ("rd-glob"): the prior globPatternToRegex escaped everything
// except `*` (turned into `.*`) but never bounded the resulting regex at
// all — an UNANCHORED, non-word-bounded substring test. `PowerShell(rd *)`
// became the bare regex `/rd .*/i`, which matches the "rd " substring
// wherever it happens to occur character-for-character — including mid-word
// inside "standa*rd s*trict", "worktree-gua*rd m*ain", "reco*rd r*egistry",
// etc. Lint (g) ran in BOTH the relaxed and full-check branches (deny rules
// are enforced even under bypassPermissions), so any dispatch merely
// MENTIONING such an unrelated word inside a fenced/cue/sigil span blocked.
// It was also a category error: a PowerShell-scoped deny rule was
// substring-matched against Bash-shaped dispatch text with no PowerShell
// context signal at all.
//
// Fix — total classification of every deny entry (B-1):
//   Bash(<pattern>)        -> escape + glob-expand the pattern, `\b`-bound
//                             the LEADING VERB TOKEN on both sides (so
//                             "rd" cannot match inside "standard"), literal
//                             spaces become `\s+`. Tested unconditionally
//                             against the same context-scoped generic spans
//                             every other lint uses (fenced/cue/sigil).
//   PowerShell(<pattern>)  -> SAME regex construction, but only ATTEMPTED
//                             when EITHER the span/dispatch context
//                             independently indicates PowerShell usage, OR
//                             the pattern's own verb token appears in
//                             COMMAND POSITION within the span (see
//                             verbInCommandPosition below — this reuses the
//                             exact command-boundary character class the
//                             worktree-isolation-guard's install-detector
//                             pinned: `; & | \` ( \n` + span start). Never a
//                             raw substring test against Bash-shaped text.
//   <Tool> bare (no parens) or `mcp__*`
//                          -> WHOLE-TOKEN literal match (`\b<escaped>\b`,
//                             no glob interpretation at all) against spans.
//   any other `Tool(pattern)` prefix (not Bash/PowerShell — e.g. a
//   hypothetical `Write(...)` deny entry; no such row is enumerated by the
//   spec, so this is a total-classification completion, not a literal spec
//   requirement): treated the SAME as the Bash row (unconditional,
//   command-boundary-bounded verb match) — the safer default per this
//   operator's own "friction over silent escape" doctrine for an unlisted
//   shape, rather than silently skipping it.
//   unparsable / empty entry (e.g. "Bash()", a non-string, or an
//   empty/whitespace-only string)
//                          -> a NAMED finding `deny-entry-unverifiable`
//                             listing the exact entry (friction, not the
//                             prior silent `continue`) — the deny-list
//                             configuration itself cannot be verified
//                             against this dispatch, which is exactly the
//                             kind of permission-surface gap this hook
//                             exists to surface, not swallow.
//
// Verb-token boundary (B-2): case-insensitive throughout (`/i`); `\b` on
// BOTH sides of the leading verb token — this alone (not a stricter
// "nothing may precede the verb" requirement) is what fixes the rd-glob
// bug, and it is REQUIRED to stay compatible with U9's own pinned fixture
// (globPatternToRegex("Bash(rm -rf *)").test("sudo rm -rf /") === true) and
// with T6 (a fenced "$ sudo rm -rf /" must still fire lint-g together with
// lint-d) — a wrapper word like "sudo" immediately before the verb does NOT
// disqualify a Bash-row match; only the PowerShell-row GATE (a widening
// OR-condition, never a narrowing one) uses the stricter "verb must sit at
// an actual command boundary" check, where being strict costs nothing
// (Bash-shaped spans are still tested unconditionally either way).
//
// Declared blind spots (do not widen): no-space cmd.exe form `rd/s`;
// quoted/aliased verbs (`"rm" -rf`, `command rm -rf`); prose-phrased hazards
// (P-1, unchanged — lint-g still only ever scans context-scoped spans, never
// bare prose).

// The ONE command-boundary character class definition in this file (B-2:
// "REUSE the one definition the worktree-isolation-guard's install-detector
// already pinned; do not fork a second"). Used ONLY as the PowerShell-row
// gate's "is this verb token in command position" check — an OR-widening
// condition, never used to narrow the Bash-row match itself (see the U9/T6
// compatibility note above for why narrowing there would be wrong).
const COMMAND_BOUNDARY_CLASS_SOURCE = "[;&|`(\\n]";

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `verb` appears, `\b`-bounded, at a genuine command-boundary
 * position within `span`: either the very start of the span, or immediately
 * (modulo whitespace) after one of `; & | \` ( \n`. Mirrors
 * worktree-isolation-guard.js's install-detector command-position check —
 * same character class, same "start-or-boundary-char, then only whitespace"
 * shape. Used ONLY to GATE whether a PowerShell-row deny pattern is even
 * attempted against a span lacking independent PowerShell context (B-1's
 * PowerShell row, condition 2) — never to narrow the Bash-row match.
 */
function verbInCommandPosition(span, verb) {
  if (!verb) return false;
  const re = new RegExp(
    "(?:^|" + COMMAND_BOUNDARY_CLASS_SOURCE + ")\\s*\\b" + escapeRegexLiteral(verb) + "\\b",
    "i"
  );
  return re.test(span);
}

/**
 * Convert a glob-pattern INNER string (spaces + `*` wildcards, e.g.
 * "rm -rf *") into a regex SOURCE string: the leading (first
 * whitespace-delimited) token is `\b`-bounded on both sides (the verb-token
 * boundary, B-2); every remaining literal space run becomes `\s+`; every
 * remaining `*` becomes `.*`; everything else is regex-escaped. Returns null
 * for an empty/whitespace-only inner string.
 */
function buildDenyPatternRegexSource(inner) {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  const m = /^(\S+)(\s*)([\s\S]*)$/.exec(trimmed);
  if (!m) return null;
  const verb = m[1];
  const restRaw = m[2] + m[3];
  const verbSource = "\\b" + escapeRegexLiteral(verb).replace(/\\\*/g, ".*") + "\\b";
  // Convert the remainder: whitespace runs -> \s+, everything else escaped
  // (with '*' -> '.*' handled AFTER escaping, same technique as before).
  const restParts = restRaw.split(/(\s+)/);
  const restSource = restParts
    .map((p) => (/^\s+$/.test(p) ? "\\s+" : escapeRegexLiteral(p).replace(/\\\*/g, ".*")))
    .join("");
  return verbSource + restSource;
}

/**
 * Whole-token literal match source for a BARE deny entry (no `Tool(...)`
 * wrapper) or an `mcp__*`-shaped entry — B-1 row 3: no glob interpretation
 * at all, just `\b<escaped literal>\b`.
 */
function buildBareTokenRegexSource(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return "\\b" + escapeRegexLiteral(trimmed) + "\\b";
}

/**
 * Total classification (B-1) of one raw deny-list entry. Returns exactly one
 * of:
 *   { kind: "unparsable", raw }
 *   { kind: "bash" | "powershell" | "other-tool", raw, tool, verb, regexSource }
 *   { kind: "bare", raw, regexSource }
 */
function classifyDenyEntry(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { kind: "unparsable", raw };
  }
  const trimmed = raw.trim();
  const m = /^([A-Za-z_][\w-]*)\(([\s\S]*)\)$/.exec(trimmed);
  if (m) {
    const tool = m[1];
    const inner = m[2].trim();
    if (!inner) return { kind: "unparsable", raw };
    const regexSource = buildDenyPatternRegexSource(inner);
    if (!regexSource) return { kind: "unparsable", raw };
    const verb = /^(\S+)/.exec(inner)[1];
    if (tool === "Bash") return { kind: "bash", raw, tool, verb, regexSource };
    if (tool === "PowerShell") return { kind: "powershell", raw, tool, verb, regexSource };
    // Total-classification completion (no such row is spec'd): default to
    // the unconditional Bash-row treatment for any other Tool(pattern) shape
    // — friction over silent escape for an unlisted tool prefix.
    return { kind: "other-tool", raw, tool, verb, regexSource };
  }
  const regexSource = buildBareTokenRegexSource(trimmed);
  if (!regexSource) return { kind: "unparsable", raw };
  return { kind: "bare", raw, regexSource };
}

/**
 * Cross-file note (globPatternToRegex): kept exported for backward
 * compatibility (U9's own fixture calls it directly) — now delegates to
 * classifyDenyEntry/buildDenyPatternRegexSource/buildBareTokenRegexSource so
 * there is exactly ONE pattern->regex construction in this file. Returns a
 * RegExp for any classifiable entry (bash/powershell/other-tool/bare), or
 * null for an unparsable one (U9 only exercises the Bash(...) shape).
 */
function globPatternToRegex(pattern) {
  const classified = classifyDenyEntry(pattern);
  if (classified.kind === "unparsable") return null;
  try {
    return new RegExp(classified.regexSource, "i");
  } catch (_) {
    return null;
  }
}

/**
 * Returns an ARRAY of findings (possibly empty) — one `lint-g-deny-list`
 * finding per deny entry that matches (first matching span only, per
 * entry), and one `deny-entry-unverifiable` finding per entry that could
 * not be classified at all (B-1 row 4 — friction, not the prior silent
 * `continue`). Every entry is evaluated independently; an unparsable entry
 * never suppresses evaluation of the rest of the list.
 */
function scanDenyListPatterns(spans, mergedDeny) {
  const findings = [];
  const contextHasPowerShellMention = spans.some((s) => /\bPowerShell\b/i.test(s));

  for (const raw of mergedDeny) {
    const classified = classifyDenyEntry(raw);

    if (classified.kind === "unparsable") {
      findings.push({
        id: "deny-entry-unverifiable",
        detail: `deny entry ${JSON.stringify(raw)} is empty or unparsable and cannot be verified against this dispatch.`,
      });
      continue;
    }

    let re;
    try {
      re = new RegExp(classified.regexSource, "i");
    } catch (_) {
      findings.push({
        id: "deny-entry-unverifiable",
        detail: `deny entry ${JSON.stringify(raw)} produced an invalid pattern and cannot be verified against this dispatch.`,
      });
      continue;
    }

    for (const span of spans) {
      if (classified.kind === "powershell") {
        // B-1 PowerShell row: only attempt the match when independent
        // PowerShell context exists, OR the verb sits at a genuine command
        // boundary within THIS span. Never a raw substring test.
        const gateOk = contextHasPowerShellMention || verbInCommandPosition(span, classified.verb);
        if (!gateOk) continue;
      }
      if (re.test(span)) {
        findings.push({
          id: "lint-g-deny-list",
          detail: `matched merged deny-list pattern "${raw}" in dispatch text: "${span.trim().slice(0, 80)}"`,
        });
        break; // one finding per matching entry; move to the next entry.
      }
    }
  }

  return findings;
}

// ── Settings baseline: three-layer load + union merge ──────────────────────

function loadSettingsLayer(filePath) {
  if (!fs.existsSync(filePath)) {
    return { allow: [], deny: [], unparsable: false, path: filePath };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    // Exists but unreadable (permissions, race, etc.) — same treatment as
    // unparsable: a permission-surface layer we cannot verify is a finding,
    // never a silent empty layer.
    return { allow: [], deny: [], unparsable: true, path: filePath };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_) {
    return { allow: [], deny: [], unparsable: true, path: filePath };
  }
  const perms = (obj && typeof obj === "object" && obj.permissions && typeof obj.permissions === "object")
    ? obj.permissions
    : {};
  const allow = Array.isArray(perms.allow) ? perms.allow.filter((x) => typeof x === "string") : [];
  const deny = Array.isArray(perms.deny) ? perms.deny.filter((x) => typeof x === "string") : [];
  return { allow, deny, unparsable: false, path: filePath };
}

/**
 * Returns { allow: string[], deny: string[], findings: Finding[] }.
 * `findings` here carries ONLY settings-unparsable findings (one per
 * unparsable layer) — the bare-Bash check is applied by the caller once the
 * merged allow[] is known.
 */
function loadMergedSettings(cwd) {
  const layerPaths = [
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
  ];

  const allowSet = new Set();
  const denySet = new Set();
  const findings = [];

  for (const p of layerPaths) {
    const layer = loadSettingsLayer(p);
    if (layer.unparsable) {
      findings.push({
        id: "settings-unparsable",
        detail: `settings file ${p} unparsable — fix it in the MAIN checkout; already-running worktree-isolated agents won't see the fix.`,
      });
      continue;
    }
    layer.allow.forEach((a) => allowSet.add(a));
    layer.deny.forEach((d) => denySet.add(d));
  }

  return { allow: Array.from(allowSet), deny: Array.from(denySet), findings };
}

// ── Block message assembly ──────────────────────────────────────────────────

function buildBlockMessage(findings, toolName) {
  let msg = `agent-permission-preflight: BLOCKED — ${toolName} dispatch failed ${findings.length} preflight check(s):\n`;
  findings.forEach((f, i) => {
    msg += `  ${i + 1}. [${f.id}] ${f.detail}\n`;
  });
  msg += `Rewrite the dispatch to address each finding above, then retry.\n`;
  return msg;
}

// ── Core evaluation (pure, no I/O beyond what's passed in) ─────────────────
// evaluateDispatchWithCwd (defined below main's callers, hoisted) is the
// single real evaluator: marker floor, settings
// baseline (bare-Bash + pre-computed settings-unparsable findings), then
// lints a-g in order.

// Export pure functions for unit-test isolation.
module.exports = {
  EXEMPT_TYPES,
  isExemptType,
  MARKER_RE,
  NO_BACKGROUND_PATTERNS,
  hasNoBackgroundClause,
  isRelaxedDispatch,
  extractCodeSpans,
  extractCueWindows,
  extractSigilLines,
  extractToolTargetWindows,
  genericSpans,
  pathTargetSpans,
  scanGitPushForce,
  scanInteractiveGit,
  scanSettingsEdit,
  scanSudo,
  scanPowerShellToolUsage,
  scanAbsolutePathTargets,
  scanDenyListPatterns,
  globPatternToRegex,
  classifyDenyEntry,
  verbInCommandPosition,
  buildDenyPatternRegexSource,
  buildBareTokenRegexSource,
  COMMAND_BOUNDARY_CLASS_SOURCE,
  loadSettingsLayer,
  loadMergedSettings,
  buildSandboxRoots,
  isWithinSandbox,
  resolvePathForSandboxCompare,
  buildBlockMessage,
  evaluateDispatchWithCwd, // defined below, exported for tests
};

/**
 * Evaluate a non-exempt Agent prompt or a SendMessage text against every
 * check (marker floor, no-background floor, settings baseline, lints a-g).
 * Returns the full findings array (possibly empty). `settingsFindings` are
 * pre-computed settings-unparsable findings from loadMergedSettings; they
 * are ALWAYS included regardless of any other outcome (P-4/P-10 — never
 * suppressed, never routed to fail-open, and never skipped by the relaxed
 * branch either — see "PERMISSION-MODE-AWARE RELAXATION" in the header).
 * `cwd` is threaded through explicitly (not smuggled on the text string) so
 * lint (f)'s sandbox-roots check resolves against the correct working
 * directory.
 *
 * `options` (trailing, optional): `{ relaxed: boolean }`. Defaults to
 * full-check behavior when omitted entirely, so every pre-existing call
 * site (including every pre-existing test in the paired test file) keeps
 * its old behavior unchanged. When `options.relaxed === true`, exactly
 * three findings are skipped — marker-floor, settings-bare-bash, and
 * lint-e — and the no-background-floor check does not run at all (it only
 * ever runs in the full-check, i.e. non-relaxed, case). Every other check
 * (lint-a/b/c/d/f/g, settings-unparsable) runs identically in both branches.
 */
function evaluateDispatchWithCwd(text, cwd, mergedAllow, mergedDeny, settingsFindings, options) {
  const relaxed = !!(options && options.relaxed === true);
  const findings = settingsFindings.slice();

  if (!relaxed && !MARKER_RE.test(text)) {
    findings.push({
      id: "marker-floor",
      detail: `no zero-dialog/permission-safe marker found in dispatch text (required, case-insensitive: "zero-dialog" or "permission-safe").`,
    });
  }

  if (!relaxed && mergedAllow.indexOf("Bash") === -1) {
    findings.push({
      id: "settings-bare-bash",
      detail: `bare "Bash" absent from merged allow permissions (checked settings.local.json + settings.json in cwd, plus ~/.claude/settings.json).`,
    });
  }

  const spansGeneric = genericSpans(text);
  const spansPath = pathTargetSpans(text);

  const a = scanGitPushForce(spansGeneric);
  if (a.fired) findings.push({ id: "lint-a-git-push-force", detail: a.detail });

  const b = scanInteractiveGit(spansGeneric);
  if (b.fired) findings.push({ id: "lint-b-interactive-git", detail: b.detail });

  const c = scanSettingsEdit(text);
  if (c.fired) findings.push({ id: "lint-c-settings-edit", detail: c.detail });

  const d = scanSudo(spansGeneric);
  if (d.fired) findings.push({ id: "lint-d-sudo", detail: d.detail });

  if (!relaxed && mergedAllow.indexOf("PowerShell") === -1) {
    const e = scanPowerShellToolUsage(spansGeneric);
    if (e.fired) findings.push({ id: "lint-e-powershell-tool", detail: e.detail });
  }

  const sandboxRoots = buildSandboxRoots(cwd);
  const f = scanAbsolutePathTargets(spansPath, sandboxRoots, mergedAllow);
  if (f.fired) findings.push({ id: "lint-f-path-outside-sandbox", detail: f.detail });

  // scanDenyListPatterns returns an ARRAY of findings (possibly empty) —
  // one lint-g-deny-list per matching entry, one deny-entry-unverifiable per
  // unparsable entry (hardened spec B). Not gated by `relaxed` — deny rules
  // are enforced even under bypassPermissions (per the docs), same as before.
  findings.push(...scanDenyListPatterns(spansGeneric, mergedDeny));

  if (!relaxed && !hasNoBackgroundClause(text)) {
    findings.push({
      id: "no-background-floor",
      detail: `no explicit prohibition of background task creation (e.g. Bash run_in_background) found in dispatch text; unattended background task creation can trigger an owner-side approval dialog in non-bypass permission modes, and the dispatch must carry an explicit prohibition.`,
    });
  }

  return findings;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (_) {
    allowFailOpen("stdin_read_error");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    allowFailOpen("json_parse_error");
    return;
  }

  if (!parsed || typeof parsed !== "object") {
    allowFailOpen("parsed_not_object");
    return;
  }

  // Raw observed permission_mode, read as soon as `parsed` is confirmed to
  // be an object ("the parse got far enough" — see header "PERMISSION-
  // MODE-AWARE RELAXATION" / A10). A missing field or a non-string value
  // both become null here; main() never coerces or trims this value, and
  // isRelaxedDispatch performs a STRICT === against "bypassPermissions"
  // only, per spec (no case-fold, no substring logic).
  const permissionMode = typeof parsed.permission_mode === "string" ? parsed.permission_mode : null;

  const tool_name = typeof parsed.tool_name === "string" ? parsed.tool_name : "";
  if (!tool_name) {
    allowFailOpen("missing_tool_name", {
      permission_mode: permissionMode,
      branch: isRelaxedDispatch(tool_name, {}, permissionMode) ? "relaxed" : "full",
    });
    return;
  }

  const tool_input = (parsed.tool_input && typeof parsed.tool_input === "object")
    ? parsed.tool_input
    : {};

  // Only Agent and SendMessage are in scope. Everything else: ordinary
  // allow, no logging needed (normal no-op path, not a fail-open occurrence).
  if (tool_name !== "Agent" && tool_name !== "SendMessage") {
    process.exit(0);
  }

  const cwd = (typeof parsed.cwd === "string" && parsed.cwd) ? parsed.cwd : process.cwd();

  // Resolved once, using the pure total classifier, and threaded through
  // every debug entry and into evaluateDispatchWithCwd's options.
  const branch = isRelaxedDispatch(tool_name, tool_input, permissionMode) ? "relaxed" : "full";

  try {
    let text;
    let subagentType = null;

    if (tool_name === "Agent") {
      subagentType = (typeof tool_input.subagent_type === "string" && tool_input.subagent_type)
        ? tool_input.subagent_type
        : "general-purpose";

      if (isExemptType(subagentType)) {
        appendDebug({
          ts: new Date().toISOString(), event: "allow_exempt_type",
          tool_name, subagent_type: subagentType,
          permission_mode: permissionMode, branch,
        });
        process.exit(0);
      }

      const prompt = tool_input.prompt;
      if (typeof prompt !== "string") {
        allowFailOpen("prompt_missing_or_non_string", {
          tool_name, subagent_type: subagentType,
          permission_mode: permissionMode, branch,
        });
        return;
      }
      text = prompt;
    } else {
      // SendMessage: no subagent_type, never STRUCTURALLY exempt (P-3) —
      // that is separate from mode-based relaxation. Scanned every
      // invocation, independently, no first-turn shortcut (P-7). May land in
      // either branch depending on permission_mode (C-1, 2026-08-24,
      // replaces the retired "always full, A1" rule) — `branch` was already
      // resolved above via isRelaxedDispatch for this tool_name.
      const message = tool_input.message;
      if (typeof message !== "string") {
        allowFailOpen("message_missing_or_non_string", {
          tool_name, permission_mode: permissionMode, branch,
        });
        return;
      }
      if (message.trim().length === 0) {
        // Not plausibly a work-assignment — ordinary allow, not fail-open,
        // mirrors agent-adversary-floor.js's treatment of the same case.
        appendDebug({
          ts: new Date().toISOString(), event: "allow_sendmessage_not_workassignment",
          tool_name, permission_mode: permissionMode, branch,
        });
        process.exit(0);
      }
      const extraPrompt = (typeof tool_input.prompt === "string") ? tool_input.prompt : "";
      text = extraPrompt ? (message + "\n\n" + extraPrompt) : message;
    }

    const settings = loadMergedSettings(cwd);
    const findings = evaluateDispatchWithCwd(
      text, cwd, settings.allow, settings.deny, settings.findings,
      { relaxed: branch === "relaxed" }
    );

    appendDebug({
      ts: new Date().toISOString(),
      event: findings.length > 0 ? "block" : "allow",
      tool_name, subagent_type: subagentType, cwd,
      finding_ids: findings.map((f) => f.id),
      permission_mode: permissionMode, branch,
    });

    if (findings.length === 0) {
      process.exit(0);
    }

    process.stderr.write(buildBlockMessage(findings, tool_name));
    process.exit(2);
  } catch (internalErr) {
    allowFailOpen("internal_exception", {
      message: String(internalErr && internalErr.message || internalErr),
      permission_mode: permissionMode, branch,
    });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (topErr) {
    try {
      appendDebug({
        ts: new Date().toISOString(), event: "fail_open",
        reason: "top_level_exception", message: String(topErr && topErr.message || topErr),
      });
      process.stderr.write(`agent-permission-preflight: preflight SKIPPED (top_level_exception)\n`);
    } catch (_) {}
    process.exit(0);
  }
}

# Spec: Routing scorecard — win/loss reporting for the model-routing guards

*Draft, not yet implemented or adversaried. Owner-approved design, captured
here for authoring. Read-only reporting layer on top of three existing
PreToolUse guards (`hooks/orchestrator-tool-guard.js`,
`hooks/agent-model-routing-guard.js`, `hooks/agent-adversary-floor.js`) —
adds a decision ledger those guards append to, and a CLI that reads it back
and renders a scorecard. Changes no guard's control flow.*

## 1. Purpose

The three model-routing guards each decide, per tool call, whether to
allow, block, or exempt a dispatch. None of them currently leave a record
answering the operator-facing question this spec exists for: **is routing
actually working** — are blocks resolving into correctly-routed retries, or
are agents abandoning blocked work, retrying the same wrong shape
repeatedly, or slipping through via a fail-open/override path? This spec
adds:

- a shared, append-only decision ledger (§2) that each guard's exit points
  write one line to, purely for reporting — never consulted for a gating
  decision, never able to change one;
- a total classification of every decision line into win / loss / escape /
  by_design_allow / friction / health_failure / unknown (§4);
- five "is routing good" signals derived from that classification, each
  with a stated threshold and a PASS/WATCH/FAIL verdict rule (§4);
- a read-only CLI, `scripts/routing-scorecard.js` (§5), that renders the
  scorecard from the ledger.

## 2. Data model

### 2.1 New shared module: `hooks/model-routing-guards.decisions.js`

Exposes one function, `appendDecision(record)`. Sibling module to
`model-routing-guards.state.js`/`.log.js`, reusing both rather than
reimplementing their primitives:

- **Session key, path, and collision-safe filename (owner ruling R3).**
  Reuses `resolveSessionKey` (from `model-routing-guards.state.js`)
  unmodified for the same present-session-id-or-`global-YYYY-MM-DD`-fallback
  behavior every other ledger in this repo already uses, then
  `sanitizeForFilename` on the result for the filename's session
  component. `sanitizeForFilename` is lossy — it collapses every
  character outside `[A-Za-z0-9_.-]` to `_` — so two distinct raw session
  ids can sanitize to the identical string. The filename therefore also
  carries an 8-hex-character disambiguator: `h8 = sha256(<the key
  resolveSessionKey returned, before sanitization>).slice(0, 8)`, hex
  digest, first 8 characters. File path:
  `<STATE_DIR>/routing-decisions.<sanitized key>.<h8>.jsonl` — `STATE_DIR`
  imported from `model-routing-guards.state.js` (§2.1 of
  `docs/specs/hook-state-write-guard.md` established this as the single
  source of truth for that constant; this module follows the same
  convention rather than re-deriving `path.join(__dirname, "state")`).
  Two files sharing the same sanitized prefix but a **different** `h8`
  are two **distinct sessions** that happened to collapse to the same
  sanitized string — never the same session split across files, and
  never to be merged by a reader. The report script never groups by
  filename at all; it groups by the `session_id` field recorded inside
  each record (see §5.2) — the filename (`h8` included) is only a
  container the writer uses to keep concurrent sessions from clobbering
  each other's ledgers, not a unit of meaning the reader relies on.
- **Prefix isolation.** `routing-decisions.` does not collide with any
  existing prefix in this state directory:
  `orchestrator-tool-guard.` (Hook 2's own tally ledger, `.ledger` suffix),
  `agent-tier-ledger.` (`.jsonl` suffix), or
  `stop-stale-worktrees-guard.` (`.json` state / `.yields.log`). No
  existing reader (`readLedgerCount`, `agent-tier-ledger.js`'s
  `listLedgerFiles`) globs a pattern broad enough to match
  `routing-decisions.*` — both are prefix-anchored on their own literal
  strings — so this module's files are invisible to every pre-existing
  reader (verified by reading both call sites; see §4 test
  `existing_reader_non_regression`). The added `.<h8>` segment sits
  between the sanitized key and `.jsonl`, so it changes nothing about
  this prefix/suffix isolation — `startsWith("routing-decisions.")` /
  `endsWith(".jsonl")` still match every file this module writes.
- **Test isolation: `MODEL_ROUTING_STATE_DIR` override.** `STATE_DIR`
  (`model-routing-guards.state.js`) is `__dirname`-relative by design — an
  installed hook always runs from inside the installed `~/.claude/hooks/`
  tree, so `path.join(__dirname, "state")` is exactly that tree's own
  `state/` with no configuration needed. When the environment variable
  `MODEL_ROUTING_STATE_DIR` is set (checked once, at module-load time),
  `STATE_DIR` is that directory instead — every module in this guard
  family (`model-routing-guards.state.js`, and
  `model-routing-guards.decisions.js` via its re-exported `STATE_DIR`)
  honors the same override, since neither derives it independently.
  Unset, behavior is unchanged. Its sole purpose is letting
  `hooks/orchestrator-tool-guard.test.js`,
  `hooks/agent-model-routing-guard.test.js`, and
  `hooks/agent-adversary-floor.test.js` redirect the *subprocess* guard
  invocations they spawn into a per-test-file `os.tmpdir()` directory,
  since a spawned guard's `appendDecision` writes a
  `routing-decisions.<key>.<h8>.jsonl` file whose `h8` component is an
  unpredictable sha256 hash a test's own cleanup-by-exact-name logic
  cannot reconstruct — the root cause of a defect where hundreds of these
  fixture files accumulated, uncleaned, in this repo's own gitignored
  `hooks/state`. `--state-dir` (§5.1) is the analogous, CLI-facing
  override for `scripts/routing-scorecard.js`'s own read path; the two are
  independent (`--state-dir` never sets this environment variable, and
  vice versa).
- **Sweep (owner ruling R2).** Calls
  `cleanupOldStateFiles(SEVEN_DAYS_MS, "routing-decisions.", ".jsonl",
  SWEEP_MIN_AGE_MS)` with `SWEEP_MIN_AGE_MS = 60000` — a new local
  constant in this module, named and valued to match
  `agent-tier-ledger.js`'s own A6 precedent (`SWEEP_MIN_AGE_MS = 60 * 1000`
  at that file's line 72) exactly, rather than inventing a second
  convention for the same guard. All four arguments come
  from/align with `model-routing-guards.state.js`. The sweep runs once at
  the top of every `appendDecision` call, before the write — same
  fail-soft, wrapped-in-try/catch sweep every other ledger in this
  directory already runs on its own prefix. Per `cleanupOldStateFiles`'s
  own `age <= minAge` skip, a file whose mtime is within 60 seconds of the
  sweep's own `now` is never unlinked, regardless of how old it is past
  `maxAgeMs` — so a `routing-decisions.*.jsonl` file an active guard
  invocation is still mid-append to (or one written moments earlier, still
  fresh) cannot be swept out from under it. A residual race narrower than
  60 seconds is not closed by this — same accepted-limitation framing
  `agent-tier-ledger.js`'s own A6 uses — but the plain "no minAgeMs" choice
  this spec previously stated is wrong and is corrected here.
- **Crash records — raw stdin capture (owner ruling R1).** Each of the
  three guards' `main()` currently reads stdin (`fs.readFileSync(0, "utf8")`)
  into a variable local to `main()`'s own scope — meaning the guard's
  top-level `try { main(); } catch (topErr) { ... }` block (the outer
  guard around `main()` itself, not `main()`'s own internal
  `try`/`catch`) has no access to the raw request at all today, and
  therefore no way to recover `session_id` when `main()` throws before
  it finishes parsing. Each guard is changed to capture that raw stdin
  buffer into a variable in **outer, module-level scope**, assigned
  before `main()` is called, so the top-level catch can reach it. See
  §3's crash-record note under each guard's table and §4.7 for how these
  records classify.
- **Crash records — best-effort session recovery and routing (owner
  ruling R1).** The top-level catch has no parsed envelope by the time it
  runs — `main()` threw somewhere between reading stdin and finishing
  classification, so nothing about `parsed` can be trusted. On entry, the
  catch does a **best-effort** parse of the captured raw stdin buffer
  (`JSON.parse` wrapped in its own `try`/`catch`, discarding the result
  entirely on any failure) **solely** to extract `session_id` — no other
  field of that best-effort parse is read or logged. Two outcomes:
  - **`session_id` recovered** (a string, non-blank after strip): the
    record is appended to *that session's own* ledger file (§2.1's
    filename rule, same `resolveSessionKey`/`h8` treatment as every other
    record), with `event: "block"` and `finding_ids: ["top_level_exception"]`
    — the same shape §3.1/§3.2 already used for this guard's own
    top-level catch. This is unchanged for `orchestrator-tool-guard.js`
    and `agent-model-routing-guard.js`. It **is** a change for
    `agent-adversary-floor.js`: that guard's top-level catch previously
    logged `event: "fail_open", reason: "top_level_exception"` (an
    escape, per its own house fail-open policy); under this ruling its
    top-level-catch record is `event: "block"` instead whenever a
    `session_id` is recoverable, same as the other two guards. This is a
    change to the **decision-ledger record only** — the guard's actual
    behavior (`process.exit(0)`, still fail-open) and its existing
    `*-debug.log` line are untouched; see §3.3's updated note and §6.
  - **`session_id` not recovered** (parse failure, non-object result, or
    a missing/blank `session_id` field): no session can be attributed at
    all, so the record is appended via the same `resolveSessionKey`
    fallback every other unattributable record in this module already
    uses — the `global-YYYY-MM-DD` (today, local time) ledger file — with
    a new, distinct `event: "guard_crash"` (not `block`, not `fail_open`).
    `finding_ids: ["top_level_exception"]` still applies. This is not a
    second global-file mechanism alongside the fallback §2.1 already
    defines; it is that same fallback, given a distinguishing event name
    because — per §4.7 — **any** record that lands in a
    `global-YYYY-MM-DD` file (for this reason or any other) is
    classified `health_failure` only, and `guard_crash` makes that
    unattributable-crash case self-evident in a raw read of the ledger
    without needing to cross-reference which file it came from.

  This best-effort-parse-and-route logic is implemented **once**, as a
  second exported function from this module —
  `appendCrashRecord(rawStdinBuffer, guard, guardVersion)` — called
  identically from all three guards' top-level catches, rather than
  reimplemented three times. It performs the `JSON.parse` attempt, the
  `session_id` extraction, the routing decision above, and the eventual
  `appendDecision`-shaped write, all internally; a guard's top-level catch
  calls it as a single bare statement, the same "never throws, no return
  value to check" contract §2.1's "Never changes control flow" bullet
  already establishes for `appendDecision`. See §7.1's
  `crash_record_routing` test.
- **Write.** A single `fs.openSync(path, "a")` + one `fs.writeSync` of the
  whole serialized line, `fs.closeSync` in a `finally` — the identical
  atomic-append primitive `agent-tier-ledger.js`'s `appendLine` and
  `model-routing-guards.state.js`'s `appendLedgerRecord` already use.
  `fs.mkdirSync(STATE_DIR, { recursive: true })` first, matching both.
- **Redaction, by construction, not by scrubbing.** `appendDecision`
  serializes **only** the fixed field allowlist in §2.2 — it builds a
  fresh object by reading exactly those keys off `record` (defaulting any
  missing one per §2.3), and calls `JSON.stringify` on that fresh object,
  never on `record` itself. A call site that accidentally attaches
  `record.prompt`, `record.message`, or `record.command` therefore never
  reaches disk — there is no field in the allowlist those values could
  land in. This is the enforcement mechanism for "no prompt, message, or
  command bodies ever," not a documented convention call sites must
  remember to honor.
- **Never changes control flow.** Every failure mode (sweep failure — already
  fail-soft internally; `mkdirSync`/`openSync`/`writeSync`/`closeSync`
  throwing; a malformed `record` of the wrong type) is caught inside
  `appendDecision` itself and swallowed. The function has no return value
  callers need to check and never throws under normal operation.
- **Defensive load and defense-in-depth at the crash-path call site (R9,
  corrects this section's prior wording).** This section previously stated
  that every call site could call `appendDecision`/`appendCrashRecord` as a
  bare statement, "with no surrounding `try/catch` needed at the call
  site," on the theory that each guard's own `main()`-wrapping `try/catch`
  was backstop enough even if this module's internal swallow somehow
  failed. Review of PR #14 (d6a5f08) found that theory wrong at exactly the
  one point in each guard where it mattered most: **the top-level catch
  itself**. `orchestrator-tool-guard.js`, `agent-model-routing-guard.js`,
  and `agent-adversary-floor.js` each `require()`'d this module at bare
  module scope, and each guard's own top-level
  `try { main(); } catch (topErr) { ...; decisions.appendCrashRecord(...);
  process.exit(N); }` called `appendCrashRecord` with no `try/catch` of its
  own. If the module is missing at install time (install drift), throws
  during `require()`, or `appendCrashRecord` itself throws (e.g. a
  corrupted or incompatible copy of this module), the exception is
  uncaught by anything — the top-level catch is the last defensive layer
  in each guard, and nothing downstream can catch a throw inside it. Node's
  default uncaught-exception handler then prints a stack trace and exits
  with code 1. A non-2 exit from a `PreToolUse` hook is treated by the
  harness as **allow** — so the guard's own crash handler became an escape
  path, in exactly the scenario (a bug or drift in this module) it exists
  to survive. Fixed as follows, in each of the three guards:
  - **Defensive `require()`.** Each guard loads this module inside its own
    `try/catch` at module scope: `let decisions; try { decisions =
    require("./model-routing-guards.decisions.js"); } catch (_) { decisions
    = { appendDecision(){}, appendCrashRecord(){}, hashTarget(){ return
    null; } }; }`. On any load failure, every `appendDecision`/
    `appendCrashRecord`/`hashTarget` call site throughout that guard's file
    transparently becomes a no-op/`null` — no call site anywhere else in
    the file needs its own guarding for **this** failure mode, and the
    guard's exit code/stdout/stderr on every path (allow, block, fail-open,
    crash) is unaffected by whether this module loaded at all.
  - **The top-level catch's own `appendCrashRecord` call additionally wraps
    itself** in a `try/catch` of its own, separately from the defensive
    `require()` above: `try { decisions.appendCrashRecord(...); } catch
    (_) {}` immediately before that guard's unconditional
    `process.exit(N)`. This is defense-in-depth for the narrower failure
    mode the defensive `require()` above does not cover — a module that
    *loaded successfully* but whose `appendCrashRecord` itself throws
    (install drift replacing a working copy with a broken one after
    load-time, or any other violation of §2.1's "never throws" contract by
    a non-canonical copy of this module). Because this is the last line of
    defense before the guard's own `process.exit(N)`, wrapping it here —
    and only here — is what makes "a decisions-module failure can never
    change a guard's exit code or output" true unconditionally, not just
    under the assumption that this module's own internals behave.
  - This fix does not touch `hook-state-write-guard.js`,
    `stop-stale-worktrees-guard.js`, or their specs/tests — out of scope
    for this ruling, owned by a separate author.
  - **Amendment (independent approver, second review of R9):** the two
    bullets above — defensive `require()` plus a lone `try/catch` around
    the top-level catch's `appendCrashRecord` call — left every OTHER
    `appendDecision`/`hashTarget` call site in each guard calling the
    module directly and unguarded (`hooks/orchestrator-tool-guard.js:55,
    73,87,139,198,210,225` and the equivalent lines in the other two
    guards, per the approver's finding). That is fine when `require()`
    itself throws (the fallback stand-in absorbs every call site
    uniformly), but NOT when `require()` **succeeds** and returns a module
    whose exports are present but not callable — e.g. `appendDecision`/
    `appendCrashRecord`/`hashTarget` as plain objects, or `undefined`.
    Calling a non-function throws a `TypeError` that the require()-level
    `try/catch` cannot see (it already returned) and that these unguarded
    call sites do not catch — empirically flipping
    `orchestrator-tool-guard`/`agent-model-routing-guard`'s allow and
    malformed-JSON cases from exit 0 to exit 2, and
    `agent-adversary-floor`'s block case from exit 2 to exit 0 (a real
    escape). Fixed by replacing every direct `decisions.*` call in all
    three guards with one of three local wrappers defined once, immediately
    after the defensive `require()`: `logDecision(record)`, `safeHash(target)`,
    `safeCrash(rawStdinBuffer, guard, guardVersion)`. Each wrapper (i)
    captures the export into a local (`const fn = decisions.appendDecision`,
    etc.) and checks `typeof fn === "function"` before calling it, (ii)
    wraps the call in its own `try/catch`, (iii) returns a harmless default
    (`undefined` for `logDecision`/`safeCrash`, `null` for `safeHash`) on
    any failure — covering a throwing `require()`, a loaded-but-non-callable
    export, AND a callable export that itself throws, uniformly, at every
    call site, not only the crash path. No guard's decision logic ever
    branches on a wrapper's return value. With this amendment, "a
    decisions-module failure can never change a guard's exit code or
    output" (§2.1 above, R9 in §6.1) holds for all of these shapes, not
    only "`require()` throws" — see §7.1a's expanded matrix.
  - See `hooks/model-routing-guards.crash-path.test.js` (§7.1a) for the
    regression tests, and R9 in §6.1.

### 2.2 Record shape

One JSON object per line:

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | Schema version literal, for forward migration. |
| `ts` | ISO 8601 string | Time of the append, this module's own `new Date().toISOString()` — not copied from the guard's own `ts` local var, so a clock is read exactly once per record. |
| `guard` | string | One of `orchestrator-tool-guard`, `agent-model-routing-guard`, `agent-adversary-floor`. |
| `guard_version` | string | See §2.4 — not uniformly available today; call sites supply a literal per guard. |
| `event` | string | The literal exit-point event name — see §3 for the enumerated set per guard. |
| `session_id` | string \| `null` | Raw `parsed.session_id` if a string, else `null` — never the sanitized/fallback key (that's implicit in the filename). |
| `agent_id` | string \| `null` | **New field (owner ruling R5).** Populated from the envelope's own agent-identifying field when present as a non-blank string (the same field `orchestrator-tool-guard.js`'s `classifyCaller` already reads to distinguish orchestrator vs. subagent, re-read here verbatim, not derived); `null` when the envelope carries no such field or it is blank/wrong-typed. Used only to compute the stream key (§4.2) — never consulted for gating. |
| `caller` | `"orchestrator"` \| `"subagent"` \| `"unknown"` | See §2.5. |
| `tool_name` | string \| `null` | `Read`/`Write`/`Edit`/`Bash`/`PowerShell`/`Agent`/`SendMessage`, or `null` if not yet known at this exit point (e.g. a stdin-read failure before `tool_name` is parsed). |
| `subagent_type` | string \| `null` | Only meaningful for `Agent` calls; `null` otherwise. |
| `tier` | string \| `null` | `planning`/`drafting`/`mechanical` where resolved; `null` otherwise. |
| `model` | string \| `null` | Raw `model` literal as declared in `tool_input`, where available; `null` otherwise. |
| `tool_use_id` | string \| `null` | See §6 blind spot — presence on the raw stdin envelope is confirmed for `agent-model-routing-guard.js`'s `Agent` branch only; the other guards/branches read it defensively the same way but this has not been independently verified for every envelope shape. |
| `target_hash` | string \| `null` | First 12 hex characters of `sha256(target)`, where `target` is the resolved file path (Read/Write/Edit), the raw command string (Bash/PowerShell), or the `subagent_type` string (Agent) — **never** the raw path/command/subagent_type itself, and never a prompt/message body. `null` when no such target exists at this exit point (e.g. a `SendMessage` call, which has no natural single-string target — see §6). |
| `finding_ids` | string[] | Empty array, not `null`, when there are none. |
| `via` | string \| `null` | Free-form provenance the guard already computed (e.g. `agent-adversary-floor`'s own `signal.via`, `"pattern"` \| `"marker"`); `null` where the guard has no such concept. |
| `reason` | string \| `null` | A short, guard-authored string (a finding's own `id`/`detail`, or a fixed literal like `"stdin_read_error"`) — **never** raw `tool_input` content. |
| `pid` | number | `process.pid`. |

### 2.3 Missing-field defaults (explicit, per field)

`appendDecision` never throws on a partially-populated `record`; every
field not present, or present with the wrong type, defaults as follows —
each one stated, not left to fall through to whatever `undefined`
serializes as:

| Field | Default when absent/wrong-typed |
|---|---|
| `v` | `1` (ignores whatever the caller passed) |
| `ts` | computed fresh, as above (ignores whatever the caller passed) |
| `guard` | `"unknown"` |
| `guard_version` | `null` |
| `event` | `"unknown"` |
| `session_id` | `null` |
| `agent_id` | `null` |
| `caller` | `"unknown"` |
| `tool_name`, `subagent_type`, `tier`, `model`, `tool_use_id`, `target_hash`, `via`, `reason` | `null` |
| `finding_ids` | `[]` (a non-array value is coerced to `[]`, not passed through) |
| `pid` | `process.pid` (ignores whatever the caller passed — this module's own process, always) |

A `record` that is not an object at all (`undefined`, a string, `null`)
produces a fully-defaulted line (`guard: "unknown"`, `event: "unknown"`,
everything else `null`/`[]`/computed) rather than throwing or silently
skipping the append — consistent with this repo's friction-over-escape
convention: a caller bug produces a visible `unknown`-bucketed line in the
scorecard, not a silently missing one.

### 2.4 `guard_version` — not uniformly available today

Only `agent-model-routing-guard.js` currently exports a `GUARD_VERSION`
constant (`"1"`, line 77). `orchestrator-tool-guard.js` and
`agent-adversary-floor.js` have no equivalent constant. Each guard's
`appendDecision` call sites pass a literal string for this field:
`agent-model-routing-guard.js` passes its existing `GUARD_VERSION`
unmodified; `orchestrator-tool-guard.js` and `agent-adversary-floor.js`
each gain a new local `const DECISIONS_GUARD_VERSION = "1"` (or similar) —
a small, new piece of code this spec requires, not a wiring-only change.

### 2.5 `caller` — orchestrator vs. subagent vs. unknown

`orchestrator-tool-guard.js` already computes this via `classifyCaller`
(keyed on `parsed.agent_id`, non-blank-after-strip → `"subagent"`, else
`"orchestrator"`) — reused as-is for that guard's own `caller` field.
`agent-model-routing-guard.js` and `agent-adversary-floor.js` have **no**
equivalent classification today (both guards apply their rules "to every
caller, orchestrator and subagent alike," per `agent-model-routing-guard.js`'s
own header comment, and never branch on `agent_id`) — each gains the
identical `classifyCaller`-shaped check at its own decision-logging call
sites, for reporting only, never for gating (importing or duplicating the
one-line-body function from `orchestrator-tool-guard.js`; duplicating it
is acceptable given its triviality, but importing is preferred if it can
be done without creating a cross-guard runtime dependency where none
exists today).

`caller` is `"unknown"` at any exit point reached **before** `agent_id`
has been parsed from `parsed` at all — concretely, every `fail_open`
triggered by `stdin_read_error`, `json_parse_error`, or
`parsed_not_object` in any of the three guards, since `parsed` itself is
unusable or doesn't exist yet at that point.

## 3. Event enumeration per guard

Every `appendDecision` call site corresponds to exactly one exit point
(one `process.exit(...)` call, or the point immediately preceding one) in
the guard's source. This table is the **total** set of `event` values each
guard can produce — the classification in §4 is defined against this
enumeration, not against the design brief's own draft list, which named
`internal_exception` as if it were a peer of `block`/`allow`; it is not,
in two of the three guards (see the note after each table).

### 3.1 `orchestrator-tool-guard.js`

| Event | Trigger (file:line, as read) | Notes |
|---|---|---|
| `fail_open` | `failOpen()`, lines 22-25, called for `stdin_read_error` / `json_parse_error` / `parsed_not_object` | `reason` field carries which. |
| `exempt_subagent` | line 98, `caller === "subagent"` | Exits 0 before any classification runs. |
| `block` | `block()`, lines 36-45 | `finding_ids` carries the real cause: an ordinary classification finding, `unexpected_tool_name` (default switch branch, line 120), `internal_exception` (catch block, line 154), or — **only when the outer catch's best-effort parse (owner ruling R1, §2.1) recovers a `session_id`** — `top_level_exception` (outer catch, line 171). |
| `allow` | `allow()`, lines 47-50, called when `result.allow && !result.orchestratorDirect` | |
| `orchestrator_direct_shell` | lines 134-143, called when `result.allow && result.orchestratorDirect` | Exits 0, but logged as a **distinct** event from `allow` — this is the guard's own existing distinction, not new to this spec. |
| `guard_crash` | outer catch, line 171 — **only when R1's best-effort parse fails to recover a `session_id`** | `finding_ids: ["top_level_exception"]`. Filed to the `global-YYYY-MM-DD` fallback file, not a per-session file (§2.1). Classifies `health_failure`, never `block` (§4.7). |

**Note:** `internal_exception` is a **finding ID inside a `block` event**
here, never a standalone event — an internal exception in this guard is a
block (safe direction), not an escape. `top_level_exception` is also a
finding ID inside `block`, but only conditionally — see the `guard_crash`
row above and owner ruling R1 (§2.1): whether it lands as `block` or as
`guard_crash` depends on whether the outer catch's best-effort parse could
recover a `session_id`, not on the guard's own logic. See §4's
classification note.

### 3.2 `agent-model-routing-guard.js`

PreToolUse (`tool_name` `Agent` or `SendMessage`) exit points:

| Event | Trigger | Notes |
|---|---|---|
| `fail_open` | lines 470/478/483 | `stdin_read_error` / `json_parse_error` / `parsed_not_object`. |
| `block` | `block()`, lines 208-217 | `finding_ids`: Agent path — `fork_subagent_forbidden`, `model_missing_or_invalid`, `oversized_field`, `plan_only_ambiguous`, `planning_prose_missing`, `report_cap_ambiguous`, `report_cap_missing_or_invalid`. SendMessage path — `recipient_invalid`, `ledger_record_tier_invalid`, `recipient_tier_ambiguous`, `recipient_tier_unknown`, plus the same `plan_only_ambiguous`/`planning_prose_missing`/`report_cap_*` set. Defensive/exception paths — `unexpected_tool_name` (line 539), `internal_exception` (line 547), and — **only when the outer catch's best-effort parse (owner ruling R1, §2.1) recovers a `session_id`** — `top_level_exception` (line 563). |
| `allow` | `allow()`, lines 219-222 | Both Agent-ok and SendMessage-ok paths. |
| `guard_crash` | outer catch, line 563 — **only when R1's best-effort parse fails to recover a `session_id`** | `finding_ids: ["top_level_exception"]`. Filed to the `global-YYYY-MM-DD` fallback file, not a per-session file (§2.1). Classifies `health_failure`, never `block` (§4.7). |

**Carve-out — `SubagentStart` is not a routing decision.** This file also
handles `hook_event_name === "SubagentStart"` (`handleSubagentStart`,
lines 436-461) — a metadata-capture path for the per-agent tier ledger,
always exiting 0, never gating anything. It has no `tool_name`, no
tier/model being enforced, and its own outcome is already durably recorded
in `agent-tier-ledger.*.jsonl`. **This spec does not call `appendDecision`
from `handleSubagentStart`** — it is not a "did routing let this through"
decision, and forcing it into the `guard`/`event` shape above would
misrepresent a bookkeeping write as a gating outcome. This is a deliberate
scope exclusion, not an oversight; noted here because the design brief's
instruction to append "at every exit point" would otherwise imply
otherwise.

**Note, same as §3.1:** `internal_exception` is a finding ID inside
`block`, not a standalone event — this guard also never fails open on an
internal exception (its own header comment states this explicitly: "any
internal exception after a successful parse is a named BLOCK — never
fail-open"). `top_level_exception` is also a finding ID inside `block`,
but only when R1's best-effort session recovery succeeds — see the
`guard_crash` row above.

### 3.3 `agent-adversary-floor.js`

| Event | Trigger | Notes |
|---|---|---|
| `fail_open` | `appendDebug` calls at lines 275/284/289/295/331-333, plus line 385 | `reason` field carries: `stdin_read_error`, `json_parse_error`, `parsed_not_object`, `missing_tool_name`, `prompt_missing_or_non_string`, `internal_exception`. **Unlike the other two guards, this file's own house policy fails open on an internal exception** (its header comment: "On ANY parse error, missing/malformed field, or internal exception: ALLOW") — so here, and only here, `internal_exception` genuinely is an escape (§4). `top_level_exception` (line 401) is **no longer** included in this row's reason set — see the `guard_crash` row below and owner ruling R1. |
| `allow_exempt_type` | lines 320-323 | `isExemptType(subagentType)` true. |
| `block` | lines 348-349 / 375-376 | Agent or SendMessage, `signal.ok === false`. `via`/`reason` from `hasCompletenessSignal`'s own `detail` (e.g. `"empty-reason-marker"`). |
| `allow` | lines 344-345 / 371-372 | Agent or SendMessage, `signal.ok === true`. `via` = `signal.via` (`"pattern"` \| `"marker"`). |
| `allow_sendmessage_not_workassignment` | lines 357-363 | SendMessage `message` missing/non-string/blank. |
| `allow_out_of_scope_tool_name` | line 307-309 | **New event, new code.** `tool_name` not `Agent`/`SendMessage` — today this branch calls `process.exit(0)` with **no logging at all** (not even a `fail_open`; the header comment explicitly calls this "a normal no-op path, not a fail-open occurrence"). Wiring this into the decision ledger requires adding an `appendDecision` call here that does not exist as an `appendDebug` call today — this is not a 1:1 hook-into-existing-log-line change like every other row in this table. |
| `guard_crash` | outer catch, line 401 — **only when R1's best-effort parse fails to recover a `session_id`** | `finding_ids: ["top_level_exception"]`. Filed to the `global-YYYY-MM-DD` fallback file, not a per-session file (§2.1). Classifies `health_failure`, never `fail_open`/escape (§4.7) — this is a genuine reclassification for this guard: previously `top_level_exception` here was always logged `fail_open` (an escape); it now splits per R1, landing as `block` in the session's own file when `session_id` is recoverable (see below), or `guard_crash`/`health_failure` when it is not. **Never** logged as `fail_open` any more. |
| `block` (top-level-catch case) | outer catch, line 401 — **only when R1's best-effort parse recovers a `session_id`** | `finding_ids: ["top_level_exception"]`, filed to that session's own file. This is the one case in this guard where a top-level-catch record is logged `block` rather than `fail_open`, per owner ruling R1 — the guard's actual runtime behavior (`process.exit(0)`, still fail-open) is unchanged; only the decision-ledger record differs from what the guard's own control flow does. See §6. |

## 4. Classification and signals

### 4.1 Classification is total

Every appended record maps to exactly one of **seven** buckets: `win`,
`loss`, `escape`, `by_design_allow`, `friction`, `health_failure`, or
`unknown`. Classification runs in a fixed priority order — the first rule
a record matches decides its bucket:

1. **`health_failure` first (§4.7, owner ruling R1).** Checked before
   anything else, including before checking whether `guard`/`event` even
   match §3's enumeration. A record is `health_failure` if **either** its
   `event` is literally `guard_crash`, **or** it is stored in a
   `global-YYYY-MM-DD` fallback file rather than a real session's file —
   regardless of what its own `guard`/`event`/`finding_ids` say. An
   unattributable record cannot be meaningfully scored as a routing
   outcome, so it never reaches the rules below.
2. **`unknown` (§4.10)**, for anything left whose `guard` or `event` fails
   to match §3's enumeration (including the `"unknown"` literal defaults
   from §2.3), or a line that fails to parse as JSON at all.
3. Everything else classifies per §4.4-§4.9, defined against §3's
   enumeration — **not** against the design brief's original event list
   verbatim, which conflated a block-time finding ID with a standalone
   event (see the notes in §3.1-§3.3).

This priority ordering is new relative to the design brief, made necessary
by owner ruling R1: without it, a `guard_crash` record, or an ordinary
`fail_open`/`block` record that happens to have landed in the global
fallback file for want of a `session_id`, would be scored by the same
rules as a normal, attributable decision — silently corrupting the
win/loss/friction counts for every real session sharing that day's global
file.

### 4.2 Streams (owner ruling R5)

Win/loss/friction pairing (§4.3) operates on **streams**, not on raw file
order. A record's **stream key** is `(session_id, agent_id_or_caller)`:
`agent_id` (§2.2) when it is non-null, else `caller` (`"orchestrator"` \|
`"subagent"` \| `"unknown"`, §2.5) as the fallback partition. Every record
in a ledger file belongs to exactly one stream.

**Ordering within a stream:** `ts` ascending; ties (equal `ts`, which can
genuinely happen at millisecond resolution) break on the record's original
line order within the file (earlier line first).

**Adjacency for runs (§4.3) is computed on the sorted per-stream
sequence, never on raw file order.** Two `block` records adjacent in the
file but belonging to different streams (interleaved output from parallel
subagents, for instance) are never treated as consecutive; two `block`
records far apart in the file but adjacent once sorted into their shared
stream are. Cross-stream interleaving can never merge two runs into one,
nor split one run into two.

See §6 for the blind spot this creates when a guard's envelope carries no
`agent_id` at all.

### 4.3 Block runs (owner ruling R4) — the unit `win`/`loss`/`friction` are computed over

**Runs, not individual `block` records, are the unit `win`, `loss`, and
`friction` count over.**

- **Block run:** within one stream (§4.2), a maximal sequence of
  consecutive `block` records sharing an identical
  `(guard, tool_name, target_hash, sorted finding_ids)` tuple
  (`finding_ids` compared as a sorted array so ordering never defeats the
  match), with no intervening allow-shaped record of the same `guard` in
  between. "Maximal" and "consecutive" are both evaluated on the sorted
  per-stream sequence from §4.2. A record already classified
  `health_failure` (§4.1 step 1, §4.7) is never a member of any run,
  regardless of its own `event` — a `block`-event record that happens to
  be filed in a `global-YYYY-MM-DD` fallback file (no attributable
  `session_id`) does not start, extend, or close a run; it is excluded
  from run-building entirely, the same way it is excluded from every
  other bucket.
- **Won run:** a block run followed **later in the same stream** by an
  allow-shaped record (`allow`, `exempt_subagent`, `allow_exempt_type`,
  `orchestrator_direct_shell`, `allow_sendmessage_not_workassignment`, or
  `allow_out_of_scope_tool_name`) from the **same `guard`**, whose pairing
  key matches the run's: **`subagent_type`** when the tool is `Agent` or
  `SendMessage`, else **`target_hash`**. A run with no comparable pairing
  field on either side is never paired.
- **Lost run:** a block run never followed by such a qualifying allow
  before the report window ends.
- **`friction_blocks`:** sum, over every run, of `(run length − 1)`. A
  run of length 1 contributes 0; a run of length 3 contributes 2.
- **`friction_runs`:** count of runs with length `>= 2`.

**One allow resolves exactly one run.** If multiple distinct-key runs are
open in the same stream at once (different `target_hash`/`subagent_type`
values), each pairs independently against its own matching allow — an
allow can close only the run whose pairing key it matches, never any
other open run, and never more than one run.

**Worked example (replaces this spec's earlier 3-blocks-then-allow
case):** three consecutive `block` records sharing the same
`(guard, tool_name, target_hash, finding_ids)` tuple, followed later in
the same stream by one matching allow-shaped record: **1 run**, **1 won
run**, `friction_blocks` **2**, `friction_runs` **1**, **0 loss**. The
three raw `block` lines are not three separate outcomes to score — they
are one run that eventually won, with 2 blocks of friction along the way.

### 4.4 `win`

The count of **won runs** (§4.3) in the report window. "Corrected shape,
now passing" is exactly this: the same guard, the same identifying field,
a run of one or more blocks, later allowed.

### 4.5 `loss`

The count of **lost runs** (§4.3) in the report window — runs abandoned
with no qualifying allow before the window ends.

### 4.6 `escape`

`orchestrator_direct_shell` (any guard), **every** `fail_open` event
regardless of `reason` (all three guards) **except** a record already
claimed by `health_failure` (§4.1 step 1 — a `fail_open` with no
recoverable `session_id`, filed to the global fallback file, is
`health_failure`, never `escape`, regardless of `reason`), and any future
explicit override path a later guard revision adds (none exists in the
current source of any of the three guards — no `SHELL_WRITE_OK`-style
token is read by any of them). This is the literal design-brief rule
applied as written, narrowed only by the `health_failure` carve-out §4.1
requires: for every `fail_open` that **is** attributable to a session, it
still deliberately does **not** distinguish `agent-adversary-floor`'s
policy fail-opens (parse errors, missing fields — a deliberate, documented
house policy, not a defect) from a genuine unrouted escape. See §6 for why
this makes the escape-rate signal (§4.11) noisier than "true adversarial
escape" alone, and why that is accepted rather than silently narrowed.

### 4.7 `health_failure` (owner ruling R1)

A record is `health_failure` when **either**:

- its `event` is the literal `guard_crash` (§3, all three guards' outer
  catch, reached only when R1's best-effort stdin re-parse could not
  recover a `session_id`); **or**
- it is stored in a `global-YYYY-MM-DD` fallback ledger file — regardless
  of which guard wrote it, what its `event` says, or why `session_id` was
  unavailable (a pre-parse `stdin_read_error`, an unparseable
  `json_parse_error`, a non-object `parsed_not_object`, or a `guard_crash`
  all share the one property that matters here: no session can be
  attributed).

`health_failure` is checked first (§4.1), ahead of every other rule — a
`health_failure` record is **never** also a block run, **never** counted
toward `win`, `loss`, or `friction`, and **never** counted toward `escape`
even when its own `event` is `fail_open` (§4.6's carve-out). It is not a
judgment about whether the underlying call was routed correctly — it is a
statement that the ledger cannot say, because it does not know which
session the call belonged to. Reported for visibility as its own count and
rate (§5.3's Health section, §4.11 signal 5), never folded into any of the
other six buckets.

### 4.8 `by_design_allow`

Every allow-shaped event from §3 not already claimed by `health_failure`
(§4.7) or §4.3's win-pairing: `allow`, `exempt_subagent`,
`allow_exempt_type` (the design brief's own three), plus
`allow_sendmessage_not_workassignment` and `allow_out_of_scope_tool_name`
(found in §3.3, not in the brief's enumeration — both are unambiguously
benign non-gating allows, so they are folded into this bucket rather than
forced into `unknown`, keeping the classification total per §4.1). Not a
loss. Reported for visibility only.

### 4.9 `friction`

`friction_blocks` and `friction_runs`, as defined in §4.3 — reported as
two separate counts (§5.3's "Wins / Losses / Friction" section), never a
single `friction` count and never a per-record tag. A run counted toward
`friction_runs`/`friction_blocks` is *also* eligible to later resolve into
a `win` (§4.4) if a qualifying allow eventually follows; the buckets are
not mutually exclusive at the per-run level — `friction`, `win`, and
`loss` are all computed as separate aggregate counts over the same set of
block runs, not as a single tag stamped on each run.

### 4.10 `unknown`

Any record whose `guard` or `event` fails to match §3's enumeration
(including the `"unknown"` literal defaults from §2.3), and any line that
fails to parse as JSON at all — except a record already claimed by
`health_failure` (§4.7 runs first; see §4.1). Always counted; never
dropped; always listed by literal `(guard, event)` pair and count in the
report (§5).

### 4.11 Signals — "is routing good"

Computed over the report window (§5). **Every rate below states its own
denominator explicitly (owner ruling R8); a rate whose denominator is 0
prints `n/a` and does not contribute to the verdict** — never silently
treated as PASS, and never silently omitted from the report.

**Prior equal-length window (owner ruling R7):** wherever a signal below
compares against "the prior equal-length window," that window is the
same-length window immediately preceding `--since` — if the report window
is `[--since, --until)` spanning `L` days, the prior window is
`[--since − L, --since)`. This applies whether the report window came from
`--window Nd` or from explicit `--since`/`--until`.

**Trend signals require >= 2 sessions in the window (owner ruling R7).**
"Falling" (signal 1), "trending down," and "flat-or-down" (signal 4) are
all trend comparisons against the prior equal-length window. Under
`--session` (a single session's ledger is, by definition, one session), or
whenever the window being scored contains fewer than 2 distinct sessions,
a trend comparison cannot be meaningfully computed:

- **Signal 4** (entirely trend-based) reports `n/a` in full and is
  **excluded from the verdict** — it counts toward neither FAIL nor WATCH,
  and does not count toward the "signals evaluated" total.
- **Signal 1** (a rate threshold *plus* a trend comparison) falls back to
  evaluating on its rate threshold alone (`< 2%`) — PASS/FAIL on the
  threshold only, with no WATCH-for-untrended-uncertainty tier, since no
  trend claim is being made when the trend itself is `n/a`. The escape
  rate figure and threshold are still reported; only the trend half of the
  line reads `n/a`.

The verdict line always states how many of the 5 signals were actually
evaluated (e.g. "4 of 5 signals evaluated" when signal 4 goes `n/a` under
`--session`) — never silently 5 when one was excluded.

| # | Signal | Denominator | Threshold | PASS rule |
|---|---|---|---|---|
| 1 | Escape rate | `escape` count / total decisions in window | `< 2%`, **and falling** vs. the prior equal-length window (see above) | PASS if rate `< 2%` **and** falling; WATCH if rate `< 2%` but not falling; FAIL if rate `>= 2%`. Denominator 0 → `n/a`, excluded from verdict. Trend `n/a` under `--session`/`< 2` sessions → evaluated on threshold alone, no WATCH tier (see above). |
| 2 | Win rate | `won runs` / `total runs` (won + lost, §4.3-§4.4) | `>= 70%` | PASS if `>= 0.70`; WATCH if `0.50 <= rate < 0.70`; FAIL if `< 0.50`. Denominator 0 (no runs — i.e. no blocks — in window) → `n/a`, excluded from verdict; **not** an automatic PASS (owner ruling R8 corrects this spec's earlier draft, which read "no blocks to score" as PASS). |
| 3 | Friction rate | `friction_blocks` / total `block` records in window (§4.3) | `<= 15%` | PASS if `<= 0.15`; WATCH if `0.15 < rate <= 0.25`; FAIL if `> 0.25`. Denominator 0 → `n/a`, excluded from verdict. |
| 4 | Orchestrator-direct trend | `Write`/`Edit` direct-block count and `orchestrator_direct_shell` count, each vs. the prior equal-length window | Both trending non-increasing | PASS if both trends are non-increasing; WATCH if either is flat-to-slightly-up (`<= 10%` increase); FAIL otherwise. `n/a`, excluded from verdict, under `--session` or `< 2` sessions (see above) — **not** WATCH (owner ruling R8 corrects this spec's earlier draft). |
| 5 | Health | `fail_open` count / total decisions in window; malformed line count | `fail_open <= 0.5%`; malformed `== 0` | PASS if both hold; FAIL if either is violated (no WATCH tier — a malformed line is always a parser/writer defect, not a judgment call). Denominator 0 is subsumed by the NO-DATA verdict below, since 0 total decisions triggers NO-DATA before any per-signal denominator is evaluated. |

**Verdict (owner ruling R8):** if the window contains **0 decisions** (the
total record count, matching §5.3's own `decisions: <count>` line —
including malformed/`unknown`/`health_failure` records, since all of those
still count as something having been read from the ledger; only a window
truly empty of any record at all is NO-DATA), the verdict is **`NO-DATA`**
— not `PASS` — and no signal is evaluated. Otherwise: `FAIL` if any
evaluated signal is FAIL; `WATCH` otherwise if at least one evaluated
signal is WATCH; `PASS` if every evaluated signal is PASS. A signal
excluded from the verdict per the trend/denominator rules above does not
count toward any of these three outcomes. The report always states each
signal's individual rating (including `n/a` ones) alongside the aggregate
verdict and the "N of 5 signals evaluated" line — never the verdict
alone.

## 5. Report CLI: `scripts/routing-scorecard.js`

Read-only. Never writes to `STATE_DIR`, never calls `appendDecision`,
never deletes or rotates a ledger file (sweeping stays exclusively
`appendDecision`'s job, per §2.1 — a read-only reporter running sweep
logic on someone else's read path would be a second, easily-diverging
copy of that sweep, not a saving).

### 5.1 Flags

| Flag | Default | Meaning |
|---|---|---|
| `--window Nd` | `7d` | Trailing window, e.g. `--window 3d`. Only the `Nd` (whole days) form is required by this spec; `--since`/`--until` below cover finer-grained needs. |
| `--since <ISO 8601>` | — | Overrides the window's start. |
| `--until <ISO 8601>` | now | Overrides the window's end. |
| `--session <id>` | — | Restrict to one session's ledger file (implies `--per-session` framing for that one session; incompatible with a broad `--aggregate` claim across sessions that don't exist in scope). |
| `--per-session` / `--aggregate` | `--aggregate` | Per-session breakout vs. summed totals. |
| `--json` / `--text` | `--text` | Output format. |
| `--state-dir <path>` | `<CLAUDE_CONFIG_DIR or ~/.claude>/hooks/state` (`resolveDefaultStateDir()`) — the INSTALLED tree's own state directory, never this repo checkout's own `hooks/state` | Points the reader at an alternate directory — e.g. an alternate installed tree, or a test fixture directory. |
| `--fail-on-threshold` | off | Opt-in: exit 1 if the verdict is `FAIL`. Without this flag, the script always exits 0 regardless of verdict (a diagnostic tool by default, not a CI gate someone enables by accident). **Advisory only, never an enforcement gate (owner ruling R6)** — see §6: win-pairing has no causal link back to the underlying work, so a verdict this flag would fail on can be manufactured by re-issuing a trivial matching call, not just earned by genuinely fixing routing. `--fail-on-threshold` is provided for a human or a non-blocking CI annotation to notice a FAIL, not as something a merge/deploy gate should key off of. |

### 5.2 Parser rules (binding on the reader, not just style)

- **No positional or contiguity assumptions across lines, only across a
  computed stream order.** Every line is parsed independently; a record's
  meaning never depends on its raw position in the file. Adjacency for
  block runs is evaluated only after sorting each stream (§4.2) by `ts`
  then original line order — never on raw file order directly — and the
  cross-record pairing rule (§4.3) is an explicit, named join on
  `(guard, subagent_type|target_hash)`, not a positional adjacency
  assumption: a block run and its matching allow do not need to be the
  next record after each other in the sorted stream, only later in it.
- **Records are grouped by the `session_id` field inside each record,
  never by filename (owner ruling R3).** A ledger file is only a
  container — two files whose sanitized-key portion happens to match but
  whose `h8` differs (§2.1) are two distinct sessions, and the reader
  must never coalesce them by filename prefix. Conversely, every record
  read from every `routing-decisions.*.jsonl` file under `STATE_DIR` (or
  `--state-dir`) is grouped into its session purely by its own
  `session_id` field (falling back to the same `global-YYYY-MM-DD`
  literal when `session_id` is `null`, consistent with §2.1's write-side
  fallback), and windowing/`--session`/`--per-session` all operate on
  that grouping, not on which file a record happened to be read from.
- **Malformed lines are counted, never abort the run.** A line that is not
  valid JSON, or parses to a non-object, is counted toward `unknown`
  (§4.10) and the read continues with the next line.
- **Unknown fields are ignored.** A field present in a line that isn't in
  §2.2's schema is dropped silently (forward-compatible with a future
  schema version bump).
- **Missing fields default explicitly** — the same defaults table as §2.3
  applies on read, not just on write, so a hand-edited or
  partially-truncated line still classifies deterministically rather than
  throwing.

### 5.3 Text output layout

If the window contains 0 decisions, the report short-circuits to a
`NO-DATA` verdict (owner ruling R8) and every section below the header
prints `n/a`/`0` rather than attempting to compute a rate against a 0
denominator:

```
routing-scorecard — window: <since> .. <until> (Nd)
sessions: <count>   decisions: <count> (<malformed> malformed)

Verdict: NO-DATA (0 decisions in window)
```

Otherwise:

```
routing-scorecard — window: <since> .. <until> (Nd)
sessions: <count>   decisions: <count> (<malformed> malformed)

Health
  fail_open rate:      X.XX%  (N / M decisions, threshold <=0.50%)   [PASS|FAIL|n/a]
  malformed lines:     N      (threshold ==0)                         [PASS|FAIL]
  health_failure:      N      (crash records + global-fallback records — never scored as a block run, win, loss, or friction; see §4.7)

Wins / Losses / Friction
  block records:  N
  runs:            N
  won runs:        N  (XX.X% of runs, threshold >=70%)                [PASS|WATCH|FAIL|n/a]
  lost runs:       N
  friction_runs:    N
  friction_blocks:  N  (XX.X% of block records, threshold <=15%)      [PASS|WATCH|FAIL|n/a]

Per-guard breakdown
  <guard>  allow:N  block:N  by_design_allow:N  escape:N  health_failure:N  unknown:N

Top finding_ids
  1. <id>  Nx
  ...

Escape events (up to 20 shown, <M more not shown>)
  <ts>  <guard>  <event>  <reason>  session:<id>

Crash records (guard_crash + global-fallback, up to 20 shown, <M more not shown>)
  <ts>  <guard>  <event>  <reason>  session:<id or "unattributed">

Verdict: PASS|WATCH|FAIL  (N of 5 signals evaluated)
  1. escape rate: ... [n/a if denominator 0 or trend n/a per §4.11]
  2. win rate: ...     [n/a if no runs in window]
  3. friction rate: ... [n/a if no block records in window]
  4. orchestrator-direct trend: ... [n/a under --session or <2 sessions]
  5. health: ...
```

### 5.4 JSON output

Same underlying numbers as §5.3, structured as one object:
`{ window, sessions, decisions, malformed, health, runs_wins_losses_friction,
per_guard, top_finding_ids, escape_events, crash_records, signals_evaluated,
verdict }` — every field text mode reports has a JSON counterpart,
including the `NO-DATA` verdict shape and every `n/a` rate (rendered as
the JSON value `null` with a sibling `*_denominator: 0`, never omitted and
never coerced to `0`); `--json`/`--text` parity is a test requirement
(§7). `health` carries `fail_open_rate`, `malformed_count`, and
`health_failure_count`. `runs_wins_losses_friction` replaces the earlier
draft's `wins_losses_friction` name and carries `block_records`, `runs`,
`won_runs`, `lost_runs`, `friction_runs`, `friction_blocks`, plus the win
rate and friction rate figures (each `null` with its denominator when
`n/a`). `crash_records` is the JSON counterpart of the new "Crash records"
text section. `signals_evaluated` is the integer (0-5) the text mode's "N
of 5 signals evaluated" line reports.

## 6. Blind spots

- **Retries the model abandons undercount friction.** §4.9's friction
  counts only see **appended** `block` records, grouped into runs (§4.3)
  — a tool call the model never retries after seeing a block (gives up,
  changes approach entirely, ends the turn) leaves exactly one `block`
  record, forming a run of length 1, which §4.5 correctly counts as a
  `loss` but which never contributes to `friction_runs` (runs of length
  `>= 2` only), even though the underlying behavior (a blocked shape that
  was never corrected) is the same failure this signal is trying to
  surface at volume. A model that reliably abandons rather than retries
  would show as high loss / low friction, understating how often the
  *same* blocked shape recurs across the fleet if abandon-then-reattempt
  happens in a fresh session (or a fresh stream, per §4.2 — a new
  `agent_id` also starts a new stream and therefore a new run) rather than
  the same one (this ledger is per-session-scoped by design, same as
  every other ledger in this directory — see
  `docs/specs/stop-guard-bounded-reblock.md` §2 item 5 for the precedent).
- **`tool_use_id` presence per guard envelope is unverified.** Confirmed
  present on the raw stdin envelope for `agent-model-routing-guard.js`'s
  `Agent` PreToolUse branch only (that file already reads
  `parsed.tool_use_id` there, line 503). Whether `orchestrator-tool-guard.js`'s
  `Read`/`Bash`/`PowerShell`/`Write`/`Edit` envelope, or
  `agent-adversary-floor.js`'s `Agent`/`SendMessage` envelope, also carries
  a top-level `tool_use_id` has not been independently confirmed by
  reading either file (neither reads that field today) — the new call
  sites read it defensively (present-string-or-`null`, per §2.3), so a
  wrong guess costs a `null` field, never a crash, but the field may be
  `null` across the board for two of the three guards for reasons that
  have nothing to do with whether a record is loggable.
- **Debug-log history is not backfilled.** Every guard already writes a
  `*-debug.log` line at each of these exit points (via `createLogger`/
  `appendDebug`). This spec's ledger starts recording from the moment
  `appendDecision` calls are wired in — no retroactive parse of the
  existing debug logs into ledger-shaped records is in scope. A scorecard
  run immediately after deployment reports on a cold, near-empty window
  until enough real traffic accumulates.
  `--window`/`--since` cannot manufacture history that was never captured
  in this shape.
- **`target_hash` is unsalted.** `sha256(target).slice(0,12)`, no per-file
  or per-install salt. For a small, guessable target space (a short list
  of well-known file paths, a handful of common shell commands) this is
  reversible by dictionary/rainbow lookup — it is a *reporting*
  obfuscation (never show the raw path/command in the ledger itself, so a
  casual read of the file doesn't leak it), not a cryptographic
  commitment. Anyone with read access to the ledger and a guess at the
  likely target set can confirm that guess.
- **Escape rate is intentionally not narrowed to "true" escapes — and
  owner ruling R1 narrows the population it covers.** §4.6 buckets every
  *session-attributable* `fail_open` as an escape, including
  `agent-adversary-floor.js`'s documented, deliberate parse-error/
  missing-field fail-opens (its own header: "a rare false ALLOW"), which
  are policy, not defects. This means signal #1 (escape rate) is measuring
  "how often something got through unrouted for *any* reason, benign or
  not," not "how often something got through unrouted *despite the guard
  trying to stop it*." R1 narrows which of `agent-adversary-floor`'s
  fail-opens actually reach this bucket, though: `stdin_read_error`,
  `json_parse_error`, and `parsed_not_object` occur before any
  `session_id` could possibly be known, so in practice they are
  `health_failure` (§4.7), not `escape` — the only fail-opens for this
  guard that realistically land as `escape` are `missing_tool_name` /
  `prompt_missing_or_non_string` (when the envelope happens to carry a
  valid `session_id` alongside the malformed field) and `internal_exception`.
  `top_level_exception` is no longer part of this guard's `fail_open`
  population at all (§3.3) — it is either `block` or `guard_crash`
  (`health_failure`) per R1, never `fail_open`. The two other guards never
  fail open on an internal exception (they block instead —
  §3.1/§3.2's notes), so what asymmetry remains concentrates almost
  entirely in `agent-adversary-floor`'s own `internal_exception` and
  malformed-but-attributable-envelope cases; a scorecard reader comparing
  escape counts across the three `guard` rows in the per-guard breakdown
  (§5.3) should read `agent-adversary-floor`'s row knowing this, not
  conclude that guard is categorically leakier by design intent.
- **The top-level-catch `block` record for `agent-adversary-floor.js`
  logs a different outcome than the guard actually took (owner ruling
  R1).** When R1's best-effort parse recovers a `session_id`, this guard's
  top-level-catch record is logged `event: "block"` (§3.3), but the
  guard's real behavior at that exit point is unchanged: it still calls
  `process.exit(0)` and still writes its own `*-debug.log` line as
  `fail_open`/`top_level_exception`, per its documented fail-open house
  policy. The decision ledger and the guard's actual control flow
  disagree for this one specific corner case (a crash after `main()`
  starts but before the outer catch's best-effort parse fails to
  recover a session — a narrow, rare window). This is accepted as the
  cost of a uniform, guard-agnostic crash-record rule (§2.1) rather than
  three different per-guard crash classifications; a reader cross-checking
  a `block` line in the ledger against that guard's own `*-debug.log`
  for the same timestamp should not be surprised to find `fail_open`
  there instead.
- **Win-pairing can mismatch across genuinely different work, and can be
  gamed (owner ruling R6).** §4.3's pairing key is `subagent_type` (for
  `Agent`/`SendMessage`) or `target_hash` (otherwise) — it has no
  session-turn or causal linkage beyond "later in the same stream." Two
  unrelated dispatches of the same `subagent_type` in the same stream (a
  blocked `general-purpose` Agent call for task A, followed much later by
  an unrelated, cleanly-formed `general-purpose` Agent call for task B)
  can be counted as a `win` for task A's block even though nothing about
  task A was actually corrected — this is a false win, not a false loss,
  and is accepted because the alternative (requiring some stronger causal
  signal neither guard's envelope currently carries) is not available from
  the data these three guards already log. **This has no defense in this
  spec, by design (R6):** because pairing has no causal link, an
  orchestrator (or a model being scored) can manufacture a win outright —
  re-issue a trivial, cleanly-formed call matching a prior block's pairing
  key, with no relationship to the work that was actually blocked, purely
  to move the win-rate signal. No fix is attempted here; §5.1's
  `--fail-on-threshold` is advisory only for exactly this reason and must
  never be wired into an enforcement gate (a merge check, a CI gate, an
  autonomous stop condition) — doing so would create a direct incentive to
  game a number this spec cannot make tamper-evident with the data these
  guards currently log.
- **Parallel subagents can create false runs when a guard's envelope
  carries no `agent_id` (owner ruling R5).** The stream key (§4.2) falls
  back to `caller` (`"orchestrator"`/`"subagent"`/`"unknown"`) whenever a
  record's `agent_id` is `null` — and per §6's `tool_use_id` blind spot
  above, this spec has not independently confirmed that every guard's
  envelope even carries an agent-identifying field at all. When it does
  not, every subagent record in a session collapses into the single
  `(session_id, "subagent")` stream, regardless of how many distinct
  subagents actually ran. Two unrelated subagents each blocked on an
  unrelated call, running concurrently, can then land adjacent to each
  other in that one collapsed stream purely by `ts` ordering — forming a
  block run (§4.3) that never existed as a single agent's real,
  consecutive retry sequence, and a subsequent allow from either subagent
  can "win" a run that was never actually one continuous attempt. This
  is the run/stream analogue of the win-pairing mismatch above, with the
  same acceptance rationale: no stronger per-subagent identity is
  available from the data these guards currently log.

### 6.1 Adversary record

Owner rulings applied against this spec's draft, one line each:

- **R1 — Crash records.** Top-level catches capture raw stdin in outer
  scope and best-effort-parse it for `session_id`; found → that session's
  file, `event: "block"`; not found → the `global-YYYY-MM-DD` fallback
  file, `event: "guard_crash"` — both `guard_crash` and every
  global-fallback record classify `health_failure` only, never a block
  run, win, loss, or friction.
- **R2 — Sweep race.** `cleanupOldStateFiles` is called with
  `minAgeMs = 60000`, matching `agent-tier-ledger.js`'s A6 precedent — a
  file touched within the last 60 seconds is never swept.
- **R3 — Filename collisions.** Filenames carry an `h8` disambiguator
  (`sha256(session key).slice(0,8)`); the reader groups records by the
  `session_id` field inside each record, never by filename.
- **R4 — Runs replace blocks as the unit.** Win/loss/friction are computed
  over maximal consecutive-identical-block runs per stream, not raw block
  records; `friction_blocks` and `friction_runs` are reported separately;
  one allow resolves exactly one run.
- **R5 — Streams.** A new optional `agent_id` field partitions records
  into `(session_id, agent_id-or-caller)` streams; runs are computed
  per-stream on `ts`-then-line-order, never on raw file order.
- **R6 — Gaming.** Win-pairing has no causal link and can be manufactured;
  `--fail-on-threshold` is advisory only and must never be wired into an
  enforcement gate. No fix is attempted.
- **R7 — Trend under `--session`.** Trend signals need >= 2 sessions in
  the window; under `--session` or fewer, they report `n/a` and are
  excluded from the verdict, which states how many signals were
  evaluated. "Prior equal-length window" is the same-length window
  immediately preceding `--since`.
- **R8 — Denominators.** Every rate states its denominator explicitly;
  denominator 0 prints `n/a` and doesn't contribute to the verdict; a
  window with 0 decisions yields verdict `NO-DATA`, not `PASS`.
- **R9 — Crash-path hardening (found in review of PR #14, d6a5f08).** Each
  guard's bare `require("./model-routing-guards.decisions.js")` and its
  top-level catch's unwrapped `appendCrashRecord(...)` call meant a missing/
  corrupted decisions module, or a `require()`/`appendCrashRecord` throw,
  escaped as an uncaught exception — Node's default exit code 1, which the
  harness treats as **allow** on a `PreToolUse` hook. Fixed: the module is
  now loaded defensively (`try/catch` around `require()`, falling back to
  no-op stand-ins) in all three guards, and each top-level catch's
  `appendCrashRecord` call additionally wraps itself in its own
  `try/catch`. A decisions-module failure can now never change a guard's
  exit code or output, crash path included. See §2.1's amended "Never
  changes control flow" bullet and `hooks/model-routing-guards.crash-path.test.js`.

## 7. Tests

`node:test`. **Implementation note (authored 2026-09-07, correcting this
section's premise):** at authoring time, neither
`hooks/model-routing-guards.state.test.js` nor
`hooks/agent-tier-ledger.test.js` exists in this repo, so there is no
"injected `fs`/`now`/`stateDir`" convention on record to match — this
section's original wording assumed suites that were never written. The
repo's ACTUAL, established convention (used throughout
`hooks/orchestrator-tool-guard.test.js`, which already exercises
`model-routing-guards.state.js` directly) is: real `fs`, the real
`STATE_DIR`, unique per-test session keys (`uniqueSession(prefix)`),
cleanup in a `finally` block, and `fs.utimesSync` backdating for
age-sensitive sweep assertions. `hooks/model-routing-guards.decisions.js`
and `scripts/routing-scorecard.js`'s own suites (§7.1/§7.2) follow that
same real-fs convention, and additionally lean on node:test's built-in
`t.mock.method()` to spy on/stub specific calls (e.g. asserting
`cleanupOldStateFiles`'s exact call arguments, or forcing
`fs.writeSync`/`fs.openSync`/`fs.mkdirSync` to throw) — both modules under
test call `fs.*` and `state.*` as namespaced property accesses rather than
destructured locals specifically so this substitution works without either
module needing an injected-dependency constructor of its own. See each
test file's own header comment.

### 7.1 `hooks/model-routing-guards.decisions.test.js`

Discovered by `scripts/run-tests.js`'s `hooks/*.test.js` glob (the module
under test lives in `hooks/`, so this is the natural, unambiguous home —
no placement decision needed here).

| Test | Checks |
|---|---|
| `append_atomicity` | Exactly one `fs.writeSync` call (injected spy) per `appendDecision`, whole line in one call — never a partial-line write split across calls. |
| `body_redaction` | A `record` with extra `prompt`/`message`/`command` keys attached — the written line, parsed back, has none of those keys; only §2.2's allowlist appears. |
| `sweep_prefix_isolation` | `cleanupOldStateFiles` is invoked with `"routing-decisions."`/`".jsonl"`; a pre-existing `orchestrator-tool-guard.*.ledger` / `agent-tier-ledger.*.jsonl` / `stop-stale-worktrees-guard.*` fixture file, backdated past 7 days, is **not** removed by an `appendDecision` call. |
| `sweep_min_age` (owner ruling R2) | `cleanupOldStateFiles` is invoked with a fourth argument, `SWEEP_MIN_AGE_MS = 60000` — asserted directly on the spy call, not inferred from behavior alone. **Implementation note (authored 2026-09-07, correcting this row):** this row's original second sentence described a single fixture file simultaneously "backdated past 7 days" (`age > maxAgeMs`) AND "touched 10/61 seconds before now" (`age <= minAgeMs`/`age > minAgeMs`) — but `cleanupOldStateFiles` (`model-routing-guards.state.js`) computes exactly one `age = now - mtime` per file and tests that SAME number against both thresholds (`if (age <= minAge) continue; if (age > maxAge) unlink`); no single mtime can be both `> 604800000` and `<= 60000`/`in (60000, ∞)` against one `now`, so the scenario as originally worded is unreachable against the real, unmodified primitive this module reuses verbatim (§2.1 requires reuse, not an injectable `now` added to it). The test therefore demonstrates the identical mechanism at the same 10s/61s boundary by calling `cleanupOldStateFiles` directly with a `maxAgeMs` small enough for both thresholds to be simultaneously reachable (e.g. `30000`), rather than through `appendDecision`'s own fixed 7-day constant, which cannot reach this state in any real-time-bounded test: a fixture touched 10s before `now` is **not** removed; an identical fixture touched 61s before `now` **is** removed. See `hooks/model-routing-guards.decisions.test.js`'s own comment on this test. |
| `existing_reader_non_regression` | After several `appendDecision` calls, `readLedgerCount` (Hook 2's own reader) and `agent-tier-ledger.js`'s `listLedgerFiles`/`readAllRecords` are unaffected — neither sees nor errors on the new `routing-decisions.*.jsonl` files. |
| `write_failure_never_blocks` | Injected `fs.openSync`/`writeSync`/`mkdirSync` throwing — `appendDecision` returns normally (no throw), no partial file left in a state a later read would choke on. |
| `missing_fields_default_explicitly` | A `record` with only `guard` and `event` set — written line has every other field at its §2.3 default, not `undefined`/absent. |
| `malformed_record_type_swallowed` | `appendDecision(null)`, `appendDecision("x")`, `appendDecision(42)` — each produces a fully-defaulted line per §2.3's non-object case, never throws. |
| `session_key_reuses_resolve_session_key` | Missing `session_id` on the record → file path uses the same `global-YYYY-MM-DD` fallback `resolveSessionKey` already produces elsewhere, not a reimplementation. |
| `filename_hash_distinctness` (owner ruling R3) | Two raw session ids that `sanitizeForFilename` collapses to the identical sanitized string (e.g. differing only in characters outside `[A-Za-z0-9_.-]`) produce **two different files** — same sanitized prefix, different `h8` suffix, `h8` matching `sha256(<raw session key>).slice(0,8)` for each. `appendDecision` calls for both session ids never write into each other's file. |
| `finding_ids_defaults_to_empty_array` | Omitted `finding_ids` → written line has `finding_ids: []`, not `null` or absent. |
| `crash_record_routing` (owner ruling R1) | `appendCrashRecord(rawBuffer, guard, guardVersion)`: (a) `rawBuffer` a valid JSON string with a non-blank `session_id` → one record appended to that session's own file, `event: "block"`, `finding_ids: ["top_level_exception"]`; (b) `rawBuffer` valid JSON but `session_id` missing/blank → one record appended to the `global-YYYY-MM-DD` fallback file, `event: "guard_crash"`; (c) `rawBuffer` not valid JSON at all (or `undefined`, matching a stdin-read failure before any bytes were captured) → same `global-YYYY-MM-DD`/`guard_crash` outcome as (b), no throw. |

### 7.1a `hooks/model-routing-guards.crash-path.test.js` (R9)

Added in the crash-path hardening fix (§2.1's "Defensive load and
defense-in-depth" bullet, R9), then extended per the independent
approver's second review (§2.1's "Amendment" sub-bullet). Discovered by
the same `hooks/*.test.js` glob as §7.1. Drives each of the three guards
as a child process (`spawnSync`) with a deterministic envelope, while
shadowing `model-routing-guards.decisions.js` in-process via a
`-r`-preloaded `Module._load` interception keyed on that module's resolved
absolute path (a relative `require("./...")`, so `NODE_PATH` cannot shadow
it).

**Structural check (one test per guard):** `assertNoUnwrappedCalls` scans
each guard's source for the literal patterns `decisions.appendDecision(`,
`decisions.hashTarget(`, `decisions.appendCrashRecord(` and asserts none
appear outside the three wrapper functions' own bodies (which capture the
export into a local before calling it, so even those definitions never
contain the literal call-shaped pattern) — a static regression guard
against a future call site bypassing `logDecision`/`safeHash`/`safeCrash`.

**Behavioral matrix:** for every combination of

- **guard** — `orchestrator-tool-guard`, `agent-model-routing-guard`,
  `agent-adversary-floor`;
- **envelope** — `allow` (a deterministic allow-path payload per guard:
  orchestrator-tool-guard's exempt-subagent branch, agent-model-routing-
  guard's Agent dispatch with a resolvable mechanical-tier model plus a
  temp `~/.claude/hooks/local-policy.json` HOME per hooks/agent-model-
  routing-guard.test.js's own `mkTierHome` convention, agent-adversary-
  floor's `Explore` exempt type), `block` (orchestrator-tool-guard's
  unexpected-`tool_name` branch, agent-model-routing-guard's model-less
  Agent dispatch, agent-adversary-floor's no-completeness-clause prompt),
  and `malformed` (invalid-JSON stdin, the same fail-open envelope for all
  three);
- **decisions-module shape** — `throw_on_load` (`require()` itself
  throws — the original R9 fix's failure mode), `non_function_objects`
  (`require()` succeeds; `appendDecision`/`appendCrashRecord`/`hashTarget`
  are each `{}` — the approver's reported shape), `undefined_exports`
  (same, but each export is `undefined`), and `throwing_functions` (each
  export IS a function but throws when called — exercises the wrappers'
  `try/catch` layer specifically, distinct from the `typeof`-guard layer
  the other three shapes exercise);

the guard is run twice with the identical envelope — once against the
real, healthy `model-routing-guards.decisions.js`, once against the
shadowed/broken module — and the test asserts the **broken run's exit code
and stdout equal the healthy run's**, computed fresh in the same test
rather than a hardcoded expected value, so the assertion cannot drift from
whatever the healthy path actually does. 3 guards x 3 envelopes x 4 shapes
= 36 behavioral tests, plus 3 structural tests = 39 total.

Verified to fail (18/39, spanning every `non_function_objects`/
`undefined_exports` case for `orchestrator-tool-guard` and
`agent-model-routing-guard`'s `allow`/`malformed` envelopes and
`agent-adversary-floor`'s `block` envelope) against the first R9 fix
(defensive `require()` + a single wrapped top-level-catch call, before the
approver's second-review amendment) — reproducing the approver's exact
finding (allow/malformed flipping to exit 2, block flipping to exit 0) —
and to pass 39/39 against both the pre-PR-#14 (`c629cf1`, decisions module
absent entirely) and the fully-amended code. This is a genuine regression
test, not a vacuous one.

Does not touch `hook-state-write-guard.js`, `stop-stale-worktrees-guard.js`,
or their specs/tests — out of scope for R9, owned by a separate author.

### 7.2 `hooks/routing-scorecard.test.js`

**Placement decision (per task instruction to state one):** this file
tests `scripts/routing-scorecard.js`, which is not itself a hook — but
`scripts/run-tests.js`'s discovery rule for `test/` picks up *any* `.js`
file there, while its rule for `hooks/` requires the `.test.js` suffix
specifically (both satisfied by naming this file
`hooks/routing-scorecard.test.js`). Placing it in `hooks/` — beside
`model-routing-guards.decisions.test.js`, which it depends on as a fixture
producer — keeps both new test files co-located and avoids adding a
`scripts/`-scanning rule to `run-tests.js` for the sake of one file, at the
minor cost of a test file for a `scripts/` module living outside
`scripts/`. `test/routing-scorecard.test.js` would work identically under
the existing discovery rule and was the alternative considered; `hooks/`
is chosen for the co-location reason above, not because one placement is
more "correct" than the other under the current discovery logic.

| Test | Checks |
|---|---|
| `window_filtering` | Records with `ts` outside `[--since, --until)` (or outside the computed `--window Nd` range) are excluded from every count. |
| `run_pairing_single_block_allow` (owner ruling R4) | One `block` immediately followed by a same-stream, same-`(guard, subagent_type)` `allow` → 1 run, 1 won run, 0 lost run, `friction_blocks` 0, `friction_runs` 0. |
| `run_pairing_three_blocks_then_allow` (owner ruling R4) | Three consecutive same-tuple `block`s in one stream, no intervening allow, followed later by one matching allow → **1 run, 1 won run, `friction_blocks` 2, `friction_runs` 1, 0 loss** (the rewritten worked example from §4.3 — supersedes this spec's earlier per-block "1 friction instance, 3 toward loss's denominator" framing). |
| `run_pairing_two_open_runs_one_allow` (owner ruling R4) | Two distinct-key block runs open concurrently in the same stream (different `target_hash`/`subagent_type`), followed by one allow matching only one of them → that one run becomes won; the other remains open/lost at window end. The allow never pairs against, shortens, or otherwise affects the non-matching run. |
| `run_pairing_never_resolved` (owner ruling R4) | A block run with no qualifying allow anywhere later in the stream before the window ends → 1 lost run, contributing to `loss`'s denominator only, never `win`'s, regardless of the run's length. |
| `stream_separation_interleaved_agent_ids` (owner ruling R5) | Two subagents (`agent_id: "a1"`, `agent_id: "a2"`) in the same session, each with a block-then-allow sequence, written to the ledger with lines physically interleaved (a1-block, a2-block, a1-allow, a2-allow) — each stream resolves its own run independently (2 won runs total); raw file order never merges or splits either agent's run. A control case with `agent_id: null` on all four lines collapses them into one `(session_id, "subagent")` stream instead, per §6's blind spot, producing a different (and here, intentionally worse — a false pairing) result than the `agent_id`-populated case, pinning that the two are NOT equivalent. |
| `malformed_tolerance` | A ledger file with one corrupt JSON line and one line with an `event` not in §3's enumeration — the run completes, both land in `unknown`, every other line is scored normally. |
| `filename_hash_and_record_grouping` (owner ruling R3) | Two ledger files with the same sanitized-session-id prefix but different `h8` suffixes (distinct sessions per §2.1) are both read; the report groups their records by each record's own `session_id` field, correctly keeping the two sessions separate under `--per-session` and correctly summing both under `--aggregate` — never merged or split by filename. |
| `json_text_parity` | Same fixture, `--json` vs `--text` — every numeric field in the JSON output matches the number rendered in the text output, including `n/a`/`null` rates and the `NO-DATA` verdict shape. |
| `threshold_verdicts` | Five fixtures, one per signal (§4.11), each engineered to sit just above/below its stated threshold — each produces the documented PASS/WATCH/FAIL for that signal and the correct aggregate verdict. |
| `no_data_verdict` (owner ruling R8) | A window with 0 decisions (empty or entirely-out-of-window ledger) → verdict `NO-DATA`, not `PASS`; no signal is evaluated; "0 of 5 signals evaluated" is reported. |
| `zero_denominator_rates_are_na` (owner ruling R8) | A window with decisions present but 0 `block` records (only `allow`/`by_design_allow` traffic) → win rate and friction rate both report `n/a` with their stated denominator (0), excluded from the verdict — not `PASS`, not silently omitted; the aggregate verdict is computed from the remaining evaluated signals only. |
| `trend_na_under_session` (owner ruling R7) | `--session <id>` (one session, so `< 2` sessions in scope): signal 4 (orchestrator-direct trend) reports `n/a` in full and is excluded from the verdict and from "N of 5 signals evaluated"; signal 1 (escape rate) still reports its rate/threshold PASS or FAIL, with only its trend half reading `n/a` (no WATCH-for-trend-uncertainty tier applied). A second fixture with exactly 2 distinct sessions confirms the trend components compute normally once the `>= 2` threshold is met. |
| `unknown_bucket_reporting` | A fixture with a deliberately fabricated `event: "totally_new_event"` on a real `guard` — counted in `unknown`, listed by `(guard, event)` pair in the report, never silently dropped or merged into `by_design_allow`. |
| `per_session_vs_aggregate` | Two sessions' ledger files, differing block/allow counts — `--per-session` reports each separately; default `--aggregate` sums them; the two never silently disagree on total decision count. |
| `fail_on_threshold_exit_code` | A FAIL-verdict fixture: exits 0 without `--fail-on-threshold`, exits 1 with it. A PASS-verdict fixture with `--fail-on-threshold`: exits 0. |
| `state_dir_override` | `--state-dir <alt>` reads from the alternate directory only, ignoring any fixture files placed in the default `STATE_DIR`. |
| `default_state_dir_resolves_under_home_config_not_repo` | With no `--state-dir`, `DEFAULT_STATE_DIR`/`resolveDefaultStateDir()` resolves under `<CLAUDE_CONFIG_DIR or ~/.claude>/hooks/state` — never this repo checkout's own `hooks/state`, and never `hooks/model-routing-guards.decisions.js`'s own (repo-relative) `STATE_DIR`; both the `CLAUDE_CONFIG_DIR`-set and unset cases are covered. |
| `state_dir_printed_in_text_header` | The `--text` output's header line names the resolved state directory (honoring `--state-dir` when given). |
| `escape_classification_matches_design` | A `fail_open` record from `agent-adversary-floor` with a real `session_id` (policy fail-open, `reason: "internal_exception"`) and an `orchestrator_direct_shell` record both count toward `escape`; a `block` record with `finding_ids: ["internal_exception"]` from `orchestrator-tool-guard` or `agent-model-routing-guard` does **not** count toward `escape` (§4.6's note) — this test exists specifically to pin the §3.1/§3.2 vs. §3.3 asymmetry described in §6. |
| `crash_record_classification` (owner ruling R1) | A `guard_crash` record and a `fail_open` record with `session_id: null` (filed to the global fallback file) both classify `health_failure`, contributing to neither `escape`, `win`, `loss`, nor `friction` — even though the latter's own `event` is `fail_open`, which §4.6 would otherwise bucket as `escape`. |

## 8. Install/registration notes

- **`scripts/install-guards.js`'s `GUARDS` array does not need a new
  entry.** `hooks/model-routing-guards.decisions.js` is not a standalone
  hook with its own `event`/`matcher` — it is a shared library module,
  same category as `model-routing-guards.state.js`/`.log.js`/`.exempt.js`.
- **It DOES need a `SUPPORT_FILES` entry — the design brief's own hedge
  ("likely not registered") is only half right.** Reading
  `scripts/install-guards.js` directly: shared library modules are copied
  to `~/.claude/hooks/` via a **separate, hand-maintained**
  `SUPPORT_FILES` array (lines 144-152) — not auto-discovered, not the
  same list as `GUARDS`. `SUPPORT_FILES` currently lists
  `model-routing-guards.state.js`, `.unicode.js`, `.log.js`, `.exempt.js`,
  `.rules.js`, `.paths.js`, and `agent-tier-ledger.js`. It does **not**
  list `model-routing-guards.decisions.js`. Since all three guard files
  this spec modifies (`orchestrator-tool-guard.js`,
  `agent-model-routing-guard.js`, `agent-adversary-floor.js`) are
  themselves `GUARDS`-registered and copied to the installed tree, an
  installed copy that `require()`s the new module without it also being
  copied would throw `MODULE_NOT_FOUND` at guard-invocation time — a
  crash, not a silent no-op, on every real session once the guard files
  are updated but the module is not copied alongside them. **Required
  change:** add `'model-routing-guards.decisions.js'` to the
  `SUPPORT_FILES` array (line 144-152) before the next
  `install-guards.js` run.
- **`scripts/routing-scorecard.js` needs no installer entry at all.** It
  is a read-only reporting script invoked directly from a repo checkout
  (`node scripts/routing-scorecard.js ...`), not a hook `install-guards.js`
  copies or wires into `settings.json`. Its default `--state-dir` (§5.1,
  `resolveDefaultStateDir()`) already resolves to the INSTALLED tree's own
  `~/.claude/hooks/state` (or `$CLAUDE_CONFIG_DIR/hooks/state`) with no
  installer involvement — `--state-dir` is only needed to point it at some
  OTHER directory (an alternate installed tree, or a test fixture
  directory).

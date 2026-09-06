# hooks/

Each guard below is a small, single-purpose script wired into a Claude Code
hook event (`PreToolUse`, `Stop`, or a library used by one). All of them
share three properties:

- **Fail-open on internal error.** A guard that throws, cannot read its
  input, or hits an unexpected shape allows the action rather than wedging
  the session. Precision over recall — a missed violation is tolerable; a
  hook that breaks every turn is not.
- **No owner-specific paths.** Every guard resolves its own install
  location from `__dirname` or the current user's home (`os.homedir()`),
  and any sandbox/governance root it needs to reason about comes from
  `os.tmpdir()` / `os.homedir()` or the optional local policy file below —
  never a literal absolute path baked in for one specific machine.
- **Tier language, not model names.** Messages and comments refer to
  "orchestrator tier" (top-tier, holds the conversation, delegates),
  "planning tier" (produces plans/options from a succinct brief),
  "drafting tier" (writes the actual content under guardrails), and
  "mechanical tier" (deterministic lookups/edits under tight guardrails) —
  never a specific model name. Remap the tiers to whatever models you use;
  the guards don't change.

## Local policy

`hooks/local-policy.json` (gitignored; copy `hooks/local-policy.example.json`
to start one) is the **only** place a guard learns something specific to
your machine or project:

```json
{
  "roots": ["<absolute path>", "..."],
  "gated_extensions": [".ps1"],
  "exempt_types": ["SomeToolName"],
  "model_tiers": {
    "<your-planning-tier-model-name>": "planning",
    "<your-drafting-tier-model-name>": "drafting",
    "<your-mechanical-tier-model-name>": "mechanical"
  }
}
```

- `roots` — extra sandbox/allow-list roots `agent-permission-preflight.js`'s
  lint (f) treats as covered locations, beyond the current working
  directory. Absent the file, the only root is `process.cwd()`.
- `gated_extensions` / `exempt_types` — reserved for guards that want a
  project-specific extension or tool-type carve-out beyond their own
  built-in default; not every guard below consumes these yet (see each
  guard's own config file where one already exists, e.g.
  `shell-write-guard.config.json`).
- `model_tiers` — the ONLY place a real model-family literal is allowed to
  exist on your machine: an object mapping each of your real model
  literal(s) to exactly one of `"planning"` / `"drafting"` / `"mechanical"`.
  `agent-model-routing-guard.js` reads this, never a hardcoded model name.
  Every key and value is folded (Unicode invisible/mark strip, trim,
  lowercase) before comparison, so casing and stray invisible characters in
  either the config or the dispatch's own `model` field don't matter — but
  two keys that COLLIDE after folding, a key that folds to empty, or a tier
  value that isn't one of the three names above, invalidates the **whole**
  `model_tiers` field back to `{}`, fail-closed, never last-key-wins.
  Absent or empty, every dispatch blocks on `model_missing_or_invalid` —
  that's the expected state until you configure this key, not a new
  failure mode.

See `hooks/lib/local-policy.js` for the loader (`loadLocalPolicy()`) —
missing file, unreadable file, or malformed JSON all fall back to the
conservative default rather than throwing.

## Guards

### no-punt-guard.js
- **Event:** `Stop`
- **Blocks:** the agent ending its turn on a closing message that defers,
  hedges, or punts flagged work to "later / your call / next session"
  instead of finishing it or asking explicitly.
- **How:** reads the transcript's last assistant message, scans it against
  a high-precision set of punt phrasings; on a match, prints a `block`
  decision that is fed back to the model as a correction.

### shell-write-guard.js
- **Event:** `PreToolUse` (Bash)
- **Blocks:** a shell command that writes to a file through a redirect,
  `cp`/`mv`/`sed -i`/heredoc, etc., when the write target has a gated
  extension (default `.ps1`/`.psm1`/`.psd1`, overridable in
  `shell-write-guard.config.json`) or lands in a location a hook-gated
  editor tool would have linted. Shell writes skip the PostToolUse linter
  an Edit/Write call would have triggered — this guard is the backstop.
- **Override:** prefix the command with `SHELL_WRITE_OK=1 ` (logged) for a
  deliberate, reviewed exception.

### bash-powershell-guard.js
- **Event:** `PreToolUse` (Bash)
- **Blocks:** a Bash tool call that actually contains PowerShell syntax
  ($env:, a Verb-Noun cmdlet, a PowerShell-only flag, a PowerShell
  automatic variable) — a hard parse error on a POSIX bash target.
  POSIX-valid constructs are never blocked.

### worktree-isolation-guard.js
- **Event:** `PreToolUse` (Bash)
- **Blocks:** a worktree-isolated agent's shell command from writing to a
  tracked file outside its own linked worktree (the main checkout, or
  another agent's worktree) — the shell-level counterpart to keeping an
  isolated agent's edits inside its own copy of the repo.

### bash-classifier-bait-guard.js
- **Event:** `PreToolUse` (Bash)
- **Blocks:** Bash command shapes that reliably trigger a permission
  classifier's confirmation dialog for no operational reason (config-grade
  protected path co-occurring with a destructive/overwrite operator, etc.)
  — reshapes friction into an explicit, reviewable stop rather than a
  dialog loop.

### orchestrator-tool-guard.js
- **Event:** `PreToolUse` (Read / Bash / Write / Edit / Agent's SendMessage
  path, when routed through PreToolUse)
- **Blocks:** the orchestrator tier drafting or touching files directly
  instead of delegating: a Read past a small line cap and a small
  per-session tally, an un-prefixed direct shell command, a Write outside
  the drafting tier's own sandbox (temp directory), and an Edit that
  reaches into this Claude Code installation's own governance/config tree
  (with one carved-out exception for a memory pointer file). This is the
  file most directly encoding "the orchestrator tier orchestrates; it does
  not draft."
- **Depends on:** `model-routing-guards.rules.js` (the per-tool
  allow/block rules) and `model-routing-guards.paths.js` (shared path
  resolution — sandbox root is `os.tmpdir()`, governance root is
  `path.join(os.homedir(), ".claude")`, both resolved at runtime).

### agent-permission-preflight.js
- **Event:** `PreToolUse` (Agent / SendMessage)
- **Blocks:** dispatching a subagent whose permission mode or settings
  would let it act outside the intended sandbox — including lint (f), an
  approximate check that a Write/Edit call's target is either covered by a
  bare tool-name grant or lands inside a sandbox root (`process.cwd()` plus
  whatever `local-policy.json` adds, plus `os.tmpdir()`).

### agent-adversary-floor.js
- **Event:** `PreToolUse` (Agent / SendMessage)
- **Blocks:** spawning a write-capable subagent (matcher, parser,
  validator, or gate work) whose prompt omits the required blind-spot
  framing — presence, not quality; see `docs/independence.md`. Certain
  tool/subagent types are exempt (`EXEMPT_TYPES`, cross-checked by
  `model-routing-guards.exempt.js`).

### agent-model-routing-guard.js
- **Event:** `PreToolUse` (Agent / SendMessage)
- **Blocks:** the Model Routing rule's `model`-declaration contract on
  EVERY `Agent`/`SendMessage` dispatch, orchestrator and subagent alike —
  no exceptions, no agent-id bypass:
  - `model` absent, or not resolving (via `local-policy.json`'s
    `model_tiers`, after the fold described above) to a configured tier,
    blocks unconditionally (`model_missing_or_invalid`).
  - `subagent_type: "fork"` is blocked before any other check
    (`fork_subagent_forbidden`) — a fork always runs on the parent
    session's model, so a declared `model` on it is inert and would let
    the orchestrator tier run inside a subagent undetected. Unicode
    invisible-character and combining-mark smuggling into `subagent_type`
    is stripped before this compare.
  - A dispatch resolving to the **planning** tier needs a standalone
    `PLAN-ONLY: no writes, no edits, no shell; return a plan only.` line
    (trailing period optional), unless `subagent_type` is one of a small
    pinned exempt list (`Explore`, `Plan`, `claude-code-guide`,
    `plugin-dev:plugin-validator`, `plugin-dev:skill-reviewer`) —
    cross-checked against `agent-adversary-floor.js`'s own live export;
    any drift between the two forces the exempt set to `[]` for that run
    (never widens it).
  - Every dispatch (Agent or SendMessage) needs a standalone
    `REPORT CAP: N words` line, `1 <= N <= 500`.
  - `REPORT CAP` / `PLAN-ONLY` / `RECIPIENT TIER` lines must each appear
    as a **bare standalone line**: optional leading whitespace only, no
    blockquote marker, no list marker, and not inside a fenced code block
    (CommonMark fence-open/close matching — an unclosed fence runs to the
    end of the text). Text is normalized first (CRLF/lone-CR -> LF, then
    per-line invisible-character strip) before any of these three lines
    are counted. **Zero** qualifying lines blocks; **two or more** also
    blocks, with a distinct `..._ambiguous` finding, rather than accepting
    the first or last match.
- **Known blind spot:** a homoglyph (a different-codepoint,
  visually-identical character) is not stripped by either normalization
  function and will not match `"fork"`, an `EXEMPT_TYPES` name, or any of
  the three bare-line markers. Documented, not fixed by this guard.
- **Depends on:** `hooks/lib/local-policy.js`'s `model_tiers` (the only
  place a real model-family literal exists on your machine),
  `model-routing-guards.exempt.js`, and `agent-tier-ledger.js` (below).

#### Per-agent tier ledger

`agent-tier-ledger.js` is a sibling module (not a hook entry point of its
own) that lets a `SendMessage` dispatch be checked against the tier its
recipient actually spawned with, instead of trusting a self-report.

- **Capture** happens across two additional hook registrations that share
  `agent-model-routing-guard.js`'s enforcement logic (via two thin shim
  entry points, `agent-model-routing-guard-posttooluse.js` and
  `agent-model-routing-guard-subagentstart.js` — see those files' header
  comments for why they're separate on-disk files rather than a second
  registration of the identical filename):
  - **`PostToolUse` (Agent):** once a dispatch is allowed at `PreToolUse`,
    a "pending" record (`tool_use_id`, raw model literal, resolved tier,
    `subagent_type`, `description`, `session_id`) is appended immediately.
    At `PostToolUse`, once `tool_response` is available, an "id" record
    (the spawned agent's id + display name, plus `rules_version`) is
    appended and joined to the pending record by `tool_use_id`.
  - **`SubagentStart`:** best-effort, NOT depended on — logs its payload's
    top-level keys once per session for future verification, and appends
    an id record too if `agent_id` and `tool_use_id` both happen to be
    present on it.
  - **Record shape (metadata only, exactly 9 fields):** agent id, display
    name, raw model literal, resolved tier, `subagent_type`,
    `description`, `session_id`, an ISO timestamp, and `rules_version`.
    NEVER a prompt body, a message body, or any tool result — hard rule,
    not a size-tuning choice.
  - **`rules_version`:** `"<guard version>:<hash-or-nopolicy>"` — the
    first 12 hex characters of a sha256 digest of the local-policy file's
    raw bytes, computed once, AT `PostToolUse` CAPTURE TIME — a distinct
    read from whatever `PreToolUse` read actually enforced the dispatch
    (accepted gap, not closed by this guard: see "Blind spots" in the PR
    description). `"nopolicy"` if no local-policy file exists at that
    moment.
- **Storage:** `hooks/state/agent-tier-ledger.<sanitized session_id>.jsonl`
  — one JSON object per line, appended via a single `O_APPEND` write per
  record. Capture writes only to the current session's own file; **lookup
  reads and merges every** `agent-tier-ledger.*.jsonl` file in the state
  directory, so a recipient spawned earlier or by another session on the
  same machine is still visible. Swept after 7 days, same as Hook 2's own
  ledger (`model-routing-guards.state.js`'s `cleanupOldStateFiles`,
  generalized in this PR to take a prefix/suffix), skipping any file
  touched in the last 60 seconds so a concurrent append can't race an
  unlink of an already-stale file (residual narrower race accepted, not
  closed).
- **Lookup (`SendMessage` `PreToolUse`):** strips/trims `to`, then matches,
  in order, exact agent id, exact display name, normalized display name,
  across the merged set. Total classification: non-string or
  blank-after-strip `to` → BLOCK (`recipient_invalid`); resolves to exactly
  one record whose tier is `planning` → message needs both a `PLAN-ONLY`
  and a `REPORT CAP` line; resolves to `drafting`/`mechanical` → `REPORT CAP`
  only; resolves to a record whose tier is present but not one of the
  three valid names → BLOCK (`ledger_record_tier_invalid`); ambiguous
  (2+ differing-tier matches) or no match at all → the **unknown branch**:
  `REPORT CAP` plus a declared standalone `RECIPIENT TIER: <tier>` line is
  required, and that declared tier's rules are enforced. **A resolved
  ledger record always overrides a declared `RECIPIENT TIER` line** — the
  declaration is a fallback for the unknown branch only. A missing
  declaration there → BLOCK (`recipient_tier_unknown`).

#### Capture verification pending

The exact field path of the spawned agent's id inside the `Agent` tool's
`PostToolUse` `tool_response` is **UNVERIFIED** as of this PR — the code
tries, in order, `tool_response.agentId`, `.agent_id`, `.id`, then (for a
string response, or any `content`/`text`/`result` string field) the regex
`/\bagentId:\s*([a-z0-9]{8,})/i`. If none resolve, capture logs one debug
line per session (the top-level keys of `tool_response` plus its first 300
characters — never a prompt/message body) and records nothing for that
dispatch; a later `SendMessage` to that recipient then falls to the
"unknown recipient" branch above, exactly as if no `Agent` dispatch had
ever been captured. To confirm the real field path in a fresh session:

1. Run `node scripts/install-guards.js` (writes your real
   `~/.claude/settings.json` — an owner action, not something this PR
   performs).
2. Dispatch one real `Agent` subagent with a valid `model`/tier, a
   `PLAN-ONLY` line if planning-tier, and a `REPORT CAP` line.
3. Read `~/.claude/hooks/agent-model-routing-guard-debug.log` — look for an
   `event: "ledger_capture_unresolved"` line (payload keys + first 300
   chars) if the id didn't resolve, or the absence of one if it did.
4. Check `~/.claude/hooks/state/agent-tier-ledger.<session>.jsonl` for a
   joined record (an `"id"`-kind line whose `agent_id` is populated) to
   confirm which field path actually worked.
5. Update this section and the spec once confirmed — this PR ships the
   defensive, logged-fallback design above specifically because that
   confirmation could not happen in this run.

### pr-independence.js
- **Event:** `PreToolUse` (Bash) — as a library, `scrubDataRegions` is also
  reused by `worktree-isolation-guard.js` to neutralize heredoc/quoted
  content before scanning a command for write targets.
- **Blocks:** a `gh pr review --approve` / `gh pr merge` (or API
  equivalent) run by the same agent identity that authored the PR —
  independence between author and approver/merger is structural, not a
  courtesy (see `docs/independence.md`).

### model-routing-guards.state.js / .unicode.js / .log.js / .exempt.js
Shared plumbing used by the guards above, not hooks in their own right:
- `state.js` — the per-session ledger (Read/Edit tallies) `rules.js` reads
  and writes; `cleanupOldStateFiles` also takes an optional
  prefix/suffix/min-age so `agent-tier-ledger.js` can reuse the same sweep
  for its own differently-named, differently-shaped ledger files.
- `unicode.js` — homoglyph/invisible-character-aware string normalization
  used before pattern matching, so a zero-width space or lookalike
  character can't slip a blocked phrase past a literal match. Exports both
  `stripNormalize` (full Cf/Cc/mark strip — fail-safe for a check that can
  only ever RESULT IN a block) and `stripInvisible` (Cf/Cc only, no marks,
  no case-fold — for a check that can RESULT IN an allow).
- `log.js` — the shared rotating-append debug logger every guard above
  calls into.
- `exempt.js` — drift detection between `agent-adversary-floor.js`'s
  `EXEMPT_TYPES` and its pinned expected value.
- `agent-tier-ledger.js` — the per-agent tier ledger `agent-model-routing-guard.js`
  reads and writes (capture, storage, lookup) — see that guard's own
  section above.

## Tests

Every `*.js` guard above ships with a matching `*.test.js` (or, for
`bash-classifier-bait-guard.js`, `test-bash-classifier-bait-guard.js`) in
this same directory, runnable with `npm test` from the repo root or
directly via `node hooks/<name>.test.js`.

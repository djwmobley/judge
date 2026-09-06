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
  "exempt_types": ["SomeToolName"]
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
  and writes.
- `unicode.js` — homoglyph/invisible-character-aware string normalization
  used before pattern matching, so a zero-width space or lookalike
  character can't slip a blocked phrase past a literal match.
- `log.js` — the shared rotating-append debug logger every guard above
  calls into.
- `exempt.js` — drift detection between `agent-adversary-floor.js`'s
  `EXEMPT_TYPES` and its pinned expected value.

## Tests

Every `*.js` guard above ships with a matching `*.test.js` (or, for
`bash-classifier-bait-guard.js`, `test-bash-classifier-bait-guard.js`) in
this same directory, runnable with `npm test` from the repo root or
directly via `node hooks/<name>.test.js`.

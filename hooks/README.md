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
- **Event:** `PreToolUse` (Bash / PowerShell)
- **Blocks:** a shell command that writes to a file through a redirect,
  `cp`/`mv`/`sed -i`/heredoc, etc., when the write target has a gated
  extension (default `.ps1`/`.psm1`/`.psd1`, overridable in
  `shell-write-guard.config.json`) or lands in a location a hook-gated
  editor tool would have linted. Shell writes skip the PostToolUse linter
  an Edit/Write call would have triggered — this guard is the backstop.
- **KNOWN_MIXED tier (`psql`/`sqlite3`/`mysql`):** these CLIs are neither
  pure reads nor pure writes — a documented, per-flag input/output split
  resolves each token to exactly one role instead of falling back to the
  generic unknown-verb scan. A file-role flag (`psql -f`/`--file`,
  `sqlite3 -init`) is never extension-gated (it's a read), but its
  argument is checked against a stdin-source denylist — `-`, `/dev/stdin`,
  `/dev/fd/*`, process substitution, a heredoc, or a here-string all
  FRICTION, naming the tempfile-canon alternative; a literal stdin
  redirect from a real file (`psql ... < file.sql`) allows. An inline-SQL
  flag (`psql -c`/`--command`, `sqlite3 -cmd`, `mysql -e`/`--execute`/
  `--init-command`) is FRICTION unconditionally and content-blind — this
  is what actually reproduced the incident shape this tier was built
  for. An output flag (`psql -o`/`-L`, `mysql --result-file`/
  `--tee`) resolves like `curl -o`. Every other token is BENIGN with a
  declared arity (including mysql's/psql's glued-only optional-argument
  flags, e.g. `-p`/`-C`) or a CONNECTION/positional slot up to the CLI's
  own limit — beyond that limit, or for any flag not in the CLI's table,
  the token is UNKNOWN and FRICTIONs by itself; it never falls through to
  the generic unknown-verb scan, so an unrelated unrecognized flag can
  never re-open an already-resolved file argument's extension check.
  Recognizes a wrapper hop (`docker exec`/`run`, `podman exec`/`run`,
  `ssh <host>`, `kubectl exec`, `sudo`, `env`, `wsl`, `cmd /c`\|`/k`,
  `nohup`, `time`, `xargs`) before dispatching — on both the Bash and the
  native-PowerShell path — and blocks outright if a recognized wrapper
  exhausts its own arguments with no inner command located. sqlite3's own
  flag surface beyond `-cmd`/`-init` is UNKNOWN by policy (its CLI
  reference could not be fetched from this environment) rather than
  guessed at with an unverified arity. See
  `docs/specs/shell-write-guard-mixed-cli-tier.md` for the full
  per-CLI tables and the two adversary rounds behind this design.
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
- **Event:** `PreToolUse` (Read / Bash / PowerShell / Write / Edit — its
  `main()` switches on exactly these five `tool_name` values; anything
  else reaching it, including `Agent`/`SendMessage`, hits the
  `unexpected_tool_name` block branch, so the matcher must never widen
  past this list).
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

- **Capture** happens at `PreToolUse` (the "pending" record) plus one
  additional hook registration that shares `agent-model-routing-guard.js`'s
  enforcement logic (via a thin shim entry point,
  `agent-model-routing-guard-subagentstart.js` — see that file's header
  comment for why it's a separate on-disk file rather than a second
  registration of the identical filename):
  - **`PreToolUse` (Agent):** once a dispatch is allowed, a "pending"
    record (`tool_use_id`, raw model literal, resolved tier,
    `subagent_type`, `description`, `session_id`) is appended immediately.
  - **`SubagentStart`:** appends the matching "id" record (the spawned
    agent's id, plus `rules_version`) from the event's top-level `agent_id`
    + `tool_use_id` fields, joined to the pending record by `tool_use_id`.
    Also logs the payload's top-level keys once per session for future
    reference. Still best-effort in the sense that a harness version whose
    `SubagentStart` payload lacks either field simply records nothing for
    that dispatch (falls to the "unknown recipient" branch below) — but it
    is, as of 2026-09-06, the sole capture path (see "Capture verified"
    below).
  - **Record shape (metadata only, exactly 9 fields):** agent id, display
    name, raw model literal, resolved tier, `subagent_type`,
    `description`, `session_id`, an ISO timestamp, and `rules_version`.
    NEVER a prompt body, a message body, or any tool result — hard rule,
    not a size-tuning choice.
  - **`rules_version`:** `"<guard version>:<hash-or-nopolicy>"` — the
    first 12 hex characters of a sha256 digest of the local-policy file's
    raw bytes, computed once, AT `SubagentStart` CAPTURE TIME — a distinct
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

#### Capture verified

The field path of the spawned agent's id was confirmed live on 2026-09-06,
in a session with the ledger shims installed at user scope: 6 `Agent`
dispatches were run, and the ledger state file received exactly 6 "id"
records — one per dispatch, each with `tool_use_id` and `agent_id`
populated. The debug log showed exactly one `subagent_start_payload_keys`
event (top-level keys `["session_id","transcript_path","cwd",
"scratchpad_dir","prompt_id","agent_id","agent_type","hook_event_name"]`,
plus `tool_use_id` on the payloads that actually joined — the debug line
itself only fires once per session, so it does not by itself enumerate
every dispatch's exact shape) and zero `ledger_capture_unresolved` events.

**Verified path:** the `SubagentStart` handler's top-level `agent_id` +
`tool_use_id` fields (`handleSubagentStart` in
`agent-model-routing-guard.js`) is the capture path — no `tool_response`
involved.

**What this ruled out, and what was removed:** PR 2 also shipped a
`PostToolUse` (Agent) registration carrying an unverified fallback chain
(`tool_response.agentId` / `.agent_id` / `.id` / a regex over
`content`/`text`/`result` strings), for the case where the field path
above turned out not to work. `agent-tier-ledger.js`'s `appendIdRecord`
never dedupes or skips — every call unconditionally appends a line — so
if that fallback had also resolved and appended across the same 6
dispatches, the state file would show 12 "id" lines, not 6; and if it had
failed to resolve even once, `ledger_capture_unresolved` would have logged
(also once per session, same debug-line convention). Neither happened, so
the fallback path never fired its append branch in this session. Since
resolving the spawned agent's id was that registration's only job, it was
removed rather than kept as an unexercised fallback:
- `hooks/agent-model-routing-guard-posttooluse.js` (the shim entry point)
- `handlePostToolUseAgent()` and the `PostToolUse` branch in `main()` in
  `agent-model-routing-guard.js`
- `resolveAgentIdFromToolResponse()`, `AGENT_ID_FROM_TEXT_RE`,
  `topLevelKeys()`, and `summarizeUnresolved()` in `agent-tier-ledger.js`
- The `agent-model-routing-guard-ledger` / `PostToolUse` / `Agent` entry in
  `scripts/install-guards.js`'s `GUARDS` array
- The PostToolUse-shaped capture helper and its dedicated test in
  `agent-model-routing-guard.test.js`, replaced with a `SubagentStart`-
  shaped equivalent

### pr-independence.js
- **Event:** `PreToolUse` (Bash) — as a library, `scrubDataRegions` is also
  reused by `worktree-isolation-guard.js` to neutralize heredoc/quoted
  content before scanning a command for write targets.
- **Blocks:** a `gh pr review --approve` / `gh pr merge` (or API
  equivalent) run by the same agent identity that authored the PR —
  independence between author and approver/merger is structural, not a
  courtesy (see `docs/independence.md`).

### stop-stale-worktrees-guard.js
- **Event:** `Stop` (registered with an explicit **30-second timeout** —
  see `scripts/install-guards.js`'s `GUARDS` entry — 10s of margin over
  this guard's own internal 20s classification deadline).
- **Blocks:** the session from ending while the repo containing the
  resolved project directory has a stale linked worktree, a stale local
  branch, or a stale remote-tracking ref on the base's own remote.
  Resolves the target directory via `CLAUDE_PROJECT_DIR`, then stdin
  `cwd`, then `process.cwd()` — never a raw, unvalidated `cwd` alone.
- **Active-worktree override (spec §15/§16), evaluated before ANY branch
  or worktree classification:** for every worktree (primary or linked)
  with a checked-out branch, that branch is forced to `active` (never
  reaching the stale rows below) if the worktree is dirty
  (`git status --porcelain`), has a commit not yet integrated into base
  (same ancestor/tree-equality/cherry detectors the branch table uses,
  not a bare `rev-list --count`), or its `logs/HEAD` reflog /
  `COMMIT_EDITMSG` was touched within a quiet window (default 30 min,
  `JUDGE_STOP_GUARD_QUIET_MINUTES`, `0` disables the recency signal only).
  Such worktrees surface one informational `systemMessage` line each
  ("active worktree on merged branch `<name>`; clean up when done")
  instead of blocking — a clean, quiet, behind/merged worktree still
  blocks as before, primary worktrees still lead their fix with
  `git checkout <base>`.
- **Worktree classes:** `ok` (on the base branch, or not prunable/dir
  exists/branch active), `stale` (prunable, missing directory, or a
  `git worktree prune --dry-run` hit — fix leads with `git worktree
  unlock` if locked, then `remove`/`prune`; or a linked worktree whose
  checked-out branch itself classifies stale — combined fix, extended
  with a grouped remote-ref fix when that branch also tracks a stale
  base-remote ref), `unknown` (detached HEAD with no in-progress marker —
  no fix offered), and `in-progress-operation` (primary worktree only,
  detached HEAD with a
  `rebase-merge`/`rebase-apply`/`MERGE_HEAD`/`CHERRY_PICK_HEAD`/
  `BISECT_START`/`REVERT_HEAD` marker present — allows with a naming
  `systemMessage` instead of blocking a mid-flight handoff).
- **Branch classes (first match wins):** `ok` (is the base branch, or tip
  equals base with no upstream — `empty-local`, never targeted for
  deletion — or tip equals base with a live, non-gone upstream), `stale`
  (gone upstream `[gone]`; local tip is an ancestor of base; local tip's
  tree matches one of the base's last 500 commit trees; `git cherry`
  reports every local commit already applied; or none of those fire on
  the LOCAL tip but the branch's own UPSTREAM ref's cached tip
  independently matches one of the same three detectors — catches a
  branch reset to base after a squash-merge whose remote copy still holds
  the pre-reset history), and `active` (none of the above). Ancestor-stale
  branches get a `-d` fix (git can verify these itself); every other stale
  row leads with `-D` plus an inline comment, and the upstream-tip row
  adds an operator-confirmed `git push origin --delete` line on its own.
  If the checked-out branch classifies stale, its fix leads with
  `git checkout <base>` (§16 extends this to the primary worktree
  specifically — a linked worktree's own combined fix already handles it).
- **Remote-tracking classes (spec §3/§13, first match wins, same three
  detectors as the branch table):** every `refs/remotes/*` ref except
  `<remote>/HEAD` (a structural name-suffix match, regardless of symref
  status) and the ref the base branch tracks classifies `stale-remote`
  (merged into base, on the base's OWN remote — blocks; fix: `fetch
  --prune`, re-verify, `push --delete`, then `branch -dr` as a fallback if
  the delete is refused, then the local branch's own delete if one tracks
  it and is itself stale), `stale-remote-foreign` (merged into base, on
  any OTHER remote, or when no base remote is determinable — allows with
  an informational `systemMessage`, never blocks: the operator has no
  standing to delete another remote's branch), `unknown` (any git call
  fails, including a ref pointing at a missing object), or `active-remote`
  (none of the above). An atomically-failing batched enumeration (one bad
  object blacks out the whole `for-each-ref refs/remotes` call) falls back
  to a reduced-format `for-each-ref` (refname+objectname only) plus
  per-ref `rev-parse --verify`, isolating the bad ref instead of hiding
  every sibling. Never fetches; a server-side delete not yet locally
  pruned still shows stale until `fetch --prune` runs.
- **Deadline:** a 20-second internal wall-clock budget from hook start,
  checked between steps and enforced again via a per-call `timeout` on
  every individual git subprocess (sized to whatever budget remains when
  that call is spawned) — either expiry is a block naming what was and
  wasn't classified yet, never a silent allow. Git calls are batched
  (`for-each-ref` once, the base's candidate tree set once) rather than
  issued per branch; `merge-base --is-ancestor` and, only when still
  unresolved, `git cherry` remain per-branch.
- **Bypass:** `JUDGE_STOP_GUARD=off`, read from the hook process's own
  inherited environment — allows with a `systemMessage` stating the
  bypass is active. **Accepted blind spot:** an agent with write access to
  `.claude/settings.json` could add this to its `env` block itself,
  indistinguishable from a genuine operator-set variable once inherited;
  closing that needs a separate guard restricting writes to that file,
  out of scope here.
- **Other declared blind spots** (see the guard's own header and
  `docs/specs/stop-stale-worktrees-guard.md` §8 for the full list): a
  squash-merge whose matching base commit falls outside the 500-commit
  window misclassifies as active; one trivial extra commit on top of
  already-squash-merged content defeats the tree-equality/cherry
  detectors by design (this guard's threat model is a forgetful agent,
  not an adversarial one); a repo with very many never-merged branches can
  still exhaust the 20s deadline on every Stop call (only the global
  bypass escapes that, disabling ALL staleness detection, not just the
  expensive path); classification is entirely local-ref-based and never
  runs `git fetch`; a resolved `main`/`master` (including via
  `origin/HEAD`) is never verified against the team's actual live
  integration branch, including the fork-workflow variant where `origin`
  is the contributor's own fork; and a linked worktree that is itself
  mid-rebase/mid-cherry-pick gets no special treatment (that allowance is
  primary-worktree-only) and still falls to the ordinary
  linked-detached-HEAD `unknown` row. Additionally (spec §8/§15): a
  misidentified base remote now shapes the stale-remote/foreign split
  rather than just a wrong base branch; `refs/heads`'s own atomically-
  failing `for-each-ref` has no fallback (only `refs/remotes` got one); and
  the active-worktree carve-out's own accepted gaps — a stray untracked
  file keeps a worktree "active" forever (condition (a), no decay,
  operator-named as expected), and a genuinely quiet, clean, behind/merged
  worktree becoming stale-eligible after the quiet window elapses is this
  feature's intended terminal behavior, not a defect.

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

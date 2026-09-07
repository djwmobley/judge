# Spec: `hook-state-write-guard` — closing the forgeable-state-file gap

*Draft, not yet implemented or adversaried. Addresses the accepted-not-closed
gap in `docs/specs/stop-guard-bounded-reblock.md` §2 item 3 / §6 (first
bullet) / §9 BR-01: an agent with ordinary file access to `<hooks
dir>/state/` can read the Stop guard's own strike-counter state and write a
forged record to force a premature yield. This spec closes that gap in two
independent layers — a write-denial PreToolUse gate and a tamper-evident
MAC on the state file itself — for whichever layer any given write path
manages to reach.*

## 1. Threat

The bounded-reblock layer (`applyBoundedReblock`,
`hooks/stop-stale-worktrees-guard.js:1450-1605`) persists per-item strike
counts at `<hooks dir>/state/stop-stale-worktrees-guard.<sanitized
session_id>.json`. An item that accumulates 3 strikes stops blocking and is
instead yielded (spec ref: `docs/specs/stop-guard-bounded-reblock.md:56-65`,
§3 step 6). The agent whose Stop event this guard gates has the *same* file
permissions the guard process itself runs with — nothing about the harness
gives the guard a privileged write surface the agent lacks. An agent that
wants to end its turn despite a genuinely unresolved stale worktree can
therefore write (or overwrite) that session's state file directly —
`{"items": {"worktree:/path/to/stale-wt": {"strikes": 3, ...}}}` — and the
next Stop invocation reads a pre-exhausted item and allows immediately,
skipping every intermediate block the guard exists to enforce (spec ref:
`docs/specs/stop-guard-bounded-reblock.md:310-315`).

This is a forgery of *guard-internal accounting state*, not a forgery of the
underlying git facts the guard reasons from (worktree/branch/remote
classification is re-derived from real `git` output every invocation and is
not touched by this spec). Two independent layers close it:

- **Layer 1 (this spec §2):** deny the write at the tool-call boundary,
  before the forged bytes ever reach disk — covers every write path this
  repo's own hooks already model (Write/Edit/NotebookEdit/MultiEdit,
  Bash, PowerShell).
- **Layer 2 (this spec §3):** if a write to the state file happens anyway
  (a tool this repo doesn't gate, an MCP filesystem write, direct
  filesystem access outside any tool call) make the forgery *detectable*
  rather than silently trusted — an unsigned or wrong-signed state file is
  treated as absent, which can only ever *delay* a yield, never grant one.

Neither layer is complete alone (see §6); together they cover every write
surface this repo's hook framework can observe, and fail toward the same
safe direction (delay, not grant) when a write does slip through.

## 2. Layer 1 — write denial (PreToolUse)

### 2.1 Protected directory

The protected directory is **the guard's own `STATE_DIR`** — the exported
constant from `hooks/model-routing-guards.state.js:35`,
`path.join(__dirname, "state")` where `__dirname` is that file's own
install location. Both new/changed files in this spec (§2.2, §2.3) import
`STATE_DIR` from that module rather than re-deriving
`path.join(__dirname, "state")` independently in three places — a single
source of truth, matching how `stop-stale-worktrees-guard.js` itself
already imports it (line 80) instead of recomputing it. This also means the
protected path tracks whichever copy is actually running: `hooks/state`
inside a repo checkout (what this spec's own test suite exercises) and
`~/.claude/hooks/state` in an installed tree (what a real session runs
against) — never a hardcoded `~/.claude/hooks` literal, which would protect
only the installed copy and leave the in-repo test fixtures unprotected by
the very code the tests are meant to validate.

### 2.2 New hook: `hooks/hook-state-write-guard.js`

PreToolUse, matcher `Write|Edit|NotebookEdit|MultiEdit`.

**Path-parameter extraction, per tool** (Claude Code's own `tool_input`
shapes — Write/Edit/MultiEdit key the target as `file_path`; NotebookEdit
keys it as `notebook_path`; a hook that only checked `file_path` would
silently let every NotebookEdit call through unclassified):

| `tool_name` | path param |
|---|---|
| `Write` | `tool_input.file_path` |
| `Edit` | `tool_input.file_path` |
| `MultiEdit` | `tool_input.file_path` |
| `NotebookEdit` | `tool_input.notebook_path` |

**Resolution:** absolute-ify (`path.resolve(cwd, raw)` when relative, `cwd`
from the hook's own stdin `cwd` field, matching
`worktree-isolation-guard.js`'s own convention), then normalize via that
same file's exported `normalizeForCompare` (backslash → forward slash,
MSYS `/c/...` → `c:/...` rewrite, full lowercase — Windows is
case-insensitive end-to-end, same rationale that function's own header
already states) — reused directly, not reimplemented, per this repo's
existing reuse-provenance convention (`shell-write-guard.js`'s own header
comment models this exact pattern for its own reused functions).
`path.resolve` already collapses `..` segments lexically before
normalization runs, so `hooks/state/../state/x.json` normalizes identically
to `hooks/state/x.json` — no `fs.realpathSync` needed for the traversal
case specifically (a symlink-based escape is a separate, declared blind
spot — §6).

**Containment check:** normalized target `===` normalized `STATE_DIR`, OR
normalized target starts with normalized `STATE_DIR + "/"` (the trailing
separator is required in the comparison so `hooks/state-backup/x.json`
cannot false-positive against a bare-prefix match on `hooks/state`).

**Total classification** (every PreToolUse call this hook's matcher can
ever receive lands in exactly one branch):

| # | Condition | Branch |
|---|---|---|
| 1 | `tool_name` not one of the four gated tools (defensive — the matcher already excludes this in practice; kept as an explicit branch for a standalone/manual invocation) | allow |
| 2 | Path param present, non-empty string, resolves outside `STATE_DIR` | allow |
| 3 | Path param present, non-empty string, resolves inside `STATE_DIR` | **DENY** — message names the protected directory literally |
| 4 | Path param missing, not a string, empty after trim, or resolution throws (malformed absolute/relative shape) | **DENY** — friction-over-escape default; an agent cannot make this hook fall through to allow by supplying a param shape the extractor can't parse |

Deny output matches this repo's existing PreToolUse-deny convention
(`worktree-isolation-guard.js:1129-1137`, `shell-write-guard.js:2969-2978`):
exit code 2, message on stderr. No `SHELL_WRITE_OK=1`-style override exists
for this hook — unlike `shell-write-guard.js`'s gated-extension friction
(which exists to route *legitimate* `.ps1` writes through the linter and
has a documented escape hatch for that), there is no legitimate reason for
an agent's own tool call to write inside the guard's own accounting state,
so this hook has no override string at all, by design.

### 2.3 Extension: `hooks/shell-write-guard.js` PROTECTED_PATH rule

Bash/PowerShell writes reach the state directory through the *same* target
resolution machinery `shell-write-guard.js` already runs (`resolveTarget`,
verb dispatch, `analyzeBash`/`analyzePowerShell`) — this spec does not add
a second parser pass. It adds one new priority check inside the existing
pipeline, at two points:

**(a) Inside `resolveTarget` itself** (`hooks/shell-write-guard.js:245-269`)
— immediately after path resolution and normalization, **before**
`classifyExtension` is even called (this is the literal sense in which the
rule "runs before tier classification": within the one function every
write-target resolution already funnels through, the protected-directory
check is checked first, ahead of the gated-extension tier logic):

```
if (containedIn(normalized, STATE_DIR)) {
  return { branch: 5, reason: "protected-state-dir", target: normalized };
}
```

Branch **5** is a new, strictly-higher-severity value than the existing
1-4 (shell-write-guard.js's own header comment, lines 15-21, currently
documents branches 1-4 as the complete total classification — this spec
requires that comment be extended to state 5 explicitly, keeping the
"total classification, never an allow-list" invariant honest). Because
`pickWorst`/`consider` (used throughout `analyzeBash`/`analyzePowerShell`)
select the numerically highest branch across every detector hit in a
command, a single branch-5 finding anywhere in a multi-stage command
(`cp a.txt b.ps1; cp c.txt hooks/state/x.json`) dominates the final result
without any change to that selection logic — this is why routing the new
check through `resolveTarget` (the one shared primitive) is sufficient
rather than threading a separate protected-path pass through every
per-verb handler individually.

**(b) In `classifyCommand`** (`hooks/shell-write-guard.js:2879-2884`) — two
changes, both load-bearing:

1. **Override reordering.** The `SHELL_WRITE_OK=1` override currently
   short-circuits to allow *before* classification ever runs
   (`OVERRIDE_RE.test(cmd)` is checked first). This spec requires
   classification to run *first* in every case, with the override consulted
   only as a *downgrade* — and only when the resulting branch is `<= 4`.
   A branch-5 result is never eligible for the override, regardless of
   what string prefixes the command. This is a deliberate, explicit design
   choice, not an oversight: the override exists to unblock *legitimate*
   friction (a real `.ps1` write an agent has a reason to make directly),
   and this spec's entire premise is that there is no legitimate reason for
   an agent's own shell command to write inside the guard's own accounting
   state — an override that could suppress branch 5 would just be a second,
   one-token forgery vector (`SHELL_WRITE_OK=1 cp forged.json
   hooks/state/x.json`) replacing the first.
2. **Raw-text fallback for unresolvable targets.** If classification's own
   result is exactly branch 4 (the existing "write-shaped but the target is
   ambiguous/dynamic and cannot be resolved to a literal path" bucket —
   e.g. a variable-assembled destination) **and** the raw, unmodified `cmd`
   string contains a case-insensitive `hooks/state` or `hooks\state`
   substring, upgrade the result to branch 5 before the override check in
   (1) runs. This catches the shape the task spec calls out explicitly: a
   command whose target `resolveTarget` cannot pin down as a literal path,
   but whose *source text* still names the protected directory verbatim
   (`STATEDIR=hooks/state; cp forged.json "$STATEDIR/x.json"` — the
   interpolated target is unresolvable to `resolveTarget`, but the literal
   substring `hooks/state` is present in the command text itself). A
   dynamic target assembled with **no** literal substring anywhere in the
   command text (e.g. built entirely from `$(dirname "$0")`-style
   indirection with no `hooks/state` text at all) is **not** caught by
   this fallback and remains branch 4, ordinary friction, override-eligible
   — declared blind spot, §6.

**Total classification, this layer, combined with §2.3's existing branches
1-4** (every Bash/PowerShell command lands in exactly one row):

| Row | Write-shaped? | Target resolvable? | Resolves inside `STATE_DIR`? | Raw text contains `hooks/state`? | Result |
|---|---|---|---|---|---|
| 1 | no (read verb, or no write signal at all) | — | — | — | branch 1, allow (unchanged) |
| 2 | yes | yes | no | — | branch 2 or 3 per existing gated-extension rule (unchanged) |
| 3 | yes | yes | **yes** | — | **branch 5, deny, override never applies** |
| 4 | yes | no (ambiguous/dynamic) | — | no | branch 4, ordinary friction (unchanged; override still applies) |
| 5 | yes | no (ambiguous/dynamic) | — | **yes** | **branch 5, deny, override never applies** |

`main()`'s output branch (`hooks/shell-write-guard.js:2969-2978`) gains a
distinct message for branch 5 — naming the protected state directory and
explicitly stating the override does not apply here, rather than reusing
the generic "gated extension… Override: prefix `SHELL_WRITE_OK=1`" text,
so an agent hitting this path understands it is categorically different
from ordinary `.ps1`-write friction rather than retrying with the override
token.

## 3. Layer 2 — tamper evidence (`stop-stale-worktrees-guard.js`)

Layer 1 covers every write path this repo's hook framework can observe.
Layer 2 assumes Layer 1 was bypassed or doesn't apply (§6) and makes the
resulting forgery detectable rather than silently authoritative.

### 3.1 Keyfile

`<state dir>/.hmac-key` — 32 bytes from `crypto.randomBytes(32)`, created
on first use if absent (an existence check followed by a create-if-missing
write; a benign race between two concurrent first-run processes both
generating a key is resolved by whichever `renameSync`/exclusive-create
wins, matching this file's existing atomic-write convention — the loser's
generated bytes are simply discarded). Written with `{ mode: 0o600 }` where
the platform honors POSIX modes (best-effort; Windows ACLs don't map onto
this cleanly and the call is not expected to meaningfully restrict access
there — declared blind spot, §6). The keyfile itself lives inside
`STATE_DIR` and is therefore already covered by Layer 1's containment
check for any *tool-mediated* write or read attempt — no special-casing
needed in Layer 1 for it.

**Keyfile unavailable (create/read failure, any reason):** the layer fails
*closed*, not open. If the guard cannot obtain the key, it cannot compute or
verify a MAC for this invocation — rather than falling back to trusting an
unverified state file's `strikes` values (which would silently reopen the
exact gap this layer exists to close), the guard treats the state as
unverifiable and therefore **absent** for this invocation, identically to
a MAC mismatch (§3.3). This is the same safe-direction principle the base
spec already applies throughout `docs/specs/stop-guard-bounded-reblock.md`
§3 step 2: any failure to positively verify prior progress can only *delay*
a yield, never accelerate one.

### 3.2 Canonical serialization and MAC

`mac` is computed over the state object's `items` field only (not the
whole state object — `session_id`/timestamps are metadata, not accounting
state an agent gains anything by forging independently of `items`).

**Canonical form**, precisely:

1. `Object.keys(items).sort()` — default JS string comparison (UTF-16 code
   unit order) is the sort comparator; this is a deterministic, total
   order over any set of item keys this file ever produces (item keys are
   ASCII `kind:normalizedIdentity` strings — see the base spec §3 — so
   locale-independent code-unit ordering never actually diverges from any
   other reasonable string order for this specific key shape, but the
   comparator itself is what's canonical, not an assumption about the
   input).
2. For each item key, its value object's own keys (`kind`, `identity`,
   `strikes`, `first_block_at`, `last_block_at`) are likewise re-inserted
   in `Array.prototype.sort()` order into a fresh object — JS objects with
   all-string keys preserve insertion order, so rebuilding each object with
   sorted-order insertion is sufficient; no custom serializer is needed.
3. `JSON.stringify(canonicalObj)` — `JSON.stringify`'s own default output
   already contains no inter-token whitespace, so no separate
   whitespace-stripping step is needed once the key order is canonical.
4. `mac = crypto.createHmac("sha256", keyBytes).update(canonicalJson,
   "utf8").digest("hex")`.

This `mac` value is added to the state object (alongside the existing
`session_id`/`stop_hook_active_last`/`created_at`/`updated_at`/`items`
fields) immediately before `writeReblockStateAtomic` serializes and writes
it — computed fresh on every write, over that write's own post-increment
`items`.

### 3.3 Verification on read

`readReblockState` (`hooks/stop-stale-worktrees-guard.js:1385-1396`) gains
a verification step, inserted after the existing shape checks (object body,
object `items`) and before the parsed object is returned as "present":

- **File does not exist, or fails to parse/shape-check** (the function's
  existing behavior, unchanged): return `{ items: {} }`. **Not** a tamper
  event — this is the ordinary first-run / corrupt-JSON case the base spec
  already treats as safe-direction absence, and logging every first run as
  a "tamper" would make the tamper log noise, not signal.
- **File parses, shapes correctly, but `mac` is missing, OR the mac
  recomputed from its own `items` (per §3.2) using the current keyfile does
  not equal the stored `mac`:** treat identically to "absent"
  (`{ items: {} }`, so every item's strikes restart at 0 for this
  invocation — this can only *delay* a yield, per the same principle
  §2 item 3 of the base spec already states for ordinary corruption), **and**
  append one line to the existing yields log
  (`REBLOCK_YIELD_LOG_PATH`, same file the base spec's §5 already defines,
  not a new log): `{"event":"tamper","session":"<session_id>","ts":"<ISO
  8601>"}` — best-effort, same swallow-on-failure convention
  `appendYieldLogLine` already uses (a failure to log the tamper detection
  never blocks or alters the already-decided reset-to-absent outcome).
- **File parses, shapes correctly, `mac` present and matches:** return the
  parsed state as-is (existing behavior).

**Backward compatibility, stated explicitly (required by task, not
optional):** a state file written by any pre-this-change install has no
`mac` field at all. Such a file is **treated as tampered** — missing `mac`
takes the identical code path as a mismatched `mac` (both fall into the
second bullet above), including the tamper-log append. Every session whose
state file predates this change starts its next Stop invocation with every
item's strikes reset to 0. This is a one-time, session-scoped reset per
pre-existing state file (once the guard rewrites it with a real `mac` on
that invocation's own write, subsequent reads of that same file verify
cleanly) — never a permanent loss of accounting, and consistent with the
base spec's own "a reset can only delay, never grant" invariant.

## 4. Test outline

`node:test`, direct calls against exported functions with injected
`fs`/`now`/`stateDir`, mirroring this repo's existing convention for both
`shell-write-guard.js` and `stop-stale-worktrees-guard.js`'s own suites —
no new test infrastructure needed.

**Layer 1 — `hook-state-write-guard.js` (new suite):**

| Test | Input | Expected |
|---|---|---|
| `write_inside_state_dir_denied` | `Write`, `file_path: "<hooks>/state/stop-stale-worktrees-guard.abc.json"` | deny, message names `STATE_DIR` |
| `write_inside_state_dir_backslash_denied` | same, Windows-style `\` separators | deny (normalization) |
| `write_state_dir_dotdot_traversal_denied` | `file_path: "<hooks>/state/../state/x.json"` | deny (lexical `..` collapse) |
| `write_state_dir_case_variant_denied` | `file_path` with mixed-case `STATE`/`State` segment | deny (case-fold) |
| `write_relative_path_into_state_dir_denied` | `Edit`, relative `file_path` + `cwd` that resolves inside `STATE_DIR` | deny |
| `notebookedit_notebook_path_inside_state_dir_denied` | `NotebookEdit`, `notebook_path` inside `STATE_DIR` | deny |
| `multiedit_inside_state_dir_denied` | `MultiEdit`, `file_path` inside `STATE_DIR` | deny |
| `write_sibling_dir_name_prefix_allowed` | `file_path` inside `<hooks>/state-backup/` (prefix, not containment) | allow |
| `write_outside_state_dir_allowed` | ordinary project-file `file_path` | allow |
| `write_missing_file_path_param_denied` | `tool_input: {}` | deny (branch 4, friction default) |
| `write_empty_file_path_denied` | `file_path: ""` | deny |
| `read_tool_never_matched` | `Read` tool call (not in this hook's matcher at all) | not invoked / allow — hook framework never dispatches |

**Layer 1 — `shell-write-guard.js` PROTECTED_PATH extension:**

| Test | Input | Expected |
|---|---|---|
| `bash_cp_into_state_dir_denied` | `cp forged.json hooks/state/stop-stale-worktrees-guard.abc.json` | branch 5 deny |
| `bash_tee_into_state_dir_denied` | `tee hooks/state/x.json <<< '{}'` (or `tee` with a literal state-dir arg) | branch 5 deny |
| `bash_redirect_gt_into_state_dir_denied` | `echo '{}' > hooks/state/x.json` | branch 5 deny |
| `bash_redirect_append_into_state_dir_denied` | `echo '{}' >> hooks/state/x.json` | branch 5 deny |
| `bash_backslash_path_into_state_dir_denied` | `cp forged.json hooks\state\x.json` (Windows-style separator in an otherwise-POSIX command) | branch 5 deny |
| `bash_quoted_target_into_state_dir_denied` | `cp forged.json "hooks/state/x.json"` | branch 5 deny |
| `powershell_set_content_into_state_dir_denied` | `Set-Content -Path hooks/state/x.json -Value '{}'` | branch 5 deny |
| `powershell_out_file_into_state_dir_denied` | `'{}' \| Out-File hooks/state/x.json` | branch 5 deny |
| `powershell_redirect_into_state_dir_denied` | `'{}' > hooks/state/x.json` | branch 5 deny |
| `override_does_not_suppress_state_dir_write` | `SHELL_WRITE_OK=1 cp forged.json hooks/state/x.json` | **still branch 5 deny** (override reordering, §2.3(b)(1)) |
| `override_still_suppresses_ordinary_gated_ext_write` | `SHELL_WRITE_OK=1 cp x.ps1 y.ps1` (no state-dir involvement) | allow (existing override behavior, unchanged) |
| `dotdot_traversal_into_state_dir_denied` | `cp forged.json hooks/state/../state/x.json` | branch 5 deny |
| `unresolvable_target_with_literal_hooks_state_text_denied` | `STATEDIR=hooks/state; cp forged.json "$STATEDIR/x.json"` | branch 5 deny (raw-text fallback, §2.3(b)(2)) |
| `unresolvable_target_no_literal_text_stays_branch4` | fully variable-assembled target with **no** `hooks/state` substring anywhere in the command | branch 4, ordinary friction (declared blind spot, not this test's concern to close) |
| `cat_state_dir_file_allowed` | `cat hooks/state/stop-stale-worktrees-guard.abc.json` | allow (branch 1, read verb, never reaches `resolveTarget`) |
| `grep_state_dir_allowed` | `grep strikes hooks/state/*.json` | allow |
| `sibling_dir_name_prefix_allowed` | `cp x.txt hooks/state-backup/y.txt` | allow (prefix boundary, not containment) |
| `write_outside_state_dir_unaffected` | ordinary `cp a.txt b.ps1` (no state dir) | existing branch 2/3 behavior, unchanged |

**Layer 2 — `stop-stale-worktrees-guard.js` MAC:**

| Test | Input | Expected |
|---|---|---|
| `mac_written_on_every_state_write` | one ordinary block-then-write cycle | written state file's `mac` field present and equals the recomputed HMAC over its own `items` |
| `mac_verifies_on_normal_read` | write, then read via the same key | state returned as-is, no tamper log line |
| `forged_state_missing_mac_treated_as_absent` | a hand-written state file with `items: {"worktree:x": {"strikes": 3, ...}}` and no `mac` field | `readReblockState` returns `{ items: {} }`; one tamper log line appended |
| `forged_state_wrong_mac_treated_as_absent` | a hand-written state file with a `mac` value that doesn't match its own `items` | same as above |
| `pre_change_state_file_no_mac_field_treated_as_tampered` | a state file shaped exactly like the pre-this-spec format (no `mac` key at all) | same as above — explicit backward-compat case |
| `tamper_reset_only_delays_never_grants` | forged `strikes: 3` state, one real stale item present | Stop invocation still **blocks** (strikes reset to 0, item re-blocks from scratch) — never allows on the forged value |
| `keyfile_created_on_first_run` | fresh state dir, no `.hmac-key` | keyfile created, 32 bytes, present on disk after the run |
| `keyfile_reused_across_runs` | keyfile already present | second run's `mac` verifies against the first run's keyfile (same key, not regenerated) |
| `keyfile_unreadable_fails_closed` | injected `fs.readFileSync`/creation throwing for the keyfile path | state treated as absent for this invocation (fails closed, not open) |
| `tamper_log_line_well_formed` | one forged-state read | exactly one JSON line appended with `event`, `session`, `ts` fields |
| `ordinary_first_run_not_logged_as_tamper` | no state file exists at all yet | zero tamper log lines appended (missing-file is not a tamper signal) |

## 5. Rollout

Both the repo copy (`hooks/hook-state-write-guard.js`,
`hooks/shell-write-guard.js`, `hooks/stop-stale-worktrees-guard.js`) and
the installed copy under `~/.claude/hooks/` must change together — this
repo has no live-patching mechanism; an installed copy is a byte-for-byte
snapshot made by `scripts/install-guards.js` at install time (per that
file's own header: "Copies this repo's hooks/*.js guards … to
~/.claude/hooks/"). Shipping this spec without re-running the installer
leaves a real session running the pre-this-spec, forgeable behavior
indefinitely.

**Installer wiring required, concretely** (verified by reading
`scripts/install-guards.js`'s `GUARDS` registry, lines 62-128, and its own
header comment, lines 3-13): the installer has **no auto-discovery** of new
hook files. It walks a fixed, hand-maintained `GUARDS` array; a `.js` file
dropped into `hooks/` with no corresponding entry is never copied to
`~/.claude/hooks/` and never wired into `settings.json`, regardless of its
filename or matcher-shaped intent. `hook-state-write-guard.js` is a
**brand-new file**, so it requires a **new `GUARDS` entry**:

```js
{ id: 'hook-state-write-guard', file: 'hook-state-write-guard.js',
  event: 'PreToolUse', matcher: 'Write|Edit|NotebookEdit|MultiEdit' },
```

added to that array before the next `install-guards.js` run — omitting
this step means the new hook file sits in the repo, is exercised by its own
test suite, and does *nothing* in any real installed session. This is not
optional follow-up; it is the mechanism by which Layer 1's new-hook half
actually takes effect.

By contrast, the `shell-write-guard.js` and `stop-stale-worktrees-guard.js`
changes (§2.3, §3) are **edits to already-registered guard files** —
`shell-write-guard` (line 64) and `stop-stale-worktrees-guard` (lines
121-127) both already have `GUARDS` entries, so those two files' changes
take effect on the next ordinary `install-guards.js` run with no registry
change required, the same way any other in-place edit to an existing guard
file already does.

## 6. Blind spots

What this spec's two layers, together, **cannot** detect or prevent:

- **Reading the keyfile and minting a valid MAC.** An agent with ordinary
  file-read access to `<state dir>/.hmac-key` (via the `Read` tool, `cat`,
  `Get-Content` — none of which Layer 1 gates, since reads are explicitly
  out of scope for a *write*-denial layer) can read the 32-byte key,
  compute a correctly-shaped `mac` over any `items` payload it wants using
  the exact algorithm in §3.2, and write a fully self-consistent forged
  state file that verifies cleanly. Layer 2 raises the bar from "edit a
  plaintext counter" to "read a keyfile and run an HMAC," it does not
  remove the forgery surface entirely — closing that fully would require
  keeping the key outside the agent's read surface too, which this repo's
  hook framework (a same-user, same-filesystem-permissions child process)
  has no mechanism to provide.
- **Writes via a tool this repo's PreToolUse hooks don't match.** Any MCP
  server exposing its own filesystem-write tool (an MCP filesystem server,
  a database blob write, etc.) is invisible to Layer 1 — its matcher only
  covers `Write|Edit|NotebookEdit|MultiEdit` (§2.2) and
  `Bash|PowerShell` (§2.3). A future tool with local write capability would
  need its own PreToolUse entry in this hook's matcher list to be covered.
- **Shell forms the parser cannot model.** `shell-write-guard.js`'s own
  existing declared blind spots (its header comment, lines 77-93) all
  still apply unchanged to the PROTECTED_PATH rule, since it rides the same
  detection machinery: bare-script (`node x.js`) internals, `cmd.exe`'s
  real grammar (coarse co-occurrence heuristic only), a `2>`/`&>` stderr
  redirect (excluded from write-target detection entirely, matching that
  file's existing convention), and any write path this file's tokenizer
  simply doesn't recognize as write-shaped in the first place.
- **A dynamic target with no literal `hooks/state` substring anywhere in
  the command text.** §2.3(b)(2)'s raw-text fallback only catches an
  unresolvable target when the protected directory's name still appears
  literally in the command. A fully indirect construction —
  `D=$(cat /tmp/target-dir-name); cp forged.json "$D/x.json"` where
  `/tmp/target-dir-name` contains the text `hooks/state` but the *command
  itself* never spells it out — resolves to branch 4 (ordinary,
  override-eligible friction), not branch 5. This is the one case in this
  spec's own design where the task's explicit instruction accepts friction
  falling short of denial as the declared, accepted limit rather than a bug
  to close.
- **Deleting the state file entirely (safe direction, not closed on
  purpose).** An agent can `rm`/`Remove-Item` the state file itself — that
  operation is a delete, not a write to a gated path Layer 1 or Layer 2
  reasons about, and is not blocked by this spec. Deleting it only resets
  every item's strikes to 0 for that session (the same outcome an ordinary
  corrupt-file or MAC-mismatch already produces), which can only delay a
  yield, never grant one — consistent with every other safe-direction
  fallback this spec and the base spec both already rely on, so it is
  intentionally left open rather than separately gated.
- **Cross-session replay of a legitimately-produced `items` blob.** The MAC
  (§3.2) is computed over `items` alone, not `items` bound to `session_id`.
  An agent that copies the *byte-identical* `items` object from one
  session's own legitimately-written (fully strike-exhausted) state file
  into a **different** session's state filename produces a state file whose
  `mac` still verifies — the signature proves "these bytes were produced by
  someone holding the key," not "these bytes belong to this session." This
  is a genuine gap beyond what the task's fixed design explicitly asked to
  close (which specifies the MAC scope as `items` only) — flagged here per
  this project's canon on disclosing a gap found during authoring rather
  than silently shipping past it, not fixed unilaterally since it would
  mean re-litigating the task's stated MAC scope.
- **`fs.writeFileSync(..., { mode: 0o600 })` on the keyfile is best-effort
  only on Windows.** POSIX file modes don't map cleanly onto NTFS ACLs; the
  call is harmless but not expected to meaningfully restrict read access to
  the keyfile on this repo's stated target platform (Windows), which is
  also why the previous bullet (reading the keyfile) is listed as an
  accepted gap rather than something this mode bit closes.
- **Whether the installer step (§5) actually gets run.** This spec adds a
  required `GUARDS` registry entry and edits to two already-registered
  files; nothing in this spec verifies at runtime that an already-installed
  `~/.claude/hooks/` tree has picked up either change. A stale installed
  copy silently keeps running the pre-this-spec, forgeable behavior with no
  in-band signal that it's out of date — outside this spec's scope to
  detect (no guard in this repo currently checks its own installed-copy
  freshness against the repo source).

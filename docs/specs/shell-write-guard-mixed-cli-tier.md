# shell-write-guard: KNOWN_MIXED tier for psql/sqlite3/mysql-style CLIs

## 0. TL;DR

The reconstructed blocked command: `psql -h localhost -U postgres -d
example_etl_db -c "SELECT count(*) FILTER (WHERE source_model IS NULL)
AS pre_existing_null, count(*) AS total_all FROM assertions;"` — blocked
as `unknown-verb-ambiguous-argument` on the `-c` value. This block is
friction enforcing the tempfile canon, not a false positive; the gap is
that `catchAllUnknownVerb` has no flag-role model, so `-f`/`-o` aren't
resolved on purpose — they're just lucky or unlucky depending on whether
an unrelated token trips the generic ambiguous/gated-extension scan.

**Round 2 revision.** A second, fresh-context adversary pass
(`.mc2-findings.md`, MC2-01..09, now deleted per process) attacked the
round-1 material itself: a no-space redirect (`db<script.sql`,
strictly the MORE common shell idiom) glues into one token that never
reaches either the ALLOW rule or the stdin denylist (MC2-01); §7.3's own
table declared mysql's `-h`/`-P`/`-u`/`-S` as arity 0 when they are
documented required-argument flags — the exact "arity wrong shifts
every later token's role" hazard §7.2 warned about, found live in this
document (MC2-02); the wrapper-unwrap fix only patches the Bash path,
leaving MC-02's original finding fully reproducible as a native
PowerShell tool call (MC2-03); and the arity vocabulary had no slot for
"optional, glued-only" flags like mysql `-p`/`-C` (MC2-04). This round
fixes MC2-01, 02, 03, 04, 05, 08, 09 and treats MC2-07 as verified (the
disputed `-z`/`-0` short forms are real, re-confirmed against a fresh
live fetch); MC2-06 is accepted, same rationale class as MC-09. Full
disposition table: §13.

**Round 1 revision.** A dedicated adversary pass (`.git/tmp/mixed-cli-
adversary-r1.md`, MC-01..MC-17) found the v1 draft's flag-role model was
an incomplete allow-list wearing a total-classification costume: `-f`
got zero inspection (unconditional bypass via `/dev/stdin`, `-`, process
substitution — MC-01); the wrapper-unwrap list didn't cover `docker
exec`/`ssh`/`kubectl exec`, so the exact incident shape survives under a
one-hop wrapper (MC-02); glued short flags, `=`-joined long flags, quoted
flag tokens, and PowerShell's clause-splitting-before-role-lookup order
all defeat literal-equality matching (MC-03..06); sqlite3's bare-
positional SQL form was never classified (MC-07); `mysql -e` was a
documented, un-fixed omission (MC-08); the "fall through to catch-all"
escape hatch reintroduced the exact bug this spec exists to fix the
moment `.sql` is gated and an unrelated flag is unrecognized (MC-14);
and one shared flag-name table across three CLIs silently mis-blocks
`mysql -c` (MC-12). This revision closes MC-01..08, MC-10, MC-12..16 by
construction; MC-09 and MC-11 are accepted, one-line rationale in §11;
MC-17 gets a one-sentence clarification, no code change. Full
disposition table: §12.

## 1. Problem

`catchAllUnknownVerb` (`hooks/shell-write-guard.js:1139-1155`) is the
default branch for any verb outside `KNOWN_READ_VERBS` (`:979-993`) and
`KNOWN_WRITE_VERBS` (`:1094-1098`). `psql`/`sqlite3`/`mysql` are
deliberately excluded from both per the comment at `:961-978`: generic
wrappers whose subcommands can write locally stay off the read allow-
list — correct for the write side. But the catch-all has no flag-role
model at all: it blocks on the first argument that is "ambiguous"
(`isAmbiguousToken`, `:188`) or whose basename classifies at branch ≥ 3
(`classifyExtension`, `:213`; checked at `:1148-1152`), unable to
distinguish `-f input.sql` (read) from `-o output.ps1` (write), and
unable to tell inline SQL passed via `-c`/`-e`/`-cmd` from a harmless
connection flag.

The structural defect, restated after round 1: an unknown verb's
FILE-role argument is extension-gated at all, its OUTPUT-role argument
isn't distinguished, and — round 1's addition — a flag-role model that
only inspects the LITERAL verb+flag shape (exact token equality, no
normalization, no wrapper transparency, no stdin-source awareness) is
not actually a flag-role model; it's the same allow-list problem one
layer down. §2 below is a genuine total classification: every token,
after tokenizer-level normalization, after wrapper unwrapping, lands in
exactly one named role, and the "I don't recognize this" branch is
FRICTION at the token level, never a hand-off to a less-aware detector.

## 2. Total classification: `KNOWN_MIXED` tier

New tier alongside `KNOWN_READ_VERBS`/`KNOWN_WRITE_VERBS`: `KNOWN_MIXED`
— CLIs with a documented, stable input/output flag split: `psql`,
`sqlite3`, `mysql` (extend only with documented verbs, each behind its
own literal table — see §7, fixing MC-12).

**Dispatch order for a single stage** (a stage is already one segment
of `splitSegments` — `;`/`&&`/`||`/`|` already isolate it,
`bash-classifier-bait-guard.js:175-184`; no new splitting logic needed
there, closing the "chaining" half of MC-02's ask):

1. Run `findPrimaryVerbIndex` as extended by §4 (wrapper unwrapping). If
   a recognized wrapper token was present and no inner verb can be
   located after unwrapping it, the whole stage is **FRICTION**
   (`detector: "wrapper-exhausted-no-inner-verb"`) — never branch 1.
   This is a global change to `findPrimaryVerbIndex`'s contract, not
   scoped to the three mixed CLIs; see §11 for the side effects (`sudo
   -i`, a bare `ssh host` session, bare `wsl` now block).
2. If the resolved verb is in `KNOWN_MIXED`, dispatch to that CLI's
   table (§7). Otherwise proceed through the existing D1 order
   (KNOWN_READ_VERBS -> KNOWN_WRITE_VERBS -> `catchAllUnknownVerb`)
   unchanged.
3. Inside a `KNOWN_MIXED` dispatch, **every token after the verb is
   normalized first** (§6: `=`-splitting, glued-short-flag prefix
   matching, quoted-bit-insensitive flag-name matching, PS clause
   reassembly before lookup), then classified into exactly one role:

   - **FILE-role** flag (`-f`/`--file` for psql, `-init` for sqlite3;
     mysql has none — see §7.3) + its argument: the argument first
     passes the stdin-source check (§5) — a stdin sentinel, process
     substitution, heredoc/here-string marker, or ambiguous token
     (`isAmbiguousToken`, unconditionally applied — this is the MC-01
     fix) is FRICTION naming the tempfile canon. Only a literal regular-
     file path argument satisfies FILE-role; it is then extension-
     EXEMPT (never gated) per the §3 invariant, unchanged from v1.
   - **INLINE-role** flag (`-c`/`--command` for psql, `-cmd` for
     sqlite3, `-e`/`--execute`/`--init-command` for mysql — MC-08 fix)
     + its argument: **FRICTION unconditionally, content-blind.** The
     block message names the CLI's own FILE-role flag as the
     alternative. Content-blind means a `-c` body containing `\o
     out.ps1` (MC-16) is moot — the whole `-c` value blocks before its
     contents are ever inspected, so no `\o`-awareness is needed as
     long as `-c` itself is correctly *recognized* (which is what
     MC-03/05/06's normalization fixes buy).
   - **OUTPUT-role** flag (`-o`/`--output`, `-L`/`--log-file` for psql;
     `--result-file`/`--tee` for mysql) + its argument: resolved like
     `handleCurl`'s `-o` (`resolveTarget` against `gatedExts`).
   - **BENIGN** flag, declared with its exact arity per §7's tables:
     `0`, `1`, `2` (sqlite3 `-lookaside`/`-pagecache`), or **`OPTIONAL
     (glued-only)`** — a fourth, first-class arity value (round 2,
     MC2-04): the flag's value is consumed ONLY when directly glued
     (`-pSECRET`, `--password=SECRET`, `-C=ON`) or `=`-joined after §6.1
     splitting; a bare occurrence with nothing glued consumes ZERO
     following tokens (mysql `-p`/`--password`, `-C`/`--compress` are
     both this kind — §7.3). Whatever the arity, the argument (if any)
     still passes `isAmbiguousToken` (a benign flag carrying a
     `$(...)`/backtick/`@`-splat value is still suspicious — this
     uniform check is new in round 1 and closes MC-15's `-v`
     variable-injection finding without a `-v`-specific rule; round 2's
     MC2-06 residual on `-v` is a DIFFERENT, SQL-level channel this
     shell-level check cannot see — see §11).
   - **CONNECTION/POSITIONAL**: per-CLI meaning (psql: dbname or
     connection URI; sqlite3: first positional = db file, any FURTHER
     positional = **FRICTION**, MC-07 fix; mysql: database name). A
     positional token gets the SAME ambiguous/extension scan as any
     other token (MC-17) — no special exemption for connection strings,
     so a raw (un-encoded) `$`/backtick/glob character in
     `postgres://user:p$ss@host/db` still blocks.
   - **UNKNOWN**: any token — flag or bare word — not matched by any of
     the above rows for THIS CLI's table is **FRICTION by itself**,
     naming the exact token. **This routing decision replaces v1's
     "fall through to `catchAllUnknownVerb`."** MC-14 showed that
     hand-off silently re-admits the original bug the moment an
     unrelated unrecognized flag shares a command with a legitimate
     `-f` and `.sql` is gated, because `catchAllUnknownVerb` has no
     role model and re-applies the raw extension check to every token,
     `-f`'s target included. Per-token FRICTION means an unrecognized
     flag on `psql -f tmp.sql --tuples-only` blocks on `--tuples-only`
     alone (once enumerated it isn't even reached — see §7.1 — but if a
     genuinely novel flag appears, IT blocks, `-f`'s resolved role is
     never re-litigated). No token dispatched through `KNOWN_MIXED` ever
     reaches `catchAllUnknownVerb`.
   - Bare `>`/`>>` on the stage: already caught by `scanRedirects`, no
     change. A bare `<` (input redirect — not currently tagged
     `redirect: true` by the shared tokenizer; see §5) is handled by the
     stdin-source table, not by this per-flag scan.

`--` (end-of-options): **not special-cased** (MC-11, accepted — see
§11). Scanning for FILE/INLINE/OUTPUT roles continues past a bare `--`
token exactly as it does for any other token; a `--` never disables
role lookup for tokens that follow it in this tier.

## 3. Invariant

**A verb's own documented read/write flag contract, where stable,
determines whether an argument is a write target — a global gated-
extension list must never veto an argument on a documented input/inert
flag.** (Unchanged from v1, now demonstrably held under gating —
§7's `-init x.ps1` test.)

**Round 1 addition — fallthrough is per-token, never per-command.** A
`KNOWN_MIXED` verb's classification is the pointwise combination of its
tokens' individual roles: the worst (most-blocking) per-token result
wins for the stage, but an unrecognized token's FRICTION never
downgrades or re-opens a DIFFERENT, already-resolved token's role. No
`KNOWN_MIXED` token is ever handed to `catchAllUnknownVerb`, which has
no flag-role awareness and would silently re-litigate a resolved FILE-
role argument against the raw gated-extension list (MC-14).

**Round 1 addition — wrapper transparency.** `findPrimaryVerbIndex`'s
verb resolution is wrapper-transparent per §4: a `KNOWN_MIXED` verb
reached through one recognized wrapper hop is classified exactly as if
it were the top-level verb. An unrecognized wrapper (any launcher not
in §4's table) is unchanged — it still falls through to
`catchAllUnknownVerb` at the OUTER verb, per MC-02's accepted residual
(§11).

## 4. Wrapper unwrapping (Bash path; PowerShell-native mirror in §6.3,
MC2-03)

`findPrimaryVerbIndex` (`:354-368`) today unwraps only `sudo`/`env`/
`wsl` and bare `VAR=val` prefixes. MC-02's `docker exec -it db psql -c
"DROP TABLE x;"` and `ssh dbhost psql -c "..."` are the identical
incident shape one wrapper hop away, and land in `catchAllUnknownVerb`
at `docker`/`ssh` today — which has no flag-role model and lets a
quoted `"DROP TABLE x;"` through (no `$`/backtick/glob/gated
extension). Fix: extend the wrapper table (open-ended list, not a
generic "scan anywhere" rescue of `catchAllUnknownVerb` — that was
MC-02's rejected option (b); an unlisted wrapper is an accepted
residual, §11).

| Wrapper | Flags-with-arg to skip | Positional(s) to skip before inner verb | Inner-verb rule |
|---|---|---|---|
| `sudo` (existing) | `-u/--user -g/--group -h/--host -r/--role -t/--type -C/--close-from -p/--prompt` | none | first non-flag token |
| `env` (existing) | `-u/--unset -C/--chdir -S/--split-string` | none (skip `VAR=val` prefixes too) | first non-flag, non-`VAR=val` token |
| `wsl` (existing) | `-d/--distribution -u/--user` | none | first non-flag token after any `--` |
| `nohup` | none | none | first token after `nohup` |
| `time` | `-o/--output` (GNU `/usr/bin/time`; shell keyword `time` takes none) | none | first non-flag token |
| `xargs` | `-I -n -P -a -d -E -L -s --arg-file` (arity 1 each) | none | first non-flag token |
| `docker exec` / `podman exec` | `-u/--user -w/--workdir -e/--env --env-file` | exactly ONE positional (container id/name) before the inner verb | first token after the container positional |
| `docker run` / `podman run` | same, plus the full `docker run` flag surface (not enumerated here — any unrecognized `docker run` flag is a benign-with-arg-or-not guess; see §11 residual) | exactly ONE positional (image) before the inner verb — `docker run img` alone (no COMMAND) has no inner verb: image's own ENTRYPOINT is opaque, so this case is FRICTION, not "no wrapper found -> allow" | first token after the image positional, if any |
| `kubectl exec` | `-n/--namespace -c/--container` | exactly ONE positional (pod name) before the inner verb | first token after a `--` separator if present; if no `--` is present, first non-flag token after the pod positional (best-effort — kubectl itself requires `--` when the inner command has its own flags, so this is friction-favoring, not exhaustive) |
| `ssh <host>` | `-p -i -l -o -F -L -R -D -J -c -e -B -b` (arity 1 each); `-A -a -C -f -g -k -M -N -n -q -s -T -t -v -x -X -Y -4 -6` (arity 0) | exactly ONE positional (`[user@]host`) before the inner verb | first token after the host positional; NONE remaining (bare `ssh host`) is an interactive session with no static inner command — per §2 step 1 this is now FRICTION (wrapper present, no inner verb located), a deliberate side effect flagged in §11, not a `KNOWN_MIXED`-specific carve-out |
| `cmd /c` / `cmd /k` | none beyond `/d /s` (arity 0) | none | first token after `/c` or `/k` — inherits the EXISTING declared blind spot ("cmd.exe's real grammar is not parsed", header comment `:79-81`); this spec does not improve cmd.exe parsing beyond locating a bare verb there |
| `pwsh -c\|-Command`, `powershell -c\|-Command` | n/a — already recurses via `handleInterpreterInline` -> `analyzePowerShell(body, ...)` (existing code, `:868-882`) | n/a | no NEW unwrap step in `findPrimaryVerbIndex`; the requirement is that `analyzePowerShell`'s own verb dispatch ALSO consults the mirrored PS `KNOWN_MIXED` tables (§7, §6.3) — otherwise a `psql` verb found only inside a recursed PS body never reaches the new tier |
| `bash -c`, `sh -c` (and `zsh`/`dash`) | n/a — already recurses via `handleShellInline` -> `analyzeBash(bodyTok.value, ..., depth+1)` (existing code, `:913-951`) | n/a | no NEW unwrap step; the recursive call already re-enters the SAME top-level dispatcher, which now includes `KNOWN_MIXED` generally |

**Chained commands** (`&&`/`||`/`;`/`|`): already split into independent
segments by `splitSegments` before any of this runs (confirmed by
reading `bash-classifier-bait-guard.js:175-184` — pipe is in the
separator set). No new splitting logic is required for MC-02's chaining
ask; the author should confirm (not re-decide) that the EXISTING
cross-segment aggregation in `analyzeBash` already takes the branch-
maximum across segments — flagged as a verification item, not a
design change, in §11.

## 5. Stdin-source table (MC-01, MC2-01)

Applies to every FILE-role flag's argument (psql `-f`, sqlite3 `-init`)
and to a `<` redirect feeding a `KNOWN_MIXED` verb with no FILE/INLINE
role flag present at all.

**Round 2 fix (MC2-01) — glued redirects.** `db<script.sql`,
`db<(cat evil.sql)`, and `-h localhost -d db<script.sql` are NOT exotic:
a no-space redirect is at least as common as the spaced form and every
POSIX shell parses it identically. Empirically confirmed against the
live, unmodified `tokenize()`: it glues a redirect character directly
onto the preceding word with zero whitespace (`["mysql", "db<script.sql"]`),
so v1/round-1's "bare `<` token, value exactly `<`" rule never fires,
and the merged token isn't caught by `isAmbiguousToken` either (that
check's character set is `$`, backtick, `[*?[\]]`, leading `@` — never
`<`, `>`, `(`, `)`). Two fixes, both required:

1. **Pre-split step, scoped to the `KNOWN_MIXED` pass only.** Before
   role lookup, any stage token matching
   `/^([^<>()]*)(<{1,3}|<\(|>\()(.*)$/` is split into its pre-redirect
   prefix (gets its own normal role lookup — `db` above is then a
   CONNECTION/positional token) and the redirect-plus-remainder (fed
   into this table below as if `tokenize()` had produced them as
   separate tokens, matching the spaced form's existing handling).
   **Scope decision**: this is implemented as a local pre-processing
   step inside the `KNOWN_MIXED` dispatcher, NOT as a change to the
   shared `tokenize()` in `bash-classifier-bait-guard.js`. That
   function is shared by every sibling hook and guard in this
   codebase; proving a shared-tokenizer change safe would require
   running the FULL cross-hook test suite (every consumer of
   `tokenize()`, not just `shell-write-guard.test.js`) and auditing
   every existing detector that currently assumes `<`/`(`/`)` are
   ordinary word characters. That was not attempted this round — the
   scoped, local fix is strictly lower-risk and sufficient for this
   tier's own correctness, so it is what this spec specifies.
2. **Extend the ambiguity check for CONNECTION/positional tokens.** Per
   MC2-01's own fix note: even after (1) splits the token, the
   PRE-redirect prefix (`db`) and any leftover fragment still need
   `<`, `>`, `(`, `)` treated as ambiguous characters when they appear
   inside a token that made it to CONNECTION/positional role lookup
   (i.e. the split in (1) failed to fully consume them, or a
   process-substitution shape survived splitting) — a tier-scoped
   addition to `isAmbiguousToken`'s character set for `KNOWN_MIXED`
   tokens only, not a global change to the shared predicate.

The table below now applies uniformly whether the redirect arrived
pre-split by `tokenize()` (the spaced form) or by step (1) above (the
glued form):

| Shape | Classification | Rationale |
|---|---|---|
| Literal relative/absolute regular-file path (`tmp.sql`, `/tmp/x.sql`) | ALLOW (subject to `isAmbiguousToken`, extension-exempt) | the only form the tempfile canon actually asks for |
| `-` | FRICTION | stdin sentinel — canon requires a literal tempfile, not `-` |
| `/dev/stdin` | FRICTION | same — MC-01's literal reproduction |
| `/dev/fd/<N>` (any N) | FRICTION | same class as `/dev/stdin` |
| `/proc/self/fd/<N>` | FRICTION | same class, Linux `/proc` alias |
| Token containing `<(` or `>(` (process substitution) | FRICTION | the shared tokenizer (`tokenize()`, no `<`/`(`/`)` break chars) does NOT cleanly isolate this as one token — treat ANY FILE-role or bare-`<` argument token containing `<`, `>`, `(`, or `)` as FRICTION outright rather than attempting to parse it |
| Token matching `$VAR`/`${...}`/`@`-splat (already `isAmbiguousToken`) | FRICTION | unconditional per the now-uniform ambiguity check (MC-01 fix: this used to be SKIPPED for FILE-role flags — "consumed, scan continues" in v1 §2 bullet 1 — the fix is simply to stop skipping it) |
| Bare `<` token (value exactly `<`, not `redirect`-tagged by the shared tokenizer — see note) followed by a literal file token | ALLOW | `psql ... < file.sql` is the canon-sanctioned form; requires the mixed-tier's OWN stage scan for a bare `<` word token, since `tokenize()` only marks `>`/`>>`/`&>` as `redirect: true` — `<` is not special-cased there today (verified by reading `bash-classifier-bait-guard.js:47-138`) |
| `<<` / `<<-` anywhere in the remaining stage (heredoc marker) | FRICTION | SQL sourced from a heredoc body is not the tempfile canon |
| `<<<` (here-string) | FRICTION | same |
| This stage is fed by a `\|` from a PRIOR segment (i.e. not segment 0) with no FILE/INLINE role flag of its own | FRICTION | e.g. `cat script.sql \| psql db` — the actual SQL source is opaque to this hook (it's the prior command's stdout) |

PowerShell mirror: the same table applies to the PS analyzer's own
redirect/pipe detection (`\|`, `>`, here-strings `@"..."@`/`@'...'@` —
here-strings are FRICTION unconditionally per §6.3/decision 5, whether
or not they're the argument to a FILE-role flag).

## 6. Normalization pipeline (MC-03, MC-04, MC-05, MC-06, MC-10)

Applied to every token BEFORE role lookup in §2/§7, for both Bash and
PowerShell:

### 6.1 `=`-splitting (MC-03)

A long-form flag glued to its value with `=` (`--command=SELECT 1`,
`--output=out.ps1`) is one token as produced by `tokenize()` (no
special-casing of bare `=` in the Bash word-loop). Split on the FIRST
`=` before role lookup: `--command=SELECT 1` -> flag `--command`, value
`SELECT 1`. Applies to every long-form flag in every CLI's table, not
just the ones under test.

### 6.2 Glued short flags (MC-05, MC2-05)

`-cSELECT id FROM users`, `-fpath.sql`, `-ofile.ps1` are real
getopt-style short-flag-plus-value syntax and are NOT split by
`tokenize()`. Role lookup for every short flag in §7's tables uses
prefix matching (`/^-c(.+)/`, `/^-f(.+)/`, `/^-o(.+)/`, ...) rather than
exact-token equality (`t.value === "-c"`), with the captured group as
the value. A flag matched only by prefix is still subject to the FULL
role treatment (FILE/INLINE/OUTPUT/BENIGN — including the stdin-source
and ambiguity checks) exactly as its space-separated form is.

**Case sensitivity (MC2-05): all `KNOWN_MIXED` flag-name and
prefix matching, short and long, Bash and PowerShell, is
case-SENSITIVE** — matching real getopt/CLI semantics, a deliberate,
explicit exception to this file's existing PowerShell-cmdlet
case-insensitivity convention (`/^-EncodedCommand$/i`, `-WhatIf`
handling). A case-insensitive `/^-f(.+)/i` prefix would collide psql's
real, distinct `-f`/`--file` (FILE-role) with `-F`/`--field-separator`
(BENIGN, arity 1, confirmed as a genuinely separate documented option
from `-f`, not a case variant of it, per a live re-fetch of
postgresql.org/docs/16/app-psql.html this round). No such collision
exists in mysql's table (mysql has no FILE-role flag at all — §7.3).

### 6.3 PowerShell clause order and quoting (MC-04, MC-06, MC-10, MC2-03,
MC2-09, decision 5)

- **Order**: `KNOWN_MIXED` role lookup for a PowerShell command runs
  AFTER `=`-joined clauses are reassembled, and that reassembly must
  happen BEFORE `splitPsClauses`' own top-level unquoted-`=`
  clause-boundary split (`:1948`) — today that split runs first and
  treats `--command="SELECT 1"`'s bare `=` as a clause boundary,
  producing an unparseable second clause. The spec requires: for a
  clause whose first token names a `KNOWN_MIXED` verb (after wrapper
  unwrap), re-join a clause-boundary `=` that immediately follows a
  recognized long-flag name back into one logical assignment before
  role lookup, rather than treating it as two PowerShell statements.
- **Quoted-bit insensitivity (MC-06)**: every existing handler in this
  file gates flag-name matching on `!t.quoted` (e.g. `handleSed`'s
  `-i`, `handleTee`'s `-a`) — a quoted flag name (`psql "-c" "SELECT
  1"`) is invisible to that convention. `KNOWN_MIXED` role lookup
  matches flag names **regardless of the `quoted` bit**, for both Bash
  and PowerShell — this is a deliberate, tier-scoped exception to the
  rest of the file's convention, not a global change to `quoted`
  handling elsewhere.
- **Backtick line continuation (MC-10, precision fix MC2-09)**:
  `splitPsStatements` has no special handling for a bare backtick
  immediately followed by a newline outside a quoted span — it
  currently orphans the backtick as its own token and splits the
  statement in two, which today blocks a completely legitimate
  multi-line `-f` invocation for an UNRELATED reason (the orphaned
  backtick trips `isAmbiguousToken`, not this tier's own logic). Fix,
  scoped to `splitPsStatements`/its pre-pass: a **"line-final"**
  unescaped backtick joins with the next line before any
  clause/statement splitting runs, where "line-final" means **the last
  non-whitespace character before the line's `\n`** — NOT strictly the
  last character before `\n`. This matches real PowerShell continuation
  semantics and closes MC2-09's concern that a strict last-character
  check would silently fail to join a line ending in `` ` `` followed
  by trailing spaces/tabs (a common accidental shape after a manual
  edit), reintroducing the exact false block this fix exists to close
  for a variant indistinguishable to a human reader. This is a general
  PowerShell-tokenization fix (not `KNOWN_MIXED`-specific) but is
  required for this tier to avoid a false block on the shapes §T36/§T59
  (§9) test.
- **PowerShell-native wrapper unwrapping (MC2-03, CRITICAL)**: §4's
  wrapper-unwrap table and wrapper-exhausted-> FRICTION rule patch
  `findPrimaryVerbIndex`, which is Bash-only (`stage` = a
  `tokenize()`/`splitSegments()` array). The PowerShell path has its
  OWN, independent "unknown cmdlet" fallback
  (`classifyPsClauseArguments`, ~lines 1904-1930) that is structurally
  identical to `catchAllUnknownVerb` — it has **no concept of
  docker/ssh/kubectl unwrapping at all**, so `docker exec -it
  dbcontainer psql -c "DROP TABLE x;"` typed as a native PowerShell
  tool call reproduces MC-02's original finding verbatim, on a path
  round 1's fix never touched. Fix: `analyzePowerShell`'s own verb
  dispatch gets its OWN mirrored copy of §4's wrapper-unwrap table
  (docker/podman/kubectl/ssh/cmd/xargs/nohup/time — the same list,
  applied to PS-tokenized stages) and the SAME "wrapper present, no
  inner verb located -> FRICTION" rule, evaluated before
  `classifyPsClauseArguments`'s catch-all fallback runs. This is a
  second, independent implementation of §4's table (PS tokenization
  differs from Bash's), not a code-sharing exercise this spec mandates
  — sharing the table DATA (wrapper names, flags-with-arg, positional
  counts) between the two implementations is an acceptable
  optimization but not required by this spec.
- **Splatting (`@p`) and here-strings (`@"..."@`/`@'...'@`)**: splatted
  arguments are already caught by the EXISTING `isAmbiguousToken`
  `@`-prefix rule (`:198-201`, added for a prior PowerShell escape) —
  no new detector needed as long as the reassembly above correctly
  surfaces the splat token to that check rather than losing it in a
  mis-split clause. Here-strings are FRICTION unconditionally,
  regardless of which role's argument they occupy — a token (or raw
  span) beginning with `@"` or `@'` is FRICTION before role lookup,
  since PowerShell here-strings can span multiple physical lines and
  are not reliably bounded by `blankPsQuotesForScan`'s single-line
  quote-blanking.

## 7. Per-CLI flag tables (MC-12, MC-13, MC-15)

Three separate, literal tables — not one shared bullet list keyed by
flag name. A flag name that exists in more than one CLI's table (e.g.
`-c`) is looked up ONLY in the table for the verb actually being
classified; there is no cross-CLI fallback.

### 7.1 psql

Source: PostgreSQL 16 documentation, `app-psql.html`
(postgresql.org/docs/16/app-psql.html), fetched and cross-checked this
round. Every flag below supports both the glued-short and `--flag=`
long form except where noted; `-P`/`-?` are `--flag=value`-only per the
doc.

| Flag(s) | Arity | Role |
|---|---|---|
| `-f`, `--file` | 1 | **FILE** (§5 stdin-source table applies) |
| `-c`, `--command` | 1 | **INLINE** (FRICTION, content-blind) |
| `-o`, `--output` | 1 | **OUTPUT** |
| `-L`, `--log-file` | 1 | **OUTPUT** (MC-15: was missing from v1's WRITE row entirely) |
| `-d`, `--dbname`; `-h`, `--host`; `-p`, `--port`; `-U`, `--username` | 1 each | BENIGN (connection params) |
| `-w`, `--no-password`; `-W`, `--password` | 0 | BENIGN |
| `-A`, `--no-align`; `-a`, `--echo-all`; `-b`, `--echo-errors`; `-e`, `--echo-queries`; `-E`, `--echo-hidden`; `-q`, `--quiet`; `-t`, `--tuples-only`; `-x`, `--expanded`; `-H`, `--html`; `--csv`; `-z`, `--field-separator-zero`; `-0`, `--record-separator-zero`; `-1`, `--single-transaction`; `-s`, `--single-step`; `-S`, `--single-line`; `-n`, `--no-readline`; `-X`, `--no-psqlrc`; `-l`, `--list`; `-V`, `--version` | 0 each | BENIGN |
| `-F`, `--field-separator`; `-R`, `--record-separator`; `-T`, `--table-attr` | 1 each | BENIGN |
| `-P`, `--pset` | 1 (name=value) | BENIGN |
| `-v`, `--set`/`--variable` | 1 (name=value) | BENIGN — value STILL passes `isAmbiguousToken` (§2), which is the actual fix for MC-15's `-v "cmd=\`rm -rf /\`"` finding; no `-v`-specific rule needed for SHELL-metacharacter injection. **A separate, SQL-level channel through the same flag (MC2-06, accepted, not fixed) is out of scope — see §11.** |
| `-?`, `--help[=topic]` | 0 or 1 | BENIGN |
| positional (0 or 1) | — | **CONNECTION**: dbname or full connection URI/string (`postgres://...`, `service=...`) |
| positional (1, only if positional 0 is a bare dbname, not a conninfo string) | — | BENIGN (username) |
| any other flag | — | **UNKNOWN** -> FRICTION naming the token |

**Round 2 (MC2-07) re-verification**: `-z`/`--field-separator-zero` and
`-0`/`--record-separator-zero` ARE real, documented short options
(re-confirmed against a fresh live fetch of the same doc URL this
round: both list an explicit short form); `--csv` genuinely has no
short form (table correctly omits one); `-F`/`--field-separator` and
`-f`/`--file` are confirmed as two distinct, real, unrelated options
(not a case-variant pair) — see §6.2's case-sensitivity rule, which is
what actually protects this pair from collision. No table change; the
citation-accuracy concern is resolved, not carried forward as a blind
spot.

### 7.2 sqlite3

Source: sqlite.org/cli.html — **could not be fetched live in EITHER
round** (connection refused to sqlite.org from this environment, four
attempts total across two sessions — direct, a mirror, an alternate
sqlite.org path, and a man-page aggregator — all failed at the network
level, not a 404; this is now a persistent, environment-level
condition, not a transient fetch failure). Table below is reconstructed
from
long-stable, well-documented sqlite3 CLI flag names; flagged as a blind
spot in §11 pending verification against an installed `sqlite3 -help`
before implementation. The two security-relevant rows (`-cmd`, `-init`,
and positional semantics) are fixed by orchestrator decision, not
reconstruction, and are not in question.

| Flag(s) | Arity | Role |
|---|---|---|
| `-cmd` | 1 | **INLINE** (FRICTION, content-blind — includes a `.read`/`.output`/other dot-command passed as the `-cmd` value; the whole value blocks regardless of content) |
| `-init` | 1 | **FILE** (§5 stdin-source table applies; extension-exempt per §3, including a `.ps1`-named init script — §9 T50) |
| positional 1 | — | database filename (or `:memory:`/empty) |
| positional 2+ | — | **FRICTION** (MC-07 fix) — sqlite3's documented second-positional-is-SQL-to-execute form, including a `.read`/`.output` dot-command passed this way, executes exactly like `-cmd`'s content and must be blocked the same way; this INVERTS v1 `§4` test 8, which allowed it — see §12 |
| **any other flag** (`-append`, `-ascii`, `-bail`, `-batch`, `-box`, `-column`, `-csv`, `-echo`, `-header`, `-help`, `-json`, `-line`, `-list`, `-lookaside`, `-newline`, `-nullvalue`, `-pagecache`, `-quote`, `-readonly`, `-safe`, `-separator`, `-stats`, `-table`, `-vfs`, `-version`, `-A`, every other name real sqlite3 documents, and any name it doesn't) | — | **UNKNOWN -> FRICTION**, per explicit operator instruction mid-round-2: since `sqlite.org` could not be fetched live in either round (§11), NO sqlite3 flag beyond `-cmd`/`-init` (which are decision-mandated, independent of the fetch) is classified BENIGN by reconstruction from memory. Round 1/round 2's earlier drafts of this table enumerated a benign flag list from general CLI knowledge with declared arities (including a `-lookaside`/`-pagecache` arity-2 special case) — that enumeration is WITHDRAWN here, not merely flagged as a blind spot: an unconfirmed arity is exactly the "getting arity wrong shifts every later token's role" hazard this document warns about elsewhere, so the safe resolution is to treat every such flag as UNKNOWN rather than assert an arity that was never verified against a live source. This is a stricter, more conservative table than round 2's own draft; it costs ordinary `-csv`/`-list`/etc. formatting usage (previously allow, now FRICTION) until the fetch succeeds and a confirmed table can restore them to BENIGN. Friction over escape, applied to the table itself. |

sqlite3 has **no OUTPUT-role CLI flag** (no `-o`/`--output` equivalent)
— v1's test 9 (`sqlite3 -o out.ps1 db.sqlite -> block`) tested a flag
that does not exist in the real CLI; it is removed, not carried
forward (§12). Output redirection for sqlite3 is either shell-level
`>` (already caught by `scanRedirects`) or the `.output FILE`
dot-command, which only reaches this hook via `-cmd`'s FRICTION-
unconditional content-blind block or the positional-2+ FRICTION rule
above — never a separate flag.

### 7.3 mysql

Source: MySQL 8.0 Reference Manual, "mysql Command Options"
(dev.mysql.com/doc/refman/8.0/en/mysql-command-options.html), fetched
and cross-checked in BOTH rounds — round 2 specifically re-fetched and
quoted the documented syntax line for every flag corrected below
(MC2-02).

| Flag(s) | Arity | Role |
|---|---|---|
| `-e`, `--execute` | 1 | **INLINE** (FRICTION, content-blind — MC-08 fix; includes `-e "source file.sql"`, since the block is content-blind regardless of whether the payload is literal SQL or a `source` directive) |
| `--init-command` | 1 | **INLINE** (same treatment — executed immediately after connecting, same risk class as `-e`) |
| `--result-file`, `--tee` | 1 each | **OUTPUT** |
| `-D`, `--database` | 1 | **CONNECTION** (also satisfiable positionally, see below) |
| `-h`, `--host`; `-P`, `--port`; `-u`, `--user`; `-S`, `--socket` | **1 each (required)** | BENIGN (connection/socket params) — **round 2 correction (MC2-02, CRITICAL)**: these were wrongly bucketed as arity 0 in round 1, sharing a row with genuinely no-arg flags. Re-fetched syntax lines confirm all four are required-argument: `--host=host_name, -h host_name`; `--port=port_num, -P port_num`; `--user=user_name, -u user_name`; `--socket={file_name\|pipe_name}, -S path`. This was exactly the "arity wrong shifts every later token's role" hazard §7.2 warned about for sqlite3, found live in this table; fixed here, not merely flagged. |
| `-p`, `--password` | **OPTIONAL, glued-only** | BENIGN — real mysql semantics: `-pSECRET`/`--password=SECRET` (glued) carries a value; a bare `-p`/`--password` with nothing glued does **NOT** consume the following token (it prompts interactively instead). Never apply the generic "flag-with-arity-1 consumes next token" rule to bare `-p`/`--password`, or the next positional (commonly the database name) is silently misconsumed as a password and every token after it shifts role by one. See §2's now-first-class `OPTIONAL (glued-only)` arity value. |
| `-C`, `--compress` | **OPTIONAL, glued-only** | BENIGN — round 2 addition (MC2-04): re-fetched syntax is `--compress[={OFF\|ON}], -C`, the SAME optional-glued-argument shape as `-p`, not arity 0 as round 1's table had it. A second confirmed instance of the pattern named in §2. |
| `-c`, `--comments` | 0 | BENIGN — preserves comments in the client; confirmed no-argument (`--comments, -c`) on re-fetch. **Correction to the adversary brief and orchestrator shorthand**: per the official manual, mysql's `-c` is `--comments`, not `--compress` (that's `-C`). The underlying classification MC-12 asked for is unaffected either way — `-c` is benign, not inline-SQL, under BOTH names — this is a citation correction only, not a reopened decision; noted in §12. |
| `-B`, `--batch`; `-N`, `--skip-column-names`; `-t`, `--table`; `-H`, `--html`; `-X`, `--xml`; `-r`, `--raw`; `-s`, `--silent`; `-v`, `--verbose`; `-V`, `--version`; `-w`, `--wait`; `-A`, `--no-auto-rehash`; `-b`, `--no-beep`; `-i`, `--ignore-spaces`; `-n`, `--unbuffered`; `-q`, `--quick`; `-U`, `--safe-updates`; `-G`, `--named-commands`; `-E`, `--vertical`; `-L`, `--skip-line-numbers`; `-o`, `--one-database`; `-T`, `--debug-info`; `-j`, `--syslog`; `-W`, `--pipe`; `-f`, `--force` | 0 each | BENIGN — round 2 re-verified `--wait`/`-w` specifically (MC2-04's "likely companion" suspicion): re-fetched syntax is plainly `--wait, -w`, no argument at all, no optional-numeric-retry form. Suspicion checked and NOT confirmed; stays arity 0. mysql's own `-f`/`--force` ("continue on error") is unrelated to any FILE role — mysql has none (see below) — so no case-sensitivity collision risk analogous to psql's `-f`/`-F` (§6.2) exists here. |
| `--connect-timeout`, `--max-allowed-packet`, `--max-join-size`, `--net-buffer-length`, `--select-limit`, `--delimiter`, `--pager`, `--prompt`, `--protocol`, `--default-character-set`, `--defaults-group-suffix`, `--bind-address`, `--network-namespace`, `--compression-algorithms`, `--tls-version`, `--tls-ciphersuites`, `-#`/`--debug` | 1 each | BENIGN |
| `--defaults-file`, `--defaults-extra-file`, `--login-path`, `--plugin-dir`, `--character-sets-dir`, `--load-data-local-dir`, `--server-public-key-path`, `--ssl-ca`, `--ssl-capath`, `--ssl-cert`, `--ssl-key`, `--ssl-crl`, `--ssl-crlpath` | 1 each | BENIGN — these are credential/config paths, not the "SQL script to run" role; mysql has **no FILE-role flag equivalent to psql `-f`/sqlite3 `-init`** (see below) |
| positional (0 or 1) | — | **CONNECTION**: database name |
| positional 2+ | — | **FRICTION** — round 2 addition (MC2-08), matching §7.2's sqlite3 precedent explicitly rather than leaving it unstated; closes the gap MC2-02's arity fix would otherwise have left open (a stray extra positional produced by an arity mistake elsewhere now has one defined outcome, not an implementer's choice between silent-allow and friction) |
| any other flag | — | **UNKNOWN** -> FRICTION naming the token |

mysql has **no direct "run this .sql file" flag.** The tempfile-canon
form is the stdin redirect `mysql db < script.sql`, governed entirely
by §5's stdin-source table (a literal file after a bare `<` allows; a
heredoc/here-string/pipe/process-substitution source FRICTIONs) — not
by anything in this per-flag table.

## 8. Config guidance

Unchanged from v1. Live config
`~/.claude/hooks/shell-write-guard.config.json`:
`{"gatedExtensions": [".ps1", ".psm1", ".psd1"]}` — `.sql` is not
currently gated. Recommendation stands: do not add `.sql` to
`gatedExtensions`; §2/§7's per-token fallthrough fix (MC-14) is what
makes that recommendation actually safe to ignore, i.e. the fix holds
even if a future config change adds `.sql`, because no unrelated
unrecognized flag can any longer re-open a resolved FILE-role target's
extension check.

## 9. Test matrix

341 existing tests (`grep -c "^t(" hooks/shell-write-guard.test.js`).
70 new tests below, prefix `MIXED-NN` (58 from round 1, MIXED-59..70
added in round 2), bringing the total to 411. Every v1 test is
preserved EXCEPT #8, #9, and #11, which are corrected (not just
re-derived) by round 1's findings — see §12 for why each changed.
MIXED-29..32 (below) are Bash-path wrapper tests; MIXED-59..62 are their
PowerShell-native counterparts, added in round 2 to close MC2-03 (§9
previously had "no test that would fail if this gap ships unfixed" —
now it does).

| ID | Command (abbreviated) | Expect | Source |
|---|---|---|---|
| MIXED-01 | `psql -f x.sql` | allow | v1 #1 |
| MIXED-02 | `psql -f x.sql`, `.sql` gated | allow | v1 #2 |
| MIXED-03 | `psql -h localhost -p 5432 -U postgres -d db -f tmp.sql`, `.sql` gated | allow | v1 #3, incident shape |
| MIXED-04 | `psql -c "select 1"` | block, message names `-f` | v1 #4 |
| MIXED-05 | `psql -o out.ps1` | block | v1 #5 |
| MIXED-06 | `psql -o out.txt` | allow | v1 #6 |
| MIXED-07 | `psql --output=out.ps1` | block | v1 #7 + MC-03 |
| MIXED-08 | `psql --unknown-flag out.ps1` | block, UNKNOWN-token FRICTION naming `--unknown-flag` (not catch-all) | v1 #12, corrected per MC-14 |
| MIXED-09 | `psql -f x.sql -o out.ps1` | block, target `out.ps1` | v1 #13 |
| MIXED-10 | `psql -A -t -F',' -f export.sql` | allow, benign flags enumerated | MC-13 |
| MIXED-11 | `psql -f tmp.sql --tuples-only`, `.sql` gated | allow, `-f` role survives a co-occurring flag | MC-14 regression proof |
| MIXED-12 | `psql -f /dev/stdin <<< "SELECT 1"` | block, names tempfile canon | MC-01 |
| MIXED-13 | `psql -f -` | block | MC-01 |
| MIXED-14 | `psql -f /dev/fd/5` | block | MC-01 |
| MIXED-15 | `psql -f <(echo "DROP TABLE x;")` | block | MC-01 |
| MIXED-16 | `psql -h localhost -d db < script.sql` | allow, literal stdin redirect | decision 1 |
| MIXED-17 | `psql -h localhost -d db <<EOF ... EOF` | block, heredoc stdin | decision 1 |
| MIXED-18 | `psql -h localhost -d db <<< "SELECT 1"` | block, here-string | decision 1 |
| MIXED-19 | `cat script.sql \| psql db` | block, pipe-fed stdin, no FILE/INLINE role | decision 1 |
| MIXED-20 | `psql -h localhost -d db --command="SELECT 1"` (Bash) | block, `=`-split normalized | MC-03 |
| MIXED-21 | same (PowerShell) | block, clause reassembly before lookup | MC-04 |
| MIXED-22 | `psql -h localhost -d db -cSELECT id FROM users` | block, glued-flag prefix match | MC-05 |
| MIXED-23 | `psql "-c" "SELECT 1"` | block, quoted-bit-insensitive match | MC-06 |
| MIXED-24 | `psql -- -c 'SELECT 1'` | block, `--` not honored as end-of-options | MC-11 |
| MIXED-25 | ``psql -v ON_ERROR_STOP=1 -v "cmd=`rm -rf /`" -f x.sql`` | block, `-v` value ambiguous | MC-15 |
| MIXED-26 | `psql -L out.ps1 -f x.sql` | block, `-L` is OUTPUT-role | MC-15 |
| MIXED-27 | `psql postgres://user:p%24ss@host/db -f x.sql` | allow, URL-encoded `$` | MC-17 |
| MIXED-28 | `psql postgres://user:p$ss@host/db -f x.sql` | block, raw `$` in positional | MC-17 companion |
| MIXED-29 | `docker exec -it dbcontainer psql -c "DROP TABLE x;"` (Bash) | block, wrapper-unwrapped | MC-02 |
| MIXED-30 | `ssh dbhost psql -c "DROP TABLE x;"` (Bash) | block, wrapper-unwrapped | MC-02 |
| MIXED-31 | `kubectl exec pod -- psql -c "DROP TABLE x;"` (Bash) | block, wrapper-unwrapped | MC-02 |
| MIXED-32 | `podman run --rm img psql -c "..."` | block, wrapper-unwrapped | MC-02 extension |
| MIXED-33 | `sudo -u postgres psql -c "..."` | block, existing sudo unwrap + new INLINE role | regression |
| MIXED-34 | `ssh dbhost` (no inner command) | block, wrapper present, no inner verb located | §2 step 1 side effect, §11 |
| MIXED-35 | `sudo -i` | block, same rationale | §11 side effect |
| MIXED-36 | `psql -h localhost -d db` + backtick continuation + `-f tmp.sql` (PowerShell) | allow, backtick-continuation fixed | MC-10 |
| MIXED-37 | `mysql -e "select 1" -uroot` | block, `-e` now INLINE | MC-08 |
| MIXED-38 | `mysql --execute="select 1"` | block, `=`-split + INLINE | MC-08 + MC-03 |
| MIXED-39 | `mysql -c -e "select 1" -d somedb` | block on `-e` only; `-c` (comments) benign | MC-12 |
| MIXED-40 | `mysql -C -e "select 1"` | block on `-e`; `-C` (compress) benign | MC-12 companion |
| MIXED-41 | `mysql -e "select 1" --result-file=out.ps1` | block | v1 #10 |
| MIXED-42 | `mysql -e "select 1" db` | block (INVERTED from v1 #11's "allow" — see §12) | MC-08 |
| MIXED-43 | `mysql db -e "select 1"` | block, order-independent | MC-08 |
| MIXED-44 | `mysql -pSECRET db` | allow, glued optional-arg password | mysql `-p` special-case |
| MIXED-45 | `mysql -p db` | allow, bare `-p` does NOT consume `db` | mysql `-p` special-case |
| MIXED-46 | `sqlite3 db.sqlite "SELECT id FROM users"` | block, second positional is FRICTION | MC-07 |
| MIXED-47 | `sqlite3 db.sqlite ".read x.sql"` | block (INVERTED from v1 #8's "allow" — see §12) | MC-07 |
| MIXED-48 | `sqlite3 -cmd ".read x.sql" db.sqlite` | block, `-cmd` content-blind | decision 4 |
| MIXED-49 | `sqlite3 -init startup.sql db.sqlite` | allow | decision 4 |
| MIXED-50 | `sqlite3 -init startup.ps1 db.sqlite` | allow, FILE-role extension-exempt even for `.ps1` | §3 invariant symmetry |
| MIXED-51 | `sqlite3 -init /dev/stdin db.sqlite` | block, stdin-sentinel applies cross-CLI | MC-01 |
| MIXED-52 | `sqlite3 -unsafe-testing db.sqlite` | block, UNKNOWN -> FRICTION (unconfirmed sqlite3 flag, table withdrew the reconstructed benign enumeration mid-round-2 — §7.2) | §7.2 |
| MIXED-53 | `bash -c 'psql -c "select 1"'` | block via existing shell-inline recursion reaching `KNOWN_MIXED` | §4 recursion note |
| MIXED-54 | `pwsh -Command 'psql -c "select 1"'` | block via existing PS-inline recursion reaching mirrored PS tables | §4/§6.3 |
| MIXED-55 | `psql @creds -f x.sql` (PowerShell splat) | block, `@`-prefixed token already ambiguous | §6.3 |
| MIXED-56 | `psql -c @"`\n`SELECT 1`\n`"@` (PowerShell here-string as `-c` body) | block, here-string FRICTION | §6.3 / decision 5 |
| MIXED-57 | `xargs psql -c "select 1"` | block, `xargs` unwrapped | §4 |
| MIXED-58 | `nohup psql -f x.sql` | allow, `nohup` unwrapped | §4 |
| MIXED-59 | `docker exec -it dbcontainer psql -c "DROP TABLE x;"` (native PowerShell tool call) | block, PS-native wrapper-unwrapped | MC2-03 |
| MIXED-60 | `ssh dbhost psql -c "DROP TABLE x;"` (native PowerShell tool call) | block, PS-native wrapper-unwrapped | MC2-03 |
| MIXED-61 | `kubectl exec pod -- psql -c "DROP TABLE x;"` (native PowerShell tool call) | block, PS-native wrapper-unwrapped | MC2-03 |
| MIXED-62 | `podman run --rm img psql -c "..."` (native PowerShell tool call) | block, PS-native wrapper-unwrapped | MC2-03 |
| MIXED-63 | `mysql db<script.sql` | **allow** — glued redirect split, resolved via the SAME literal-file rule the spaced form gets (decision 1); corrected during implementation from an earlier draft's blanket "block" (see below) | MC2-01 |
| MIXED-64 | `psql -h localhost -d db<script.sql` | **allow**, same reasoning — glued redirect on a flag-bearing command, literal file | MC2-01 |
| MIXED-65 | `psql -h localhost -d db<(cat evil.sql)` | block, glued process substitution | MC2-01 |

**Implementation-time correction to MIXED-63/64.** MC2-01's finding text
reads "Should be: FRICTION, same as the spaced form" — but decision 1
(§2, §5) explicitly allows the SPACED literal-file form (`psql ... <
file.sql`), and MC2-01's own point is that the glued and spaced forms
are semantically IDENTICAL in every real shell and must be resolved by
the SAME logic, not that every glued redirect must block. Read
literally, "block, same as the spaced form" is self-contradictory once
the spaced form for a literal file is itself an ALLOW. The fix routes
BOTH forms through the identical §5 stdin-source table: a literal file
(`db<script.sql`) allows either way; a sentinel or process substitution
(`db<(cat evil.sql)`, `db</dev/stdin`, ...) FRICTIONs either way. This
is the reading that is actually internally consistent with decision 1
and was confirmed against the implementation (MIXED-63/64 initially
asserted "block" and failed against a correct implementation; the test
expectation was corrected, not the code, per the discipline in
`hooks/shell-write-guard.test.js`'s own tests where a "self-found bug"
is fixed at its source rather than the test loosened to match a wrong
result).
| MIXED-66 | `mysql -h attackerhost -u root -e "select 1"` | block on `-e`; `-h`/`-u` correctly consume `attackerhost`/`root` as their own arguments, no token-shift | MC2-02 |
| MIXED-67 | `mysql -h localhost -u root db < script.sql` (no `-e`) | allow, literal stdin redirect, arity-corrected connection flags | MC2-02 regression proof |
| MIXED-68 | `mysql -Cpassword123 db` (glued optional-arg compress-with-value shape) | allow, `-C` OPTIONAL-glued-only, does not misconsume `db` | MC2-04 |
| MIXED-69 | `mysql db extra positional` | block, positional 2+ FRICTION | MC2-08 |
| MIXED-70 | psql multi-line PowerShell backtick continuation with TRAILING WHITESPACE after the backtick, then `-f tmp.sql` | allow, "line-final" tolerates trailing whitespace | MC2-09 |

## 10. Work path

Unchanged in shape from v1: dispatch a drafting-tier adversary
against THIS revision before authoring (round 2) — the residuals in §11
are exactly its starting brief. Fix the spec again if round 2 finds a
real gap, then author, in `isolation: "worktree"`. Author and approver/
merger are two separate Agent invocations; author never approves/merges
its own PR. Poll CI in the foreground (`gh pr checks`, not `--watch`)
before handoff; every dispatch carries a `REPORT CAP: <N> words` line
plus the blind-spot-section requirement.

## 11. Blind spots

- **sqlite3's flag surface (§7.2) could not be fetched live in either
  round** — `sqlite.org`, a mirror, an alternate path, and a man-page
  aggregator all refused the connection from this environment
  (network-level, not a 404). Per explicit operator instruction received
  mid-round-2, this is now handled by policy rather than by
  reconstruction-from-memory: only `-cmd` (INLINE) and `-init` (FILE),
  plus the positional-2+ FRICTION rule, are asserted (decision-mandated,
  independent of the fetch); every other sqlite3 flag is UNKNOWN ->
  FRICTION until a live fetch confirms its real arity. This trades
  false blocks on ordinary formatting flags (`-csv`, `-list`, `-A`,
  etc.) for the guarantee that no flag's arity is asserted without a
  citation — re-attempt the fetch from a different network before
  relaxing this table.
- **docker/ssh/kubectl/wsl's own flag-with-arg lists (§4) are best-
  effort, not fetched against their current man pages this session.**
  An unlisted flag-with-arg for one of these wrappers would misalign
  the "skip N tokens then take the positional" walk, potentially
  mis-locating the inner verb. Same failure direction as above (blocks
  rather than silently escapes, since an inner-verb-not-found now
  FRICTIONs per §2 step 1) but should be spot-checked.
- **`docker run`'s full flag surface is not enumerated** (§4) — only
  the "skip one positional (image) before the inner verb" shape is
  specified; a `docker run` invocation with many flags before the image
  positional could misalign that walk. Flagged, not fixed, in this
  round.
- **PGOPTIONS and equivalent env-var SQL-injection channels (MC-09,
  accepted).** `PGOPTIONS="-c search_path=evil,pg_temp" psql -f
  tmp.sql` never puts `-c`/`--command` on psql's own command line —
  it's libpq's own startup-options string, invisible to a flag-role
  table by construction. Out of scope for a shell-command-line guard;
  would require env-var-value inspection, a different detector class
  entirely. Accepted, not fixed.
- **`--` end-of-options is deliberately not honored (MC-11, accepted).**
  Recommended lean, applied: none of psql/mysql/sqlite3 meaningfully
  support `--` as their own end-of-options marker in ordinary use, so
  NOT special-casing it avoids MC-11's false-allow failure mode (an
  attacker inserting a bare `--` to smuggle a later `-c` past role
  lookup) at the cost of a rare false block (a positional value that
  legitimately starts with `-` after an intentional `--`). Friction
  over escape, per canon.
- **Wrapper list is enumerable, not exhaustive (MC-02 residual,
  accepted).** A container/remote-exec launcher not in §4's table
  (e.g., a future `nerdctl exec`, `lxc exec`, `incus exec`) still falls
  through to `catchAllUnknownVerb` at the outer verb, unchanged from
  today. This was MC-02's explicitly rejected alternative (making
  `catchAllUnknownVerb` scan for `psql`/`sqlite3`/`mysql` anywhere in an
  unknown verb's own argument list) — accepted as an open-ended,
  add-as-discovered list rather than a broader heuristic.
- **`findPrimaryVerbIndex`'s new "wrapper-exhausted -> FRICTION" rule
  (§2 step 1) is a global behavior change, not scoped to `KNOWN_MIXED`.**
  It changes today's handling of `sudo -i` (interactive shell, no
  static command) and a bare `ssh host` (interactive session) from
  allow to block (MIXED-34, MIXED-35). This is almost certainly rare in
  agent-issued Bash calls and errs toward friction, consistent with
  canon, but it is a wider blast radius than this spec's stated
  problem and should be called out explicitly to whoever reviews the
  eventual PR, not discovered by them.
- **Cross-segment worst-branch aggregation (§4) is asserted as existing
  behavior from reading `splitSegments`, not independently re-traced
  through `analyzeBash`'s full top-level aggregation logic this
  session.** If aggregation across `;`/`&&`/`||`/`|` segments does NOT
  already take the branch-maximum, that's a pre-existing defect outside
  this tier's scope — flagged for the author to confirm before
  claiming MC-02's chaining ask is closed.
- **MC-16's `\o`/`\out` in-script directive is closed only as a
  consequence of MC-03/05/06's recognition fixes, not by any new
  `\o`-specific detector.** If a future normalization gap lets an
  INLINE-role flag go unrecognized again, `\o out.ps1` inside its value
  reaches `catchAllUnknownVerb`'s generic basename-slicing on a
  multi-word quoted blob — MC-16's own note that `\`-as-path-separator
  behavior there is untested and could split the SQL text oddly. Not
  re-tested this round; still a live blind spot if recognition ever
  regresses.
- **Real installed-binary version drift**: psql 16 and mysql 8.0's
  tables (§7.1, §7.3) come from the current official manuals, fetched
  this session, but were not cross-checked against an actually-
  installed binary's `--help` output — a distro-patched build could add
  or rename a flag.
- **SQL-level `:var` interpolation via psql `-v` (MC2-06, accepted).**
  `psql -v cond="1=1) OR (SELECT pg_sleep(5)" -f audit.sql`, where
  `audit.sql` is a real, tempfile-canon-compliant, non-ambiguous file
  containing `SELECT * FROM t WHERE (:cond);`, lets a `-v` value do
  exactly what `-c`/INLINE is supposed to unconditionally block,
  entirely undetected — `isAmbiguousToken` only catches SHELL
  metacharacters, and this payload is syntactically valid SQL text, not
  shell syntax. Distinct from MC-09 (env-var channel) and from MC-15's
  disposition (which addresses only shell-metachar injection via `-v`).
  Same rationale as MC-09: a different, SQL-level detector class,
  out of scope for a shell-command-line guard. Accepted, not fixed. If
  this residual is judged unacceptable in a future round, the
  documented alternative is to promote `-v` to INLINE-role (unconditional
  FRICTION) rather than BENIGN — noted here, not applied, since that
  would block the large majority of ordinary, safe `-v` usage
  (`ON_ERROR_STOP=1` and similar) as collateral.
- **`docker/podman/kubectl/ssh`'s PowerShell-native mirror table
  (§6.3, MC2-03) is a second, independent hand-implementation of §4's
  wrapper list, in a different tokenization context** — verifying the
  two stay behaviorally identical (same wrapper names, same
  flags-with-arg, same positional-skip counts) is a manual-parity
  burden this spec does not eliminate; a future wrapper added to one
  table and not the other silently reopens MC2-03's exact gap on
  whichever path was missed. Flagged for the author and for whoever
  reviews the eventual PR to check both tables were touched together.
- **sqlite3 remains unreachable from this environment across both
  rounds (four fetch attempts total)** — this is now treated as a
  standing environment condition, not a one-off transient failure;
  anyone re-running this spec's research step from a different network
  should re-attempt the live fetch before assuming the reconstructed
  table (§7.2) is final.

## 12. Adversary round 1 change log

| Finding | Disposition | One-line rationale |
|---|---|---|
| MC-01 | FIXED | `-f`/`-init` argument now always passes `isAmbiguousToken` plus the §5 stdin-source denylist; v1 skipped this entirely |
| MC-02 | FIXED | wrapper-unwrap list extended (§4); MC-02's own rejected alternative (scan-anywhere in catch-all) not taken |
| MC-03 | FIXED | `=`-splitting normalization before role lookup, every long flag (§6.1) |
| MC-04 | FIXED | spec now states explicit order: reassemble `=`-split PS clauses before role lookup, before `splitPsClauses`' own boundary split (§6.3) |
| MC-05 | FIXED | prefix-matching for glued short flags, every short flag (§6.2) |
| MC-06 | FIXED | `KNOWN_MIXED` flag-name matching ignores the `quoted` bit, a tier-scoped exception (§6.3) |
| MC-07 | FIXED | sqlite3 second-and-further positional is FRICTION (§7.2); inverts v1 test 8 |
| MC-08 | FIXED | mysql `-e`/`--execute`/`--init-command` added as INLINE-role (§7.3), per orchestrator decision 4; inverts v1 test 11 |
| MC-09 | ACCEPTED | env-var (`PGOPTIONS`) channel is invisible to a command-line flag-role table by construction; different detector class, out of scope |
| MC-10 | FIXED | `splitPsStatements` backtick line-continuation fix (§6.3) — a general PS-tokenization fix, required for this tier's own correctness |
| MC-11 | ACCEPTED | `--` deliberately not honored as end-of-options for any of the three CLIs (§2, §11) — friction over escape |
| MC-12 | FIXED | three separate literal per-CLI tables (§7), no shared bullet list; also corrects the `-c`=compress mislabel against the official mysql manual (`-c` is `--comments`; `-C` is `--compress`) — outcome (benign) unchanged, citation corrected |
| MC-13 | FIXED | every CLI's benign flags fully enumerated with arity (§7); nothing is silently absorbed into an unstated "other flags" bucket |
| MC-14 | FIXED | per-token fallthrough — an unrecognized token is FRICTION by itself; no `KNOWN_MIXED` token ever reaches `catchAllUnknownVerb` (§2, §3) |
| MC-15 | FIXED (best-effort) | full flag surface enumerated per CLI with source citations (§7); `-v`'s injection risk closed by the uniform ambiguity check, not a `-v`-specific rule; residual version-drift risk documented (§11) |
| MC-16 | FIXED (as consequence) | INLINE-role flags are content-blind FRICTION regardless of body; `\o` is moot once `-c`/`-cmd`/`-e` recognition itself is fixed (MC-03/05/06) — residual re-opens only if recognition regresses (§11) |
| MC-17 | ACCEPTED, clarified | one sentence added (§2): positional/connection-string tokens get the identical ambiguity/extension scan as any other token — no code change, v1's design already did this implicitly |

## 13. Adversary round 2 change log

| Finding | Disposition | One-line rationale |
|---|---|---|
| MC2-01 | FIXED | glued redirect/grouping operators split from their preceding word before role lookup, scoped to the `KNOWN_MIXED` pass only (not the shared `tokenize()` — safety against the full cross-hook suite was not attempted); ambiguity check extended for CONNECTION/positional tokens to include `<>()` (§5) |
| MC2-02 | FIXED | mysql `-h`/`-P`/`-u`/`-S` re-declared as required-argument (arity 1), re-verified against a fresh live fetch quoting each syntax line (§7.3) — round 1's own table had exactly the arity defect §7.2 warned about |
| MC2-03 | FIXED | `analyzePowerShell`'s own verb dispatch gets a mirrored wrapper-unwrap table and the same wrapper-exhausted rule (§6.3); new PS-native wrapper tests MIXED-59..62 (§9) |
| MC2-04 | FIXED | `OPTIONAL (glued-only)` added as a first-class fourth arity value in §2's vocabulary, not just a per-CLI footnote; `-C`/`--compress` identified as a second instance of the pattern; `-w`/`--wait` suspicion checked and ruled out (§7.3) |
| MC2-05 | FIXED | one sentence in §6.2: all `KNOWN_MIXED` flag matching is case-sensitive, an explicit exception to this file's PS-cmdlet case-insensitivity convention |
| MC2-06 | ACCEPTED | SQL-level `:var` interpolation via `-v` is a different, SQL-level detector class from the shell-metacharacter check `isAmbiguousToken` provides; same rationale as MC-09; documented in §11 with a named alternative (promote `-v` to INLINE) if this residual is later judged unacceptable |
| MC2-07 | VERIFIED, no defect | re-fetched the same doc URL: `-z`/`-0` are real short options, `-F`/`-f` are genuinely distinct options — round 1's table was already correct; citation-accuracy concern closed, not carried forward (§7.1) |
| MC2-08 | FIXED | mysql positional 2+ now explicitly FRICTION (§7.3), mirroring §7.2's sqlite3 precedent — closes the "which of two readings" ambiguity MC2-08 identified |
| MC2-09 | FIXED | "line-final" backtick precisely defined as "last non-whitespace character before `\n`," matching real PowerShell continuation semantics, not a strict last-character check (§6.3); new trailing-whitespace test MIXED-70 |

# shell-write-guard: KNOWN_MIXED tier for psql/sqlite3/mysql-style CLIs

## 0. TL;DR

The reconstructed blocked command: `psql -h localhost -U postgres -d
pipeline_pwa_etl -c "SELECT count(*) FILTER (WHERE source_model IS NULL)
AS pre_existing_null, count(*) AS total_all FROM assertions;"` — blocked
as `unknown-verb-ambiguous-argument` on the `-c` value. The `-f
<tempfile>.sql` form was never blocked; the house tempfile canon (never
inline `-c`) forbids `-c` anyway — this block is friction enforcing that
canon, not a false positive. Remaining gap: `psql` has no per-flag
awareness, so `-f`/`-o` isn't resolved by the catch-all. Fix: a
`KNOWN_MIXED` verb tier resolving flag roles per CLI, treating `-c` as
FRICTION (block, point at `-f`), falling through on unrecognized flags.

## 1. Problem

`catchAllUnknownVerb` (`hooks/shell-write-guard.js:1139-1155`) is the
default branch for any verb outside `KNOWN_READ_VERBS` (`:979-993`) and
`KNOWN_WRITE_VERBS` (`:1094-1098`). `psql` is deliberately excluded from
both per the comment at `:961-978`: wrappers whose subcommands can write
locally stay off the read allow-list (adversary testing found real
escapes, e.g. `wsl cp a.txt out.ps1`) — correct for the write side.
But the catch-all has no flag-role model: it blocks on the first argument
that is "ambiguous" (`isAmbiguousToken`, `:188`) or whose basename
classifies at branch ≥ 3 (`classifyExtension`, `:213`; check at
`:1148-1152`), unable to distinguish `-f input.sql` (read) from
`-o output.ps1` (write).

Verified via `classifyCommand`: under the live config (`.ps1`/`.psm1`/
`.psd1` gated, `.sql` not gated), `psql -h localhost -p 5432 -U postgres -d
<db> -f <tempfile>.sql` allows (branch 1) today and stays allowed once the
fix lands, even if `.sql` later enters `gatedExtensions`. `ADVV2-05`
(`hooks/shell-write-guard.test.js:1773`) proves the default-config `-f`
case. The structural defect: an unknown verb's `-f`-style read-flag
argument is extension-gated at all, and its `-o`-style write-flag
argument isn't distinguished — the CLI's own read/write contract should
decide, not a global extension list. The `-c` block is desired behavior,
made systematic here rather than accidental.

## 2. Total classification: `KNOWN_MIXED` tier

New tier alongside `KNOWN_READ_VERBS`/`KNOWN_WRITE_VERBS`: `KNOWN_MIXED` —
CLIs with a documented, stable input/output flag split: `psql`,
`sqlite3`, `mysql` (extend only with documented verbs).
Every token after the verb maps to exactly one branch — default is
friction, never silent allow:

- `-f`/`--file` (+ arg) -> READ/inert: never extension-gated; consumed,
  scan continues.
- `-c`/`--command` (+ arg) -> FRICTION: block as ambiguous inline SQL;
  block message names the `-f <tempfile>.sql` alternative; matches the
  reconstructed pwa-etl incident and enforces the tempfile canon instead
  of parsing SQL text for write intent.
- `-o`/`--output`, `\o` (psql meta-command), `--log-file`,
  `--result-file`/`--tee` (mysql) (+ arg) -> WRITE: resolve like
  `handleCurl`'s `-o` (extension/ambiguous check against `gatedExts`).
- bare `>`/`>>` on the stage -> already caught by `scanRedirects`, no
  change.
- other structural flags (`-h`, `-p`, `-U`, `-d`, ...) -> inert, consumed.
- any flag NOT in this verb's table -> **fall through unchanged to
  `catchAllUnknownVerb`** — never guess.

This keeps the tier total, not an allow-list: an unrecognized flag never
resolves safe by omission.

## 3. Invariant

**A verb's own documented read/write flag contract, where stable,
determines whether an argument is a write target — a global gated-extension
list must never veto an argument on a documented input/inert flag.**
Unrecognized flags on a mixed verb fall through to the catch-all exactly
as today.

## 4. Tests to add

Current: 341 tests (`grep -c "^t(" hooks/shell-write-guard.test.js`).
Predicted after this change: 355 (+14, prefix `MIXED-NN`).

1. `psql -f x.sql` -> allow (ADVV2-05 covers default config)
2. same, `gatedExtensions: [".sql"]` -> allow (new; proves the fix)
3. `psql -h localhost -p 5432 -U postgres -d db -f tmp.sql`, `.sql` gated
   -> allow (incident shape)
4. `psql -c "select 1"` -> block (incident shape)
5. `psql -o out.ps1` -> block (branch 4)
6. `psql -o out.txt` -> allow (WRITE role, non-gated target)
7. `psql --output=out.ps1` -> block (`=` form)
8. `sqlite3 db.sqlite ".read x.sql"` -> allow
9. `sqlite3 -o out.ps1 db.sqlite` -> block
10. `mysql -e "select 1" --result-file=out.ps1` -> block
11. `mysql -e "select 1" db` -> allow
12. `psql --unknown-flag out.ps1` -> block, catch-all fall-through
13. `psql -f x.sql -o out.ps1` -> block, target `out.ps1`
14. `psql -c "select 1"` -> block message contains `-f`

## 5. Config guidance

Live config `~/.claude/hooks/shell-write-guard.config.json`:
`{"gatedExtensions": [".ps1", ".psm1", ".psd1"]}` — **`.sql` is not
currently gated.** Loader: `CONFIG_PATH = path.join(HOOKS_DIR,
"shell-write-guard.config.json")`, `HOOKS_DIR = __dirname`
(`hooks/shell-write-guard.js:137-138`), falling back to
`DEFAULT_GATED_EXTENSIONS` (`:140`, same three extensions) — matches the
default.

Recommendation: do not add `.sql` to `gatedExtensions` — it's a legitimate,
high-volume read target (`psql -f`, `sqlite3 .read`) and gating it makes
the catch-all's flaw fire routinely. §2's fix holds regardless of config
value, removing the "extension happens to be gated" dependency so a
future config change can't reintroduce this as collateral damage.

## 6. Work path

Adversary-before-author: dispatch a `model: "sonnet"` adversary against
this spec first — glued flags (`-ffile.sql`), `=`-joined flags, quoted
tokens, psql `\o` inside `-c` strings, piped mixed verbs. Fix the spec,
then author, in `isolation: "worktree"`. Author and approver/merger are
two separate Agent invocations; author never approves/merges its own PR.
Poll CI in the foreground (`gh pr checks`, not `--watch`) before handoff;
every dispatch carries a `REPORT CAP: <N> words` line plus the
blind-spot-section requirement.

## 7. Blind spots

- The 14 tests cover one probe plus the reconstructed incident; an
  undocumented or version-dependent flag (e.g. a `mysql` alias for
  `--result-file`) could slip past READ if the per-verb table stales.
- `mysql -e` plays the same role as `psql -c` but isn't in the FRICTION
  row (tests 10/11 unchanged) — inconsistent by omission, not fixed here
  since it wasn't the incident's shape.
- `\o`/`\out` are psql in-script directives, not flags; §2 doesn't
  distinguish the two, so `-c "\o out.ps1"` may go uncaught — left for
  the adversary pass.
- Does not audit other classified verbs (`git`, `curl`) for their own
  gaps; scope is the new tier only.

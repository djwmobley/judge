# Spec v2 — PowerShell assignment total classification (judge shell-write-guard, backlog #30)

Source: planning-tier plan v1, 2026-09-24, amended with owner-orchestrator rulings R1-R5
on the spec-adversary's findings (`adversary-ps-assign-judge-2026-09-24.md`,
harness `adversary-ps-harness-judge-2026-09-24.js`, same directory). v2
changes are called out inline as **R1**-**R5**; everything else is v1,
unchanged. **R3a** (this revision, same day) further amends R3's braced-LHS
`${...}` classification per a second spec-adversary pass
(`adversary-r3a-judge-2026-09-24.md`, harnesses `r3a-probe-judge-2026-09-24.ps1`
/ `r3a-tokenize-judge-2026-09-24.ps1` / `r3a-tokenize2-judge-2026-09-24.ps1`,
same directory) — see the R3a section below.

**Root cause:** `splitPsClauses` (`hooks/shell-write-guard.js`) split on
every bare `=`, so `$env:PROJECT_ROOT = "..."` became a verb-less clause ->
unrecognized-clause path -> `isAmbiguousToken` sees `$` -> branch 4. Also
`$x = $y`, `$x = $(...)`, `$x = @{...}` RHS yielded a stray `$`/`@` fragment
via the `(`/`{` split. A command combining a legitimate PS-native env
assignment with an otherwise-fine following statement (`$env:PROJECT_ROOT =
"..."; node scripts/handoff.js status`) blocked the WHOLE statement even
though `node scripts/handoff.js status` alone is allowed.

**Approach:** detect a PowerShell assignment as its own construct —
anchored to the statement's own start, bracket/paren-depth aware — and
classify its LHS and RHS separately. Everything not recognized as an
assignment keeps today's split (no behavior change). Default for anything
unclassified = existing block path (branch 4, friction).

## R2 (owner ruling) — architecture: statement-anchored, depth-aware split

v1 originally proposed tagging clauses with an `assign-lhs`/`assign-rhs`
role INSIDE `splitPsClauses`'s own single left-to-right scan, at the `=`
character. The spec adversary found this unreachable for the "index
containing `(`" LHS branch (finding A1): `splitPsClauses` already splits
unconditionally on any `(` not preceded by an identifier character, in the
SAME left-to-right pass, BEFORE the `=`-lookback would ever run — so by the
time `=` is reached in `$a[(Set-Content x.ps1)] = 1`, the LHS-candidate text
handed to LHS parsing is only the orphaned fragment after the `(` split,
never the whole `$a[(Set-Content x.ps1)]` shape.

**Ruling:** assignment detection is a SEPARATE, statement-anchored,
bracket/paren-depth-aware forward scan (`findPsAssignmentSplit`), run before
`splitPsClauses` for the statement, not embedded in it:

- Tracks depth over `(`, `[`, `{` (with `${...}` treated as one atomic
  unit — see item 1a below); an `=` seen at depth > 0, or inside `[...]`,
  is not an assignment-operator candidate at all (existing behavior — the
  scan just keeps going).
- The FIRST `=` found at depth 0 (accounting for compound-assignment
  prefixes `+= -= *= /= %= ??=`) is the only candidate ever considered —
  there is no fallback scan for a LATER `=` in the same statement.
- **Assignment detected only if the ENTIRE text from statement start to
  that operator parses as a valid LHS** (`parsePsAssignmentLhs`). If it does
  not, the whole statement is conclusively NOT an assignment and falls
  through, unchanged, to the existing unconditional `splitPsClauses`-based
  dispatch — this is what keeps `Write-Output $x=1`, `node a --x=$y`, `cmd
  /c set X=1` from ever being misread as assignments (none of their
  pre-`=` text starts with `$`).
- This split-first design is what makes the "index containing `(`" branch
  reachable at all: `$a[(Set-Content x.ps1)] = 1`'s depth-aware scan
  correctly locates the `=` AFTER the whole `[(...)]` index span closes, so
  `parsePsAssignmentLhsSingle` receives the complete LHS text and can
  inspect the index content for an embedded `(`.

## Change points (v1, still in effect except where R2 supersedes)

1. `splitPsClauses` — (a) treat `${...}` as an atomic unit (skip to
   matching `}`, no brace split at either delimiter) — UNCHANGED from v1,
   applies unconditionally (not just in assignment contexts), fixing
   `${env:X}` fragmentation generally. (b) the `=`-lookback role-tagging
   from v1 is SUPERSEDED by R2 — `splitPsClauses` itself still treats bare
   `=` as a hard clause boundary, unchanged, for every other caller.
2. New helpers: `findPsAssignmentSplit`, `parsePsAssignmentLhs` /
   `parsePsAssignmentLhsSingle`, `classifyPsBracedLhs`, `applySuffixChain`,
   `looksLikePsBracedPath`, `splitTopLevelCommas`, `classifyPsAssignmentRhs`,
   `psRhsHasQuotedSubexpression`, `isPsRhsPureExpression`,
   `isReservedLhsVarName`.
3. `analyzePsStatement` — assignment detection runs first; when detected,
   LHS and RHS are classified independently and the statement's own
   unconditional `splitPsClauses`/`classifyPsClauses` loop is SKIPPED for
   that statement (RHS text that is not "pure" is instead routed through
   `classifyPsClauses`, the SAME loop, extracted into its own function so
   it can be reused for RHS-only text without duplicating logic — see
   "existing dispatch" below). When no assignment is detected, the
   statement runs through `classifyPsClauses` exactly as before — zero
   behavior change.
4. Clause-boundary comment (top of the `analyzePsStatement` section)
   updated to describe the new architecture.
5. **Untouched**: `isAmbiguousToken`, `classifyPsClauseArguments`, the
   whole-statement redirect scan (`>`, `>>`) at the end of
   `analyzePsStatement` — this runs unconditionally on the full statement
   text regardless of assignment status, which is what still catches `$x =
   Get-Content a > out.ps1` (branch 3) even though neither the LHS nor the
   "existing dispatch" RHS classification of `Get-Content a` on its own
   would see the redirect.

## LHS branches

| Form | Result |
|---|---|
| `$v`, `$scope:v` or `${scope:v}` (scope in global/local/script/private/variable/env/function/alias) | no finding, UNLESS **R1** applies (see below) |
| above + member/index (`.p`, `[lit]`, `[$i]`, chainable) | no finding, same R1 exception |
| index containing `(` (bracket/paren-depth aware — see R2) | branch 4 `assignment-lhs-index-paren` |
| `[T]`/`[T[]]` prefixes, then valid form | no finding |
| `$a, $b` list | **R4**: each element classified independently, worst wins |
| `${...}` braced, content has NO ASCII `:` | **R3a-1**: plain-`$name` semantics (R1 reserved-check, then suffix chain) — no path carve-out |
| `${X:\path}` (provider path, content HAS a colon; writes the file) | **R3a-2**/R3: `resolveTarget(path)` |
| `${...}` braced, content HAS a colon, any other unrecognized qualifier | **R3a-2**/R3: branch 4 `assignment-lhs-provider` |
| `${...}` braced, content contains a backtick (any position) | **R3a-3**: branch 4 `assignment-lhs-escape` |
| `$X:name` (unbraced) with any other qualifier (incl. `using`) | branch 4 `assignment-lhs-provider` |
| anything else (doesn't even start with `$`/`[`) | not an assignment; existing split |

### R1 (owner ruling) — reserved automatic/preference variables (escape E1)

**Finding E1 (adversary, HIGH):** `$PSDefaultParameterValues['Out-File:FilePath']
= 'out.ps1'` passed v1's LHS table as written (`$v` + literal-index member
access -> "no finding") because `PSDefaultParameterValues` is syntactically
just a plain variable. This is PowerShell's real "default parameter value"
mechanism: after this line, ANY subsequent bare `Out-File` call in the same
session silently writes to `out.ps1` with no path token visible at the call
site — a genuine indirect write-target injection that the installing
statement itself carries zero gated text for.

**Ruling:** the LHS `$v`/`${v}` "no finding" bucket does not apply when the
base variable name is a documented reserved variable. Total classification:

An LHS whose base variable name — case-insensitive, under any scope prefix
or braced form (including `${variable:X}`) — is:
- a documented PowerShell **automatic variable** (`about_Automatic_Variables`) or
  **preference variable** (`about_Preference_Variables`), enumerated in
  `PS_RESERVED_LHS_VARS` in `hooks/shell-write-guard.js` (`_`, `args`,
  `consolefilename`, `error`, `event`, `eventargs`, `eventsubscriber`,
  `executioncontext`, `foreach`, `home`, `host`, `input`, `lastexitcode`,
  `matches`, `myinvocation`, `nestedpromptlevel`, `pid`, `profile`, `pwd`,
  `sender`, `shellid`, `stacktrace`, `switch`, `this`, `true`, `false`,
  `null`, `errorview`, `formatenumerationlimit`, `logcommandhealthevent`,
  `logcommandlifecycleevent`, `logenginehealthevent`,
  `logenginelifecycleevent`, `logproviderlifecycleevent`,
  `logproviderhealthevent`, `maximumaliascount`, `maximumdrivecount`,
  `maximumerrorcount`, `maximumfunctioncount`, `maximumhistorycount`,
  `maximumvariablecount`, `ofs`, `outputencoding`, `transcript`), OR
- starts with `PS` (covers `PSDefaultParameterValues`, `PSBoundParameters`,
  `PSCmdlet`, `PSScriptRoot`, ... every other `PS*` automatic variable), OR
- ends with `Preference` (covers every remaining preference variable not
  already listed, e.g. `ErrorActionPreference`, `WhatIfPreference`,
  `ConfirmPreference`, `VerbosePreference`, ...)

-> branch 4 `assignment-lhs-reserved`.

**`env:` scope is exempt**: `$env:PSModulePath = "..."` is a no-finding
in-memory-shaped assignment even though `PSModulePath` itself starts with
`PS` — environment-variable assignment cannot install a parameter-binding
default, and is exactly the shape backlog #30 exists to unblock.

Tests: `$PSDefaultParameterValues['Out-File:FilePath'] = 'out.ps1'` blocks
(branch 4, `assignment-lhs-reserved`); `$WhatIfPreference = $false` blocks;
`$ErrorActionPreference = 'Stop'` blocks (accepted friction); `$env:PSModulePath
= "C:\mods"` allowed.

**Disclosed consequence (not a v1 requirement, a side effect of the
blanket enumeration R1 requires):** `$null`, `$true`, `$false` are
themselves documented automatic variables, so `$null = New-Item out.ps1`
(v1's own "must still block" list, annotated branch (3) there) now blocks
via `assignment-lhs-reserved` (branch 4) at the LHS stage, rather than via
RHS resolution (branch 3) as v1's un-amended design would have produced.
The command is blocked either way (`allow: false` in both cases) — only
the winning branch/detector differs. Flagged explicitly rather than
silently reinterpreting the spec's branch-number annotations.

### R2 — index containing `(` (escape/dead-branch A1)

See "R2 (owner ruling) — architecture" above. Covered by the
statement-anchored, depth-aware `findPsAssignmentSplit` design, which is
what makes this LHS-table row reachable in the first place. Test:
`$a[(Set-Content x.ps1)] = 1` -> branch 4 `assignment-lhs-index-paren`.

### R3 (owner ruling) — braced `${...}` "other qualifier" (O1)

**Finding O1 (adversary, MEDIUM):** v1's LHS table wrote the "any other
qualifier -> branch 4 `assignment-lhs-provider`" rule only for the
UNBRACED `$X:name` shape. Once item 1a makes `${...}` atomic, a braced
form with an unrecognized qualifier (`${using:x}`, `${foo:bar}`) has no
explicit rule to match against it — a symmetric bullet was missing, and a
loose regex for the "safe scope" bucket could have silently readmitted it.

**Ruling:** `${...}` content is classified explicitly, symmetric to the
unbraced case, by exact Set membership (never a loose prefix regex):
1. `scope:name` where `scope` (case-insensitive) is exactly one of the 8
   allowed scopes -> treated exactly like the unbraced scoped-variable case
   (R1 reserved-check on `name`, `env` exempt), plus any trailing
   member/index chain applied the same way.
2. else, content that looks like a provider PATH — drive letter (`X:\` or
   `X:/`), a UNC prefix (`\\host\share`), any `\` or `/` path separator, or
   a leading `.` (`${.\out.ps1}`, relative-path shorthand) — writes that
   file: `resolveTarget(path)`.
3. else (e.g. `${using:x}`, `${foo:bar}`) -> branch 4
   `assignment-lhs-provider`.

Tests: `${foo:bar} = 1` -> branch 4; `${using:out} = 1` -> branch 4;
`${.\out.ps1} = 'x'` -> **SUPERSEDED by R3a below** (colon-less content is
now unconditionally plain-variable semantics, not a path — see R3a-1);
`${C:\t\out.ps1} = 'x'` -> resolves and blocks (branch 3, v1's own "must
still block" case, unaffected by R3a since it contains a colon);
`${env:X} = 1` -> no finding.

### R3a (owner ruling) — braced LHS colon-gated classification + shared
### backtick-aware brace scan (spec-adversary pass, `adversary-r3a-judge-
### 2026-09-24.md`, harnesses `r3a-probe-judge-2026-09-24.ps1` /
### `r3a-tokenize-judge-2026-09-24.ps1` / `r3a-tokenize2-judge-2026-09-24.ps1`)

**Finding F1 (adversary, MEDIUM, over-block/spec-correctness, not a
bypass):** R3's `looksLikePsBracedPath` carve-out (`\`/`/`/leading-`.`/
leading-`~`/UNC) tests a condition PowerShell's `${...}` grammar never
satisfies without a colon-qualified drive — confirmed via AST
(`VariablePath.IsDriveQualified` is unconditionally `false` for colon-less
content across backslash, forward-slash, UNC, leading-`.`, and leading-`~`
variants) and via live execution (`${\foo\bar.ps1} = 'x'` creates an
in-memory variable literally named `\foo\bar.ps1`; zero files touched).
Blocking is the safe direction, so this was not an escape, but it defeats
R3's own stated purpose (backlog #30 exists to REMOVE false-positive
over-blocking) and produces exactly that: `${.\out.ps1} = 5`, `${~} = 'x'`,
and similar harmless colon-less assignments blocked for no real-world
reason.

**Finding F2 (adversary, investigated, NOT exploitable, hardened anyway):**
a backtick-escaped `}` inside braced content (`` ${a`}b} ``, or inside a
drive path `` ${C:\folder`}name\out.ps1} ``) made every braced-variable
scan's naive `indexOf("}")` stop at the escaped `}`, truncating the content
before PowerShell's real (unescaped) end — confirmed via AST that the real
`UserPath` for the drive-path case is the full, gated
`C:\folder}name\out.ps1`, which the old JS scan never saw. No live bypass
was found: the truncated JS content always retains the literal,
un-interpreted backtick, and `isAmbiguousToken`'s unconditional
backtick-match rule caught every case anyway — but that protection was
accidental (an unrelated ambiguity rule), not designed, and every reserved
name in `PS_RESERVED_LHS_VARS` is `}`-free so none can ever need
backtick-escaping in the first place (no reserved-name evasion path
exists). Hardened per the ruling below rather than relying on the
accident.

**Findings F3/F4 (adversary, confirmed no-op, informational):** Unicode
lookalikes for `:` (U+FF1A) and `/` (U+2215) are not special to PowerShell
and are not normalized by the current ASCII-only character tests (no bug);
a backtick before a real colon (`` ${a`:b} ``) does not suppress the colon
as a scope separator in real PowerShell, and the existing raw-text ASCII
colon scan already sees it and routes correctly (no bug) — both confirmed
via AST/live execution, no change required for either.

**Ruling:**

- **R3a-1 (supersedes R3's colon-less path carve-out):** braced LHS
  `${...}` content with **NO ASCII `:`** is unconditionally plain-`$name`
  semantics — R1 reserved-name check on the whole content as the base name
  (no scope prefix exists in this shape), then the existing member/index
  suffix-chain rules (R2 index-`(` check still applies). The
  `\`/`/`/leading-`.`/leading-`~`/UNC "path-like" carve-out is REMOVED
  entirely for colon-less content — PowerShell only provider-qualifies
  braced content with an ASCII colon (`VariablePath.IsDriveQualified`).
  Examples: `${name} = 1`, `${my var} = 1`, `${.\out.ps1} = 5` -> no
  finding; `${PSDefaultParameterValues} = @{}` / `${null} = 1` -> R1
  branch 4 `assignment-lhs-reserved`.
- **R3a-2 (unchanged):** braced content **WITH** an ASCII `:` keeps
  existing R3 exactly as written above (scope-membership test, else
  path-like resolution, else `assignment-lhs-provider`) — untouched by
  this amendment.
- **R3a-3 (new, explicit):** braced content containing a backtick
  (anywhere, regardless of colon presence) -> branch 4
  `assignment-lhs-escape` — explicit and unconditional, replacing today's
  accidental `isAmbiguousToken`-backstop protection (F2) with a designed
  one. Checked FIRST, before the colon-presence branch above.
- **R3a-4 (new, shared helper):** every braced-variable scan site
  (`parsePsAssignmentLhsSingle`'s LHS brace parse, `findPsAssignmentSplit`,
  `splitTopLevelCommas`, and `splitPsClauses`'s `${...}` atomic-unit skip)
  is rewritten to call ONE shared helper, `findPsBracedClose(text, start)`,
  that scans forward from just after the opening `${` for the TRUE closing
  `}`, treating a backtick as escaping the next character (so an escaped
  `` `} `` is skipped as one unit, never mistaken for the real close). An
  unterminated `${` (no unescaped `}` before the end of the text) ->
  `findPsBracedClose` returns "not found", which the LHS parser
  (`parsePsAssignmentLhsSingle`) turns into branch 4
  `assignment-lhs-malformed` (unchanged from today's unterminated-brace
  handling, now reached via the shared scan instead of an ad hoc one); the
  non-LHS scan sites (statement/clause splitting, comma splitting) treat an
  unterminated span as running to the end of the text, exactly as before —
  they have no "branch" of their own to force, and the downstream LHS
  parse (or `isAmbiguousToken`) is what applies friction if the resulting
  text is actually part of an assignment.

Tests: `${name} = 1`, `${my var} = 1`, `${.\out.ps1} = 5` -> no finding
(R3a-1); `${PSDefaultParameterValues} = @{}`, `${null} = 1` -> branch 4
`assignment-lhs-reserved` (R3a-1 + R1); `` ${a`}b} = 1 `` -> branch 4
`assignment-lhs-escape` (R3a-3); `` ${C:\folder`}name\out.ps1} = 1 `` ->
branch 4 `assignment-lhs-escape` (R3a-3 + R3a-4 — the shared scan finds the
TRUE closing brace, so the LHS sees the full, backtick-bearing content
rather than a truncated one); comma list with colon-less braced elements:
`${a}, $b = 1,2` -> allowed (R3a-1 + R4), `${a}, ${C:\x.ps1} = 1,2` ->
resolves and blocks via the second (colon-bearing) element (R3a-1 for the
first element, R3a-2/R3 for the second, R4 worst-wins); Unicode lookalike
colon `${a：b} = 1` (U+FF1A, not ASCII `:`) -> no finding, plain-variable
semantics per R3a-1 (F3 confirms no normalization bug is needed); the R1
regression `$env:PROJECT_ROOT = "C:\x"; node scripts/handoff.js status`
remains allowed (unaffected — `env:` is an unbraced scope prefix, not
routed through `classifyPsBracedLhs` at all).

## Blind spots carried from the R3a adversary pass (not probed; see
## `adversary-r3a-judge-2026-09-24.md` for the full list)
- `-EncodedCommand`/base64-wrapped braced assignments, and braced LHS
  reached via `pwsh -Command` inline-body recursion
  (`handleInterpreterInline`) — only the native PowerShell-tool path was
  exercised.
- Unicode fuzzing beyond U+FF1A and U+2215 (e.g. U+2024 one-dot-leader as a
  leading-dot lookalike, or RTL/bidi-control-character obfuscation) was not
  attempted.
- PowerShell Core vs Windows PowerShell 5.1 version skew was not tested for
  any of F1-F4 (all live verification ran on one machine's installed
  `pwsh` only).
- No live end-to-end file-write trigger was attempted for the F2
  drive-path case (deliberately, per floor constraints) — F2's conclusion
  rests on AST inspection, not a live write-then-check.
- `findPsAssignmentSplit`'s and `splitTopLevelCommas`'s own independent
  copies of the shared brace scan were re-derived from the same
  `findPsBracedClose` helper as the LHS-parsing copy, but the adversary
  pass itself only traced the LHS-parsing copy (`parsePsAssignmentLhsSingle`)
  against real PowerShell semantics in full; the other two call sites share
  the same helper and reasoning by construction, not by independent
  re-derivation against a live parser.

### R4 (owner ruling) — comma-list LHS split algorithm (O2, CONTIGUITY)

**Finding O2 (adversary, spec-ambiguity/contiguity risk):** v1 never stated
how a comma-list LHS (`$a, $b = 1, 2`) is split — specifically (a) how a
real list separator is distinguished from a comma nested inside `[...]`
(`$a[1,2], $b = ...`), and (b) what happens when one element fails to
parse: silently dropped (an escape) or forced to branch 4 (friction,
correct)? Per canon, an unstated contiguity/split algorithm over
human-editable text is exactly the pattern that must be closed explicitly,
not left to interpretation.

**Ruling:** the LHS candidate text is split on depth-0 commas ONLY
(`splitTopLevelCommas` — bracket/paren/brace-depth aware, `${...}`
atomic, mirroring `findPsAssignmentSplit`'s own depth tracking, so
`$a[1,2], $b` splits correctly into `$a[1,2]` and `$b`). Once 2+ top-level
segments exist, the text is conclusively treated as an assignment (never
falls back to "not an assignment" from here). **Every element must
independently parse as a valid single LHS; an element that does not is
branch 4 `assignment-lhs-unparseable-element`, never silently dropped** —
worst element (by branch) wins for the whole LHS.

Tests: `$a, $b = 1,2` -> no finding (allowed); `$a[1,2], $b = @(1,2), 3` ->
nesting-aware split verified (both elements valid, allowed — RHS
separately not "pure" but resolves to no gated content); `$a, 1+1 = 2, 3`
-> branch 4 `assignment-lhs-unparseable-element` (`1+1` is not a valid LHS
element).

## RHS branches

| Form | Result |
|---|---|
| empty | branch 4 `assignment-rhs-empty` |
| `"…$(…)…"` / `@"…$(…)…"@` (interpolated subexpression in a double-quoted string or here-string) | branch 4 `rhs-subexpression` — checked BEFORE the pure-expression grammar, on RAW (unblanked) text |
| **R5**: pure expression (closed token grammar) | no finding |
| only `$`/`@` remnant from `$(`, `@(`, `@{` as the FIRST clause of "existing dispatch" | no finding for that one clause; every clause nested inside it still classified as today |
| cmdlet, native, `& …`, `. …`, `[T]::M(…)`, `New-Object`, scriptblock body, `$v.M(…)`, anything else not pure | existing dispatch (`classifyPsClauses`, unmodified clause logic, run on just the RHS text) |
| pipeline / redirection | unchanged — whole-statement redirect scan, untouched |

### R5 (owner ruling) — "pure expression" closed token grammar (A2, A3)

**Finding A2 (adversary, spec-ambiguity):** v1's "pure expression" bucket
excluded text containing "`-op`" with no defined operator list — a narrow
implementation (e.g. only comparison operators) could misclassify
`-f`/`-replace`/`-join`/`-split`/`-as`/`-is` as pure, though actual
exploitability was judged low since real invocation still needs `(`
(separately excluded).

**Finding A3 (adversary, low severity):** whether a literal-only
double-quoted here-string (`@"...out.ps1..."@`, no `$(...)`) counts as
"pure" was unstated, though consistent with the spec's own declared policy
delta (a literal RHS naming a gated file is intentionally allowed).

**Ruling:** define "pure expression" as a CLOSED token grammar — the
ENTIRE trimmed RHS text must tokenize exhaustively (whitespace-separated)
into ONLY these token types, with nothing left over:
- numeric literal, `$true`/`$false`/`$null`
- single-quoted string (`'...'`, `''` escapes a literal quote)
- double-quoted string OR double-quoted here-string **with no `$(`**
  (resolves A3 directly: `@"...out.ps1..."@` alone is pure)
- single-quoted here-string (`@'...'@` — never interpolated in real
  PowerShell, always pure)
- a variable/accessor with no `(` (`$v`, `$scope:v`, chained `.member` or
  `[literal-index]`, but the index content itself must not contain `(`)
- **any `-word` operator** — `-eq`, `-f`, `-replace`, `-join`, `-split`,
  `-as`, `-is`, anything shaped `-[A-Za-z]+` — with **no enumerated
  allow-list** (resolves A2 directly: no operator is special-cased in or
  out)
- punctuation: `+ - * / % , .. ! [ ]` (bare `.` is NOT standalone
  punctuation — member access already covers it via the variable/accessor
  token)

Any token outside this grammar (most notably a bare `(` — not a token type
at all here) fails the WHOLE-RHS pure check and falls through to existing
dispatch. This is a total classification, not an allow-list of safe
constructs mixed with a denylist of dangerous ones: unknown shapes always
fall to the safer "existing dispatch" branch, never to "pure".

Tests: `$x = $y`, `$x += 1`, `$x ??= Get-Date`, `$h = @{a=1}`, `$r =
@(1,2)`, `$x = "out.ps1"`, `$x = @"\nout.ps1\n"@` all allowed;
`"{0}" -f (Set-Content out.ps1 -Value 'y')` still falls through to existing
dispatch (the `-f` operator alone doesn't disqualify it, the following `(`
does) and still blocks (branch 3, via the nested `Set-Content` clause).

## Tests (beside PSD1-16 at `shell-write-guard.test.js:1279`)

Now allowed:
- `$env:PROJECT_ROOT = "C:\x"; node scripts/handoff.js status` (asserted:
  `node scripts/handoff.js status` alone is allowed as a PowerShell-tool
  baseline first)
- `$x = $y`, `$x += 1`, `$x ??= Get-Date`, `[string]$s = 'a'`, `$a[0] = 1`,
  `$a.b = $c`, `$a,$b = 1,2`
- `${env:X} = 1`, `$x = $(Get-Date)`, `$h = @{a=1}`, `$r = @(1,2)`,
  `$x = "out.ps1"`, `$x = @"\nout.ps1\n"@`
- **R3a**: `${name} = 1`, `${my var} = 1`, `${.\out.ps1} = 5` (colon-less
  braced LHS, R3a-1); `${a}, $b = 1,2` (colon-less braced element in a
  comma list, R3a-1 + R4); `${a：b} = 1` (Unicode lookalike colon, F3,
  still plain-variable per R3a-1)

Unchanged: `Write-Host "a=b"`, `git log --format=%H`, `if ($a -eq 1) {}`;
CALLOP-07/09; WHATIF-05..07 (none of these carry a top-level, depth-0 `=`,
so `findPsAssignmentSplit` never fires and they run the identical,
untouched `classifyPsClauses` path).

Must still block:
- `$x = Set-Content -Path out.ps1 -Value y` (RHS existing dispatch)
- `$null = New-Item out.ps1` (LHS `assignment-lhs-reserved`, branch 4 — see
  R1's disclosed consequence above; v1 annotated this branch (3))
- `$x = [IO.File]::WriteAllText('out.ps1','x')` (RHS existing dispatch)
- `$x = & $cmd a.ps1` (RHS existing dispatch, call operator)
- `$x = $w.Write('out.ps1')` (RHS existing dispatch, unrecognized clause)
- `$x = "$(Set-Content out.ps1)"` (RHS `rhs-subexpression`)
- `$x = Get-Content a > out.ps1` (whole-statement redirect scan, untouched)
- `${C:\t\out.ps1} = 'x'` (LHS provider-path resolution)
- `$c:foo = 1` (LHS `assignment-lhs-provider`)
- `$a[(Set-Content x.ps1)] = 1` (LHS `assignment-lhs-index-paren`)
- `$sb = { Set-Content out.ps1 }` (RHS existing dispatch)
- SPLAT-01 (gated hashtable value; unaffected — verified no regression)
- **R3a**: `${PSDefaultParameterValues} = @{}`, `${null} = 1` (colon-less
  reserved name, `assignment-lhs-reserved`, R3a-1 + R1); `` ${C:\folder`}name\out.ps1} = 1 ``
  (backtick in braced content, `assignment-lhs-escape`, R3a-3 + R3a-4 —
  shared scan finds the TRUE closing brace so the escape is actually seen);
  `${a}, ${C:\x.ps1} = 1,2` (colon-bearing element in a comma list still
  resolves and blocks, R3a-2 + R4)

Unit: `splitPsClauses` `${...}` atomic-unit behavior; `findPsAssignmentSplit`
depth/compound-op detection; `parsePsAssignmentLhs`/`parsePsAssignmentLhsSingle`
branch coverage; `classifyPsAssignmentRhs`/`isPsRhsPureExpression` token
grammar coverage; `splitTopLevelCommas` nesting; `findPsBracedClose`
backtick-aware close-scan coverage (R3a-4).

Policy delta: literal RHS naming a gated file (`$x = "out.ps1"`,
`$x = @"...out.ps1..."@`) now allowed — later `$x` use as a target is
already ambiguous-blocked (verified sound by the adversary pass: every
downstream cmdlet-argument use of a variable token is caught by
`isAmbiguousToken`'s unconditional `$`-match regardless of how the string
was built).

## Known blind spots (from v1 planner, still accurate)
- `--flag=$var` in native commands: not an assignment; existing false
  positive stays.
- `$(...)` inside strings OUTSIDE assignments still invisible
  (`blankPsQuotesForScan`) — the new `psRhsHasQuotedSubexpression` check
  only runs for assignment RHS text, not general command arguments.
- `;` inside `${a;b}` still breaks statement splitting.
- Property setters with side effects (`$fi.IsReadOnly = $false`) treated as
  in-memory (LHS parses as plain member-access, branch 1).
- Scriptblocks classified as if executed (intentional, over-blocking).
- `param()` defaults and `if ($a = …)` keep old split (no depth-0 `=` at
  statement start in the latter case — the `=` is inside the `(...)`
  condition, depth > 0).
- Multi-line here-strings depend on `splitPsStatements`/`stripPsComments`/
  `joinPsLineContinuations` handling of `@"` upstream of everything here.
- Worktree copy `.claude/worktrees/init-routing-qa` not covered.
- No live `pwsh` interpreter was run to verify parser-level semantics (e.g.
  whether a given multi-letter custom PSDrive name is even valid syntax) —
  all classification is argued from the language spec and general
  PowerShell knowledge, mirroring the adversary pass's own disclosed
  methodology.
- Chained/nested assignment in a single statement (`$a = $b = 1`) is not
  specifically designed for: `findPsAssignmentSplit` only ever considers
  the FIRST depth-0 `=`, so the outer assignment is detected and its RHS
  (`$b = 1`) is handled by "existing dispatch" (the unmodified
  `classifyPsClauses`/`splitPsClauses` path) rather than being recursively
  re-classified as its own nested assignment — untested, unspecified by
  v1, not required by any owner ruling.
- `applySuffixChain`'s index-content "`(`" check operates on the
  blanked-quotes scan text, so a literal `(` INSIDE a quoted index key
  (`$a['(']`) is correctly excluded from triggering `assignment-lhs-index-
  paren` — but this was reasoned from the blanking logic, not verified
  against a live parser.

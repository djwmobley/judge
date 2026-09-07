"use strict";
// shell-write-guard.test.js
// Unit + integration tests for the shell-write-guard PreToolUse hook.
// Run with:  node hooks/shell-write-guard.test.js (from the repo root)
//
// Style matches no-punt-guard.test.js: node:test + node:assert, named tests,
// "Results: N passed, M failed" summary line, exit 1 on any failure.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOK_PATH = path.join(__dirname, "shell-write-guard.js");
const {
  classifyCommand,
  analyzeBash,
  classifyExtension,
  resolveTarget,
  isAmbiguousToken,
  detectCmdCIndirection,
  detectHeredocFedInterpreter,
  detectStderrClobberRedirects,
  isKnownReadVerb,
  classifyVerbToken,
  catchAllUnknownVerb,
  checkFindNamePattern,
  checkFindFprintFamily,
  blankPsQuotesForScan,
  detectDotNetIoMutation,
  isDynamicInterpreterBody,
  classifyFileStreamAccess,
  isPsVerbPosition,
  findPsVerbPositionMatch,
  findHasDeleteOrWriteExecAction,
  findHasFprintFamilyFlag,
  splitPsClauses,
  isPsKnownReadVerb,
  isPsKnownWriteVerb,
  normalizePsColonParams,
  resolvePsKnownWriteClause,
  findPsCallOperatorRest,
  psNamedFlagValue,
  psWhatIfSuppresses,
  stripBashComments,
  stripPsComments,
  extractPsPositionals,
  resolvePsAmbiguousPositionals,
  extractFirstStringLiteral,
  splitPsStatements,
  loadConfig,
  DEFAULT_GATED_EXTENSIONS,
  normalizeRawCommandForStateDirCheck,
} = require(HOOK_PATH);

const GATED = DEFAULT_GATED_EXTENSIONS.slice(); // [".ps1", ".psm1", ".psd1"]
const TMPDIR = os.tmpdir();

function bash(cmd, cwd) { return classifyCommand(cmd, cwd || "C:\\work", "Bash", GATED); }
function ps(cmd, cwd) { return classifyCommand(cmd, cwd || "C:\\work", "PowerShell", GATED); }

// ── Pass/fail counter + "Results: N passed, M failed" summary line ─────────
// node:test already exits 1 on failure when run directly (node <file>.js);
// this wrapper additionally prints the required literal summary line and
// makes the exit-1-on-failure behavior explicit rather than implicit.
let __passed = 0, __failed = 0;
function t(name, fn) {
  test(name, async () => {
    try {
      await fn();
      __passed++;
    } catch (e) {
      __failed++;
      throw e;
    }
  });
}
process.on("exit", () => {
  console.log(`Results: ${__passed} passed, ${__failed} failed`);
  if (__failed > 0) process.exitCode = 1;
});

function runHook(payload) {
  let exitCode = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync("node", [HOOK_PATH], { input: JSON.stringify(payload), encoding: "utf8", timeout: 10000 });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stdout = err.stdout ? String(err.stdout) : "";
    stderr = err.stderr ? String(err.stderr) : "";
  }
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Branch 1: no write detected -> allow
// ---------------------------------------------------------------------------

t("B1-01: git status -> allow", () => {
  assert.equal(bash("git status").allow, true);
});

t("B1-02: git commit -m with prose mentioning cp/sed -> allow (quoted, not a verb)", () => {
  const r = bash('git commit -m "cp foo > bar.ps1 sed -i notes"');
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("B1-03: cat/grep read-only -> allow", () => {
  assert.equal(bash("cat foo.ps1").allow, true);
  assert.equal(bash("grep -n TODO foo.ps1").allow, true);
});

t("B1-04: git add / diff / status -> allow", () => {
  assert.equal(bash("git add foo.ps1").allow, true);
  assert.equal(bash("git diff foo.ps1").allow, true);
  assert.equal(bash("git status").allow, true);
});

t("B1-05: git mv (tracked rename) -> explicitly allowed", () => {
  const r = bash("git mv old.ps1 new.ps1");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("B1-06: bare script invocation (node x.js) -> allowed, no inline body", () => {
  assert.equal(bash("node script.js").allow, true);
  assert.equal(bash("pwsh -File deploy.ps1").allow, true);
  assert.equal(bash("python run.py").allow, true);
});

t("B1-07: gated extension appearing only as a read/exec argument -> allow", () => {
  assert.equal(bash("Get-Content foo.ps1").allow, true); // bash tool, PS-named read cmdlet as plain word
  assert.equal(bash("cat ./scripts/foo.ps1").allow, true);
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

t("R-01: echo x > foo.ps1 -> BLOCK (branch 3)", () => {
  const r = bash("echo x > foo.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 3);
});

t("R-02: echo x > foo.txt -> allow (branch 2)", () => {
  const r = bash("echo x > foo.txt");
  assert.equal(r.allow, true); assert.equal(r.branch, 2);
});

t("R-03: echo x >> foo.ps1 -> BLOCK", () => {
  assert.equal(bash("echo x >> foo.ps1").allow, false);
});

t("R-04: 2>&1 -> allow (stderr-to-stdout, never a file write)", () => {
  const r = bash("npm install 2>&1 | tail -5");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("R-05: > /dev/null -> allow", () => {
  assert.equal(bash("some_cmd > /dev/null").allow, true);
});

// ---------------------------------------------------------------------------
// tee
// ---------------------------------------------------------------------------

t("T-01: cmd | tee foo.ps1 -> BLOCK", () => {
  assert.equal(bash("echo x | tee foo.ps1").allow, false);
});

t("T-02: cmd | tee -a foo.txt -> allow", () => {
  assert.equal(bash("echo x | tee -a foo.txt").allow, true);
});

// ---------------------------------------------------------------------------
// sed -i
// ---------------------------------------------------------------------------

t("SED-01: sed -i 's/a/b/' foo.ps1 -> BLOCK", () => {
  assert.equal(bash("sed -i 's/a/b/' foo.ps1").allow, false);
});

t("SED-02: sed -i.bak 's/a/b/' foo.ps1 -> BLOCK (suffix form)", () => {
  assert.equal(bash("sed -i.bak 's/a/b/' foo.ps1").allow, false);
});

t("SED-03: sed 's/a/b/' foo.ps1 (no -i) -> allow, no write", () => {
  assert.equal(bash("sed 's/a/b/' foo.ps1").allow, true);
});

// ---------------------------------------------------------------------------
// cp / mv / install + directory-destination join rule
// ---------------------------------------------------------------------------

t("CP-01: cp a.txt b.ps1 -> BLOCK (dest gated)", () => {
  assert.equal(bash("cp a.txt b.ps1").allow, false);
});

t("CP-02: cp a.ps1 b.txt -> allow (dest not gated; source not tracked for cp/mv)", () => {
  const r = bash("cp a.ps1 b.txt");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("CP-03: cp a.ps1 dest/ -> BLOCK (dir-join: dest/a.ps1)", () => {
  const r = bash("cp a.ps1 dest/");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.match(r.target, /dest\/a\.ps1$/);
});

t("CP-04: cp a.txt dest/ -> allow (dir-join: dest/a.txt)", () => {
  assert.equal(bash("cp a.txt dest/").allow, true);
});

t("CP-05: cp a.ps1 dest (no trailing slash, no extension) -> BLOCK (no-ext dest treated as dir)", () => {
  assert.equal(bash("cp a.ps1 dest").allow, false);
});

t("CP-06: install -m 0644 a.txt b.ps1 -> BLOCK", () => {
  assert.equal(bash("install -m 0644 a.txt b.ps1").allow, false);
});

t("CP-07: npm install (package-manager subcommand) -> allow, never treated as coreutils install", () => {
  assert.equal(bash("npm install some-package").allow, true);
});

t("CP-08: mv a.ps1 b.txt -> allow (documented residual — see report adversary section)", () => {
  const r = bash("mv a.ps1 b.txt");
  assert.equal(r.allow, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// dd / truncate
// ---------------------------------------------------------------------------

t("DD-01: dd if=a of=b.ps1 -> BLOCK", () => {
  assert.equal(bash("dd if=a of=b.ps1").allow, false);
});

t("DD-02: dd if=a of=b.txt -> allow", () => {
  assert.equal(bash("dd if=a of=b.txt").allow, true);
});

t("TR-01: truncate -s 0 foo.ps1 -> BLOCK", () => {
  assert.equal(bash("truncate -s 0 foo.ps1").allow, false);
});

t("TR-02: truncate -s 0 foo.txt -> allow", () => {
  assert.equal(bash("truncate -s 0 foo.txt").allow, true);
});

// ---------------------------------------------------------------------------
// rsync / ln / curl / wget / tar / unzip / rename / perl / vim
// ---------------------------------------------------------------------------

t("RS-01: rsync a.txt b.ps1 (local) -> BLOCK", () => {
  assert.equal(bash("rsync a.txt b.ps1").allow, false);
});

t("RS-02: rsync a.txt user@host:b.ps1 (remote) -> allow, not a local write", () => {
  assert.equal(bash("rsync a.txt user@host:b.ps1").allow, true);
});

t("LN-01: ln -sf target link.ps1 -> BLOCK", () => {
  assert.equal(bash("ln -sf target link.ps1").allow, false);
});

t("LN-02: ln -s target link.ps1 (no -f) -> allow, not detected by this hook", () => {
  assert.equal(bash("ln -s target link.ps1").allow, true);
});

t("CURL-01: curl -o out.ps1 http://x -> BLOCK", () => {
  assert.equal(bash("curl -o out.ps1 http://x").allow, false);
});

t("CURL-02: curl -O http://x/out.ps1 -> BLOCK (unresolvable, remote-derived name)", () => {
  const r = bash("curl -O http://x/out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("CURL-03: curl -o out.txt http://x -> allow", () => {
  assert.equal(bash("curl -o out.txt http://x").allow, true);
});

t("WGET-01: wget -O out.ps1 http://x -> BLOCK", () => {
  assert.equal(bash("wget -O out.ps1 http://x").allow, false);
});

t("WGET-02: wget -O out.txt http://x -> allow", () => {
  assert.equal(bash("wget -O out.txt http://x").allow, true);
});

t("TAR-01: tar -xzf archive.tar.gz -> BLOCK (archive contents unknown, always)", () => {
  const r = bash("tar -xzf archive.tar.gz");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("TAR-02: tar -cf archive.tar.gz foo.txt (create, not extract) -> allow", () => {
  assert.equal(bash("tar -cf archive.tar.gz foo.txt").allow, true);
});

t("UNZIP-01: unzip -o archive.zip -> BLOCK (always)", () => {
  assert.equal(bash("unzip -o archive.zip").allow, false);
});

t("UNZIP-02: unzip archive.zip (no -o) -> allow, not detected", () => {
  assert.equal(bash("unzip archive.zip").allow, true);
});

t("REN-01: rename old.ps1 new.ps1 -> BLOCK (plain two-arg rename)", () => {
  assert.equal(bash("rename old.ps1 new.ps1").allow, false);
});

t("REN-02: perl-style rename 's/foo/bar/' *.ps1 -> BLOCK (unresolvable pattern)", () => {
  const r = bash("rename 's/foo/bar/' file.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("PERL-01: perl -i -pe 's/a/b/' foo.ps1 -> BLOCK", () => {
  assert.equal(bash("perl -i -pe 's/a/b/' foo.ps1").allow, false);
});

t("PERL-02: perl -pi -e 's/a/b/' foo.ps1 -> BLOCK", () => {
  assert.equal(bash("perl -pi -e 's/a/b/' foo.ps1").allow, false);
});

t("PERL-03: perl -e 's/a/b/' foo.ps1 (no -i) -> allow", () => {
  assert.equal(bash("perl -e 's/a/b/' foo.ps1").allow, true);
});

t("VIM-01: vim -c wq foo.ps1 -> BLOCK", () => {
  assert.equal(bash("vim -c wq foo.ps1").allow, false);
});

t("VIM-02: vim foo.ps1 (no -c wq) -> allow", () => {
  assert.equal(bash("vim foo.ps1").allow, true);
});

// ---------------------------------------------------------------------------
// base64 -d + redirect (covered by the generic redirect detector)
// ---------------------------------------------------------------------------

t("B64-01: base64 -d payload.b64 > out.ps1 -> BLOCK via generic redirect", () => {
  assert.equal(bash("base64 -d payload.b64 > out.ps1").allow, false);
});

// ---------------------------------------------------------------------------
// node/python/pwsh/powershell -e/-c/-Command inline bodies
// ---------------------------------------------------------------------------

t("INL-01: node -e writeFileSync('out.ps1', ...) -> BLOCK (resolvable literal)", () => {
  const r = bash(`node -e "require('fs').writeFileSync('out.ps1','x')"`);
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("INL-02: python -c open('out.txt','w').write(...) -> allow (resolvable, not gated)", () => {
  const r = bash(`python -c "open('out.txt','w').write('x')"`);
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("INL-03: pwsh -Command Set-Content -Path out.ps1 -> BLOCK", () => {
  const r = bash(`pwsh -Command "Set-Content -Path 'out.ps1' -Value x"`);
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("INL-04: node -e with write API but no extractable literal path -> BLOCK (unresolvable)", () => {
  const r = bash(`node -e "fs.writeFileSync(path.join(dir, name), data)"`);
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("INL-05: node -e with no write API at all -> allow", () => {
  assert.equal(bash(`node -e "console.log('hello world')"`).allow, true);
});

// ---------------------------------------------------------------------------
// Heredoc-fed interpreter
// ---------------------------------------------------------------------------

t("HD-01: node <<'EOF' ... writeFileSync ... EOF -> BLOCK", () => {
  const cmd = "node <<'EOF'\nrequire('fs').writeFileSync('out.txt','x');\nEOF";
  const r = bash(cmd);
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("HD-02: node <<'EOF' with no write API -> allow", () => {
  const cmd = "node <<'EOF'\nconsole.log('hi');\nEOF";
  assert.equal(bash(cmd).allow, true);
});

// ---------------------------------------------------------------------------
// git content-mutation verbs
// ---------------------------------------------------------------------------

t("GIT-01: git checkout -- foo.ps1 -> BLOCK", () => {
  assert.equal(bash("git checkout -- foo.ps1").allow, false);
});

t("GIT-02: git restore foo.ps1 -> BLOCK", () => {
  assert.equal(bash("git restore foo.ps1").allow, false);
});

t("GIT-03: git apply patch.diff -> BLOCK (always, patch target unknowable)", () => {
  const r = bash("git apply patch.diff");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("GIT-04: git stash pop -> BLOCK (always)", () => {
  assert.equal(bash("git stash pop").allow, false);
});

t("GIT-05: git stash apply -> BLOCK (always)", () => {
  assert.equal(bash("git stash apply").allow, false);
});

t("GIT-06: git reset --hard foo.ps1 (with pathspec) -> BLOCK", () => {
  assert.equal(bash("git reset --hard foo.ps1").allow, false);
});

t("GIT-07: git reset --hard (bare, no pathspec) -> allow, out of this hook's scope", () => {
  assert.equal(bash("git reset --hard").allow, true);
});

t("GIT-08: git mv foo.ps1 bar.ps1 -> allow (explicit)", () => {
  assert.equal(bash("git mv foo.ps1 bar.ps1").allow, true);
});

// ---------------------------------------------------------------------------
// cmd /c indirection (documented residual heuristic)
// ---------------------------------------------------------------------------

t("CMDC-01: cmd /c \"copy a.txt b.ps1\" -> BLOCK (gated ext + write verb in body)", () => {
  assert.equal(bash('cmd /c "copy a.txt b.ps1"').allow, false);
});

t("CMDC-02: cmd /c \"echo hi > out.txt\" (no gated ext) -> allow", () => {
  assert.equal(bash('cmd /c "echo hi > out.txt"').allow, true);
});

t("CMDC-03: cmd.exe /c 'move a.txt b.ps1' -> BLOCK", () => {
  assert.equal(bash("cmd.exe /c 'move a.txt b.ps1'").allow, false);
});

// ---------------------------------------------------------------------------
// PowerShell tool_name (same field, tool_input.command)
// ---------------------------------------------------------------------------

t("PS-01: Set-Content -Path out.ps1 -Value x -> BLOCK", () => {
  const r = ps(`Set-Content -Path out.ps1 -Value x`);
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("PS-02: Set-Content -Path out.txt -Value x -> allow", () => {
  assert.equal(ps(`Set-Content -Path out.txt -Value x`).allow, true);
});

t("PS-03: Get-Content out.ps1 (read) -> allow", () => {
  assert.equal(ps(`Get-Content out.ps1`).allow, true);
});

t("PS-04: Select-String -Path out.ps1 -Pattern foo -> allow (read)", () => {
  assert.equal(ps(`Select-String -Path out.ps1 -Pattern foo`).allow, true);
});

t("PS-05: Get-Content x.txt | Out-File out.ps1 -> BLOCK (pipe to Out-File)", () => {
  assert.equal(ps(`Get-Content x.txt | Out-File out.ps1`).allow, false);
});

t("PS-06: New-Item -Path out.psm1 -ItemType File -> BLOCK", () => {
  assert.equal(ps(`New-Item -Path out.psm1 -ItemType File`).allow, false);
});

t("PS-07: sc out.ps1 hello -> BLOCK (Set-Content alias)", () => {
  assert.equal(ps(`sc out.ps1 hello`).allow, false);
});

t("PS-08: Invoke-ScriptAnalyzer -Path out.ps1 -> allow (read, explicitly allowed)", () => {
  assert.equal(ps(`Invoke-ScriptAnalyzer -Path out.ps1`).allow, true);
});

t("PS-09: [System.IO.File]::WriteAllText('out.ps1','x') -> BLOCK", () => {
  const r = ps(`[System.IO.File]::WriteAllText('out.ps1','x')`);
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("PS-10: Get-ChildItem (unrelated word 'description' must not false-trigger sc) -> allow", () => {
  assert.equal(ps(`Get-ChildItem | Where-Object description -eq 'foo'`).allow, true);
});

// ---------------------------------------------------------------------------
// Override anchor (position-0 only; never mid-command/quoted)
// ---------------------------------------------------------------------------

t("OV-01: SHELL_WRITE_OK=1 prefix at position 0 -> allow (overridden)", () => {
  const r = bash("SHELL_WRITE_OK=1 echo x > foo.ps1");
  assert.equal(r.allow, true); assert.equal(r.overridden, true);
});

t("OV-02: marker NOT at position 0 (leading whitespace) -> still blocks", () => {
  const r = bash("  SHELL_WRITE_OK=1 echo x > foo.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("OV-03: marker quoted mid-command -> still blocks (not an override)", () => {
  const r = bash('echo "SHELL_WRITE_OK=1 " > foo.ps1');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("OV-04: marker appears later in the command (not position 0) -> still blocks", () => {
  const r = bash("echo hi && SHELL_WRITE_OK=1 echo x > foo.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// Ambiguous targets ($VAR, glob, backtick)
// ---------------------------------------------------------------------------

t("AMB-01: echo x > $OUT -> BLOCK (variable-sourced target)", () => {
  const r = bash("echo x > $OUT");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("AMB-02: echo x > *.ps1 -> BLOCK (glob target)", () => {
  const r = bash("echo x > *.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("AMB-03: cp a.txt \"$(compute_name)\" -> BLOCK (command-substitution target)", () => {
  const r = bash('cp a.txt "$(compute_name)"');
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("AMB-04: echo x > `backtick_name` -> BLOCK", () => {
  const r = bash("echo x > `backtick_name`");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

// ---------------------------------------------------------------------------
// Multi-dot / trailing-suffix extension evasion (spec item 5)
// ---------------------------------------------------------------------------

t("EXT-01: cp a.txt out.ps1.bak -> BLOCK (first segment gated, branch 4)", () => {
  const r = bash("cp a.txt out.ps1.bak");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("EXT-02: cp a.txt out.ps1~ -> BLOCK (trailing-suffix evasion, branch 4)", () => {
  const r = bash("cp a.txt out.ps1~");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("EXT-03: cp a.txt out.tar.gz -> allow (unrelated multi-dot)", () => {
  assert.equal(bash("cp a.txt out.tar.gz").allow, true);
});

t("EXT-04: cp a.txt out.ps1 -> BLOCK (branch 3, single clean extension)", () => {
  const r = bash("cp a.txt out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 3);
});

// ---------------------------------------------------------------------------
// Case / backslash / MSYS path variants
// ---------------------------------------------------------------------------

t("CASE-01: echo x > file.PS1 (uppercase ext) -> BLOCK", () => {
  assert.equal(bash("echo x > file.PS1").allow, false);
});

t("CASE-02: echo x > .\\x.ps1 (backslash-relative) -> BLOCK", () => {
  assert.equal(bash("echo x > .\\x.ps1", "C:\\work").allow, false);
});

t("CASE-03: echo x > /c/home/testuser/out.ps1 (MSYS absolute) -> BLOCK, normalized target", () => {
  const r = bash("echo x > /c/home/testuser/out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.target, "c:/home/testuser/out.ps1");
});

// ---------------------------------------------------------------------------
// cd-aware relative resolution
// ---------------------------------------------------------------------------

t("CD-01: cd C:\\other && echo x > rel.ps1 -> BLOCK, resolved against cd target not stdin cwd", () => {
  const r = bash("cd C:\\other && echo x > rel.ps1", "C:\\work");
  assert.equal(r.allow, false);
  assert.equal(r.target, "c:/other/rel.ps1");
});

t("CD-02: no stdin cwd at all + relative redirect target -> BLOCK (unresolvable, branch 4)", () => {
  const r = classifyCommand("echo x > rel.ps1", null, "Bash", GATED);
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("CD-03: absolute target ignores an earlier cd -> resolves directly", () => {
  const r = bash("cd C:\\other && echo x > C:\\abs\\out.ps1", "C:\\work");
  assert.equal(r.allow, false);
  assert.equal(r.target, "c:/abs/out.ps1");
});

t("CD-04: cd with ambiguous ($ ) argument -> INDETERMINATE thereafter -> BLOCK on later relative target", () => {
  const r = bash("cd $HOME/proj && echo x > rel.ps1", "C:\\work");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

// ---------------------------------------------------------------------------
// sudo/env/xargs/-exec command-position unwrapping
// ---------------------------------------------------------------------------

t("WRAP-01: sudo cp a.txt b.ps1 -> BLOCK", () => {
  assert.equal(bash("sudo cp a.txt b.ps1").allow, false);
});

t("WRAP-02: sudo -u root cp a.txt b.ps1 -> BLOCK", () => {
  assert.equal(bash("sudo -u root cp a.txt b.ps1").allow, false);
});

t("WRAP-03: env FOO=1 cp a.txt b.ps1 -> BLOCK", () => {
  assert.equal(bash("env FOO=1 cp a.txt b.ps1").allow, false);
});

t("WRAP-04: bare VAR=val prefix cp a.txt b.ps1 -> BLOCK", () => {
  assert.equal(bash("FOO=1 cp a.txt b.ps1").allow, false);
});

t("WRAP-05: find . -exec cp a.txt b.ps1 {} -> BLOCK (command position after -exec)", () => {
  assert.equal(bash("find . -exec cp a.txt b.ps1 {}").allow, false);
});

t("WRAP-06: something | xargs tee out.ps1 -> BLOCK (command position after xargs)", () => {
  assert.equal(bash("something | xargs tee out.ps1").allow, false);
});

// ---------------------------------------------------------------------------
// D1: total verb classification (was an allow-list)
// ---------------------------------------------------------------------------

t("D1-01: xcopy a.txt out.ps1 -> BLOCK (unknown verb, gated arg, friction default)", () => {
  const r = bash("xcopy a.txt out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
  assert.match(r.detector, /xcopy/);
});

t("D1-02: robocopy src dest out.ps1 -> BLOCK (unknown verb, gated arg)", () => {
  const r = bash("robocopy src dest out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("D1-03: PowerShell copy alias — copy a.txt out.ps1 -> BLOCK (real resolution, added to write set)", () => {
  const r = ps("copy a.txt out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("D1-04: PowerShell copy alias — copy a.ps1 out.txt -> allow (proves target = dest, not blanket block)", () => {
  assert.equal(ps("copy a.ps1 out.txt").allow, true);
});

t("D1-05: PowerShell ac alias (Add-Content) — ac out.ps1 'hello' -> BLOCK", () => {
  assert.equal(ps("ac out.ps1 'hello'").allow, false);
});

t("D1-06: PowerShell ni alias (New-Item) — ni out.psm1 -ItemType File -> BLOCK", () => {
  assert.equal(ps("ni out.psm1 -ItemType File").allow, false);
});

t("D1-07: unknown verb + gated argument -> BLOCK (branch 4)", () => {
  const r = bash("frobnicate a.txt out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("D1-08: unknown verb + no gated argument -> allow (branch 1)", () => {
  assert.equal(bash("frobnicate a.txt b.txt").allow, true);
});

t("D1-09: read-only verbs with a .ps1 argument all allow regardless", () => {
  const cmds = [
    "cat foo.ps1", "less foo.ps1", "head foo.ps1", "tail foo.ps1",
    "grep x foo.ps1", "rg x foo.ps1", "wc -l foo.ps1", "file foo.ps1",
    "stat foo.ps1", "ls foo.ps1", "diff a.ps1 foo.ps1",
    "git add foo.ps1", "git commit -m foo.ps1", "git diff foo.ps1",
    "git status foo.ps1", "git log foo.ps1", "git show foo.ps1",
    "git fetch foo.ps1", "git pull foo.ps1", "git push foo.ps1",
    "git rev-parse foo.ps1", "git ls-files foo.ps1", "git check-ignore foo.ps1",
    "git branch --list foo.ps1", "find . -type f foo.ps1",
    "curl http://x/foo.ps1", "node run.js foo.ps1",
    "Invoke-ScriptAnalyzer -Path foo.ps1", "Get-Content foo.ps1",
    "Get-ChildItem foo.ps1",
  ];
  for (const c of cmds) {
    const r = bash(c);
    assert.equal(r.allow, true, `expected allow for "${c}", got ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------------------
// D2: find -exec placeholder ambiguity + -name pattern gating
// ---------------------------------------------------------------------------

t("D2-01: find . -exec sed -i s/a/b/ {} -> BLOCK ({} ambiguous for a write verb)", () => {
  const r = bash("find . -exec sed -i s/a/b/ {}");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("D2-02: find -name '*.ps1' -exec rm {} -> BLOCK (independent -name gating signal)", () => {
  const r = bash("find . -name '*.ps1' -exec rm {}");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("D2-03: find -exec grep foo {} -> allow (read verb, no -name gating)", () => {
  assert.equal(bash("find . -exec grep foo {}").allow, true);
});

t("D2-04: {}+ terminator form is also ambiguous", () => {
  const r = bash("find . -exec sed -i s/a/b/ {}+");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

// ---------------------------------------------------------------------------
// D3: stderr / clobber redirects
// ---------------------------------------------------------------------------

t("D3-01: cat file.txt 2> out.ps1 -> BLOCK (stderr redirect truncates the file)", () => {
  const r = bash("cat file.txt 2> out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("D3-02: cat file.txt 2>> out.ps1 -> BLOCK (append form)", () => {
  assert.equal(bash("cat file.txt 2>> out.ps1").allow, false);
});

t("D3-03: cat file.txt &> out.ps1 -> BLOCK (combined stdout+stderr)", () => {
  assert.equal(bash("cat file.txt &> out.ps1").allow, false);
});

t("D3-04: cat file.txt >| out.ps1 -> BLOCK (clobber override)", () => {
  assert.equal(bash("cat file.txt >| out.ps1").allow, false);
});

t("D3-05: cat file.txt 2>&1 -> allow (fd duplication, not a write)", () => {
  assert.equal(bash("cat file.txt 2>&1").allow, true);
});

t("D3-06: cat file.txt 2>/dev/null -> allow", () => {
  assert.equal(bash("cat file.txt 2>/dev/null").allow, true);
});

t("D3-07: PowerShell Get-Content x.txt 2> out.ps1 -> BLOCK", () => {
  assert.equal(ps("Get-Content x.txt 2> out.ps1").allow, false);
});

t("D3-08: PowerShell Get-Content x.txt 2>$null -> allow", () => {
  assert.equal(ps("Get-Content x.txt 2>$null").allow, true);
});

// ---------------------------------------------------------------------------
// D5: PowerShell -WhatIf and quoted-cmdlet-name false positives
// ---------------------------------------------------------------------------

t("D5-01: Set-Content -Path out.ps1 -Value x -WhatIf -> allow (simulate only)", () => {
  assert.equal(ps("Set-Content -Path out.ps1 -Value x -WhatIf").allow, true);
});

t("D5-02: Write-Host \"Run Set-Content -Path out.ps1\" -> allow (cmdlet name only inside a quoted string)", () => {
  const r = ps('Write-Host "Run Set-Content -Path out.ps1"');
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("D5-03: blankPsQuotesForScan preserves string length (index alignment)", () => {
  const text = 'Write-Host "Run Set-Content -Path out.ps1"';
  assert.equal(blankPsQuotesForScan(text).length, text.length);
});

// ---------------------------------------------------------------------------
// E1: full .NET file/directory mutating surface
// ---------------------------------------------------------------------------

t("E1-01: [System.IO.File]::AppendAllText('out.ps1','x') -> BLOCK", () => {
  const r = ps("[System.IO.File]::AppendAllText('out.ps1','x')");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("E1-02: [IO.File]::ReadAllText('a.ps1') -> allow (read, not in the mutating surface)", () => {
  assert.equal(ps("[IO.File]::ReadAllText('a.ps1')").allow, true);
});

t("E1-03: [IO.File]::Copy('a.txt','out.ps1') -> BLOCK", () => {
  assert.equal(ps("[IO.File]::Copy('a.txt','out.ps1')").allow, false);
});

t("E1-04: [IO.File]::Delete('out.ps1') -> BLOCK", () => {
  assert.equal(ps("[IO.File]::Delete('out.ps1')").allow, false);
});

t("E1-05: [System.IO.Directory]::CreateDirectory('out.ps1') -> BLOCK", () => {
  assert.equal(ps("[System.IO.Directory]::CreateDirectory('out.ps1')").allow, false);
});

t("E1-06: New-Object System.IO.StreamWriter('out.ps1') -> BLOCK", () => {
  assert.equal(ps("New-Object System.IO.StreamWriter('out.ps1')").allow, false);
});

t("E1-07: [IO.File]::Open('out.ps1', [IO.FileMode]::Create) -> BLOCK (Open qualified by Create marker)", () => {
  const r = ps("[IO.File]::Open('out.ps1', [IO.FileMode]::Create)");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("E1-08: [IO.File]::Open('a.ps1', [IO.FileMode]::Open) -> allow (Open with no write/create/append marker)", () => {
  // FileMode.Open itself does not satisfy /write|create|append/i.
  assert.equal(ps("x = [IO.File]::Open('a.ps1', [IO.FileMode]::Open)").allow, true);
});

t("UNIT-12: detectDotNetIoMutation recognizes ReadAllText as null (not a mutation)", () => {
  assert.equal(detectDotNetIoMutation("[IO.File]::ReadAllText('a.ps1')"), null);
});

t("E1-09: [IO.File]::OpenWrite('out.ps1') -> BLOCK (self-found fix: method name itself is the write marker)", () => {
  const r = ps("[IO.File]::OpenWrite('out.ps1')");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("E1-10: [IO.File]::OpenText('a.ps1') -> allow (OpenText is a READ API despite starting with Open)", () => {
  assert.equal(ps("[IO.File]::OpenText('a.ps1')").allow, true);
});

t("UNIT-13: extractFirstStringLiteral finds the first quoted literal", () => {
  assert.equal(extractFirstStringLiteral("AppendAllText('out.ps1','x')"), "out.ps1");
});

// ---------------------------------------------------------------------------
// E2: -WhatIf scoped per statement
// ---------------------------------------------------------------------------

t('E2-01: Get-ChildItem -WhatIf; Set-Content -Path out.ps1 -Value x -> BLOCK (branch 3, second statement)', () => {
  const r = ps("Get-ChildItem -WhatIf; Set-Content -Path out.ps1 -Value x");
  assert.equal(r.allow, false); assert.equal(r.branch, 3);
});

t("E2-02: Set-Content -Path out.ps1 -Value x -WhatIf -> allow (its own statement carries -WhatIf)", () => {
  assert.equal(ps("Set-Content -Path out.ps1 -Value x -WhatIf").allow, true);
});

t("E2-03: splitPsStatements splits on ; | && ||", () => {
  const segs = splitPsStatements("a; b | c && d || e");
  assert.equal(segs.length, 5);
});

t("E2-04: splitPsStatements does not split inside a quoted string", () => {
  const segs = splitPsStatements('Write-Host "a; b | c"');
  assert.equal(segs.length, 1);
});

// ---------------------------------------------------------------------------
// E3: find -name gating requires a qualifying mutating action
// ---------------------------------------------------------------------------

t("E3-01: find . -name '*.ps1' (no mutating action) -> allow", () => {
  assert.equal(bash("find . -name '*.ps1'").allow, true);
});

t("E3-02: find . -name '*.ps1' -delete -> BLOCK (delete qualifies)", () => {
  const r = bash("find . -name '*.ps1' -delete");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("E3-03: find . -name '*.ps1' -exec grep foo {} -> allow (exec'd verb is read, not qualifying)", () => {
  assert.equal(bash("find . -name '*.ps1' -exec grep foo {}").allow, true);
});

t("E3-04: find . -name '*.ps1' -exec cp {} out.ps1 -> BLOCK (exec'd verb is write, qualifies)", () => {
  const r = bash("find . -name '*.ps1' -exec cp {} out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("E3-05: find . -fprint out.ps1 (no -name) -> BLOCK (own file operand resolves like a redirect)", () => {
  const r = bash("find . -fprint out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("E3-06: find . -fprint out.txt -> allow (not gated)", () => {
  assert.equal(bash("find . -fprint out.txt").allow, true);
});

t("UNIT-14: checkFindFprintFamily resolves -fls target", () => {
  const stage = [
    { value: "find", quoted: false }, { value: ".", quoted: false },
    { value: "-fls", quoted: false }, { value: "out.ps1", quoted: false },
  ];
  const r = checkFindFprintFamily(stage, "C:\\work", GATED);
  assert.equal(r.branch, 3);
});

// ---------------------------------------------------------------------------
// E4: extended read-only utilities
// ---------------------------------------------------------------------------

t("E4-01: du -h *.ps1 -> allow", () => {
  assert.equal(bash("du -h *.ps1").allow, true);
});

t("E4-02: sort a.ps1 > b.ps1 -> BLOCK (redirect still caught independently)", () => {
  const r = bash("sort a.ps1 > b.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 3);
});

t("E4-03: awk '{print}' foo.ps1 -> allow (no -i)", () => {
  assert.equal(bash("awk '{print}' foo.ps1").allow, true);
});

t("E4-04: awk -i inplace '{print}' foo.ps1 -> BLOCK (unknown-verb catch-all once -i disqualifies read status)", () => {
  const r = bash("awk -i inplace '{print}' foo.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("E4-05: md5sum foo.ps1 -> allow", () => {
  assert.equal(bash("md5sum foo.ps1").allow, true);
});

t("E4-06: certutil -hashfile foo.ps1 MD5 -> allow", () => {
  assert.equal(bash("certutil -hashfile foo.ps1 MD5").allow, true);
});

t("E4-07: certutil -encode foo.ps1 out.ps1 -> BLOCK (non-hashfile subcommand, catch-all)", () => {
  const r = bash("certutil -encode foo.ps1 out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("E4-08: PowerShell read-cmdlet families (Test-Path, Format-List, ConvertTo-Json) -> allow", () => {
  assert.equal(bash("Test-Path foo.ps1").allow, true);
  assert.equal(bash("Format-List foo.ps1").allow, true);
  assert.equal(bash("ConvertTo-Json foo.ps1").allow, true);
});

// ---------------------------------------------------------------------------
// Final round: sh/bash/zsh/dash -c/-lc bodies recursively classified
// (previously reported adversary finding — NOW FIXED)
// ---------------------------------------------------------------------------

t("FINAL-01: find . -name '*.ps1' -exec sh -c 'echo pwned > {}' \\; -> BLOCK (branch 4, was the reported escape, now fixed)", () => {
  const r = bash("find . -name '*.ps1' -exec sh -c 'echo pwned > {}' \\;");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t('FINAL-02: bash -c "echo x > a.ps1" -> BLOCK (branch 3, recursive classification)', () => {
  const r = bash('bash -c "echo x > a.ps1"');
  assert.equal(r.allow, false); assert.equal(r.branch, 3);
});

t('FINAL-03: bash -c "ls" -> allow (recursed body is a pure read)', () => {
  assert.equal(bash('bash -c "ls"').allow, true);
});

t('FINAL-04: wsl -- bash -lc "cp a.txt /mnt/c/x/out.ps1" -> BLOCK (branch 3; gated extension is what matters, not the drive form)', () => {
  const r = bash('wsl -- bash -lc "cp a.txt /mnt/c/x/out.ps1"');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("FINAL-05: triple-nested bash -c with escaped inner quotes -> never allow (branch 3 or 4)", () => {
  const q = '"';
  const bs = "\\";
  const nestedCmd =
    "bash -c " + q +
    "bash -c " + bs + q +
    "bash -c " + bs + bs + bs + q +
    "echo x > a.ps1" +
    bs + bs + bs + q +
    bs + q +
    q;
  const r = bash(nestedCmd);
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.ok(r.branch === 3 || r.branch === 4, `expected branch 3 or 4, got ${r.branch}`);
});

t("FINAL-06: sh -c 'cat a.ps1' -> allow (recursed body is a pure read)", () => {
  assert.equal(bash("sh -c 'cat a.ps1'").allow, true);
});

t("FINAL-07: nesting depth cap — a bash -c dispatched at depth 3 blocks unconditionally (branch 4)", () => {
  // Constructing a real 4-layer nested STRING with only two native quote
  // characters (' and ") is fragile (needs real backslash-escaping this
  // tokenizer does not model — see FINAL-05's residual risk). The cap
  // itself is depth-driven, not string-shape-driven, so it is tested
  // directly via analyzeBash's own (exported) depth parameter: this is
  // exactly what handleShellInline sees on the 4th real nesting layer.
  const r = analyzeBash("bash -c 'echo x > a.ps1'", "C:\\work", GATED, 3);
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("FINAL-07b: the SAME command at depth 2 (still under the cap) recurses normally -> BLOCK branch 3", () => {
  const r = analyzeBash("bash -c 'echo x > a.ps1'", "C:\\work", GATED, 2);
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("FINAL-08: bare bash/sh invocation with no -c/-lc -> allow (still explicitly allowed bare-script shape)", () => {
  assert.equal(bash("bash script.sh").allow, true);
  assert.equal(bash("sh script.sh").allow, true);
});

t("FINAL-09: bash -c with an unquoted (non-single-token) body -> BLOCK (branch 4, cannot classify cleanly)", () => {
  const stage = [
    { value: "bash", quoted: false }, { value: "-c", quoted: false },
    { value: "echo", quoted: false },
  ];
  const r = classifyVerbToken(stage, 0, "C:\\work", GATED, 0);
  assert.equal(r.branch, 4);
});

// ---------------------------------------------------------------------------
// Adversary v4 — one new pass-but-shouldn't after this round's fixes
// (NOT fixed this round — reported, see report disposition)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Last fix: dynamic interpreter bodies ($(...), backticks, $VAR/${...},
// heredoc, process substitution) -> branch 4, never branch 1
// (previously reported adversary finding — NOW FIXED)
// ---------------------------------------------------------------------------

t('LASTFIX-01: bash -c "$(gen_malicious)" -> BLOCK (branch 4, was the reported escape, now fixed)', () => {
  const r = bash('bash -c "$(gen_malicious)"');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t('LASTFIX-02: bash -c "echo $X > a.txt" -> BLOCK (branch 4, literal target but dynamic body — accepted friction)', () => {
  const r = bash('bash -c "echo $X > a.txt"');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t('LASTFIX-03: bash -c "ls $HOME" -> BLOCK (branch 4, accepted cost)', () => {
  const r = bash('bash -c "ls $HOME"');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t('LASTFIX-04: bash -c "ls" -> allow (no dynamic markers, pure read)', () => {
  assert.equal(bash('bash -c "ls"').allow, true);
});

t("LASTFIX-05: node -e body with backtick -> BLOCK (dynamic gate applies to all interpreters, not just shells)", () => {
  const r = bash('node -e "require(\'fs\').writeFileSync(`out${x}.ps1`,\'y\')"');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("UNIT-15: isDynamicInterpreterBody detects $(...), backticks, ${...}, $VAR, heredoc, process substitution", () => {
  assert.equal(isDynamicInterpreterBody("$(cmd)"), true);
  assert.equal(isDynamicInterpreterBody("`cmd`"), true);
  assert.equal(isDynamicInterpreterBody("${X}"), true);
  assert.equal(isDynamicInterpreterBody("$HOME"), true);
  assert.equal(isDynamicInterpreterBody("cat <<EOF"), true);
  assert.equal(isDynamicInterpreterBody("diff <(a) <(b)"), true);
  assert.equal(isDynamicInterpreterBody("ls -la"), false);
});

// ---------------------------------------------------------------------------
// Adversary v5 — one new pass-but-shouldn't (NOT fixed, disclosed)
// ---------------------------------------------------------------------------

t('ADVV5-01: node script.js "$(cat /tmp/x)" -> allow (bare invocation, argument content never inspected)', () => {
  // The new dynamic-body gate lives ONLY inside handleInterpreterInline/
  // handleShellInline, reached only when -e/-c/-Command/-lc is present.
  // A BARE script invocation (no such flag) is unconditionally read per D1
  // regardless of its arguments' content -- so a dynamically-computed
  // argument to an arbitrary script is invisible here too; script.js can do
  // anything with it, including writing wherever the substitution resolves.
  const r = bash('node script.js "$(cat /tmp/x)"');
  assert.equal(r.allow, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// F1: find -delete (or write-verb -exec) with no resolvable -name/-path
// pattern -> branch 4 (target unresolvable)
// ---------------------------------------------------------------------------

t("F1-01: find . -delete (no -name) -> BLOCK (branch 4, was the reported escape, now fixed)", () => {
  const r = bash("find . -delete");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("F1-02: find . -name '*.ps1' -delete -> BLOCK (branch 4, existing gated-pattern path, unaffected)", () => {
  const r = bash("find . -name '*.ps1' -delete");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("F1-03: find . -type f -> allow (no qualifying mutating action at all)", () => {
  assert.equal(bash("find . -type f").allow, true);
});

t("F1-04: find . -exec cp {} out.ps1 (no -name) -> BLOCK (write-verb exec, no pattern)", () => {
  const r = bash("find . -exec cp {} out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("F1-05: find . -fprint out.txt (no -name, -fprint alone) -> allow (its own target is independently resolvable, not gated)", () => {
  assert.equal(bash("find . -fprint out.txt").allow, true);
});

t("F1-06: find . -path '*/secrets/*' -delete -> BLOCK (gated? no — pattern present, not gated -> allow via E3 path)", () => {
  // -path is a resolvable pattern per F1; it is not gated (no .ps1/.psm1/
  // .psd1 text in it), so the existing E3 logic (pattern present -> only
  // gated patterns block) applies and this allows.
  assert.equal(bash("find . -path '*/secrets/*' -delete").allow, true);
});

t("UNIT-16: findHasDeleteOrWriteExecAction / findHasFprintFamilyFlag distinguish -delete from -fprint alone", () => {
  const deleteStage = [{ value: "find", quoted: false }, { value: "-delete", quoted: false }];
  const fprintStage = [{ value: "find", quoted: false }, { value: "-fprint", quoted: false }, { value: "out.txt", quoted: false }];
  assert.equal(findHasDeleteOrWriteExecAction(deleteStage), true);
  assert.equal(findHasFprintFamilyFlag(deleteStage), false);
  assert.equal(findHasDeleteOrWriteExecAction(fprintStage), false);
  assert.equal(findHasFprintFamilyFlag(fprintStage), true);
});

// ---------------------------------------------------------------------------
// F2: handleInterpreterInline reuses detectDotNetIoMutation + the PS
// analyzer for pwsh/powershell bodies; -EncodedCommand -> branch 4
// ---------------------------------------------------------------------------

t('F2-01: pwsh -Command "[IO.File]::Copy(\'a.txt\',\'out.ps1\')" via Bash tool_name -> BLOCK (branch 3, real dest = 2nd arg)', () => {
  const r = bash(`pwsh -Command "[IO.File]::Copy('a.txt','out.ps1')"`);
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t('F2-02: pwsh -Command "Get-Content a.ps1" -> allow (read cmdlet, reused PS analyzer)', () => {
  assert.equal(bash('pwsh -Command "Get-Content a.ps1"').allow, true);
});

t("F2-03: pwsh -EncodedCommand ABCD -> BLOCK (branch 4, base64 body unresolvable)", () => {
  const r = bash("pwsh -EncodedCommand ABCD");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t('F2-04: powershell -Command "Set-Content -Path out.ps1 -Value x" via Bash tool_name -> BLOCK (branch 3)', () => {
  const r = bash('powershell -Command "Set-Content -Path out.ps1 -Value x"');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

// ---------------------------------------------------------------------------
// F3: FileStream/StreamReader access-mode awareness
// ---------------------------------------------------------------------------

t("F3-01: New-Object System.IO.FileStream('a.ps1', [IO.FileMode]::Open, [IO.FileAccess]::Read) -> allow (explicit read access, was the reported escape, now fixed)", () => {
  const r = ps("New-Object System.IO.FileStream('a.ps1', [IO.FileMode]::Open, [IO.FileAccess]::Read)");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("F3-02: New-Object IO.StreamWriter('a.ps1') -> BLOCK (branch 3, StreamWriter is always write)", () => {
  const r = ps("New-Object IO.StreamWriter('a.ps1')");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("F3-03: New-Object System.IO.FileStream('out.ps1', [IO.FileMode]::Create) -> BLOCK (Create -> write)", () => {
  const r = ps("New-Object System.IO.FileStream('out.ps1', [IO.FileMode]::Create)");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("F3-04: New-Object System.IO.FileStream('out.ps1') (no access argument at all) -> BLOCK (conservative write default)", () => {
  const r = ps("New-Object System.IO.FileStream('out.ps1')");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("F3-05: New-Object System.IO.StreamReader('a.ps1') -> allow (StreamReader is inherently read-only)", () => {
  assert.equal(ps("New-Object System.IO.StreamReader('a.ps1')").allow, true);
});

t("UNIT-17: classifyFileStreamAccess", () => {
  assert.equal(classifyFileStreamAccess("[IO.FileAccess]::Read"), "read");
  assert.equal(classifyFileStreamAccess("[IO.FileAccess]::ReadWrite"), "write");
  assert.equal(classifyFileStreamAccess("[IO.FileMode]::Append"), "write");
  assert.equal(classifyFileStreamAccess("[IO.FileMode]::Create"), "write");
  assert.equal(classifyFileStreamAccess("no access marker here"), "write");
});

// ---------------------------------------------------------------------------
// F4: cmdlet/alias regexes match only in verb position
// ---------------------------------------------------------------------------

t("F4-01: Test-Path -Path report.mi -> allow (was the reported false positive, now fixed — 'mi' inside the extension is not verb position)", () => {
  const r = ps("Test-Path -Path report.mi");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("F4-02: mi a.txt b.ps1 -> BLOCK (branch 3, 'mi' genuinely used in verb position)", () => {
  const r = ps("mi a.txt b.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("F4-03: Get-ChildItem | Where-Object description -eq 'foo.mi' -> allow (extension collision after a pipe, still not verb position)", () => {
  assert.equal(ps("Get-ChildItem | Where-Object description -eq 'foo.mi'").allow, true);
});

t("F4-04: (mi a.txt b.ps1) inside a subexpression -> BLOCK (open-paren is a valid verb boundary)", () => {
  const r = ps("(mi a.txt b.ps1)");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("UNIT-18: isPsVerbPosition / findPsVerbPositionMatch", () => {
  const text = "Test-Path -Path report.mi";
  assert.equal(isPsVerbPosition(text, 0), true); // "Test-Path" at start
  const miIdx = text.lastIndexOf("mi");
  assert.equal(isPsVerbPosition(text, miIdx), false); // "mi" glued to "report."
  const aliasRe = /\bmi\b/i;
  assert.equal(findPsVerbPositionMatch(text, aliasRe), null);
  assert.ok(findPsVerbPositionMatch("mi a.txt b.ps1", aliasRe) !== null);
});

// ---------------------------------------------------------------------------
// PowerShell D1 inversion: analyzePsStatement was a fixed cmdlet allow-list
// ---------------------------------------------------------------------------

t("PSD1-01: Invoke-WebRequest -Uri u -OutFile out.ps1 -> BLOCK (branch 3, was the reported escape, now fixed)", () => {
  const r = ps("Invoke-WebRequest -Uri u -OutFile out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("PSD1-02: curl -OutFile out.ps1 u -> BLOCK (branch 3, curl treated as Invoke-WebRequest under PowerShell tool_name, was the reported escape, now fixed)", () => {
  const r = ps("curl -OutFile out.ps1 u");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("PSD1-03: Invoke-WebRequest -Uri u (no -OutFile) -> allow", () => {
  assert.equal(ps("Invoke-WebRequest -Uri u").allow, true);
});

t("PSD1-04: Invoke-RestMethod -Uri u -OutFile out.ps1 -> BLOCK (branch 3)", () => {
  const r = ps("Invoke-RestMethod -Uri u -OutFile out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("PSD1-05: wget -OutFile out.ps1 u -> BLOCK (branch 3)", () => {
  const r = ps("wget -OutFile out.ps1 u");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("PSD1-06: iwr -Uri u -OutFile out.txt -> allow (not gated)", () => {
  assert.equal(ps("iwr -Uri u -OutFile out.txt").allow, true);
});

t("PSD1-07: Start-Process notepad out.ps1 -> BLOCK (branch 4, unrecognized cmdlet + gated argument)", () => {
  const r = ps("Start-Process notepad out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
  assert.match(r.detector, /Start-Process/);
});

t("PSD1-08: Get-Item out.ps1 -> allow (Get-* family, unconditional read)", () => {
  assert.equal(ps("Get-Item out.ps1").allow, true);
});

t("PSD1-09: Some-Cmdlet -Path out.txt -> allow (unrecognized cmdlet, named-flag value not gated)", () => {
  assert.equal(ps("Some-Cmdlet -Path out.txt").allow, true);
});

t("PSD1-10: Some-Cmdlet -Path out.ps1 -> BLOCK (branch 4, unrecognized cmdlet, named-flag value gated)", () => {
  const r = ps("Some-Cmdlet -Path out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("PSD1-11: ForEach-Object nested write — Get-ChildItem *.txt | ForEach-Object { Set-Content -Path out.ps1 -Value $_ } -> BLOCK (branch 3, script-block clause independently classified)", () => {
  const r = ps("Get-ChildItem *.txt | ForEach-Object { Set-Content -Path out.ps1 -Value $_ }");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("PSD1-12: ForEach-Object with no nested write — Get-ChildItem *.ps1 | ForEach-Object { Write-Host $_ } -> allow", () => {
  assert.equal(ps("Get-ChildItem *.ps1 | ForEach-Object { Write-Host $_ }").allow, true);
});

t("PSD1-13: known-write cmdlets/aliases still resolve as before (Copy-Item, sc)", () => {
  const r1 = ps("Copy-Item -Path a.txt -Destination out.ps1");
  assert.equal(r1.allow, false, JSON.stringify(r1));
  const r2 = ps("sc out.txt hello");
  assert.equal(r2.allow, true, JSON.stringify(r2));
});

t("PSD1-14: dotnet mutation still resolves correctly with the new clause splitter ([IO.File]::Copy)", () => {
  const r = ps("[IO.File]::Copy('a.txt','out.ps1')");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("PSD1-15: FileStream with explicit read access -> allow (StreamReader-style fix survives the new clause splitter)", () => {
  const r = ps("New-Object System.IO.FileStream('a.ps1', [IO.FileMode]::Open, [IO.FileAccess]::Read)");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("PSD1-16: assignment RHS write cmdlet is classified — $x = Set-Content -Path out.ps1 -Value y -> BLOCK", () => {
  const r = ps("$x = Set-Content -Path out.ps1 -Value y");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("UNIT-19: splitPsClauses keeps a dotnet call's own parens together but splits a bare subexpression", () => {
  const dotnetClauses = splitPsClauses("[IO.File]::Copy('a','b')");
  assert.equal(dotnetClauses.length, 1);
  const subExprClauses = splitPsClauses("(mi a.txt b.ps1)");
  assert.ok(subExprClauses.length >= 2);
});

// ---------------------------------------------------------------------------
// Colon-bound parameter fix: -Path:out.ps1, -OutFile:'out.ps1', etc.
// ---------------------------------------------------------------------------

t("COLON-01: Some-Cmdlet -Path:out.ps1 -> BLOCK (branch 4, was the reported escape, now fixed)", () => {
  const r = ps("Some-Cmdlet -Path:out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("COLON-02: Set-Content -Path:out.ps1 -Value:x -> BLOCK (branch 3, known-write cmdlet)", () => {
  const r = ps("Set-Content -Path:out.ps1 -Value:x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("COLON-03: Invoke-WebRequest -Uri:u -OutFile:out.ps1 -> BLOCK (branch 3, web-request family)", () => {
  const r = ps("Invoke-WebRequest -Uri:u -OutFile:out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("COLON-04: Get-Item -Path:out.ps1 -> allow (known-read verb, unconditional)", () => {
  assert.equal(ps("Get-Item -Path:out.ps1").allow, true);
});

t("COLON-05: Some-Cmdlet -Path:out.txt -> allow (colon form, value not gated)", () => {
  assert.equal(ps("Some-Cmdlet -Path:out.txt").allow, true);
});

t("COLON-06: quoted colon-bound value — Set-Content -Path:'out.ps1' -Value:x -> BLOCK", () => {
  const r = ps("Set-Content -Path:'out.ps1' -Value:x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("UNIT-20: normalizePsColonParams rewrites -Word:value to -Word value, leaves non-flag colons alone", () => {
  assert.equal(normalizePsColonParams("-Path:out.ps1"), "-Path out.ps1");
  assert.equal(normalizePsColonParams("-OutFile:'out.ps1'"), "-OutFile 'out.ps1'");
  assert.equal(normalizePsColonParams("http://foo:8080"), "http://foo:8080");
  assert.equal(normalizePsColonParams("-Path out.ps1"), "-Path out.ps1"); // already space-separated, unchanged
});

// ---------------------------------------------------------------------------
// Splat (@) / variable ($) target ambiguity fix
// ---------------------------------------------------------------------------

t("SPLAT-01: $p=@{Path='out.ps1'}; Set-Content @p -> BLOCK (branch 4, was the reported escape, now fixed)", () => {
  const r = ps("$p=@{Path='out.ps1'}; Set-Content @p");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("SPLAT-02: Set-Content -Path $f -Value x -> BLOCK (branch 4, variable target)", () => {
  const r = ps("Set-Content -Path $f -Value x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("SPLAT-03: Get-Content @p -> allow (read cmdlet, unconditional)", () => {
  assert.equal(ps("Get-Content @p").allow, true);
});

t("UNIT-21: isAmbiguousToken flags @-prefixed splat tokens", () => {
  assert.equal(isAmbiguousToken("@p"), true);
  assert.equal(isAmbiguousToken("@{Path='x'}"), true);
  assert.equal(isAmbiguousToken("plain.txt"), false);
});

// ---------------------------------------------------------------------------
// Per-cmdlet target map (was one generic -Destination/-Path fallback)
// ---------------------------------------------------------------------------

t("MAP-01: Rename-Item -Path a.txt -NewName out.ps1 -> BLOCK (branch 3, target = -NewName, never -Path)", () => {
  const r = ps("Rename-Item -Path a.txt -NewName out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("MAP-02: Rename-Item a.txt out.ps1 -> BLOCK (branch 3, positional 2 = NewName)", () => {
  const r = ps("Rename-Item a.txt out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("MAP-03: Rename-Item -Path a.ps1 -NewName b.txt -> allow (dest not gated, -Path itself never checked)", () => {
  assert.equal(ps("Rename-Item -Path a.ps1 -NewName b.txt").allow, true);
});

t("MAP-04: Copy-Item -Path a.txt -Destination dir\\ (dir is directory-shaped) -> allow (branch 2, dir-join, .txt not gated)", () => {
  const r = ps("Copy-Item -Path a.txt -Destination dir\\");
  assert.equal(r.allow, true, JSON.stringify(r)); assert.equal(r.branch, 2);
});

t("MAP-05: Copy-Item -Path a.ps1 -Destination dir\\ -> BLOCK (branch 3, dir-join with gated source basename)", () => {
  const r = ps("Copy-Item -Path a.ps1 -Destination dir\\");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("MAP-06: Copy-Item -Path out.ps1 -Destination b.txt -> allow (dest not gated; -Path/source never used as the target)", () => {
  assert.equal(ps("Copy-Item -Path out.ps1 -Destination b.txt").allow, true);
});

t("MAP-07: New-Item -Path dir -Name out.ps1 -> BLOCK (branch 3, -Path joined with -Name)", () => {
  const r = ps("New-Item -Path dir -Name out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("MAP-08: Tee-Object -FilePath out.ps1 -> BLOCK (branch 3)", () => {
  const r = ps("Tee-Object -FilePath out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("MAP-09: Tee-Object -Variable v -> BLOCK (branch 4, ambiguous per spec)", () => {
  const r = ps("Tee-Object -Variable v");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("MAP-10: Start-Process notepad out.ps1 -> BLOCK (branch 4, unconditionally ambiguous)", () => {
  const r = ps("Start-Process notepad out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("MAP-11: Export-Csv -Path out.ps1 -> BLOCK (branch 4, via the catch-all's named-flag scan, no special-casing needed)", () => {
  const r = ps("Export-Csv -Path out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MAP-12: ConvertTo-Json | Set-Content x.txt with no -Path on ConvertTo-Json -> allow", () => {
  assert.equal(ps("Get-Process | ConvertTo-Json").allow, true);
});

// ---------------------------------------------------------------------------
// Ambiguous call operator: & or . followed by (...), $var, or "string"
// ---------------------------------------------------------------------------

t("CALLOP-01: & (Get-Command Set-Content) -Path out.ps1 -Value x -> BLOCK (branch 4, was the reported escape, now fixed)", () => {
  const r = ps('& (Get-Command Set-Content) -Path out.ps1 -Value x');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t('CALLOP-02: & "Get-Content" a.ps1 -> BLOCK (branch 4, accepted friction — real verb unknowable statically)', () => {
  const r = ps('& "Get-Content" a.ps1');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("CALLOP-03: & $cmd a.ps1 -> BLOCK (branch 4, variable-computed verb)", () => {
  const r = ps("& $cmd a.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("CALLOP-04: & (Get-Command Get-Content) a.txt -> allow (no gated/ambiguous argument)", () => {
  assert.equal(ps("& (Get-Command Get-Content) a.txt").allow, true);
});

t("CALLOP-05: dot-source operator — . $script out.ps1 -> BLOCK (branch 4)", () => {
  const r = ps(". $script out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("UNIT-22: findPsCallOperatorRest returns null when statement does not start with & or .", () => {
  assert.equal(findPsCallOperatorRest("Set-Content -Path out.ps1", "Set-Content -Path out.ps1"), null);
});

t("UNIT-23: psNamedFlagValue extracts a quoted or bare value", () => {
  assert.equal(psNamedFlagValue("-Path out.ps1 -Value x", "Path"), "out.ps1");
  assert.equal(psNamedFlagValue("-Destination 'dir\\out.ps1'", "Destination"), "dir\\out.ps1");
  assert.equal(psNamedFlagValue("-Value x", "Path"), null);
});

// ---------------------------------------------------------------------------
// Call-operator detection applied at EVERY clause start, not just statement
// start; nested inside script blocks / control-flow bodies
// ---------------------------------------------------------------------------

t("CALLOP-06: if ($true) { & $cmd -Path out.ps1 } -> BLOCK (branch 4, nested call operator, was the reported escape, now fixed)", () => {
  const r = ps("if ($true) { & $cmd -Path out.ps1 }");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("CALLOP-07: foreach ($f in $x) { Set-Content -Path out.ps1 -Value 1 } -> BLOCK (branch 3, condition itself must not false-trigger)", () => {
  const r = ps("foreach ($f in $x) { Set-Content -Path out.ps1 -Value 1 }");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("CALLOP-08: try { Get-Content a.ps1 } catch {} -> allow (control-flow keywords are read; nested read cmdlet)", () => {
  assert.equal(ps("try { Get-Content a.ps1 } catch {}").allow, true);
});

t("CALLOP-09: while ($x -lt 10) { Get-Content a.ps1 } -> allow (condition variable must not false-trigger)", () => {
  assert.equal(ps("while ($x -lt 10) { Get-Content a.ps1 }").allow, true);
});

t("UNIT-24: splitPsClauses keeps '& (' together as one clause", () => {
  const clauses = splitPsClauses("& (Get-Command Set-Content) -Path out.ps1");
  assert.equal(clauses.length, 1);
});

t("UNIT-25: splitPsClauses keeps 'foreach (' together as one clause (control-flow keyword)", () => {
  const clauses = splitPsClauses("foreach ($f in $x)");
  assert.equal(clauses.length, 1);
});

// ---------------------------------------------------------------------------
// Adversary v6 — one new pass-but-shouldn't (NOT fixed, disclosed)
// ---------------------------------------------------------------------------

t("ADVV6-01: if (Set-Content -Path out.ps1 -Value x) { } -> allow (write cmdlet hidden inside a condition, NOT fixed, see report)", () => {
  // "if"/"elseif"/"while"/etc. are now unconditionally read so their OWN
  // condition/header (kept together with its parens) is never scanned as
  // arguments -- necessary to avoid false-triggering on an ordinary
  // `$variable` in a condition (CALLOP-07/09 above) -- but this also means
  // a REAL write cmdlet placed directly inside the condition expression
  // itself is swallowed by that same skip and never independently
  // classified.
  const r = ps("if (Set-Content -Path out.ps1 -Value x) { }");
  assert.equal(r.allow, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// Flag-consumes-value positional parsing fix
// ---------------------------------------------------------------------------

t("FLAGVAL-01: Set-Content -Value x out.ps1 -> BLOCK (branch 3, was the reported escape, now fixed)", () => {
  const r = ps("Set-Content -Value x out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("FLAGVAL-02: Set-Content out.ps1 -Value x -> BLOCK (branch 3)", () => {
  const r = ps("Set-Content out.ps1 -Value x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("FLAGVAL-03: Add-Content -Encoding utf8 out.ps1 -Value x -> BLOCK (branch 3, -Encoding is a known value-flag)", () => {
  const r = ps("Add-Content -Encoding utf8 out.ps1 -Value x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("FLAGVAL-04: Out-File -Append out.ps1 -> BLOCK (branch 3, -Append is a known SWITCH, takes no value)", () => {
  const r = ps("Out-File -Append out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("FLAGVAL-05: Set-Content -Unknown y out.ps1 -> BLOCK (branch 4, ambiguous positional parse)", () => {
  const r = ps("Set-Content -Unknown y out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("FLAGVAL-06: Set-Content -Value out.ps1 -Path a.txt -> allow (branch 2, value is not the path)", () => {
  const r = ps("Set-Content -Value out.ps1 -Path a.txt");
  assert.equal(r.allow, true, JSON.stringify(r)); assert.equal(r.branch, 2);
});

t("FLAGVAL-07: Copy-Item -Force a.txt out.ps1 -> BLOCK (branch 3, -Force is a known switch)", () => {
  const r = ps("Copy-Item -Force a.txt out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t('FLAGVAL-08: here-string probe — Set-Content -Path out.ps1 -Value @"\nmulti\nline\n"@ -> BLOCK (branch 3, named -Path unaffected by here-string content)', () => {
  const r = ps('Set-Content -Path out.ps1 -Value @"\nmulti\nline\n"@');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("UNIT-26: extractPsPositionals consumes a value-flag's argument, not a known-switch's", () => {
  const r1 = extractPsPositionals("Set-Content -Value x out.ps1");
  assert.deepEqual(r1.positionals, ["out.ps1"]);
  assert.equal(r1.ambiguousFlag, false);
  const r2 = extractPsPositionals("Out-File -Append out.ps1");
  assert.deepEqual(r2.positionals, ["out.ps1"]);
  assert.equal(r2.ambiguousFlag, false);
  const r3 = extractPsPositionals("Set-Content -Unknown y out.ps1");
  assert.deepEqual(r3.positionals, ["out.ps1"]);
  assert.equal(r3.ambiguousFlag, true);
});

t("UNIT-27: resolvePsAmbiguousPositionals blocks on a gated token, allows (null) otherwise", () => {
  assert.equal(resolvePsAmbiguousPositionals(["out.ps1"], "Some-Cmdlet", GATED).branch, 4);
  assert.equal(resolvePsAmbiguousPositionals(["out.txt"], "Some-Cmdlet", GATED), null);
});

// ---------------------------------------------------------------------------
// Ambiguous-positional scan must include tokens an unknown flag consumed
// (previously reported adversary finding — NOW FIXED)
// ---------------------------------------------------------------------------

t("FLAGVAL-09: New-Item -Container out.ps1 -> BLOCK (branch 4, was the reported escape, now fixed)", () => {
  const r = ps("New-Item -Container out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("FLAGVAL-10: Set-Content -Unknown out.ps1 -Value x -> BLOCK (branch 4, gated token consumed by the unknown flag)", () => {
  const r = ps("Set-Content -Unknown out.ps1 -Value x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 4);
});

t("FLAGVAL-11: Set-Content -Unknown y a.txt -> allow (nothing gated among any non-flag token)", () => {
  assert.equal(ps("Set-Content -Unknown y a.txt").allow, true);
});

t("UNIT-28: extractPsPositionals.allNonFlagTokens includes values consumed by an unknown flag", () => {
  const r = extractPsPositionals("New-Item -Container out.ps1");
  assert.deepEqual(r.positionals, []);
  assert.equal(r.ambiguousFlag, true);
  assert.deepEqual(r.allNonFlagTokens, ["out.ps1"]);
});

// ---------------------------------------------------------------------------
// -WhatIf:$false / -WhatIf:$var / -Confirm:$false fixes
// ---------------------------------------------------------------------------

t("WHATIF-01: Set-Content -Path out.ps1 -Value x -WhatIf:$false -> BLOCK (branch 3, was the reported escape, now fixed)", () => {
  const r = ps("Set-Content -Path out.ps1 -Value x -WhatIf:$false");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("WHATIF-02: Set-Content -Path out.ps1 -Value x -WhatIf:$true -> allow (explicit true still suppresses)", () => {
  assert.equal(ps("Set-Content -Path out.ps1 -Value x -WhatIf:$true").allow, true);
});

t("WHATIF-03: Set-Content -Path out.ps1 -Value x -WhatIf:$w -> BLOCK (branch 3, variable value is a real run)", () => {
  const r = ps("Set-Content -Path out.ps1 -Value x -WhatIf:$w");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("WHATIF-04: bare -WhatIf still suppresses (unchanged)", () => {
  assert.equal(ps("Set-Content -Path out.ps1 -Value x -WhatIf").allow, true);
});

t("CONFIRM-01: Set-Content out.ps1 -Confirm:$false -Value x -> BLOCK (branch 3, -Confirm:$false is self-contained, was the reported escape, now fixed)", () => {
  const r = ps("Set-Content out.ps1 -Confirm:$false -Value x");
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("UNIT-29: psWhatIfSuppresses distinguishes bare/$true from $false/$var/(expr)", () => {
  assert.equal(psWhatIfSuppresses("-WhatIf"), true);
  assert.equal(psWhatIfSuppresses("-WhatIf:$true"), true);
  assert.equal(psWhatIfSuppresses("-WhatIf:$false"), false);
  assert.equal(psWhatIfSuppresses("-WhatIf:$w"), false);
  assert.equal(psWhatIfSuppresses("-WhatIf:(Get-Foo)"), false);
  assert.equal(psWhatIfSuppresses("Set-Content -Path x.txt"), false);
});

t("UNIT-30: normalizePsColonParams strips a known-switch's colon-bound value entirely", () => {
  assert.equal(normalizePsColonParams("Set-Content out.ps1 -Confirm:$false -Value x"), "Set-Content out.ps1 -Confirm -Value x");
  assert.equal(normalizePsColonParams("-Path:out.ps1"), "-Path out.ps1"); // value-flag still space-normalized
});

// ---------------------------------------------------------------------------
// -WhatIf suppression scoped per CLAUSE, not whole statement
// (previously reported adversary finding — NOW FIXED)
// ---------------------------------------------------------------------------

t('WHATIF-05: if ($true) { Get-Item -WhatIf } else { Set-Content -Path out.ps1 -Value x } -> BLOCK (branch 3, was the reported escape, now fixed)', () => {
  const r = ps('if ($true) { Get-Item -WhatIf } else { Set-Content -Path out.ps1 -Value x }');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t('WHATIF-06: if ($true) { Set-Content -Path out.ps1 -Value x -WhatIf } -> allow (the write clause carries its OWN -WhatIf)', () => {
  assert.equal(ps('if ($true) { Set-Content -Path out.ps1 -Value x -WhatIf }').allow, true);
});

t('WHATIF-07: foreach ($f in $x) { Get-Item $f -WhatIf; Set-Content -Path out.ps1 -Value 1 } -> BLOCK (branch 3)', () => {
  const r = ps('foreach ($f in $x) { Get-Item $f -WhatIf; Set-Content -Path out.ps1 -Value 1 }');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t('WHATIF-08: try { Set-Content -Path out.ps1 -Value 1 -WhatIf } catch { Add-Content -Path out.ps1 -Value 2 } -> BLOCK (branch 3, catch body is a separate clause)', () => {
  const r = ps('try { Set-Content -Path out.ps1 -Value 1 -WhatIf } catch { Add-Content -Path out.ps1 -Value 2 }');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

// ---------------------------------------------------------------------------
// Comment stripping (quote-aware): Bash `#` token-initial, PowerShell `#`
// and `<# ... #>` block comments — never contribute a target/verb/-WhatIf/
// override marker
// ---------------------------------------------------------------------------

t('COMMENT-01: PS trailing comment mentioning -WhatIf -> BLOCK (branch 3, comment text never suppresses)', () => {
  const r = ps('Set-Content -Path out.ps1 -Value x # -WhatIf considered');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t('COMMENT-02: PS block comment mentioning -WhatIf before the real command -> BLOCK (branch 3)', () => {
  const r = ps('<# -WhatIf #> Set-Content -Path out.ps1 -Value x');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t('COMMENT-03: PS trailing comment mentioning a gated filename -> allow (branch 2, comment never contributes a target)', () => {
  const r = ps('Set-Content -Path a.txt -Value x # out.ps1');
  assert.equal(r.allow, true, JSON.stringify(r)); assert.equal(r.branch, 2);
});

t('COMMENT-04: Bash trailing comment mentioning a gated redirect -> allow (branch 2)', () => {
  const r = bash('echo x > a.txt # > b.ps1');
  assert.equal(r.allow, true, JSON.stringify(r)); assert.equal(r.branch, 2);
});

t('COMMENT-05: Bash # inside a quoted string is NOT a comment -> BLOCK (branch 3)', () => {
  const r = bash('echo "#" > out.ps1');
  assert.equal(r.allow, false, JSON.stringify(r)); assert.equal(r.branch, 3);
});

t("COMMENT-06: SHELL_WRITE_OK=1 echo x > a.ps1 # ok -> allow (override marker still checked at position 0, unaffected)", () => {
  const r = bash("SHELL_WRITE_OK=1 echo x > a.ps1 # ok");
  assert.equal(r.allow, true, JSON.stringify(r)); assert.equal(r.overridden, true);
});

t("UNIT-31: stripBashComments preserves $# and a#b (not comments), strips a real trailing comment", () => {
  assert.equal(stripBashComments("echo $#"), "echo $#");
  assert.equal(stripBashComments("echo a#b"), "echo a#b");
  const stripped = stripBashComments("echo x # comment");
  assert.equal(stripped.trim(), "echo x");
  assert.equal(stripped.length, "echo x # comment".length);
});

t("UNIT-32: stripPsComments strips # line comments and <# #> block comments, preserves length", () => {
  const s1 = stripPsComments("Get-Item x # comment");
  assert.equal(s1.trim(), "Get-Item x");
  assert.equal(s1.length, "Get-Item x # comment".length);
  const s2 = stripPsComments("<# block #> Get-Item x");
  assert.equal(s2.trim(), "Get-Item x");
  assert.equal(s2.length, "<# block #> Get-Item x".length);
});

// ---------------------------------------------------------------------------
// Direct unit tests for the new exported classification helpers
// ---------------------------------------------------------------------------

t("UNIT-07: isKnownReadVerb true for cat, false for cp", () => {
  const catStage = [{ value: "cat", quoted: false }, { value: "foo.ps1", quoted: false }];
  const cpStage = [{ value: "cp", quoted: false }, { value: "a.txt", quoted: false }, { value: "b.ps1", quoted: false }];
  assert.equal(isKnownReadVerb(catStage, 0), true);
  assert.equal(isKnownReadVerb(cpStage, 0), false);
});

t("UNIT-08: checkFindNamePattern fires on gated -name pattern WHEN a qualifying mutating action (-delete) is present (E3)", () => {
  const stage = [
    { value: "find", quoted: false }, { value: ".", quoted: false },
    { value: "-name", quoted: false }, { value: "*.ps1", quoted: true },
    { value: "-delete", quoted: false },
  ];
  const r = checkFindNamePattern(stage, GATED);
  assert.equal(r.branch, 4);
});

t("UNIT-08b: checkFindNamePattern returns null with NO qualifying mutating action (E3)", () => {
  const stage = [
    { value: "find", quoted: false }, { value: ".", quoted: false },
    { value: "-name", quoted: false }, { value: "*.ps1", quoted: true },
  ];
  assert.equal(checkFindNamePattern(stage, GATED), null);
});

t("UNIT-09: catchAllUnknownVerb null when no gated/ambiguous argument", () => {
  const stage = [{ value: "xcopy", quoted: false }, { value: "a.txt", quoted: false }, { value: "b.txt", quoted: false }];
  assert.equal(catchAllUnknownVerb(stage, 0, GATED), null);
});

t("UNIT-10: detectStderrClobberRedirects skips 2>&1 and /dev/null", () => {
  assert.deepEqual(detectStderrClobberRedirects("cmd 2>&1", "C:\\work", GATED), []);
  assert.deepEqual(detectStderrClobberRedirects("cmd 2>/dev/null", "C:\\work", GATED), []);
});

t("UNIT-11: classifyVerbToken null for a known-write verb whose args are all clean (branch 1 via known-write, not catch-all)", () => {
  const stage = [{ value: "sed", quoted: false }, { value: "s/a/b/", quoted: false }, { value: "in.txt", quoted: false }];
  assert.equal(classifyVerbToken(stage, 0, "C:\\work", GATED), null); // no -i present -> handleSed returns null
});

// ---------------------------------------------------------------------------
// Adversary v2 follow-up — generic CLI wrappers moved OUT of the read set,
// now routed through catchAllUnknownVerb (fixed, per coordinator correction)
// ---------------------------------------------------------------------------

t("ADVV2-01: wsl cp a.txt out.ps1 -> BLOCK (branch 3 now: final round's wsl-unwrap lets cp resolve precisely, superseding the earlier cruder catch-all block)", () => {
  const r = bash("wsl cp a.txt out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("ADVV2-02: wsl -- bash -lc \"ls\" -> allow (no gated/ambiguous argument)", () => {
  assert.equal(bash('wsl -- bash -lc "ls"').allow, true);
});

t("ADVV2-03: pg_dump --file out.ps1 -> BLOCK (branch 4)", () => {
  const r = bash("pg_dump --file out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("ADVV2-04: pg_dump -f x.dump -> allow (not a gated extension)", () => {
  assert.equal(bash("pg_dump -f x.dump").allow, true);
});

t("ADVV2-05: psql -f x.sql -> allow", () => {
  assert.equal(bash("psql -f x.sql").allow, true);
});

t("ADVV2-06: gh pr create --body-file body.md -> allow", () => {
  assert.equal(bash("gh pr create --body-file body.md").allow, true);
});

// ── GH-API-READ (cm gh-api adversary follow-up to ADVV2-06) ─────────────────
// `gh api <endpoint>` has no local-file write surface of its own; a REST
// path/query argument routinely contains `?`/`&`, which the generic
// catch-all unknown-verb scan otherwise misreads as an ambiguous glob and
// blocks (branch 4 false positive). See isGhApiReadSegment.

t("GHAPI-01: gh api '<endpoint>?query' --jq '...' -> allow (bare REST path/query no longer ambiguous)", () => {
  const r = bash("gh api 'repos/o/r/dependabot/alerts?state=all&per_page=100' --jq '[.[]|{n:.number}]'");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.branch, 1);
});

t("GHAPI-02: GH_TOKEN=x gh api ... --paginate -> allow (env-prefix stripped by findPrimaryVerbIndex, verb reaches isGhApiReadSegment)", () => {
  const r = bash("GH_TOKEN=x gh api repos/o/r/issues --paginate");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.branch, 1);
  assert.notEqual(r.overridden, true, "must not pass via the SHELL_WRITE_OK override — this proves the gh-api read path itself");
});

t("GHAPI-03: gh api --method GET repos/o/r/issues -> allow (no flag/method parsing needed)", () => {
  const r = bash("gh api --method GET repos/o/r/issues");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.branch, 1);
});

t("GHAPI-04: gh api repos/o/r/issues > out.ps1 -> BLOCK (redirect to gated extension still fires)", () => {
  const r = bash("gh api repos/o/r/issues > out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 3);
  assert.equal(r.detector, "redirect");
});

t("GHAPI-05: gh api repos/o/r/issues | tee notes.md -> current tee (non-gated ext) handling unchanged", () => {
  const r = bash("gh api repos/o/r/issues | tee notes.md");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.branch, 2);
  assert.equal(r.detector, "tee");
});

t("GHAPI-06: gh -R o/r api '...?x=1' -> stays on catch-all, BLOCKED (global flag before api is not the bare gh-api shape)", () => {
  const r = bash("gh -R o/r api 'repos/o/r?x=1'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
  assert.equal(r.reason, "unknown-verb-ambiguous-argument");
});

t("GHAPI-07: gh whatever 'a?b' -> other gh subcommands unaffected, still BLOCKED", () => {
  const r = bash("gh whatever 'a?b'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
});

t("GHAPI-08 (PowerShell tool): gh api '<endpoint>?query' --jq '...' -> allow", () => {
  const r = ps("gh api 'repos/o/r/dependabot/alerts?state=all&per_page=100' --jq '[.[]|{n:.number}]'");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.branch, 1);
});

t("GHAPI-09 (PowerShell tool): gh api repos/o/r/issues | Out-File x.md -> current PS write handling unchanged", () => {
  const r = ps("gh api repos/o/r/issues | Out-File x.md");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.branch, 2);
  assert.equal(r.detector, "Out-File");
});

// ── OVERRIDE-STRICT (independent-review gap 2) ──────────────────────────────
// OVERRIDE_RE was `/^SHELL_WRITE_OK=\S+\s/` — ANY non-space value after
// `SHELL_WRITE_OK=` was a full unconditional bypass. Fixed to require the
// exact literal value `1`. Any other value is not an override at all — it
// is just an ordinary VAR=value env-prefix that findPrimaryVerbIndex strips
// before classification proceeds normally on the real verb/args.

t("OVR-01: SHELL_WRITE_OK=1 foo 'a?b' -> allow (override fires on the exact value 1)", () => {
  const r = bash("SHELL_WRITE_OK=1 foo 'a?b'");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.overridden, true);
});

t("OVR-02: SHELL_WRITE_OK=0 foo 'a?b' -> BLOCKED (not an override — ordinary env-prefix, unknown verb + ambiguous arg)", () => {
  const r = bash("SHELL_WRITE_OK=0 foo 'a?b'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
  assert.notEqual(r.overridden, true);
});

t("OVR-03: SHELL_WRITE_OK=true foo 'a?b' -> BLOCKED (not an override)", () => {
  const r = bash("SHELL_WRITE_OK=true foo 'a?b'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
  assert.notEqual(r.overridden, true);
});

t("OVR-04: SHELL_WRITE_OK=1foo 'a?b' -> BLOCKED (no whitespace after the value — not an override; the whole 'SHELL_WRITE_OK=1foo' is one env-prefix token, so 'a?b' itself becomes the verb, and a bare quoted glob-shaped verb is not a valid command name)", () => {
  const r = bash("SHELL_WRITE_OK=1foo 'a?b'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
  assert.notEqual(r.overridden, true);
});

// ── QUOTED-VERB (independent-review gap 3) ──────────────────────────────────
// findPrimaryVerbIndex used to `return -1` the instant the effective verb
// token was quoted, and analyzeStage treated -1 as "no verb -> allow" —
// `"cp" a.txt out.ps1` silently bypassed classification entirely even
// though real shell semantics execute a quoted command name exactly like
// its unquoted form. Fixed: a quoted verb whose dequoted value is a valid
// bare word (no whitespace/metachar) is classified exactly as if unquoted;
// a quoted verb that ISN'T a valid bare word (multi-word, or itself
// metachar-laden) is an unconditional branch-4 unknown verb.

t("QV-01: \"cp\" a.txt out.ps1 -> BLOCKED, same branch as unquoted cp", () => {
  const quoted = bash('"cp" a.txt out.ps1');
  const unquoted = bash("cp a.txt out.ps1");
  assert.equal(quoted.allow, false, JSON.stringify(quoted));
  assert.equal(quoted.branch, unquoted.branch);
  assert.equal(quoted.branch, 3);
});

t("QV-02: 'cp' a.txt out.ps1 -> BLOCKED, same branch as unquoted cp", () => {
  const quoted = bash("'cp' a.txt out.ps1");
  const unquoted = bash("cp a.txt out.ps1");
  assert.equal(quoted.allow, false, JSON.stringify(quoted));
  assert.equal(quoted.branch, unquoted.branch);
});

t('QV-03: "gh" api \'a?b\' -> BLOCKED branch 4 (quoted "gh" is a valid bare word, falls through to normal dispatch, still ends on catch-all since isGhApiReadSegment stays strict on unquoted gh/api)', () => {
  const r = bash('"gh" api \'a?b\'');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
});

t("QV-04: 'gh api' 'a?b' -> BLOCKED branch 4 (multi-word quoted verb is never a valid command name)", () => {
  const r = bash("'gh api' 'a?b'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
  assert.equal(r.reason, "quoted-verb-not-a-bare-word");
});

t('QV-05: "echo" hi -> allow (quoted known-read verb classified exactly as unquoted)', () => {
  const r = bash('"echo" hi');
  assert.equal(r.allow, true, JSON.stringify(r));
});

t('QV-06: FOO=1 "cp" a.txt out.ps1 -> BLOCKED (env prefix stripped, then quoted verb classified normally)', () => {
  const r = bash('FOO=1 "cp" a.txt out.ps1');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 3);
});

// PowerShell path check (gap 3): analyzePsStatement's verb regex
// (`^[A-Za-z_][A-Za-z0-9_.:-]*`) runs against the QUOTE-BLANKED scan text,
// so a quoted verb never matches it at all (the leading char is a quote
// delimiter, not a letter) — verbMatch is null, and the existing
// "unrecognized clause" fallback (classifyPsClauseArguments) scans the RAW
// clause content instead, which still catches a gated-extension argument.
// This is NOT the same escape Bash had (there is no branch that returns
// early with an unconditional allow) — PS never special-cased quoted verbs
// into a bypass, so no equivalent fix was needed there. Verified live.

t('QV-07 (PowerShell tool): "cp" a.txt out.ps1 -> BLOCKED via the existing unrecognized-clause fallback (no bypass to begin with)', () => {
  const r = ps('"cp" a.txt out.ps1');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
});

t("ADVV2-07: az storage blob download --file out.ps1 -> BLOCK (branch 4)", () => {
  const r = bash("az storage blob download --file out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("ADVV2-08: scp a.txt host:out.ps1 -> BLOCK (branch 4)", () => {
  const r = bash("scp a.txt host:out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("ADVV2-09: docker cp c:/x out.ps1 -> BLOCK (branch 4)", () => {
  const r = bash("docker cp c:/x out.ps1");
  assert.equal(r.allow, false); assert.equal(r.branch, 4);
});

t("ADVV2-10: curl still read-only for --data @file (no -o/-O present)", () => {
  assert.equal(bash("curl --data @payload.ps1 http://x").allow, true);
});

t("ADVV2-11: curl -o out.ps1 still resolves via the known-write path -> BLOCK", () => {
  assert.equal(bash("curl -o out.ps1 http://x").allow, false);
});

// ---------------------------------------------------------------------------
// Adversary-found fixes (see report adversary section)
// ---------------------------------------------------------------------------

t("ADV-01: cp evil.ps1 conf.d -> BLOCK when conf.d is a REAL on-disk directory (fs-stat fix)", () => {
  const dir = fs.mkdtempSync(path.join(TMPDIR, "swg-adv-"));
  const confD = path.join(dir, "conf.d");
  fs.mkdirSync(confD);
  try {
    const r = bash("cp evil.ps1 conf.d", dir);
    assert.equal(r.allow, false, JSON.stringify(r));
    assert.match(r.target, /conf\.d\/evil\.ps1$/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

t("ADV-02: cp evil.ps1 notadir.d -> allow when notadir.d does NOT exist on disk (lexical fallback, not a false block)", () => {
  const dir = fs.mkdtempSync(path.join(TMPDIR, "swg-adv-"));
  try {
    // notadir.d does not exist -> stat fails -> falls back to lexical
    // heuristic, which sees a dot in the basename and treats it as a plain
    // (non-directory) file target with extension ".d" (not gated).
    const r = bash("cp evil.ps1 notadir.d", dir);
    assert.equal(r.allow, true, JSON.stringify(r));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

t("ADV-03: PowerShell Copy-Item -Path a.txt -Destination out.ps1 -> BLOCK (Destination wins over Path)", () => {
  const r = ps("Copy-Item -Path a.txt -Destination out.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("ADV-04: PowerShell Copy-Item -Path a.ps1 -Destination out.txt -> allow (proves target = Destination, not Path)", () => {
  const r = ps("Copy-Item -Path a.ps1 -Destination out.txt");
  assert.equal(r.allow, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

t("CFG-01: config file on disk matches the required default shape", () => {
  const configPath = path.join(__dirname, "shell-write-guard.config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed.gatedExtensions, [".ps1", ".psm1", ".psd1"]);
});

t("CFG-02: loadConfig falls back to default on malformed JSON", () => {
  const bad = path.join(TMPDIR, "shell-write-guard-badconfig-" + Date.now() + ".json");
  fs.writeFileSync(bad, "NOT VALID JSON", "utf8");
  try {
    const cfg = loadConfig(bad);
    assert.deepEqual(cfg, DEFAULT_GATED_EXTENSIONS);
  } finally { try { fs.unlinkSync(bad); } catch (_) {} }
});

t("CFG-03: loadConfig falls back to default on missing file", () => {
  const cfg = loadConfig(path.join(TMPDIR, "definitely-does-not-exist-" + Date.now() + ".json"));
  assert.deepEqual(cfg, DEFAULT_GATED_EXTENSIONS);
});

// ---------------------------------------------------------------------------
// Pure unit tests: classifyExtension / resolveTarget / isAmbiguousToken
// ---------------------------------------------------------------------------

t("UNIT-01: classifyExtension no-extension basename -> branch 2", () => {
  assert.equal(classifyExtension("makefile", GATED).branch, 2);
});

t("UNIT-02: isAmbiguousToken detects $, backtick, glob", () => {
  assert.equal(isAmbiguousToken("$FOO"), true);
  assert.equal(isAmbiguousToken("`x`"), true);
  assert.equal(isAmbiguousToken("*.ps1"), true);
  assert.equal(isAmbiguousToken("plain.txt"), false);
});

t("UNIT-03: resolveTarget with indeterminate (symbol) cwd -> branch 4", () => {
  const r = resolveTarget("rel.ps1", Symbol("indeterminate"), GATED);
  assert.equal(r.branch, 4);
});

t("UNIT-04: detectCmdCIndirection null on unrelated command", () => {
  assert.equal(detectCmdCIndirection("git status", GATED), null);
});

t("UNIT-05: detectHeredocFedInterpreter null when no heredoc present", () => {
  assert.equal(detectHeredocFedInterpreter("node script.js"), null);
});

// ---------------------------------------------------------------------------
// Hook integration: fail-open on malformed stdin, wrong tool, log rotation
// ---------------------------------------------------------------------------

t("H-01: malformed stdin JSON -> exit 0, no stdout/stderr", () => {
  let exitCode = 0, stdout = "";
  try {
    stdout = execFileSync("node", [HOOK_PATH], { input: "NOT VALID JSON !!!", encoding: "utf8", timeout: 8000 });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
    stdout = err.stdout ? String(err.stdout) : "";
  }
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
});

t("H-02: empty stdin -> exit 0 (fail-open)", () => {
  let exitCode = 0;
  try {
    execFileSync("node", [HOOK_PATH], { input: "", encoding: "utf8", timeout: 8000 });
  } catch (err) {
    exitCode = (err.status != null) ? err.status : 1;
  }
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
});

t("H-03: tool_name Read (out of scope) -> exit 0 regardless of command shape", () => {
  const { exitCode } = runHook({ tool_name: "Read", tool_input: { file_path: "foo.ps1" }, cwd: "C:\\work" });
  assert.equal(exitCode, 0);
});

t("H-04: full hook run — Bash gated write -> exit 2 with Fix line in stderr", () => {
  const { exitCode, stderr } = runHook({ tool_name: "Bash", tool_input: { command: "echo x > foo.ps1" }, cwd: "C:\\work" });
  assert.equal(exitCode, 2);
  assert.match(stderr, /Delegate this edit to a subagent/);
  assert.match(stderr, /SHELL_WRITE_OK=1/);
});

t("H-05: full hook run — Bash non-gated write -> exit 0", () => {
  const { exitCode } = runHook({ tool_name: "Bash", tool_input: { command: "echo x > foo.txt" }, cwd: "C:\\work" });
  assert.equal(exitCode, 0);
});

t("H-06: full hook run — PowerShell tool gated cmdlet -> exit 2", () => {
  const { exitCode, stderr } = runHook({ tool_name: "PowerShell", tool_input: { command: "Set-Content -Path out.ps1 -Value x" }, cwd: "C:\\work" });
  assert.equal(exitCode, 2);
  assert.match(stderr, /Set-Content/);
});

t("H-07: full hook run — override marker -> exit 0, no stderr", () => {
  const { exitCode, stderr } = runHook({ tool_name: "Bash", tool_input: { command: "SHELL_WRITE_OK=1 echo x > foo.ps1" }, cwd: "C:\\work" });
  assert.equal(exitCode, 0);
  assert.equal(stderr.trim(), "");
});

t("H-08: log rotation — write debug log past 2MB, then run hook, assert .1 rotated file created and live log shrinks", () => {
  const logPath = path.join(__dirname, "shell-write-guard-debug.log");
  const rotatedPath = logPath + ".1";
  const backupLog = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null;
  const backupRotated = fs.existsSync(rotatedPath) ? fs.readFileSync(rotatedPath) : null;
  try {
    const filler = "x".repeat(1024);
    const lines = [];
    // (2 MB / ~1KB) + margin lines to push size safely over the 2MB threshold.
    for (let i = 0; i < 2200; i++) lines.push(filler);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const sizeBefore = fs.statSync(logPath).size;
    assert.ok(sizeBefore > 2 * 1024 * 1024, `test setup must exceed 2MB, got ${sizeBefore}`);

    runHook({ tool_name: "Bash", tool_input: { command: "echo x > foo.txt" }, cwd: "C:\\work" });

    assert.ok(fs.existsSync(rotatedPath), "expected rotated .1 log file to exist after rotation");
    const rotatedSize = fs.statSync(rotatedPath).size;
    assert.ok(rotatedSize > 2 * 1024 * 1024, "rotated file should hold the oversized content");
    const liveSize = fs.statSync(logPath).size;
    assert.ok(liveSize < rotatedSize, "live log should have restarted small after rotation");
  } finally {
    try { fs.unlinkSync(rotatedPath); } catch (_) {}
    try { fs.unlinkSync(logPath); } catch (_) {}
    if (backupRotated) fs.writeFileSync(rotatedPath, backupRotated);
    if (backupLog) fs.writeFileSync(logPath, backupLog);
  }
});

// (D4: log rotation is now provided by model-routing-guards.log.js's shared
// appendRotating/createLogger, exercised end-to-end by H-08 above. That
// module's own rotation unit tests live in its own test file, not here.)

// ---------------------------------------------------------------------------
// KNOWN_MIXED tier: psql/sqlite3/mysql-style CLIs.
// Spec: docs/specs/shell-write-guard-mixed-cli-tier.md, section 9 test
// matrix (MIXED-01..70), adversary rounds 1 (MC-01..17) and 2 (MC2-01..09).
// ---------------------------------------------------------------------------

const { classifyCommand: mixedClassify } = require(HOOK_PATH);
function bashSql(cmd, cwd) { return mixedClassify(cmd, cwd || "C:\\work", "Bash", [".sql"]); }

t("MIXED-01 (v1 #1): psql -f x.sql -> allow", () => {
  assert.equal(bash("psql -f x.sql").allow, true);
});

t("MIXED-02 (v1 #2): psql -f x.sql, .sql gated -> allow", () => {
  assert.equal(bashSql("psql -f x.sql").allow, true);
});

t("MIXED-03 (v1 #3, incident shape): psql -h localhost -p 5432 -U postgres -d db -f tmp.sql, .sql gated -> allow", () => {
  const r = bashSql("psql -h localhost -p 5432 -U postgres -d db -f tmp.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-04 (v1 #4): psql -c \"select 1\" -> block, message names -f", () => {
  const r = bash('psql -c "select 1"');
  assert.equal(r.allow, false);
  assert.match(r.reason, /-f/);
});

t("MIXED-05 (v1 #5): psql -o out.ps1 -> block", () => {
  assert.equal(bash("psql -o out.ps1").allow, false);
});

t("MIXED-06 (v1 #6): psql -o out.txt -> allow", () => {
  assert.equal(bash("psql -o out.txt").allow, true);
});

t("MIXED-07 (v1 #7 + MC-03): psql --output=out.ps1 -> block", () => {
  assert.equal(bash("psql --output=out.ps1").allow, false);
});

t("MIXED-08 (v1 #12, MC-14 corrected): psql --unknown-flag out.ps1 -> block, UNKNOWN-token FRICTION naming --unknown-flag", () => {
  const r = bash("psql --unknown-flag out.ps1");
  assert.equal(r.allow, false);
  assert.equal(r.reason, "unknown-flag");
  assert.equal(r.target, "--unknown-flag");
});

t("MIXED-09 (v1 #13): psql -f x.sql -o out.ps1 -> block, target out.ps1", () => {
  const r = bash("psql -f x.sql -o out.ps1");
  assert.equal(r.allow, false);
  assert.match(r.target, /out\.ps1/);
});

t("MIXED-10 (MC-13): psql -A -t -F, -f export.sql -> allow, benign flags enumerated (glued -F, too)", () => {
  const r = bash("psql -A -t -F, -f export.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-11 (MC-14 regression proof): psql -f tmp.sql --tuples-only, .sql gated -> allow, -f role survives co-occurring flag", () => {
  const r = bashSql("psql -f tmp.sql --tuples-only");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-12 (MC-01): psql -f /dev/stdin <<< \"SELECT 1\" -> block, names tempfile canon", () => {
  const r = bash('psql -f /dev/stdin <<< "SELECT 1"');
  assert.equal(r.allow, false);
  assert.match(r.reason, /stdin-sentinel-use-tempfile/);
});

t("MIXED-13 (MC-01): psql -f - -> block", () => {
  assert.equal(bash("psql -f -").allow, false);
});

t("MIXED-14 (MC-01): psql -f /dev/fd/5 -> block", () => {
  assert.equal(bash("psql -f /dev/fd/5").allow, false);
});

t("MIXED-15 (MC-01): psql -f <(echo \"DROP TABLE x;\") -> block", () => {
  const r = bash('psql -f <(echo "DROP TABLE x;")');
  assert.equal(r.allow, false);
});

t("MIXED-16 (decision 1): psql -h localhost -d db < script.sql -> allow, literal stdin redirect", () => {
  const r = bash("psql -h localhost -d db < script.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-17 (decision 1): psql -h localhost -d db <<EOF heredoc -> block", () => {
  const r = bash("psql -h localhost -d db <<EOF\nSELECT 1;\nEOF");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-18 (decision 1): psql -h localhost -d db <<< \"SELECT 1\" -> block, here-string", () => {
  const r = bash('psql -h localhost -d db <<< "SELECT 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-19 (decision 1): cat script.sql | psql db -> block, pipe-fed stdin, no FILE/INLINE role", () => {
  const r = bash("cat script.sql | psql db");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-20 (MC-03): psql -h localhost -d db --command=\"SELECT 1\" (Bash) -> block, =-split normalized", () => {
  const r = bash('psql -h localhost -d db --command="SELECT 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-21 (MC-04): psql -h localhost -d db --command=\"SELECT 1\" (PowerShell) -> block, clause reassembly before lookup", () => {
  const r = ps('psql -h localhost -d db --command="SELECT 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-22 (MC-05): psql -h localhost -d db -cSELECT (glued) -> block, glued-flag prefix match", () => {
  const r = bash("psql -h localhost -d db -cSELECT");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-23 (MC-06): psql \"-c\" \"SELECT 1\" -> block, quoted-bit-insensitive match", () => {
  const r = bash('psql "-c" "SELECT 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-24 (MC-11): psql -- -c 'SELECT 1' -> block, -- not honored as end-of-options", () => {
  const r = bash("psql -- -c 'SELECT 1'");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-25 (MC-15): psql -v ON_ERROR_STOP=1 -v cmd=$(rm -rf /) -f x.sql -> block, -v value ambiguous", () => {
  const r = bash('psql -v ON_ERROR_STOP=1 -v "cmd=$(rm -rf /)" -f x.sql');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-26 (MC-15): psql -L out.ps1 -f x.sql -> block, -L is OUTPUT-role", () => {
  const r = bash("psql -L out.ps1 -f x.sql");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-27 (MC-17): psql postgres://user:p%24ss@host/db -f x.sql -> allow, URL-encoded $", () => {
  const r = bash("psql postgres://user:p%24ss@host/db -f x.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-28 (MC-17 companion): psql postgres://user:p$ss@host/db -f x.sql -> block, raw $ in positional", () => {
  const r = bash("psql postgres://user:p$ss@host/db -f x.sql");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-29 (MC-02, Bash): docker exec -it dbcontainer psql -c \"DROP TABLE x;\" -> block, wrapper-unwrapped", () => {
  const r = bash('docker exec -it dbcontainer psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-30 (MC-02, Bash): ssh dbhost psql -c \"DROP TABLE x;\" -> block, wrapper-unwrapped", () => {
  const r = bash('ssh dbhost psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-31 (MC-02, Bash): kubectl exec pod -- psql -c \"DROP TABLE x;\" -> block, wrapper-unwrapped", () => {
  const r = bash('kubectl exec pod -- psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-32 (MC-02 extension): podman run --rm img psql -c \"...\" -> block, wrapper-unwrapped", () => {
  const r = bash('podman run --rm img psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-33 (regression): sudo -u postgres psql -c \"...\" -> block, existing sudo unwrap + new INLINE role", () => {
  const r = bash('sudo -u postgres psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-34 (wrapper-exhausted side effect): ssh dbhost (no inner command) -> block", () => {
  const r = bash("ssh dbhost");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "wrapper-exhausted-no-inner-verb");
});

t("MIXED-35 (wrapper-exhausted side effect): sudo -i -> block", () => {
  const r = bash("sudo -i");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "wrapper-exhausted-no-inner-verb");
});

t("MIXED-36 (MC-10): psql -f tmp.sql across a PowerShell backtick line continuation -> allow", () => {
  const r = ps("psql -h localhost -d db `\n  -f tmp.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-37 (MC-08): mysql -e \"select 1\" -uroot -> block, -e now INLINE", () => {
  const r = bash('mysql -e "select 1" -uroot');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-38 (MC-08 + MC-03): mysql --execute=\"select 1\" -> block, =-split + INLINE", () => {
  const r = bash('mysql --execute="select 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-39 (MC-12): mysql -c -e \"select 1\" -d somedb -> block on -e only; -c (comments) benign", () => {
  const r = bash('mysql -c -e "select 1" -d somedb');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason.startsWith("inline-sql-content-blind"), true, JSON.stringify(r));
});

t("MIXED-40 (MC-12 companion): mysql -C -e \"select 1\" -> block on -e; -C (compress) benign", () => {
  const r = bash('mysql -C -e "select 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-41 (v1 #10): mysql -e \"select 1\" --result-file=out.ps1 -> block", () => {
  const r = bash('mysql -e "select 1" --result-file=out.ps1');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-42 (MC-08, INVERTED from v1 #11): mysql -e \"select 1\" db -> block", () => {
  const r = bash('mysql -e "select 1" db');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-43 (MC-08): mysql db -e \"select 1\" -> block, order-independent", () => {
  const r = bash('mysql db -e "select 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-44 (mysql -p special-case): mysql -pSECRET db -> allow, glued optional-arg password", () => {
  const r = bash("mysql -pSECRET db");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-45 (mysql -p special-case): mysql -p db -> allow, bare -p does NOT consume db", () => {
  const r = bash("mysql -p db");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-46 (MC-07): sqlite3 db.sqlite \"SELECT id FROM users\" -> block, second positional is FRICTION", () => {
  const r = bash('sqlite3 db.sqlite "SELECT id FROM users"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-47 (MC-07, INVERTED from v1 #8): sqlite3 db.sqlite \".read x.sql\" -> block", () => {
  const r = bash('sqlite3 db.sqlite ".read x.sql"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-48 (decision 4): sqlite3 -cmd \".read x.sql\" db.sqlite -> block, -cmd content-blind", () => {
  const r = bash('sqlite3 -cmd ".read x.sql" db.sqlite');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-49 (decision 4): sqlite3 -init startup.sql db.sqlite -> allow", () => {
  const r = bash("sqlite3 -init startup.sql db.sqlite");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-50 (§3 invariant symmetry): sqlite3 -init startup.ps1 db.sqlite -> allow, FILE-role extension-exempt even for .ps1", () => {
  const r = bash("sqlite3 -init startup.ps1 db.sqlite");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-51 (MC-01 cross-CLI): sqlite3 -init /dev/stdin db.sqlite -> block, stdin-sentinel applies cross-CLI", () => {
  const r = bash("sqlite3 -init /dev/stdin db.sqlite");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-52 (§7.2 policy): sqlite3 -unsafe-testing db.sqlite -> block, UNKNOWN -> FRICTION (unconfirmed flag)", () => {
  const r = bash("sqlite3 -unsafe-testing db.sqlite");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "unknown-flag");
});

t("MIXED-53 (recursion note): bash -c 'psql -c \"select 1\"' -> block via existing shell-inline recursion", () => {
  const r = bash("bash -c 'psql -c \"select 1\"'");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-54 (§6.3 recursion): pwsh -Command 'psql -c \"select 1\"' -> block via PS-inline recursion", () => {
  const r = bash('pwsh -Command \'psql -c "select 1"\'');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-55 (§6.3 PowerShell splat): psql @creds -f x.sql -> block, @-prefixed token already ambiguous", () => {
  const r = ps("psql @creds -f x.sql");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-56 (§6.3 here-string): psql -c @\"\\nSELECT 1\\n\"@ -> block, here-string FRICTION", () => {
  const r = ps('psql -c @"SELECT 1"@');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-57 (§4): xargs psql -c \"select 1\" -> block, xargs unwrapped", () => {
  const r = bash('xargs psql -c "select 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-58 (§4): nohup psql -f x.sql -> allow, nohup unwrapped", () => {
  const r = bash("nohup psql -f x.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-59 (MC2-03, PS-native): docker exec -it dbcontainer psql -c \"DROP TABLE x;\" (native PowerShell) -> block", () => {
  const r = ps('docker exec -it dbcontainer psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-60 (MC2-03, PS-native): ssh dbhost psql -c \"DROP TABLE x;\" (native PowerShell) -> block", () => {
  const r = ps('ssh dbhost psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-61 (MC2-03, PS-native): kubectl exec pod -- psql -c \"DROP TABLE x;\" (native PowerShell) -> block", () => {
  const r = ps('kubectl exec pod -- psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-62 (MC2-03, PS-native): podman run --rm img psql -c \"...\" (native PowerShell) -> block", () => {
  const r = ps('podman run --rm img psql -c "DROP TABLE x;"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-63 (MC2-01, corrected): mysql db<script.sql -> allow, glued redirect split and resolved via the SAME literal-file rule as the spaced form (decision 1)", () => {
  const r = bash("mysql db<script.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-64 (MC2-01, corrected): psql -h localhost -d db<script.sql -> allow, glued redirect on a flag-bearing command, literal file", () => {
  const r = bash("psql -h localhost -d db<script.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-65 (MC2-01): psql -h localhost -d db<(cat evil.sql) -> block, glued process substitution", () => {
  const r = bash("psql -h localhost -d db<(cat evil.sql)");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-66 (MC2-02): mysql -h attackerhost -u root -e \"select 1\" -> block on -e; -h/-u correctly consume their own args", () => {
  const r = bash('mysql -h attackerhost -u root -e "select 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason.startsWith("inline-sql-content-blind"), true, JSON.stringify(r));
});

t("MIXED-67 (MC2-02 regression proof): mysql -h localhost -u root db < script.sql (no -e) -> allow", () => {
  const r = bash("mysql -h localhost -u root db < script.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-68 (MC2-04): mysql -Cpassword123 db -> allow, -C OPTIONAL-glued-only does not misconsume db", () => {
  const r = bash("mysql -Cpassword123 db");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("MIXED-69 (MC2-08): mysql db extra positional -> block, positional 2+ FRICTION", () => {
  const r = bash("mysql db extra positional");
  assert.equal(r.allow, false, JSON.stringify(r));
});

t("MIXED-70 (MC2-09): psql backtick continuation with TRAILING WHITESPACE, then -f tmp.sql -> allow", () => {
  const r = ps("psql -h localhost -d db `  \n  -f tmp.sql");
  assert.equal(r.allow, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// RV-01 (reviewer finding on PR #9): a quoted, flag-shaped, UNRECOGNIZED
// token was falling through to classifyMixedBareToken (allowed as a
// connection/positional slot) instead of FRICTIONing as UNKNOWN — the
// unknown-flag check was wrongly gated on `!tok.quoted`. Fixed in
// dispatchKnownMixed; these tests lock in quoted-bit-insensitive UNKNOWN
// classification across all three CLIs, Bash and PowerShell, plus prove a
// quoted RECOGNIZED flag still matches correctly (was already correct via
// matchMixedFlag, which never gated on quoted — confirmed, not just fixed).
// ---------------------------------------------------------------------------

t('MIXED-71 (RV-01, psql, Bash): psql "--unknown-flag" -f x.sql -> block, quoted unrecognized flag is FRICTION', () => {
  const r = bash('psql "--unknown-flag" -f x.sql');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "unknown-flag");
});

t('MIXED-72 (RV-01, psql, Bash): psql -f x.sql "-badflag" -> block, quoted unrecognized flag after a resolved FILE role is FRICTION', () => {
  const r = bash('psql -f x.sql "-badflag"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "unknown-flag");
});

t('MIXED-73 (RV-01, mysql, Bash): mysql db "--unknown-flag" -> block, quoted unrecognized flag is FRICTION', () => {
  const r = bash('mysql db "--unknown-flag"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "unknown-flag");
});

t('MIXED-74 (RV-01, sqlite3, Bash): sqlite3 db.sqlite "--unknown-flag" -> block, quoted unrecognized flag is FRICTION (not the positional-2+ path)', () => {
  const r = bash('sqlite3 db.sqlite "--unknown-flag"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.reason, "unknown-flag");
});

t('MIXED-75 (RV-01, psql, PowerShell-native): psql "--unknown-flag" -f x.sql -> block, quoted unrecognized flag is FRICTION', () => {
  const r = ps('psql "--unknown-flag" -f x.sql');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t('MIXED-76 (RV-01, mysql, PowerShell-native): mysql db "--unknown-flag" -> block, quoted unrecognized flag is FRICTION', () => {
  const r = ps('mysql db "--unknown-flag"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t('MIXED-77 (RV-01, sqlite3, PowerShell-native): sqlite3 db.sqlite "--unknown-flag" -> block, quoted unrecognized flag is FRICTION', () => {
  const r = ps('sqlite3 db.sqlite "--unknown-flag"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t('MIXED-78 (RV-01, quoted "--" consistency): psql "--" -c \'SELECT 1\' -> block, quoted -- is inert (same as unquoted), -c still recognized', () => {
  const r = bash('psql "--" -c \'SELECT 1\'');
  assert.equal(r.allow, false, JSON.stringify(r));
});

t('MIXED-79 (RV-01 regression proof, quoted recognized flag): psql "-f" x.sql -> allow, a quoted RECOGNIZED flag still matches (unaffected by the fix)', () => {
  const r = bash('psql "-f" x.sql');
  assert.equal(r.allow, true, JSON.stringify(r));
});

t('MIXED-80 (RV-01 regression proof, quoted recognized flag, PowerShell): psql "-c" "select 1" -> block on -c itself (quoted recognized INLINE flag still matches)', () => {
  const r = ps('psql "-c" "select 1"');
  assert.equal(r.allow, false, JSON.stringify(r));
});

// ═══════════════════════════════════════════════════════════════════════════
// PROTECTED_PATH extension (docs/specs/hook-state-write-guard.md §2.3) —
// branch 5, a shell write into the guard framework's own STATE_DIR. Uses
// literal "hooks/state/..." targets throughout: the segment-bounded
// /hooks/state/ over-block rule (spec §2.2 rule 2, reused here via
// isProtectedStatePath) fires regardless of the actual resolved STATE_DIR
// for this install, which is the deliberate behavior under test.
// ═══════════════════════════════════════════════════════════════════════════

t("PROTECTED-01 (bash_cp_into_state_dir_denied): cp forged.json hooks/state/x.json -> branch 5 deny", () => {
  const r = bash("cp forged.json hooks/state/stop-stale-worktrees-guard.abc.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-02 (bash_tee_into_state_dir_denied): tee hooks/state/x.json -> branch 5 deny", () => {
  const r = bash("tee hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-03 (bash_redirect_gt_into_state_dir_denied): echo '{}' > hooks/state/x.json -> branch 5 deny", () => {
  const r = bash("echo '{}' > hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-04 (bash_redirect_append_into_state_dir_denied): echo '{}' >> hooks/state/x.json -> branch 5 deny", () => {
  const r = bash("echo '{}' >> hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-05 (bash_backslash_path_into_state_dir_denied): cp forged.json hooks\\state\\x.json -> branch 5 deny", () => {
  const r = bash("cp forged.json hooks\\state\\x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t('PROTECTED-06 (bash_quoted_target_into_state_dir_denied): cp forged.json "hooks/state/x.json" -> branch 5 deny', () => {
  const r = bash('cp forged.json "hooks/state/x.json"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-07 (powershell_set_content_into_state_dir_denied): Set-Content -Path hooks/state/x.json -Value '{}' -> branch 5 deny", () => {
  const r = ps("Set-Content -Path hooks/state/x.json -Value '{}'");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-08 (powershell_out_file_into_state_dir_denied): '{}' | Out-File hooks/state/x.json -> branch 5 deny", () => {
  const r = ps("'{}' | Out-File hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-09 (powershell_redirect_into_state_dir_denied): '{}' > hooks/state/x.json -> branch 5 deny", () => {
  const r = ps("'{}' > hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-10 (override_does_not_suppress_state_dir_write): SHELL_WRITE_OK=1 cp forged.json hooks/state/x.json -> still branch 5 deny", () => {
  const r = bash("SHELL_WRITE_OK=1 cp forged.json hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
  assert.notEqual(r.overridden, true);
});

t("PROTECTED-11 (override_still_suppresses_ordinary_gated_ext_write): SHELL_WRITE_OK=1 cp x.ps1 y.ps1 -> allow (unchanged)", () => {
  const r = bash("SHELL_WRITE_OK=1 cp x.ps1 y.ps1");
  assert.equal(r.allow, true, JSON.stringify(r));
  assert.equal(r.overridden, true);
});

t("PROTECTED-12 (dotdot_traversal_into_state_dir_denied): cp forged.json hooks/state/../state/x.json -> branch 5 deny", () => {
  const r = bash("cp forged.json hooks/state/../state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t('PROTECTED-13 (unresolvable_target_with_literal_hooks_state_text_denied): STATEDIR=hooks/state; cp forged.json "$STATEDIR/x.json" -> branch 5 deny (raw-text fallback)', () => {
  const r = bash('STATEDIR=hooks/state; cp forged.json "$STATEDIR/x.json"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t('PROTECTED-14 (unresolvable_target_quoted_literal_hooks_state_denied): STATEDIR="hooks/state"; cp forged.json "$STATEDIR/x.json" -> branch 5 deny (quote-strip)', () => {
  const r = bash('STATEDIR="hooks/state"; cp forged.json "$STATEDIR/x.json"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-15 (unresolvable_target_no_literal_text_stays_branch4): fully indirect target, no hooks/state text anywhere -> branch 4, ordinary friction", () => {
  const r = bash('D=$(cat /tmp/target-dir-name); cp forged.json "$D/x.json"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
});

t("PROTECTED-16 (split_variable_target_stays_branch4): H1=hooks; H2=state; cp forged.json \"$H1/$H2/x.json\" -> branch 4, declared blind spot §6(e)", () => {
  const r = bash('H1=hooks; H2=state; cp forged.json "$H1/$H2/x.json"');
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 4);
});

t("PROTECTED-17 (unresolvable_target_comment_text_literal_denied): a #-comment line naming hooks/state, unrelated real write on a later line -> branch 5 deny (accepted friction, blind spot §6(d))", () => {
  const cmd = ["# writing to hooks/state is fine, do not worry", 'D=$(cat /tmp/target-dir-name); cp forged.json "$D/x.json"'].join(
    "\n"
  );
  const r = bash(cmd);
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-18 (cat_state_dir_file_allowed): cat hooks/state/x.json -> allow (branch 1, read verb)", () => {
  const r = bash("cat hooks/state/stop-stale-worktrees-guard.abc.json");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("PROTECTED-19 (grep_state_dir_allowed): grep strikes hooks/state/*.json -> allow", () => {
  const r = bash("grep strikes hooks/state/x.json");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("PROTECTED-20 (sibling_dir_name_prefix_allowed): cp x.txt hooks/state-backup/y.txt -> allow (prefix boundary)", () => {
  const r = bash("cp x.txt hooks/state-backup/y.txt");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("PROTECTED-21 (hooks_statement_sibling_allowed): cp x.txt hooks/statement/y.txt -> allow (not a segment match)", () => {
  const r = bash("cp x.txt hooks/statement/y.txt");
  assert.equal(r.allow, true, JSON.stringify(r));
});

t("PROTECTED-22 (write_outside_state_dir_unaffected): cp a.txt b.ps1 -> existing branch 3 behavior, unchanged", () => {
  const r = bash("cp a.txt b.ps1");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 3);
});

t("PROTECTED-23 (multi-stage command, branch 5 dominates): cp a.txt b.ps1; cp c.txt hooks/state/x.json -> branch 5, not 3", () => {
  const r = bash("cp a.txt b.ps1; cp c.txt hooks/state/x.json");
  assert.equal(r.allow, false, JSON.stringify(r));
  assert.equal(r.branch, 5);
});

t("PROTECTED-24 (normalizeRawCommandForStateDirCheck): strips quotes/backslashes, lowercases, collapses slashes", () => {
  assert.equal(normalizeRawCommandForStateDirCheck('STATEDIR="Hooks/State"'), "statedir=hooks/state");
  assert.equal(normalizeRawCommandForStateDirCheck("hooks\\\\state\\\\x.json"), "hooks/state/x.json");
  assert.equal(normalizeRawCommandForStateDirCheck("hooks//state/./x.json"), "hooks/state/x.json");
});

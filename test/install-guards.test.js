"use strict";
// test/install-guards.test.js
//
// Exercises scripts/install-guards.js entirely against in-memory objects
// and temp-directory fixtures. NEVER points at a real ~/.claude/settings.json
// — every spawn-based test below overrides HOME/USERPROFILE and cwd to
// fresh directories under os.tmpdir(), and every direct-call test builds
// its own settings object from scratch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  GUARDS,
  LEGACY_GUARD_FILES,
  mergeGuardHooks,
  isOurs,
  isLegacy,
  normalizeCommand,
  validateHooksSection,
  detectIndent,
  detectOursPresent,
  serializeSettings,
  unifiedDiff,
  scanEntries,
  diffLines,
  reconcileFormatting,
  makeBackupPath,
  collectManagedRelPaths,
  filesDiffer,
  planBackups,
  backupDiffering,
} = require("../scripts/install-guards.js");

const INSTALL_SCRIPT = path.join(__dirname, "..", "scripts", "install-guards.js");

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // best-effort
  }
}

const FAKE_HOOKS_DIR = "C:/fake/home/.claude/hooks";

// ── isOurs / normalizeCommand ────────────────────────────────────────────────

test("isOurs: recognizes a plain node command ending in hooks/<guard>.js", () => {
  const id = isOurs("node C:/fake/home/.claude/hooks/no-punt-guard.js");
  assert.deepEqual(id, { id: "no-punt-guard" });
});

test("isOurs: recognizes a quoted path with spaces", () => {
  const id = isOurs('node "C:/Fake/home with spaces/.claude/hooks/shell-write-guard.js"');
  assert.deepEqual(id, { id: "shell-write-guard" });
});

test("isOurs: rejects a command for a file this repo doesn't ship", () => {
  assert.equal(isOurs("node C:/fake/home/.claude/hooks/some-other-hook.js"), null);
});

test("isOurs: rejects a substring match (no-punt-guard.js.bak)", () => {
  assert.equal(isOurs("node C:/fake/home/.claude/hooks/no-punt-guard.js.bak"), null);
});

test("isOurs: rejects a command with extra arguments", () => {
  assert.equal(isOurs("node C:/fake/home/.claude/hooks/no-punt-guard.js --verbose"), null);
});

test("isOurs: rejects a non-node command", () => {
  assert.equal(isOurs("python C:/fake/home/.claude/hooks/no-punt-guard.js"), null);
});

test("normalizeCommand: lowercases only a leading drive letter", () => {
  assert.equal(normalizeCommand("C:\\Fake\\Hooks\\X.js"), "c:/Fake/Hooks/X.js");
});

// ── validateHooksSection (total classification) ──────────────────────────────

test("validateHooksSection: rejects non-object top level", () => {
  assert.equal(validateHooksSection(null).ok, false);
  assert.equal(validateHooksSection([]).ok, false);
  assert.equal(validateHooksSection("x").ok, false);
});

test("validateHooksSection: accepts settings with no hooks key", () => {
  assert.equal(validateHooksSection({}).ok, true);
});

test("validateHooksSection: rejects hooks.<event> that isn't an array", () => {
  const r = validateHooksSection({ hooks: { PreToolUse: {} } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must be an array/);
});

test("validateHooksSection: rejects a non-object entry", () => {
  const r = validateHooksSection({ hooks: { PreToolUse: [null] } });
  assert.equal(r.ok, false);
});

// ── mergeGuardHooks: fresh install ───────────────────────────────────────────

test("mergeGuardHooks: fresh settings gets every guard added exactly once", () => {
  const settings = {};
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  assert.equal(report.added.length, GUARDS.length);
  assert.equal(report.repointed.length, 0);
  assert.equal(report.moved.length, 0);

  // Every guard's command shows up exactly once, under the right event+matcher.
  for (const g of GUARDS) {
    const arr = settings.hooks[g.event];
    assert.ok(Array.isArray(arr), `hooks.${g.event} must exist`);
    const hits = [];
    for (const entry of arr) {
      const entryMatcher = typeof entry.matcher === "string" ? entry.matcher : null;
      if (entryMatcher !== g.matcher) continue;
      for (const inner of entry.hooks) {
        if (isOurs(inner.command) && isOurs(inner.command).id === g.id) hits.push(inner);
      }
    }
    assert.equal(hits.length, 1, `expected exactly one entry for ${g.id}`);
  }
});

test("mergeGuardHooks: is idempotent (second run makes no changes)", () => {
  const settings = {};
  mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  const snapshot = JSON.stringify(settings);
  const report2 = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  assert.equal(JSON.stringify(settings), snapshot);
  assert.equal(report2.added.length, 0);
  assert.equal(report2.repointed.length, 0);
  assert.equal(report2.moved.length, 0);
  assert.equal(report2.deduped.length, 0);
});

test("mergeGuardHooks: preserves an unrelated existing hook untouched", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node /somewhere/else/my-other-hook.js" }] },
      ],
    },
  };
  mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  const bashGroups = settings.hooks.PreToolUse.filter((e) => e.matcher === "Bash");
  const otherStillThere = bashGroups.some((g) =>
    g.hooks.some((h) => h.command === "node /somewhere/else/my-other-hook.js")
  );
  assert.ok(otherStillThere, "unrelated hook must survive the merge");
});

test("mergeGuardHooks: re-points an existing guard entry to a new hooksDir", () => {
  const settings = {};
  mergeGuardHooks(settings, { hooksDir: "C:/old/hooks" });
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  assert.ok(report.repointed.includes("no-punt-guard"));
  const stopGroup = settings.hooks.Stop.find((e) => !e.matcher);
  assert.ok(stopGroup.hooks[0].command.includes("C:/fake/home"));
});

test("mergeGuardHooks: dedupes two entries for the same guard, keeping one", () => {
  const settings = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: `node ${FAKE_HOOKS_DIR}/no-punt-guard.js` }] },
        { hooks: [{ type: "command", command: `node ${FAKE_HOOKS_DIR}/no-punt-guard.js` }] },
      ],
    },
  };
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  assert.equal(report.deduped.length, 1);
  const remaining = settings.hooks.Stop.filter((e) => e.hooks && e.hooks.length > 0);
  const noPuntCount = remaining.reduce(
    (acc, e) => acc + e.hooks.filter((h) => isOurs(h.command) && isOurs(h.command).id === "no-punt-guard").length,
    0
  );
  assert.equal(noPuntCount, 1);
});

test("mergeGuardHooks: moves a guard entry found under the wrong matcher", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Read", hooks: [{ type: "command", command: `node ${FAKE_HOOKS_DIR}/shell-write-guard.js` }] },
      ],
    },
  };
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
  assert.ok(report.moved.some((m) => m.id === "shell-write-guard"));
  const expectedMatcher = GUARDS.find((g) => g.id === "shell-write-guard").matcher;
  const bashGroup = settings.hooks.PreToolUse.find((e) => e.matcher === expectedMatcher);
  assert.ok(bashGroup.hooks.some((h) => isOurs(h.command) && isOurs(h.command).id === "shell-write-guard"));
  const readGroup = settings.hooks.PreToolUse.find((e) => e.matcher === "Read");
  assert.equal(readGroup, undefined, "the now-empty Read group must be pruned");
});

// ── mergeGuardHooks: --uninstall ─────────────────────────────────────────────

test("mergeGuardHooks uninstall: removes only judge's entries", () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "node /somewhere/else/unrelated-stop-hook.js" }] }],
    },
  };
  mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR }); // install first
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR, uninstall: true });
  assert.equal(report.removed.length, GUARDS.length);

  // Nothing of ours remains anywhere.
  for (const event of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[event]) {
      for (const inner of entry.hooks || []) {
        assert.equal(isOurs(inner.command), null);
      }
    }
  }
  // The unrelated Stop hook survives.
  const stopHooks = settings.hooks.Stop.flatMap((e) => e.hooks || []);
  assert.ok(stopHooks.some((h) => h.command === "node /somewhere/else/unrelated-stop-hook.js"));
});

// ── serialize / diff / backup ────────────────────────────────────────────────

test("serializeSettings: preserves detected indent and EOL", () => {
  const text = serializeSettings({ a: 1, b: 2 }, { indent: "    ", eol: "\r\n", hadBOM: false });
  assert.ok(text.includes("\r\n"));
  assert.ok(text.includes("    \"a\": 1"));
});

test("reconcileFormatting: keeps untouched lines' original bytes", () => {
  const original = '{\n\t"a": 1\n}\n';
  const naive = '{\n  "a": 1\n}\n';
  const reconciled = reconcileFormatting(original, naive);
  assert.equal(reconciled, original);
});

test("unifiedDiff: empty diff for identical text", () => {
  assert.equal(unifiedDiff("same\n", "same\n", "f.json"), "");
});

test("unifiedDiff: non-empty diff for changed text", () => {
  const d = unifiedDiff("a\n", "b\n", "f.json");
  assert.match(d, /^--- a\/f\.json/);
  assert.match(d, /-a/);
  assert.match(d, /\+b/);
});

test("makeBackupPath: appends a numeric suffix on collision", () => {
  const tmp = mkTmpDir("install-guards-backup-");
  try {
    const target = path.join(tmp, "settings.json");
    fs.writeFileSync(target, "{}");
    const ts = "2026-01-01T00-00-00.000Z";
    const first = makeBackupPath(target, ts);
    fs.writeFileSync(first, "{}");
    const second = makeBackupPath(target, ts);
    assert.notEqual(first, second);
    assert.match(second, /-2$/);
  } finally {
    rmTree(tmp);
  }
});

// ── detectOursPresent ─────────────────────────────────────────────────────────

test("detectOursPresent: false for a nonexistent file", () => {
  assert.equal(detectOursPresent(path.join(os.tmpdir(), "definitely-does-not-exist-xyz.json")), false);
});

test("detectOursPresent: true once a guard has been merged in", () => {
  const tmp = mkTmpDir("install-guards-detect-");
  try {
    const target = path.join(tmp, "settings.json");
    const settings = {};
    mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });
    fs.writeFileSync(target, JSON.stringify(settings));
    assert.equal(detectOursPresent(target), true);
  } finally {
    rmTree(tmp);
  }
});

// ── End-to-end CLI, fully sandboxed under a fake HOME ────────────────────────

function runCli(args, { home, cwd }) {
  return execFileSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
}

test("CLI --dry-run --hooks-scope project: writes nothing under a fake HOME/cwd", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    const out = runCli(["--dry-run", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    assert.match(out, /dry-run/i);
    assert.equal(fs.existsSync(path.join(fakeProject, ".claude", "settings.local.json")), false);
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "hooks")), false);
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

test("CLI --force --hooks-scope project then --uninstall: fully sandboxed round trip", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    runCli(["--force", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    const settingsPath = path.join(fakeProject, ".claude", "settings.local.json");
    assert.ok(fs.existsSync(settingsPath), "project settings file must be created");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(detectOursPresent(settingsPath), "settings must contain judge's guard entries");
    for (const g of GUARDS) {
      assert.ok(fs.existsSync(path.join(fakeHome, ".claude", "hooks", g.file)), `${g.file} must be copied`);
    }

    runCli(["--force", "--hooks-scope", "project", "--uninstall"], { home: fakeHome, cwd: fakeProject });
    assert.equal(detectOursPresent(settingsPath), false, "guard entries must be gone after uninstall");
    for (const g of GUARDS) {
      assert.equal(
        fs.existsSync(path.join(fakeHome, ".claude", "hooks", g.file)),
        false,
        `${g.file} must be removed by uninstall`
      );
    }
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

// ── GUARDS matcher scope: PowerShell (dry-run bug this file's PR fixes) ─────

test("GUARDS: shell-write-guard's matcher includes PowerShell", () => {
  const g = GUARDS.find((x) => x.id === "shell-write-guard");
  assert.ok(g, "shell-write-guard must be registered");
  assert.ok(
    g.matcher.split("|").includes("PowerShell"),
    `shell-write-guard.js handles tool_name "PowerShell" (see its own header, "Matcher scope: Bash | PowerShell") ` +
      `but its GUARDS matcher is ${JSON.stringify(g.matcher)}`
  );
});

test("GUARDS: orchestrator-tool-guard's matcher includes PowerShell (and only the five tools its code switches on)", () => {
  const g = GUARDS.find((x) => x.id === "orchestrator-tool-guard");
  assert.ok(g, "orchestrator-tool-guard must be registered");
  const tools = g.matcher.split("|");
  assert.ok(
    tools.includes("PowerShell"),
    `orchestrator-tool-guard.js has an explicit case "PowerShell" but its GUARDS matcher is ${JSON.stringify(g.matcher)}`
  );
  // The guard's own switch statement only has cases for these five tool
  // names; anything else reaching it hits the "unexpected_tool_name" block
  // branch, per its own header ("matcher should be Read|Bash|PowerShell|
  // Write|Edit only"). A wider matcher would mean legitimate Agent/
  // SendMessage calls get unconditionally blocked.
  assert.deepEqual(tools.sort(), ["Bash", "Edit", "PowerShell", "Read", "Write"].sort());
});

test("mergeGuardHooks: consolidates a pre-existing standalone Bash entry and a pre-existing standalone PowerShell entry for the same guard into one entry under the guard's combined matcher, without dropping an unrelated hook sharing the PowerShell block", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `node ${FAKE_HOOKS_DIR}/shell-write-guard.js` }] },
        {
          matcher: "PowerShell",
          hooks: [
            { type: "command", command: `node ${FAKE_HOOKS_DIR}/shell-write-guard.js` },
            { type: "command", command: "node /somewhere/else/unrelated-ps-hook.js" },
          ],
        },
      ],
    },
  };
  const expectedMatcher = GUARDS.find((g) => g.id === "shell-write-guard").matcher; // "Bash|PowerShell"
  mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });

  // Exactly one shell-write-guard entry remains anywhere, and it lives under
  // the combined matcher — the operator's real PowerShell-only matcher
  // block is never simply deleted along with our entry.
  let hits = 0;
  let combinedGroupSeen = false;
  for (const entry of settings.hooks.PreToolUse) {
    const entryMatcher = typeof entry.matcher === "string" ? entry.matcher : null;
    for (const inner of entry.hooks || []) {
      const id = isOurs(inner.command);
      if (id && id.id === "shell-write-guard") {
        hits++;
        assert.equal(entryMatcher, expectedMatcher, "shell-write-guard must live under its combined matcher");
        combinedGroupSeen = true;
      }
    }
  }
  assert.equal(hits, 1, "shell-write-guard must appear exactly once after consolidation");
  assert.ok(combinedGroupSeen);

  // No bare "Bash" or bare "PowerShell" matcher group is left holding a
  // shell-write-guard entry.
  for (const entry of settings.hooks.PreToolUse) {
    if (entry.matcher === "Bash" || entry.matcher === "PowerShell") {
      for (const inner of entry.hooks || []) {
        const id = isOurs(inner.command);
        assert.notEqual(id && id.id, "shell-write-guard");
      }
    }
  }

  // The unrelated hook that shared the standalone PowerShell block survives
  // (the block is pruned only when it becomes fully empty, never wholesale).
  const survivorGroup = settings.hooks.PreToolUse.find(
    (e) => e.matcher === "PowerShell" && (e.hooks || []).some((h) => h.command === "node /somewhere/else/unrelated-ps-hook.js")
  );
  assert.ok(survivorGroup, "unrelated hook sharing the old standalone PowerShell block must survive");
});

// ── Backup of overwritten hook files (safety gap fixed by this PR) ─────────

test("collectManagedRelPaths / filesDiffer / planBackups: identify only differing, installer-managed files", () => {
  const tmpSrc = mkTmpDir("install-guards-backup-src-");
  const tmpDest = mkTmpDir("install-guards-backup-dest-");
  try {
    fs.writeFileSync(path.join(tmpSrc, "guard-a.js"), "new content A");
    fs.writeFileSync(path.join(tmpDest, "guard-a.js"), "old content A"); // differs
    fs.writeFileSync(path.join(tmpSrc, "guard-b.js"), "same content B");
    fs.writeFileSync(path.join(tmpDest, "guard-b.js"), "same content B"); // identical
    // guard-c.js exists only in src (fresh install) — must not be "differing".
    fs.writeFileSync(path.join(tmpSrc, "guard-c.js"), "brand new C");
    // A file the installer does not manage at all must never be considered.
    fs.writeFileSync(path.join(tmpDest, "not-ours.js"), "leave me alone");

    assert.equal(filesDiffer(path.join(tmpSrc, "guard-a.js"), path.join(tmpDest, "guard-a.js")), true);
    assert.equal(filesDiffer(path.join(tmpSrc, "guard-b.js"), path.join(tmpDest, "guard-b.js")), false);
    assert.equal(filesDiffer(path.join(tmpSrc, "guard-c.js"), path.join(tmpDest, "guard-c.js")), false);

    // planBackups drives off the real GUARDS/SUPPORT_FILES/SUPPORT_DIRS list,
    // so exercise it against the real repo hooks/ directory instead of the
    // synthetic guard-a/b/c files above (those only exercise filesDiffer).
    const realSrcHooksDir = path.join(__dirname, "..", "hooks");
    const tmpRealDest = mkTmpDir("install-guards-backup-realdest-");
    try {
      fs.mkdirSync(tmpRealDest, { recursive: true });
      const swgSrc = fs.readFileSync(path.join(realSrcHooksDir, "shell-write-guard.js"), "utf8");
      fs.writeFileSync(path.join(tmpRealDest, "shell-write-guard.js"), swgSrc + "\n// locally modified\n");
      const npgSrc = fs.readFileSync(path.join(realSrcHooksDir, "no-punt-guard.js"));
      fs.writeFileSync(path.join(tmpRealDest, "no-punt-guard.js"), npgSrc); // byte-identical
      fs.writeFileSync(path.join(tmpRealDest, "not-managed-by-installer.js"), "untouchable");

      const toBackup = planBackups(realSrcHooksDir, tmpRealDest);
      assert.ok(toBackup.includes("shell-write-guard.js"));
      assert.ok(!toBackup.includes("no-punt-guard.js"));
      assert.ok(!toBackup.includes("not-managed-by-installer.js"));
    } finally {
      rmTree(tmpRealDest);
    }
  } finally {
    rmTree(tmpSrc);
    rmTree(tmpDest);
  }
});

test("backupDiffering: copies only the listed relative paths, preserving subdirectory structure", () => {
  const tmpDest = mkTmpDir("install-guards-backupdiffering-");
  try {
    fs.mkdirSync(path.join(tmpDest, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmpDest, "guard-a.js"), "old A");
    fs.writeFileSync(path.join(tmpDest, "lib", "shared.js"), "old shared");
    fs.writeFileSync(path.join(tmpDest, "guard-b.js"), "untouched B");

    const backupDir = backupDiffering(tmpDest, ["guard-a.js", path.join("lib", "shared.js")], "2026-01-01T00-00-00.000Z");
    assert.equal(backupDir, path.join(tmpDest, ".backup-2026-01-01T00-00-00.000Z"));
    assert.equal(fs.readFileSync(path.join(backupDir, "guard-a.js"), "utf8"), "old A");
    assert.equal(fs.readFileSync(path.join(backupDir, "lib", "shared.js"), "utf8"), "old shared");
    assert.equal(fs.existsSync(path.join(backupDir, "guard-b.js")), false, "un-listed file must not be backed up");
  } finally {
    rmTree(tmpDest);
  }
});

test("CLI --dry-run: reports how many differing files would be backed up, without writing anything", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    const hooksDir = path.join(fakeHome, ".claude", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const before = "old shell-write-guard content, pre-existing on disk";
    fs.writeFileSync(path.join(hooksDir, "shell-write-guard.js"), before);

    const out = runCli(["--dry-run", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    assert.match(out, /would back up 1 differing file\(s\)/);

    // Nothing was actually written: the pre-existing file is untouched and
    // no backup directory was created.
    assert.equal(fs.readFileSync(path.join(hooksDir, "shell-write-guard.js"), "utf8"), before);
    const backupDirs = fs.readdirSync(hooksDir).filter((f) => f.startsWith(".backup-"));
    assert.equal(backupDirs.length, 0);
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

// ── --yes / non-TTY fail-fast (this PR) ─────────────────────────────────────

test("CLI with no --yes/--force/--non-interactive and non-TTY stdin: refuses fast naming --yes, writes nothing", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    // execFileSync defaults to stdio:'pipe' — a pipe is never a TTY, so this
    // exercises exactly the shape that used to hang forever on
    // readline.question() waiting for stdin that can never arrive.
    let threw = null;
    try {
      runCli(["--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "must exit non-zero instead of hanging or succeeding");
    assert.equal(threw.status, 1);
    assert.match(threw.stderr, /--yes/);
    assert.match(threw.stderr, /not a TTY/);

    // Nothing was written: no settings file, no copied hook files.
    assert.equal(fs.existsSync(path.join(fakeProject, ".claude", "settings.local.json")), false);
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "hooks")), false);
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

test("CLI --dry-run with no --yes/--force: never prompts, even with non-TTY stdin (unaffected by this PR)", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    // Must NOT throw and must NOT hang: --dry-run bypasses the confirmation
    // gate entirely, before the TTY check is ever reached.
    const out = runCli(["--dry-run", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    assert.match(out, /dry-run/i);
    assert.doesNotMatch(out, /--yes/);
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

test("CLI --yes --hooks-scope project then --uninstall: skips confirmation and writes, full round trip", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    runCli(["--yes", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    const settingsPath = path.join(fakeProject, ".claude", "settings.local.json");
    assert.ok(fs.existsSync(settingsPath), "project settings file must be created");
    assert.ok(detectOursPresent(settingsPath), "settings must contain judge's guard entries");
    for (const g of GUARDS) {
      assert.ok(fs.existsSync(path.join(fakeHome, ".claude", "hooks", g.file)), `${g.file} must be copied`);
    }

    // -y (the short alias) must behave identically for --uninstall.
    runCli(["-y", "--hooks-scope", "project", "--uninstall"], { home: fakeHome, cwd: fakeProject });
    assert.equal(detectOursPresent(settingsPath), false, "guard entries must be gone after uninstall");
    for (const g of GUARDS) {
      assert.equal(
        fs.existsSync(path.join(fakeHome, ".claude", "hooks", g.file)),
        false,
        `${g.file} must be removed by uninstall`
      );
    }
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

test("CLI --force real run: backs up a differing hook file and leaves a byte-identical one alone", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    const hooksDir = path.join(fakeHome, ".claude", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const oldContent = "old shell-write-guard content, pre-existing on disk";
    fs.writeFileSync(path.join(hooksDir, "shell-write-guard.js"), oldContent);
    // no-punt-guard.js pre-exists byte-identical to what the installer will
    // copy in, so it must be left alone (not backed up).
    const realNoPunt = fs.readFileSync(path.join(__dirname, "..", "hooks", "no-punt-guard.js"));
    fs.writeFileSync(path.join(hooksDir, "no-punt-guard.js"), realNoPunt);

    const out = runCli(["--force", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });
    assert.match(out, /Backed up 1 differing file\(s\) to/);

    const backupDirs = fs.readdirSync(hooksDir).filter((f) => f.startsWith(".backup-"));
    assert.equal(backupDirs.length, 1, "exactly one backup directory must be created");
    const backupDir = path.join(hooksDir, backupDirs[0]);
    assert.equal(fs.readFileSync(path.join(backupDir, "shell-write-guard.js"), "utf8"), oldContent);
    assert.equal(fs.existsSync(path.join(backupDir, "no-punt-guard.js")), false, "identical file must not be backed up");

    // The live file was actually overwritten with the new content.
    const realSwg = fs.readFileSync(path.join(__dirname, "..", "hooks", "shell-write-guard.js"), "utf8");
    assert.equal(fs.readFileSync(path.join(hooksDir, "shell-write-guard.js"), "utf8"), realSwg);
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

// ── Legacy prune (session-end-worktree-guard.js's SessionEnd rename) ────────

test("isLegacy: recognizes the retired stop-stale-worktrees-guard.js command path", () => {
  const hit = isLegacy(`node ${FAKE_HOOKS_DIR}/stop-stale-worktrees-guard.js`);
  assert.deepEqual(hit, { file: "stop-stale-worktrees-guard.js" });
});

test("isLegacy: rejects a command for a file that isn't retired", () => {
  assert.equal(isLegacy(`node ${FAKE_HOOKS_DIR}/no-punt-guard.js`), null);
});

test("mergeGuardHooks: prunes a stale Stop entry for the retired guard and adds the new SessionEnd entry", () => {
  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: `node ${FAKE_HOOKS_DIR}/stop-stale-worktrees-guard.js`, timeout: 30 },
            { type: "command", command: `node ${FAKE_HOOKS_DIR}/no-punt-guard.js` },
          ],
        },
      ],
    },
  };
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR });

  assert.equal(report.prunedLegacy.length, 1);
  assert.equal(report.prunedLegacy[0].file, "stop-stale-worktrees-guard.js");

  // The legacy Stop entry is gone; the sibling no-punt-guard entry (same
  // group) survives untouched.
  const stopGroup = settings.hooks.Stop.find((e) => !e.matcher);
  assert.ok(stopGroup, "no-punt-guard's own Stop group must still exist");
  assert.equal(
    stopGroup.hooks.some((h) => isLegacy(h.command)),
    false,
    "no legacy command must remain anywhere in hooks.Stop"
  );
  assert.ok(
    stopGroup.hooks.some((h) => isOurs(h.command) && isOurs(h.command).id === "no-punt-guard"),
    "no-punt-guard's own entry must survive the prune"
  );

  // The new SessionEnd entry for session-end-worktree-guard was added.
  assert.ok(Array.isArray(settings.hooks.SessionEnd), "hooks.SessionEnd must exist");
  const segEntry = settings.hooks.SessionEnd.flatMap((e) => e.hooks).find(
    (h) => isOurs(h.command) && isOurs(h.command).id === "session-end-worktree-guard"
  );
  assert.ok(segEntry, "session-end-worktree-guard must be registered on SessionEnd");
  assert.equal(segEntry.timeout, 30);
});

test("mergeGuardHooks: legacy prune also runs on --uninstall", () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `node ${FAKE_HOOKS_DIR}/stop-stale-worktrees-guard.js` }] }],
    },
  };
  const report = mergeGuardHooks(settings, { hooksDir: FAKE_HOOKS_DIR, uninstall: true });
  assert.equal(report.prunedLegacy.length, 1);
  const remaining = (settings.hooks.Stop || []).flatMap((e) => e.hooks || []);
  assert.equal(remaining.some((h) => isLegacy(h.command)), false);
});

test("LEGACY_GUARD_FILES: no current GUARDS entry ships a file also listed as legacy", () => {
  const legacySet = new Set(LEGACY_GUARD_FILES);
  for (const g of GUARDS) {
    assert.equal(legacySet.has(g.file), false, `${g.file} is both an active guard and marked legacy`);
  }
});

test("CLI install prunes an existing settings.json's stale Stop entry for the retired guard and installs SessionEnd", () => {
  const fakeHome = mkTmpDir("install-guards-home-");
  const fakeProject = mkTmpDir("install-guards-project-");
  try {
    const settingsDir = path.join(fakeProject, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, "settings.local.json");
    const legacySettings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `node ${path.join(fakeHome, ".claude", "hooks", "stop-stale-worktrees-guard.js").replace(/\\/g, "/")}`,
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(legacySettings, null, 2));

    runCli(["--force", "--hooks-scope", "project"], { home: fakeHome, cwd: fakeProject });

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const stopCommands = (after.hooks.Stop || []).flatMap((e) => e.hooks || []).map((h) => h.command);
    assert.ok(
      stopCommands.every((c) => !isLegacy(c)),
      "no stop-stale-worktrees-guard.js command must remain on hooks.Stop"
    );
    const sessionEndCommands = (after.hooks.SessionEnd || []).flatMap((e) => e.hooks || []).map((h) => h.command);
    assert.ok(
      sessionEndCommands.some((c) => c.endsWith("session-end-worktree-guard.js")),
      "session-end-worktree-guard.js must be registered on SessionEnd"
    );
    assert.ok(
      fs.existsSync(path.join(fakeHome, ".claude", "hooks", "session-end-worktree-guard.js")),
      "session-end-worktree-guard.js must be copied into the hooks dir"
    );
  } finally {
    rmTree(fakeHome);
    rmTree(fakeProject);
  }
});

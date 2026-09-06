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
  mergeGuardHooks,
  isOurs,
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
  const id = isOurs('node "C:/Users/a b/.claude/hooks/shell-write-guard.js"');
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
  const bashGroup = settings.hooks.PreToolUse.find((e) => e.matcher === "Bash");
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

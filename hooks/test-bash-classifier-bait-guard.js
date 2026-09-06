"use strict";
// test-bash-classifier-bait-guard.js
// Self-contained, in-process test runner for checkCommand(). Drives the
// exported function directly — NO test shells out to bash or executes any
// real command; every command string below is inert classifier test data.
//
// Run: node test-bash-classifier-bait-guard.js
// Exit 0 all-pass; nonzero otherwise. Prints "N/M" pass summary.

const { checkCommand } = require("./bash-classifier-bait-guard.js");

// expected: null => must ALLOW; string => must BLOCK with that branch id
//   ("B1" also matches an actual returned branch of "B1"; "B2v" matches "B2v")
const cases = [
  // ── Required table: BLOCK B1 ──────────────────────────────────────────
  ["rm -rf .git", "B1"],
  ["git clean -fdx", "B1"],
  ["cp malicious.json .claude/settings.json", "B1"],
  ["tee .claude/settings.json", "B1"],
  ["install bad.json .claude/settings.json", "B1"],
  ["echo x >> C:\\Home\\testuser\\.claude\\settings.json", "B1"],
  ["mv new.js ~/.claude/hooks/guard.js", "B1"],
  ["rm C:/Home/testuser/.claude/hooks/old.js", "B1"],
  ['cmd /c "rd /s /q .claude\\hooks"', "B1"],

  // ── Required table: BLOCK B2 ───────────────────────────────────────────
  ['for wt in .claude/worktrees/agent-*; do git worktree remove --force "$wt"; done', "B2"],
  ['for b in $(git branch --merged | grep agent-); do git branch -Df "$b"; done', "B2"],
  ["find .claude/worktrees -name 'agent-*' -mtime +7 -delete", "B2"],
  ["find . -name '*.tmp' -exec rm {} \\;", "B2"],
  ["git branch --list | xargs git branch -D", "B2"],
  // DECISION (see bash-classifier-bait-guard.js DECISIONS / report): `dropdb`
  // is not in the DESTRUCTIVE OPERATOR list, so a $()-fed loop whose body
  // invokes it does not trip B2 — matches spec's stated philosophy that a
  // false negative here is tolerable and the pattern can be added later.
  ["for db in $(psql -Atc 'select datname from pg_database'); do dropdb \"$db\"; done", null],

  // ── Required table: BLOCK B2v ──────────────────────────────────────────
  ["rm -rf $WT", "B2v"],
  ["git push origin --delete $todel", "B2v"],
  ["git branch -D $(cat stale.txt)", "B2v"],

  // ── Required table: BLOCK B3 ────────────────────────────────────────────
  ["mv C:/Home/testuser/.claude/x.md C:/Home/testuser/.claude/y.md && rm C:/Home/testuser/old.md", "B3"],
  ["mkdir -p ~/.claude/hooks/new && node setup.js", "B3"],

  // ── Required table: ALLOW regressions ───────────────────────────────────
  ["git worktree remove --force .claude/worktrees/agent-a4a1943800697633b", null],
  ["rm .claude/worktrees/agent-x/.scratch/tmp.json", null],
  ["mv .claude/worktrees/agent-x/.scratch/out.txt ./out.txt", null],
  ['git commit -m "fix: wait for review, cleanup rm-related bug in .env.example docs"', null],
  ["git branch -D a b c", null],
  ["rm /tmp/x.txt", null],
  ["git push --force-with-lease origin main", null],
  ["grep -E 'foo|bar' file", null],
  ["git log --format='%H > %s'", null],
  ["git status", null],
  ["gh pr list --state merged --limit 20 --json number", null],
  ["sed -n '106p' file.jsonl | grep -o 'x'", null],
  ["git fetch --prune", null],
  ["node scripts/handoff.js resume", null],
  ["git worktree prune", null],

  // ── Author-added cases ───────────────────────────────────────────────
  // .gitignore / .gitattributes / .github must never match the standalone
  // .git path check (word-boundary requirement).
  ["rm -rf .gitignore", null],
  ["rm -rf .gitattributes", null],
  ["rm -rf .github/workflows/ci.yml", null],
  // "digit" must not false-positive against the .git substring check.
  ["echo digit-counter-value", null],
  // .env.example / .env.sample / .env.template must never match .env,
  // even unquoted and even as a destructive op's literal target.
  ["rm .env.example", null],
  ["rm .env.sample", null],
  ["rm .env.template", null],
  // Bare ".env" (unquoted) as a destructive target IS protected.
  ["rm .env", "B1"],
  ["cat .env/nested", null], // not destructive operator (cat not in list) -> ALLOW despite protected path
  // Path matching is case-insensitive and slash-direction-agnostic.
  ["rm -rf SETTINGS.JSON", "B1"],
  ["rm -rf C:\\Home\\testuser\\.CLAUDE\\HOOKS\\x.js", "B1"],
  // Worktree carve-out must survive case-insensitivity too.
  ["rm .CLAUDE/WORKTREES/agent-x/out.txt", null],
  // git branch -D with a long-form --delete co-occurring with a protected
  // path in the same segment.
  ["git branch --delete .claude/hooks", "B1"],
  // find -exec with a NON-destructive command must not trip the sweep check.
  ["find . -name '*.log' -exec echo {} \\;", null],
  // xargs with a non-destructive command must not trip the sweep check.
  ["echo file1 file2 | xargs echo", null],
  // xargs feeding a destructive command with no protected path -> B2 (sweep+destroy), not B1.
  ["find . -name '*.bak' | xargs rm", "B2"],
  // git reset --hard alone (no protected path, no sweep) -> ALLOW.
  ["git reset --hard HEAD~1", null],
  // git reset --hard co-occurring with a protected path in the same segment -> B1.
  ["git reset --hard && rm .claude/settings.json", "B1"],
  // git global flags interposed before the subcommand must still be recognized.
  ["git -C /some/dir clean -fdx", "B1"],
  // The --git-dir value itself contains a literal .git path segment, which
  // co-occurs with `reset --hard` in the same segment -> correctly B1 (not
  // a global-flag-skipping bug: the skip logic is what let us reach the
  // `reset` subcommand at all; the .git reference is separately real).
  ["git --git-dir=/r/.git --work-tree=/r reset --hard", "B1"],
  // Same global-flag-skipping path, but with no .git-shaped value anywhere -> ALLOW.
  ["git --git-dir=/r/repo.gitdir --work-tree=/r reset --hard", null],
  // Quoted prose containing an operator word must never trigger, even
  // when a real protected path also appears unquoted elsewhere (still
  // same-segment, so this specifically tests the quoting carve-out, not
  // segment scoping).
  ["git commit -m 'rm -rf .git' -- .claude/worktrees/agent-x/.scratch/note.txt", null],
  // Literal enumerated rm targets (no sweep, no variable) -> ALLOW.
  ["rm a.txt b.txt c.txt", null],
  // $(...) substitution used as a plain argument to a non-destructive
  // command must not be misparsed as a segment-splitting pipe (the
  // substitution body itself contains a pipe).
  ["echo $(git log --oneline | head -1)", null],
];

let pass = 0;
const failures = [];

for (const [cmd, expectedBranch] of cases) {
  let result;
  try {
    result = checkCommand(cmd);
  } catch (e) {
    failures.push({ cmd, expectedBranch, error: e && e.stack });
    continue;
  }
  const actualBranch = result ? result.branch : null;
  const ok = expectedBranch === null ? actualBranch === null : actualBranch === expectedBranch;
  if (ok) {
    pass++;
  } else {
    failures.push({ cmd, expectedBranch, actualBranch, result });
  }
}

const total = cases.length;
console.log(`${pass}/${total} passed`);

if (failures.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) {
    console.log(`  cmd: ${f.cmd}`);
    console.log(`    expected: ${f.expectedBranch === null ? "ALLOW" : f.expectedBranch}`);
    if (f.error) {
      console.log(`    threw: ${f.error}`);
    } else {
      console.log(`    actual:   ${f.actualBranch === null ? "ALLOW" : f.actualBranch}`);
      console.log(`    detail:   ${JSON.stringify(f.result)}`);
    }
  }
  process.exit(1);
}

process.exit(0);

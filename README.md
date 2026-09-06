# judge

Harness law for multi-agent Claude Code sessions.

## What this is

`judge` is the enforcement layer that sits on top of a multi-agent coding
session. It ships a set of hooks — small scripts wired into a Claude Code
installation's `PreToolUse` / `Stop` / `SessionEnd` events — that block a
fixed set of dispatch failure modes before they land:

- an orchestrator tier drafting content instead of delegating it
- an agent approving or merging the pull request it authored
- a validator being skipped in favor of a self-review
- a shell write bypassing the hooks gated on editor-tool calls
- a background watch replacing a foreground poll on a gating check
- an agent operating outside the worktree it was isolated into

These are process invariants for how agents are dispatched, reviewed, and
allowed to touch shared state — not a memory or retrieval system. The rules
are written in tier language (orchestrator tier, planning tier, drafting
tier, mechanical tier) rather than against any specific model name, so the
same guards keep working as the tiers are remapped to newer models.

`judge` reads a small local policy file (`hooks/local-policy.json`, copied
from `hooks/local-policy.example.json`) for the paths and extensions that
are specific to one machine or one project. Nothing about a specific
person, employer, or private repository ships in this repository.

## What this is not

`judge` is not a memory engine. It does not store conversation history,
entities, assertions, or embeddings, and it has no opinion about how a
session resumes context across turns. For that, see a project's own
memory/retrieval layer — `judge` only consumes that layer's MCP surface
where a guard needs to check session state; it does not implement it.

## Layout

- `hooks/` — the guard scripts and their unit tests, plus `hooks/README.md`
  describing each guard (purpose, event, what it blocks).
- `hooks/local-policy.example.json` — template for the local policy file;
  copy to `hooks/local-policy.json` and edit for your machine.
- `scripts/install-guards.js` — merges the guards into a Claude Code
  user-scope `settings.json`, following the same matcher-wrapped schema,
  ownership marker, backup-and-atomic-write, `--dry-run`, `--hooks-scope`,
  and `--uninstall` pattern used elsewhere for hook installation. This
  script is never run against a live machine as part of this repository's
  own tests — it is exercised only against a temporary settings fixture.
- `docs/independence.md` — the first written law: authoring and
  approving/merging are always two separate dispatches; a spec-adversary
  pass runs before a matcher, parser, validator, or gate is authored, not
  after; every write-capable agent report carries a stated blind-spot
  section.
- `test/` — repository-level tests, including a scan that fails the build
  if anything under `hooks/` or `docs/` carries an owner-identifying path,
  handle, or private project name.

## Status

This repository is being built up in a small number of pull requests.
This first PR carries the dispatch guards themselves, parameterized to be
machine- and project-agnostic. Later PRs add a fully model-agnostic
routing guard and the judge docket protocol.

"use strict";
// agent-model-routing-guard-subagentstart.js
// Thin SubagentStart entry point for the per-agent tier ledger's id
// capture (owner decision D3) — the verified sole capture path as of
// 2026-09-06 (see hooks/README.md's "Capture verified" section). All real
// logic lives in agent-model-routing-guard.js's exported `main()`; this is
// a separate on-disk file, rather than a second registration of
// agent-model-routing-guard.js itself, because install-guards.js's
// isOurs() identifies an installed entry purely by which guard *file* its
// command runs, so two registrations sharing one filename could never be
// told apart on re-install. A third such file,
// agent-model-routing-guard-posttooluse.js (PostToolUse/Agent), existed
// alongside this one through PR 2 as an unverified id-capture fallback;
// it was removed once live verification showed it never contributed a
// captured id.
require("./agent-model-routing-guard.js").main();

"use strict";
// agent-model-routing-guard-posttooluse.js
// Thin PostToolUse (Agent) entry point for the per-agent tier ledger's id
// capture (owner decision D3). All real logic lives in
// agent-model-routing-guard.js's exported `main()` — this file exists only
// so install-guards.js can wire a SECOND, independently-identified
// (event, matcher) registration for the same guard logic: its own
// ownership-marker/dedup matching in scripts/install-guards.js keys off
// the installed command's file path, so a second registration pointed at
// the SAME file cannot be told apart from the first one on re-install.
// Giving each registration its own on-disk filename (all three requiring
// the same shared module) keeps that matching correct while the actual
// enforcement/capture code stays in one place. See hooks/README.md's
// "agent-model-routing-guard.js" section.
require("./agent-model-routing-guard.js").main();

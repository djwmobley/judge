"use strict";
// agent-model-routing-guard-subagentstart.js
// Thin SubagentStart entry point for the per-agent tier ledger's
// best-effort id capture (owner decision D3 — "do not depend on it"). All
// real logic lives in agent-model-routing-guard.js's exported `main()`;
// see agent-model-routing-guard-posttooluse.js's header comment for why
// this is a separate on-disk file rather than a third registration of the
// same filename.
require("./agent-model-routing-guard.js").main();

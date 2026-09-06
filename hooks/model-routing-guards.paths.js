"use strict";
// model-routing-guards.paths.js
// Shared path-resolution logic for Hook 2's Write/Edit/Read rules (spec §4).
// Realpath resolution defeats symlink/junction indirection (A4); path.resolve
// collapses ".." traversal (A3); one shared algorithm serves both Write's
// sandbox check and Edit's governance-root deny check (B1).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stripNormalize } = require("./model-routing-guards.unicode.js");

/** backslash -> /, lowercase, strip trailing /. */
function normalizeForCompare(p) {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

// Sandbox root: the drafting tier's own scratch space. This is the current
// user's OS temp directory (os.tmpdir()) — on Windows that resolves under
// AppData/Local/Temp, on macOS/Linux under /tmp or $TMPDIR — never a
// hardcoded machine path.
const SANDBOX_ROOT = normalizeForCompare(os.tmpdir());
// Governance root: this Claude Code installation's own config/hooks tree,
// resolved from the current user's home directory.
const GOVERNANCE_ROOT = normalizeForCompare(path.join(os.homedir(), ".claude"));
// Exactly one project-scoped directory segment under projects/, then a
// literal memory/, then a bare .md filename with no further subdirectories.
const MEMORY_EXCEPTION_RE = new RegExp(
  "^" + GOVERNANCE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/projects/[^/]+/memory/[^/]+\\.md$"
);

/**
 * Rewrite a leading POSIX/MSYS drive prefix ("/x/..." -> "x:/...") — before
 * any resolution step, because path.resolve on win32 Node does not
 * understand "/x/..." as a drive path.
 */
function rewritePosixMsysPrefix(p) {
  return p.replace(/^\/([A-Za-z])\//, "$1:/");
}

/**
 * Realpath resolution (A4, junction/symlink defeat): if the path exists,
 * realpath it directly; else walk upward to the nearest existing ancestor,
 * realpath THAT, and re-append the not-yet-created tail. Wrapped try/catch
 * -> "realpath_failed" on any exception; "no_existing_ancestor" if no
 * ancestor (up to the filesystem root) exists at all.
 */
function resolveRealPathOrAncestor(resolvedPath) {
  try {
    if (fs.existsSync(resolvedPath)) {
      return { realPath: fs.realpathSync(resolvedPath), error: null };
    }
    let cur = resolvedPath;
    const tail = [];
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return { realPath: null, error: "no_existing_ancestor" };
      }
      tail.unshift(path.basename(cur));
      if (fs.existsSync(parent)) {
        const realParent = fs.realpathSync(parent);
        return { realPath: path.join(realParent, ...tail), error: null };
      }
      cur = parent;
    }
  } catch (_) {
    return { realPath: null, error: "realpath_failed" };
  }
}

/**
 * Shared file_path resolution used by Write and Edit (spec §4 Write steps
 * 1-5, reused identically by Edit's governance-path check): stripNormalize
 * -> blank check -> POSIX/MSYS drive-prefix rewrite -> path.resolve ->
 * realpath (existing path or nearest existing ancestor) -> normalize for
 * comparison. Returns { ok: true, realPath } or { ok: false, reason }.
 */
function resolveFilePathFull(rawFilePath) {
  if (typeof rawFilePath !== "string") {
    return { ok: false, reason: "file_path_invalid_shape" };
  }
  const stripped = stripNormalize(rawFilePath);
  if (stripped.trim() === "") {
    return { ok: false, reason: "file_path_invalid_shape" };
  }
  const rewritten = rewritePosixMsysPrefix(stripped);
  const resolvedPath = path.resolve(rewritten);
  const { realPath, error } = resolveRealPathOrAncestor(resolvedPath);
  if (error) {
    return { ok: false, reason: error };
  }
  return { ok: true, realPath: normalizeForCompare(realPath) };
}

/**
 * Read's tally-path normalization: stripNormalize -> POSIX/MSYS-prefix
 * rewrite -> path.resolve -> backslash-to-/ -> lowercase -> strip-trailing-
 * slash — the SAME normalization Write performs WITHOUT the realpath/
 * junction-defeat step. The tally is a friction control on call volume, not
 * a sandbox boundary (spec §4 session-tally rule), so this is deliberately
 * junction-blind.
 */
function normalizeReadPathForTally(rawFilePath) {
  const stripped = stripNormalize(rawFilePath);
  const rewritten = rewritePosixMsysPrefix(stripped);
  const resolvedPath = path.resolve(rewritten);
  return normalizeForCompare(resolvedPath);
}

/** True iff normalizedPath equals root, or starts with root + "/". */
function isUnderRoot(normalizedPath, root) {
  return normalizedPath === root || normalizedPath.startsWith(root + "/");
}

module.exports = {
  SANDBOX_ROOT,
  GOVERNANCE_ROOT,
  MEMORY_EXCEPTION_RE,
  rewritePosixMsysPrefix,
  normalizeForCompare,
  resolveRealPathOrAncestor,
  resolveFilePathFull,
  normalizeReadPathForTally,
  isUnderRoot,
};

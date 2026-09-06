# Independence

This is the first written law in this repository, because everything else
here exists to enforce it. Three rules, in the order a session hits them.

## 1. Adversary before author, not review after

Before a matcher, parser, validator, or gate is authored, a dedicated
adversary pass runs against the spec as written — constructing inputs that
would pass but shouldn't. The spec is fixed against what that pass finds.
Only then is the thing built.

A defect caught in review of finished code is a process bug, not a
near-miss: it means the adversary step was skipped or was too shallow.
Post-hoc review is a backstop. It is not the design process, and treating
it as one is how an allow-list or a positional-parsing assumption ends up
in production — see the two rules below for the concrete shapes those
mistakes take.

**Never specify a validation gate as an allow-list.** Specify the total
classification instead: every input maps to a branch, and "unknown" is
itself a branch with a defined, visible outcome. An allow-list fails
silently — an unlisted case slips through. A total classification fails
loudly — an unlisted case produces friction (a visible, correctable block).
Friction is always the safer default.

**Never let a parser over human-edited input assume contiguity or
position.** People reorder, insert, and delete lines by hand. A parser that
assumes a field is always on line N, or always adjacent to some other
field, breaks silently on the next manual edit — not loudly, not
obviously, just wrong.

Every prompt dispatching write-capable work — authoring a matcher, parser,
validator, or gate — must require the subagent to report what its own work
cannot detect. This is a floor, not a review: `hooks/agent-adversary-floor.js`
enforces that the framing is present in the dispatch, not that the adversary
work was actually thorough. Meeting the hook is not the same as having done
the work; the hook can only block total omission of the ask.

## 2. Author, approve, and merge are never the same dispatch

The agent that authored and opened a pull request cannot also review,
approve, or merge it. Not "should not as a matter of style" — cannot, as a
structural rule enforced independently of how careful that agent was.

The unit is the **dispatch**, not the session. Two separate agent
invocations in the same conversation, working on the same PR, are two
separate identities for this rule as long as neither is a case of the
second identity being nothing more than the first one delegated. Concretely:

- If an orchestrator dispatches Dispatch A to author a PR, the
  orchestrator's own identity is added to that PR's authoring set —
  delegation counts as authorship for whoever delegated.
- A `gh pr review --approve` or `gh pr merge` (or API equivalent) on PR N
  is a violation if and only if the identity making that call is in PR N's
  authoring set. If it isn't, the merge is permitted, even if it happens in
  the same root conversation, on the same machine, in the same hour.
- Approve-and-merge is one role, performed by one independent dispatch. It
  is never split into two agents, and the author never performs either
  half of it.

`hooks/pr-independence.js` enforces the mechanical half of this — matching
the calling identity against the PR's authoring set before a merge/approve
command is allowed to run — because a rule that only lives in a written
policy gets skipped exactly when someone is confident enough not to need
it.

## 3. A blind spot found before merge is fixed before merge, or said out loud

If review — automated or human — finds a gap in work that hasn't shipped
yet, "non-blocking, fix later" is not a merge license for a gap the author
found in their own work. Finding it is the trigger to stop and fix it in
the same unit of work.

If a known gap ships anyway, that is a deliberate choice, and it is not the
shipping agent's choice to make silently. State the gap and the decision to
ship despite it, in the open, where the next reader — human or agent — will
see it before they build on top of it.

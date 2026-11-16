# ADR 0018: A unit's project root is the repository its files belong to

Status: **proposed** — waiting for the owner's decision (issue #64). Nothing of this
record may be implemented before it is accepted.

## Context

The Claude Code hook takes `CLAUDE_PROJECT_DIR` as the unit's trusted root, records it for
the unit and resolves every path the host reports against it. The review worker then loads
`.jev/rules.md` under that same root.

That holds when the session runs inside the repository being changed. It does not hold for
a host that runs an agent in its own workspace folder and lets it edit the user's
repository by absolute path — which is how `agentes.chat` runs Claude Code. There the cwd
is not a Git work tree, and one cause produces three failures:

- every edit path resolves outside the root, so each edit is `PATH_OUTSIDE_REPOSITORY`;
- each shell or MCP snapshot runs Git against a directory that is not a work tree, so the
  call has no proof (`GIT_FAILED` in the hook log) and the unit is `UNAVAILABLE`;
- the worker looks for `.jev/rules.md` under a folder that has none.

In the owner's hook log of 2026-11-13, 11 of 43 `UNAVAILABLE` units had
`PATH_OUTSIDE_REPOSITORY`, and the log held 456 `GIT_FAILED` entries.

## Decision (proposed)

The unit's root is the **Git top level of the unit's own evidence**, not the session's cwd:

1. The root is resolved from the first write-capable evidence of the unit — the
   `file_path` of an edit, or the `cwd` of a shell or MCP call — with
   `git rev-parse --show-toplevel`.
2. It is recorded once for the unit, with the existing exclusive-create record. A later
   event that resolves to a **different** top level makes the unit `UNAVAILABLE` with a new
   reason, `MULTIPLE_REPOSITORIES`. The root never moves silently.
3. A unit whose write-capable evidence resolves to no work tree at all is `UNAVAILABLE`
   with a new reason, `PROJECT_ROOT_UNRESOLVED`.
4. Every path is resolved against that root, as today, so `PATH_OUTSIDE_REPOSITORY` keeps
   its meaning: a path outside the unit's repository.
5. The Git snapshot of a shell or MCP call is taken **at the unit's root**, not at the
   event's `cwd`. A call made from a non-Git cwd is then fenced like any other.
6. When a unit has no write-capable evidence at all, the root stays
   `CLAUDE_PROJECT_DIR`; such a unit has nothing to review and ends `SKIPPED`.

The worker keeps loading the policy from the root recorded in the handoff, so the rules
that apply are the ones of the repository the change belongs to.

## Why not something else

- **Keep `CLAUDE_PROJECT_DIR` and ask the host to set it to the target repository.**
  Rejected: the host sets it to the session's working directory by contract, and the
  plugin cannot change how the host runs. The failure would stay.
- **Walk up from each file looking for `.jev/`.** Rejected: a `.jev` folder is not a
  repository boundary, so two nested `.jev` folders would make the applicable policy
  ambiguous, and the rule "one unit, one policy" would depend on directory layout.
- **Accept a unit that spans several repositories and review the union.** Rejected: the
  policy of a repository is its own (`ADR 0005`), and a union has no single policy. A unit
  that touches two repositories is `UNAVAILABLE` instead.
- **Trust the agent with a tool argument that names the root.** Rejected outright: it
  would let the agent pick which policy judges it.

## Risks to the contract

- **The agent's path chooses the policy.** With the root derived from the edited file, an
  agent that edits inside a repository with weak or permissive rules is judged by that
  repository's rules. This is the intent — the policy of the repository the change belongs
  to — but it means an agent can reach a friendlier `.jev/` by editing elsewhere. The
  guardrail is scope, not the root: the unit only ever reviews files inside that one
  repository, and a unit touching a second repository is `UNAVAILABLE`.
- **Evidence recorded before the root is known.** The root must be fixed before any
  pre-image or snapshot is keyed by a repo path. Resolution happens at the first
  write-capable event, inside the same hook process that records that event, so every
  recorded key belongs to the resolved root or the unit is `UNAVAILABLE`.
- **Nested repositories** keep today's behaviour: a call made inside a nested work tree is
  not proven by the outer repository's Git (`ADR 0014`), and it now resolves to a
  different top level, so it is `MULTIPLE_REPOSITORIES`.
- **Cost.** One `git rev-parse --show-toplevel` per unit, cached in the unit's root record;
  no per-event Git call is added.
- **A link cannot move the root.** The path is resolved to its real path before Git reports
  the top level, the same guard the evidence policy already applies.

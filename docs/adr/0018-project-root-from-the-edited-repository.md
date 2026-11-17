# ADR 0018: A unit's project root is the repository its files belong to

Status: **accepted** — 2026-11-16, approved by the owner (issue #64).

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

1. The root is resolved from the first write-capable evidence of the unit that names a
   place in a work tree: the `file_path` of an edit, or the `cwd` of a shell or MCP call
   **when that cwd is inside a work tree**, with `git rev-parse --show-toplevel`.
2. A shell or MCP call whose `cwd` is not inside any work tree establishes nothing. That is
   the ordinary case on `agentes.chat`, where the host runs the agent in its own folder and
   its MCP tools are called from there: such a call says where the agent works, not where
   the change is, so it neither resolves the root nor fails it on its own.
3. The root is recorded once for the unit, with the existing exclusive-create record. A
   later event that resolves to a **different** top level makes the unit `UNAVAILABLE` with
   a new reason, `MULTIPLE_REPOSITORIES`. The root never moves silently.
4. Every path is resolved against that root, as today, so `PATH_OUTSIDE_REPOSITORY` keeps
   its meaning: a path outside the unit's repository.
5. The Git snapshot of a shell or MCP call is taken **at the unit's root**, not at the
   event's `cwd`. A call made from a non-Git cwd is then fenced like any other, once the
   root is known.
6. **A fenced call that starts before the root is known.** Its picture can only be taken
   where the unit will be judged, and that place is not known yet. When the call's `cwd` is
   inside a work tree, that is the answer: the call resolves the root, records it and is
   fenced there. When the `cwd` is not in a work tree, the call carries no proof: the unit
   is `UNAVAILABLE` with `PROJECT_ROOT_UNRESOLVED`. It is never fenced at the session's
   cwd, and never dropped without a cause. The consequence is deliberate: a unit that
   starts with a call from outside any repository and edits a repository afterwards cannot
   prove what that first call did; a unit that starts with an edit, or with a call from
   inside the repository, is reviewed normally.
7. A unit with no write-capable evidence at all keeps `CLAUDE_PROJECT_DIR` as its root;
   it has nothing to review and ends `SKIPPED`.
8. A unit whose only write-capable evidence never resolves to a work tree — shell or MCP
   calls from a folder that is not one, and no edit — is `UNAVAILABLE` with
   `PROJECT_ROOT_UNRESOLVED`. It is not `SKIPPED`: there were calls that could write, and
   nothing proves they did not.

The worker keeps loading the policy from the root recorded in the handoff, so the rules
that apply are the ones of the repository the change belongs to. A root without
`.jev/rules.md` is not a way out of the review: the rule lane reports `UNAVAILABLE`
(`INVALID_RULE`) and the built-in checks still run, which is what happens today when the
file is absent. A read failure of `.jev/rules.md` or `.jev/config.yaml` also degrades only
the rule lane; neither case turns into a silent `SKIPPED`.

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
  write-capable event that names a place in a work tree, inside the same hook process that
  records that event, so every recorded key belongs to the resolved root or the unit is
  `UNAVAILABLE`. The price is the case in decision 6: a call from outside any repository,
  before the root is known, leaves the unit without proof. That is the honest outcome —
  the alternative is judging a unit on a picture that may not cover the call at all — and
  it is the one to revisit first if `agentes.chat` turns out to start most turns with such
  a call.
- **Nested repositories** keep today's behaviour: a call made inside a nested work tree is
  not proven by the outer repository's Git (`ADR 0014`), and it now resolves to a
  different top level, so it is `MULTIPLE_REPOSITORIES`. An edit needs the same check, and
  its file resolves inside the outer root, so the edit walks up from the file's folder to
  the root looking for a `.git` entry, with `stat` only; a Git call follows only when one is
  found and the top level is not the root. A unit whose first edit is in a nested work tree
  therefore starts there, and an edit in the outer repository afterwards is the one that
  makes it `MULTIPLE_REPOSITORIES`.
- **A call that cannot say where it ran.** A shell or MCP call whose `cwd` is inside the
  unit's repository but whose `rev-parse --show-toplevel` fails is not fenced at the root:
  the failure can be a nested repository of another owner or a `safe.directory` refusal, and
  a snapshot keyed elsewhere would attribute a change nobody observed. Such a call leaves
  the unit `UNAVAILABLE`. A `cwd` outside every work tree is unchanged: it is fenced where
  the unit is judged, or `PROJECT_ROOT_UNRESOLVED` before the root is known.
- **Cost.** One `git rev-parse --show-toplevel` per unit, cached in the unit's root record,
  plus one `stat` per directory between an edited file and the root; a Git call is added
  only for an edit that sits in a nested repository.
- **A link cannot move the root.** The path is resolved to its real path before Git reports
  the top level, the same guard the evidence policy already applies.

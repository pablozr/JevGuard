# ADR 0023: A CI check mode judges an existing commit range

Status: proposed — 2026-11-21 (issue #119).

## Context

Observe and enforce both work inside an agent's turn, which means they need the plugin
loaded in the host that made the change. That leaves out the cheapest place to adopt a
policy: the team's CI, where a diff already exists, no agent is running and anybody —
person or agent — can open the pull request. The third mode must therefore judge a diff
that is already committed, from the command line, with the same rules and gates as a
review and without the plugin on the host.

The unit stays the turn: `replay` already reviews each commit's own patch with the
commit subject as the task, and `check` is the same judgment over a commit range chosen
by the caller. Two properties bound it:

- **Cost is per commit per rule.** Every rule over every commit is one Jev call, so a
  range must never be judged without a bound the caller can see.
- **The output is a CI log.** It leaves the machine and is kept by a third party, so it
  must respect the same allowlist as the local log: rule IDs, outcomes, probabilities,
  severities and typed reasons, never the diff, the task (including the commit subject)
  or a credential.

## Decision

1. `jevguard check --range <base>..<head>` reads the non-merge commits of the range
   (newest first) with `git rev-list` / `git log` / `git show`, and runs the repository
   rules over each commit's own patch, with the commit subject as the task. Merge
   commits are not units: a merge is not a change a rule can judge, so they neither
   count against the limit nor reach Jev.
2. Only `base..head` is accepted. A revision starting with `-`, a triple dot or a
   whitespace is refused before Git runs, so nothing the caller types can become a Git
   flag; `base...head` would judge commits that are not in the head branch, which is
   not the change under review.
3. Exit codes: `0` for `PASS` and `WARN`, `1` when at least one rule with severity
   `error` reached `FAIL`, `2` when the check could not run (invalid or unknown range,
   invalid arguments, an unknown `--rule`, Git unavailable, or a range above the commit
   limit). A `FAIL` of a `warning` rule never fails the build — the gate already keeps
   it at `WARN` unless the team lowers the thresholds, and the check does not override
   that policy.
4. `UNAVAILABLE` never becomes a failure: the run exits `0` and prints an explicit
   warning naming how many commits were not judged and why. An unparseable patch is
   treated the same way, and so is a patch the Git reader had to cut at its 16 MiB
   output bound: the unit is reported as `DIFF_TOO_LARGE` and never judged over the
   prefix, because a cut the author of the pull request can place is not evidence.
   `--strict` turns that warning into exit `1` for teams that
   prefer a broken credential or an oversized patch to be visible as a red check; it is
   off by default, because a policy engine must never pretend incomplete evidence is a
   violation, and a red check tied to the reviewer's own infrastructure teaches people
   to ignore it.
5. The limit is `--last <n>` (newest `n` commits) with a hard cap of 50 commits; a
   range above the cap is refused with exit `2` and the count, never silently
   truncated, so the check never reports a verdict over a subset the caller did not
   ask for.
6. Output is text by default, `--json` for machines, and `--annotations` for GitHub
   Actions workflow commands (`::error` / `::warning`) in every commit line. No mode
   prints a line to point at (a rule result has no reliable one) or any diff content.
   Every mode prints IDs, outcomes, commit revisions and the typed reasons of
   commits not judged; the JSON also prints each rule's severity, probability and
   scoped paths and the slice metadata of a sliced rule; the text report and the
   annotations carry no paths.
7. The check writes nothing: no review history, no file, no state, and it never edits
   the user's code. The Jev key is read from the same credential store or
   `TYPESAFE_API_KEY` as every other command; in CI it is a repository secret.
8. `--staged` (pre-commit) is out of v1. It needs a decision from the project owner on
   whether it ships as opt-in at all, and the same cost and latency arguments apply
   per commit hook. The flag is recognized and refused with that explanation rather
   than reported as unknown.
9. Documented limitation: without a real task, the commit subject is weaker context
   for `SCOPE-001` than the task the agent was given, so the mode measures secrets and
   destructive changes better than scope drift.

## Consequences

- A team can adopt JevGuard by adding one step to its workflow and one repository
  secret, with no plugin installed on any machine, and get `0`/`1` for a pull request.
- The check shares the review path (`checkRules`, the gate, the scope filter, the slice
  budget) with `rules check` and `replay`, so a rule behaves identically in all three.
- A PR above 50 commits must be narrowed or limited explicitly. That is a visible cost
  decision, not a silent one.
- `--strict` can produce a red check for reasons outside the author's change; it is
  documented as opt-in for teams that monitor their own credential and service.
- Pre-commit stays unshipped until decided; nothing in this ADR commits to it.

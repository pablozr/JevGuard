# ADR 0021: A shutdown that cuts a review writes one interrupted line

Status: accepted — 2026-11-19 (issue #108). Applies to the OpenCode V2 server plugin
([ADR 0011](0011-opencode-v2-review-episode.md)).

## Context

The smoke for the 2.3.x line (#102) found a turn whose `README.md` change reached the
worktree but left **no line at all** in the review history. The turn ran under
`opencode run "<prompt>"`, which ends the process as soon as the turn finishes: the
plugin's cleanup drains detached work for at most `SHUTDOWN_DRAIN_MS` (2 s), and a review
still waiting on Jev when that budget expires was simply lost.

Two facts bound the fix:

- OpenCode awaits the cleanup a plugin returns when it unloads the plugin (`@opencode/plugin`
  README, "OpenCode awaits the cleanup when the plugin is unloaded or replaced"), so the
  drain budget is ours, not the host's.
- The same host starts the server that loads the plugin as a child process and ends it
  with `killSignal: "SIGTERM"` and `forceKillAfter: "3 seconds"` (`packages/cli/src/services/standalone.ts`
  in the 2.3.0 source), so anything we wait on at shutdown has to fit inside a few
  seconds. Draining longer would only trade one lost review for another, later.

## Decision

1. The shutdown drain keeps its small, fixed budget (2 s), well inside the host's grace.
2. When the budget expires with units still in flight — attribution or review running —
   the runtime calls `abandon()`: each such unit is presented **once** as
   `UNAVAILABLE` with the typed reason `REVIEW_INTERRUPTED`.
3. A verdict that finishes after that handoff is dropped, so one unit never carries two
   lines and a unit is never closed with a verdict on evidence the shutdown cut.

The unit therefore never disappears from the history. It says it was not judged, which
is the honest state: no rule, no built-in and no verdict were produced.

## Consequences

- `jevguard`/`replay` and the history show `UNAVAILABLE/REVIEW_INTERRUPTED` where the
  old behavior showed nothing; the CLI hint explains the host exited first.
- A single-turn `opencode run` can still end without a verdict when the Jev call is
  slower than the shutdown budget. That is a host property we cannot schedule around,
  and the line now says so instead of leaving a silent gap.
- The state machine is unchanged: attribution, review and presentation keep their
  order; only the shutdown path gains one terminal branch.

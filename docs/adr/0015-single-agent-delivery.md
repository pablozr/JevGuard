# ADR 0015: one agent delivery per unit, no remediation chain

Status: accepted — 2026-11-12, explicit owner decision. Narrows the opt-in agent
delivery of [ADR 0014](0014-claude-code-tool-attributed-turn-profile.md) and the OpenCode
`mode: remediate` chain that followed it.

## Context

Agent delivery was first a bounded chain: up to three attempts per failure, a
failure-set comparison between attempts, closure codes and a local chain log. It needed
per-host state (in memory on OpenCode, files beside the private proposal requests on
Claude Code), an outcome channel from the in-session module back to the worker, and a
set of closure codes that users had to learn. The proposer is strategy-only and the agent
that receives its text is the one that decides what to change, so the extra machinery
bought little over letting the next normal review judge the result.

## Decision

With the user's own opt-in (`delivery: agent`, never the repository), each reviewed unit
with at least one `FAIL` gets at most one visible delivery to the agent. It carries every
`FAIL` finding (id, description, severity, probability, location with hunk) and the
proposer's strategy, or the findings alone when there is no strategy: the proposer failed,
or the unit has no proposer request because its diff is oversized or holds a blocked path.
The guarantee does not depend on the proposer: every unit with a `FAIL` is delivered.

- The findings are collected from the review results and the per-file patches, independent
  of the proposer request and of the diff size. A location never names a path the evidence
  policy blocks. Hosts decide delivery by the findings, not by the request.
- At most 32 findings are delivered, with paths cut to 512 characters and texts to 1000.
  What does not fit is counted and shown as `+N more findings not listed`; a limit never
  downgrades a delivery to the panel.
- The whole message stays within the 16384-character task limit, because it becomes the
  next turn's task: the strategy is cut with a `[truncated]` marker first, and findings are
  dropped from the end (and counted) only if they alone do not fit.
- On Claude Code the worker writes the private request even without a proposer request
  (prompts `null`), the user's `delivery` choice is kept as written, and a separate
  `fromDelivery` flag says the unit is itself a delivery, so it only gets the panel.

- The turn a delivery causes is reviewed normally. If it fails, it gets its own proposal
  (observe) but never another automatic delivery.
- At most 3 deliveries per session. Only a delivery the host accepted counts.
- OpenCode waits up to 120 seconds for the session to be idle and then gives up; the
  proposal stays in the child session.
- `delivery` stays `user | agent`. The legacy `mode` and `max_attempts` keys are accepted
  with a warning code and change nothing.
- Removed: the chain decision and state, closure codes, the `remediation-chains.jsonl`
  history and the module-to-worker outcome file.

## Consequences

- No state survives between units except the per-session delivery count.
- A failing correction is visible in the normal review result instead of a closure code.
- The safety bounds of ADR 0014 are unchanged: no apply path, no retry, no forced
  re-evaluation, hooks emit nothing, and the message is never submitted as the user.

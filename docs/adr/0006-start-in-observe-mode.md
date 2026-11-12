# ADR 0006: Start in observe mode

## Status

Accepted

The MVP is post-turn and observational: it displays a transient TUI toast and
writes a structured log, but does not add a message to the coding-agent session,
block task completion, or start a correction turn. This keeps review independent
from the agent context until attribution, calibration, and remediation safeguards
are proven.

Future `enforce` and opt-in `remediate` modes must preserve this mode's semantics
and add bounded-loop protections before they can alter agent workflow.

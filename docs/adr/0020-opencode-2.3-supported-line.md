# ADR 0020: OpenCode 2.3 is a supported line alongside 2.2

Status: accepted — 2026-11-19 (issue #102). Widens the range fixed when the V2 plugin was
written ([ADR 0011](0011-opencode-v2-review-episode.md)): `>=2.2.2 <2.3` becomes
`>=2.2.2 <2.4`.

## Context

The owner's host is `opencode 2.3.0`, and `jevguard doctor` failed it: the plugin declared
`engines.opencode` `>=2.2.2 <2.3`, so the version check was `FAIL` and `setup` skipped the
host. That blocked the first-run onboarding, before any review could happen.

Widening a host range is only honest with evidence that the plugin still sees the same
host contract. The evidence here is the published packages, not a guess:

- `@opencode/plugin@2.2.7` against `2.3.0`: of every `.d.ts` the plugin compiles against,
  four lines were removed and everything else was added. The removals are
  `ToolContext` no longer carrying `cancel` (a promise tool now stops through `signal`),
  `SessionRequest.messages` widening from `Message[]` to `SessionMessage[]` where
  `SessionMessage = Message & { metadata? }`, and two GUI-only doc/icon lines.
  `SessionHooks` gained a `fork` hook; the plugin editor gained `freeform`. Neither is
  used by JevGuard, and a new hook cannot break a plugin that does not register it.
- `@opencode/schema@2.2.7` against `2.3.0`: `session-event.d.ts` has no removed line at
  all — only added event definitions (`session.step.first-token`, `experimental.mcp.*`).
  The four execution lifecycle events the plugin subscribes to keep their `data` shape
  (`sessionID`, and for `failed`/`interrupted` the same fields as before).
- What the plugin actually reads is unchanged: `event.subscribe`, `tool.hook`
  (`execute.after`), `location.project`, and the session/VCS facade the snapshot uses.

The `@opencode/plugin` peer stays type-only in the plugin package — it is imported with
`import type` — so the range only matters for development types; the host provides the
runtime API it loads the plugin with.

## Decision

- `OPENCODE_ENGINE_RANGE` is `>=2.2.2 <2.4`, derived from a first supported minor (2.2,
  from patch 2) through a last supported minor (2.3). A newer line (2.4 and later) is
  outside the range until it is reviewed the same way.
- `engines.opencode` in the plugin manifest and the `@opencode/plugin` peer both use
  that range; the development dependency stays at `2.2.2`, the strictest of the two
  minor lines, so the code keeps compiling against the smaller API.
- The unsupported-version message names the newest supported line and the command that
  pins it: `The newest supported line is 2.3.x. To pin it: npm install --global
  @opencode/cli@2.3.` A user on a newer host therefore gets an action, not just a
  verdict. The same text reaches `doctor` and `setup`.
- The full smoke on 2.3.0 covers the same four scenarios the 2.2.7 line passed in #101,
  run on the build of this change against the real 2.3.0 binary, in an isolated server
  where the host's npm cache points at that build:
  - a violating turn reviewed its own patch, returned `FAIL` (+0.7 s) and recorded the
    history; the delivery reached the session as `FINDINGS_ONLY` because the free model
    hit a 429 mid-proposal, not because of the host line;
  - a clean turn returned `PASS` with `scopedPaths` equal to `["README.md"]` only — a
    `print()` left dirty in `src/app.py` before the session did not enter the turn's
    review;
  - a turn without changes and a read-only turn each recorded one unit per rule and per
    built-in as `SKIPPED` / `NO_ATTRIBUTED_PATCH` (5/5), the no-change answer, not a
    review of leftover state — identical to 2.2.7.
- The unsupported-version message was also checked live: `doctor` reports `OK` on the
  real 2.2.7 and 2.3.0 hosts, and on a simulated 2.4.0 host it fails with `The newest
  supported line is 2.3.x. To pin it: npm install --global @opencode/cli@2.3.`.
- A separate one-shot `opencode run` in a scratch repository edited a file but left no
  history record: the host exits as soon as the turn ends and the plugin caps its
  shutdown drain at 2 s, so a review that still needs the Jev call can be cut. Nothing
  in this ADR depends on that path — the four scenarios above ran where the process
  lived on — and the one-shot case is tracked as its own defect (issue #108).

Update 2026-11-20 (issue #112): the one-shot child does load project plugins. On
`2.3.0` in a scratch Linux repository, `opencode run` logged `loading plugin` for the
project entry — a `file:` canary module and the published `@pablozrrrr/jevguard@0.4.1`
— the canary's `setup` ran and received `session.execution.succeeded`, and the
published plugin wrote its review (four `UNAVAILABLE` results, no rules and no
credential) to the local history before the process exited. The same canary loaded on
Windows `2.3.0`, observed through the canary's own side effects (its `module loaded`
and `setup called` lines and the `session.execution.succeeded` it received); only the
`loading plugin` line was missing from the log, because on Windows the host does not
write server logs to stderr even with `--print-logs`. A lab
that sees zero `loading plugin` lines on Windows therefore cannot conclude the plugin
was not loaded. The shutdown-window limitation described above still stands: loading is
not the problem, the exit before the review finishes is.

## Alternatives considered

- **Keep `<2.3` and document the limitation.** Rejected: the owner's own host is on 2.3,
  and the code contract did not change; documenting a limitation the code does not have
  would leave onboarding blocked for no reason.
- **Widen to `<3`.** Rejected: the 3.x plugin API has not been reviewed, and the range is
  a promise the version check makes on every start.
- **Pin the plugin to 2.3 only.** Rejected: 2.2.x hosts are still in use and the API is
  compatible in both directions for what the plugin reads.

## Consequences

- A 2.3.x host passes the version check and loads the plugin.
- The doctor and `setup` wording carries the newest supported line and a pin command, so a
  future 2.4 host gets an instruction instead of an unexplained `FAIL`.
- The version tests pin 2.3.0/2.3.9 as supported and 2.4.0 as unsupported; adding the
  next line means repeating the diff and the smoke, then moving `lastMinor`.

# Check mode: rules in CI

`jevguard check` is the third mode, next to observe and enforce. It judges a change
that is already committed, from the command line, with no plugin on the host: the unit
is one commit's own patch and the commit subject is the task. That makes it the
cheapest way for a team to put its policy in CI, and it works with any author — person
or agent.

See [ADR 0023](./adr/0023-check-mode-in-ci.md) for the design and the decisions behind
it, and
[configuration](./configuration.md#jevguard-check---range-basehead---last-1-50---rule-id---strict---json----annotations)
for the flag-by-flag reference.

## Quick start

```sh
# every non-merge commit in the range
jevguard check --range origin/main..HEAD

# the newest two commits only, JSON for a script
jevguard check --range origin/main..HEAD --last 2 --json

# GitHub Actions annotations instead of the plain report
jevguard check --range origin/main..HEAD --annotations
```

`--range` takes exactly one `base..head`. Merge commits are not units: they are not
reviewed, not counted against the limit and never reach Jev. Use `--rule <id>` to
check one rule. `--last <n>` (at most 50) reviews only the newest `n` commits; a range
above that limit is refused with its commit count rather than silently truncated.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No `error`-severity rule failed. Warnings are fine. |
| `1` | At least one rule with severity `error` reached `FAIL`, or a commit was not judged completely and `--strict` was given. |
| `2` | The check could not run: invalid arguments, an invalid or unknown range, a `--rule` that matches nothing, Git unavailable, or a range above the commit limit. |

`UNAVAILABLE` never becomes a failure: a rule whose evidence was incomplete, or a
patch the parser could not read, leaves the check at exit `0` with an explicit
warning. A patch the Git reader had to cut at its 16 MiB output bound is reported the
same way, as `DIFF_TOO_LARGE`: the commit is never judged over the prefix. `--strict`
turns that warning into exit `1`, for teams that would rather see a broken credential
or an oversized patch as a red check. It is off by default.

A `FAIL` of a `warning`-severity rule never fails the build either. The gate already
keeps a warning rule at `WARN` under the default thresholds, and the check does not
override the team's policy.

## GitHub Actions

The Jev key goes in the repository secrets (`Settings > Secrets and variables >
Actions`), never in the workflow file:

```yaml
name: JevGuard

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the base revision must be present for the range

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Check the pull request
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
        run: |
          npx @pablozrrrr/jevguard-cli check \
            --range origin/${{ github.base_ref }}..HEAD \
            --annotations
```

`fetch-depth: 0` (or at least enough history to contain the base) matters: with the
default shallow checkout the base is not there, the range cannot be resolved and the
check exits `2`. That full checkout is also why no separate `git fetch` is needed.
The same pattern works for a push job with
`--range "${{ github.event.before }}..${{ github.sha }}"` — except on the first push
of a branch, where `github.event.before` is all zeros and the range is invalid: gate
that job on the value or fall back to the default branch.

`--annotations` prints GitHub workflow commands (`::error` / `::warning`) next to the
plain report, so a failing rule shows up on the pull request's annotations. An
annotation carries the severity, the rule ID, the commit revision and the probability;
it never carries a path, the commit subject or any diff content.

## What it reads, and what it does not

- Only the commits in the range, each with its own patch. Nothing else in the
  repository is read, and no built-in check runs.
- The output — text, JSON or annotations — carries rule IDs, outcomes, probabilities,
  severities, commit revisions and typed reason codes. It never carries the diff, the
  task (including the commit subject) or a credential, so a CI log kept by a third
  party cannot leak the change.
- It writes nothing: no review history, no file, no repository change, and it never
  edits the code.
- Each rule over each commit is one Jev call, which is what the limit bounds.

## Known limitation: the task is weaker

In a review the agent's task is real context. In CI the commit subject stands in for
it, and a subject is a weaker signal for scope drift. `SCOPE-001` therefore judges
less reliably in check mode; secrets and destructive changes are the rules that
measure best. Review the scope result as a hint, keep it as a `warning` rule, and let
enforce (ADR 0022) handle the turns where the real task exists.

## Pre-commit is out of v1

`jevguard check --staged` is recognized and refused with that explanation. Whether
pre-commit ships as opt-in is an open decision: the same per-commit cost and latency
apply on every `git commit`, and the default must stay off. Until the decision is
recorded, the mode is CI and pre-push only.

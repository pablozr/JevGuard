# Public benchmark

JevGuard publishes a reproducible measurement of how its repository rules answer on a
versioned corpus. The numbers below come from this repository's harness and from a
live Jev run; nothing here is hand-written, estimated, or copied from another product.

## What is measured

- **Accuracy per rule**: how often the rule's gate state (PASS, WARN, FAIL) matches the
  label the case author wrote for it.
- **False alarm**: a clean case (expected PASS) that the rule flagged with WARN or FAIL.
- **Hard false positive**: a clean case that reached FAIL. A warning-severity rule
  cannot reach FAIL, so its Hard FP is always 0 by construction — that zero is the
  rule's ceiling, not a measured result.
- **Missed violation**: a case expected to FAIL that reached PASS.
- **Missed WARN / Over-fire**: a borderline case that fell to PASS or escalated to FAIL.
- **Latency and cost per review, per host**: wall-clock time around a complete review
  and the tokens its responses reported, driven through the review entry each host
  uses (OpenCode's in-process runtime and Claude Code's review worker).

Only the rules of the initial pack (`jevguard init` writes them) are covered today:
QUALITY-001, SECRETS-001, SCOPE-001 and API-001.

## Methodology

1. The corpus lives in [`benchmarks/corpus/`](../../benchmarks/corpus). Every case has a
   task, a complete `git diff`, an expected gate state, and a one-line rationale.
   The diff must be one the plugin itself accepts, so a case can never pass validation
   while the host would refuse its input.
2. `bun tools/benchmark/main.ts run` (also `pnpm benchmark`) validates the corpus, then
   runs one Jev rule evaluation per case through the core rule lane — the same lane
   both plugins call — with the case's target rule selected before Jev.
3. The host pass runs a complete review (all rules of the pack plus the built-in batch)
   through each host's own review entry on the probe cases.
4. Tokens come from each response's usage envelope. The model that answered is read
   from the same envelope (`jev-latest` resolves to a versioned id).
5. Cost uses TypeSafe's published list price, $0.042 per million input tokens with
   output free ([TypeSafe models](https://docs.typesafe.ai/models), read 2026-11-19).
   The price is not carried by the API response, so it is recorded as a run input.

A run performs zero API calls unless `--confirm-live-runs` matches the planned number of
reviews, and never writes a task, a diff, a finding, a path, or a credential to its
report.

```bash
bun tools/benchmark/main.ts run                 # preflight only
bun tools/benchmark/main.ts run --confirm-live-runs 24
```

The run writes `benchmarks/results/bench-<timestamp>.json` and `.md`.

## Results — 2026-11-19

Run [`benchmarks/results/bench-20261119-182600.md`](../../benchmarks/results/bench-20261119-182600.md),
model `jev-1.14.0` (requested as `jev-latest`), corpus `c5822e8838af904c`, 20 cases,
one repeat per case.

| Rule | Severity | Cases | Exact | False alarm | p50 review |
| --- | --- | ---: | ---: | ---: | ---: |
| QUALITY-001 | warning | 5 | 5/5 | 0/3 | 170 ms |
| SECRETS-001 | error | 5 | 5/5 | 0/2 | 176 ms |
| SCOPE-001 | warning | 5 | 5/5 | 0/3 | 183 ms |
| API-001 | warning | 5 | 5/5 | 0/3 | 174 ms |

| Host | Reviews | p50 review | Input tokens / review | Cost / review (US$) |
| --- | ---: | ---: | ---: | ---: |
| OpenCode runtime | 2 | 377 ms | 4673 | 0.000196 |
| Claude Code worker | 2 | 354 ms | 4673 | 0.000196 |

How to read it: on this 20-case, author-written corpus every gate state matched the
label, including the borderline case that landed at 0.46 (SECRETS-001) inside the WARN
band. A warning-severity rule cannot reach FAIL, so "expected WARN" there means "the
violation was seen", and a missed warning is a missed violation. Two host reviews per
host is a smoke-sized sample: quote the latency as an order of magnitude, not as a
distribution. The milliseconds were measured on one machine and one network in a single
run, so they will not reproduce exactly anywhere else. The exact rate is a ceiling of agreement with an authored corpus, not a
production accuracy estimate; the limitations above are part of the number.

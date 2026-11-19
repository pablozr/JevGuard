# Benchmark corpus

One JSON document per rule of the initial pack. Each case carries a task, a complete
`git diff`, the gate state the author expects, and a rationale the reviewer can argue
with. The harness validates every diff with the plugin's own parser, so an invalid case
stops the run before any API call.

```json
{
  "version": 1,
  "rule": "SECRETS-001",
  "cases": [
    {
      "id": "SECRETS-001/hardcoded-api-key",
      "task": "Wire the billing client to the payment provider.",
      "expected": "FAIL",
      "rationale": "A provider key is hardcoded in source instead of read from the environment.",
      "diff": ["diff --git a/src/billing/config.ts b/src/billing/config.ts", "..."]
    }
  ]
}
```

- `expected` is the gate state the rule's own severity can reach. An `error` rule can
  reach PASS, WARN or FAIL; a `warning` rule only reaches PASS or WARN, so an expected
  FAIL on it is rejected as invalid.
- Every rule needs at least one clean case (PASS) and one flagging case, so no rule can
  publish a one-sided number.
- WARN is a probability band, not a deterministic label. Borderline cases are labeled
  WARN on purpose, and the report counts a move to PASS as a missed warning.
- Cases are synthetic and short on purpose. They are labeled by an author, not measured
  ground truth, and the docs say so wherever the numbers are cited.

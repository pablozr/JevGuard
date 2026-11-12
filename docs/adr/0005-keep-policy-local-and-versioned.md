# ADR 0005: Keep policy local and versioned

## Status

Accepted

Repository semantic policy is authored in `.jev/rules.md` and deterministic gate
configuration lives in optional `.jev/config.yaml`. This makes policy reviewable
with the code it governs, usable by local-agent and future CI adapters, and avoids
introducing a database or central control plane in the initial product.

`Allowed` is a normative exception within a rule's single violation decision; an
invalid or self-contradictory rule is rejected locally as `INVALID_RULE` rather
than being interpreted by Jev.

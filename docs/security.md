# Security Model

JevGuard sends code-change evidence to Jev. Evidence safety is therefore a product
boundary, not a best-effort feature.

## What is sent

For an applicable rule, JevGuard sends:

- the direct parent user task;
- the rule ID, policy, violation definition, and optional allowed exception;
- the full attributed textual diff for changed files within the rule scope;
- the relevant file paths.

It does not send repository-wide diffs as a fallback.

## Evidence must be complete

JevGuard never truncates a relevant diff. If evidence exceeds the configured input
limit, the review is `UNAVAILABLE`.

It also does not evaluate a rule from a subset of its relevant files. If an
applicable file is rejected by the safety policy, the rule is `UNAVAILABLE`.

## File safety policy

Only configured textual/code extensions may be sent. Sensitive paths are rejected,
including environment files, private keys, and credential files. The exact
allowlist/denylist becomes configurable with the implementation; the invariant is
that rejected content never leaves the machine.

Structured logs may record a rejected path and reason. They must never record the
rejected file contents.

## Credentials

For normal local use, run:

```sh
jevguard login
```

The CLI reads the key using a masked terminal prompt and stores it in the native
operating-system credential store:

- macOS: Keychain;
- Windows: Credential Manager;
- Linux: Secret Service/keyring.

JevGuard reads the credential automatically when OpenCode starts. The API key never
belongs in `.jev/`, `opencode.json`, agent messages, logs, toasts, test fixtures,
or a committed file.

For CI and controlled automation, set `TYPESAFE_API_KEY` in the job's secret
environment. This environment value overrides the credential store for that
process. Do not print it, pass it as a CLI argument, or use a shell command that
persists it in history.

If neither source provides a key, the plugin stays loaded and the evaluation is
`UNAVAILABLE`, with a safe instruction to run `jevguard login`.

> [!IMPORTANT]
> A secret passed through the environment of the OpenCode process can be inherited
> by subprocesses. The credential store is the preferred path for local use because
> it avoids placing the key in the agent process environment. Treat environment
> credentials as an automation/CI integration surface, not a local secret vault.

## Operational outcomes

`UNAVAILABLE` is intentional when JevGuard cannot obtain complete safe evidence,
validate policy, access Jev, or retrieve the attributed diff. It is not a policy
pass, a warning, or a failure, and the V0.1 observe-mode plugin does not block work.

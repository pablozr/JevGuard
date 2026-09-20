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

JevGuard never truncates a relevant diff. The assembled diff for the rule's
applicable files is capped at `100000` characters; a larger diff is
`UNAVAILABLE` with reason `OVERSIZED_DIFF`.

It also does not evaluate a rule from a subset of its relevant files. If any
applicable file is rejected by the safety policy, the rule is `UNAVAILABLE` with
reason `BLOCKED_EVIDENCE`.

## File safety policy

The V0.1 evidence policy is fixed in core (not yet configurable). Only common
code and text extensions may be sent; a file without an allowlisted extension is
rejected rather than assumed textual.

Allowed extensions are broad and cover common source, config, docs, shell, and
data text formats: for example `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.md`,
`.yaml`, `.toml`, `.css`, `.html`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.cs`,
`.php`, `.c`, `.cpp`, `.swift`, `.sh`, `.ps1`, `.sql`, `.graphql`, `.tf`, and
`.patch`.

Sensitive paths are always rejected, including:

- exact file names such as `.env`, `.envrc`, `.netrc`, `_netrc`, `.npmrc`,
  `.pypirc`, `.pgpass`, `.git-credentials`, `.htpasswd`, `.dockercfg`, `id_rsa`,
  `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`, `credentials.json`,
  `credentials.yaml`, `credentials.yml`, `secrets`, `secrets.json`,
  `secrets.yaml`, `secrets.yml`, `shadow`, and `master.key`;
- extensions such as `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, and
  `.ppk`;
- directory segments such as `.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, and
  `.docker`.

Matching is case-insensitive and treats both `/` and `\` as separators. A
dot-prefixed denied name also matches its dotted variants, so `.env` rejects
`.env.local`; entries without a leading dot such as `credentials` and `secrets`
match exactly. The invariant is that rejected content never leaves the machine.

Structured logs may record a rejected path and reason. They must never record the
rejected file contents, and a rejected file is never replaced by the repository
diff or by another file's patch.

## Credentials

For normal local use, install the packed artifact globally and run:

```sh
bun install --global /path/to/jevguard-plugin-<version>.tgz
jevguard login
```

If the artifact is not on `PATH`, run the installed binary directly, or from this
workspace use the Bun fallback `bun packages/plugin/src/cli/main.ts login`.

The CLI reads the key using a masked terminal prompt and stores it in the native
operating-system credential store:

- macOS: Keychain;
- Windows: Credential Manager;
- Linux: Secret Service/keyring.

JevGuard reads the credential each time it evaluates a turn. The API key never
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

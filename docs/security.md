# Security Model

JevGuard sends code-change evidence to Jev. Evidence safety is therefore a product
boundary, not a best-effort feature.

## What is sent

For an applicable rule, JevGuard sends:

- the direct parent user task;
- the rule ID, policy, violation definition, and optional allowed exception;
- the full attributed textual diff for changed files within the rule scope;
- the relevant file paths.

For the built-in batch (`SCOPE-CREEP` and `COMPLEXITY`), JevGuard sends the same task,
both checks' own definitions, the complete attributed textual diff for every changed
file with a nonempty patch, and those paths. It sends no rule-scoped subset. The batch
is a single request with two independent answers; the same complete evidence feeds both.

It does not send repository-wide diffs as a fallback.

## Evidence must be complete

JevGuard never truncates a relevant diff. The assembled diff for the rule's
applicable files is capped at `100000` characters; a larger diff is
`UNAVAILABLE` with reason `OVERSIZED_DIFF`.

It also does not evaluate a rule from a subset of its relevant files. If any
applicable file is rejected by the safety policy, that rule is `UNAVAILABLE` with
reason `BLOCKED_EVIDENCE`.

The same cap and rejection apply to each built-in over the whole attributed patch: an
oversized or blocked file makes the built-in `UNAVAILABLE` rather than evaluating it
on partial evidence.

Rejections are scoped to the rules they affect. Evidence is selected per rule from
that rule's applicable files, so an oversized or blocked file makes only the rules
whose scope matches it `UNAVAILABLE`; rules with disjoint, safe applicable files
still run.

## File safety policy

The evidence policy is fixed in core (not configurable). Only common code and text
extensions may be sent; a file without an allowlisted extension is rejected rather
than assumed textual.

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

For normal local use, run the login command with the published package:

```sh
bunx --package @jevguard/plugin jevguard login
```

Or install it globally so `jevguard` is on `PATH`:

```sh
bun install --global @jevguard/plugin
jevguard login
```

Adding the plugin to `opencode.json` does not put `jevguard` on `PATH`.
`@jevguard/plugin` is not published yet; until then, install the packed local
tarball globally and run `jevguard login`.

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
pass, a warning, or a failure, and the observe-only plugin does not block work.

A policy-load or config failure does not suppress the built-in batch: when the turn is
attributed, both built-ins still evaluate the complete safe patch with their fixed
thresholds. `SCOPE-CREEP` can fail; `COMPLEXITY` is advisory and can only pass or
warn. One malformed answer fails only its own check.

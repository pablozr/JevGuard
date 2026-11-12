# ADR 0010: Store local API keys in the OS credential store

## Status

Accepted

JevGuard provides `jevguard login`, which captures a TypeSafe API key using a masked
terminal prompt and saves it in the native operating-system credential store. The
plugin reads that credential automatically for normal local use. `TYPESAFE_API_KEY`
remains a process-local higher-precedence override for CI and controlled automation.

Repository configuration, agent messages, CLI arguments, logs, and toasts are not
credential channels. Environment variables are convenient for automation but may be
inherited by agent subprocesses, so they are not the preferred local-user path.

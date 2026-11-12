# ADR 0004: Require complete and safe evidence

## Status

Accepted

JevGuard never truncates relevant diffs or evaluates a rule after excluding an
applicable sensitive file. It sends only allowlisted textual/code files to Jev and
rejects sensitive paths such as environment files, keys, and credential material;
incomplete, oversized, or blocked evidence yields `UNAVAILABLE`.

This deliberately favors no verdict over a misleading approval or failure based on
partial source, while preventing accidental export of sensitive contents to an
external API.

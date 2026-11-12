# ADR 0013: strict native historical changesets

Status: accepted direction — 2026-10-03, explicit owner decision. Supersedes
[ADR 0012](0012-owned-capture-awaited-host-bridge.md)'s capture ownership and
default awaited-plugin-hook plan, not J01's host-independent episode invariants.
Future V2 only; shipped V1 and production code are unchanged.

## Decision

Use host-owned native historical changesets, initially Git text only. Freeze the
initial boundary before execution, final after cleanup/finalizers before durable
closure and successor; expose read-only retrieval by exact closure. Persist typed
coverage, tracked/untracked universe, exact extremes, limits and omission reasons.
Render from frozen historical inputs, never current tree/ignores/attributes/config.
No owned scanner, duplicate strict Git capturer, watchers/cache/incremental framework
or automatic fallback. Unsupported profiles and incomplete evidence are UNAVAILABLE.

Ignored relevant files are explicit omission problems, not benign ignore policy.
Binary content without representation has an incapacity reason. Patch appearance
and empty diffs cannot certify coverage. Only independently provable complete safe
disjoint rule evidence may be reviewed; incomplete total evidence blocks built-ins
and proposal. Freeze initial policy with baseline for both review and proposal.
History, overlap, writer settlement, deadlines/late invalidation and observe-only,
strategy-only boundaries remain J01 gates. Core remains host-independent and I/O-free.

Classify sensitive paths before new opt-in native content acquisition; no-read and
no-export remain mandatory. Native seed/refresh design may not be small. Existing
unrelated host snapshot reads are not certified by this product; they do not grant
permission to reproduce those reads in JevGuard's capability. No containment or
production budget is inferred from the cooperative-profile acceptance.

## Evidence and alternatives

Historical execution proof (local record)
exercised real coordinator/Bus/Snapshot/Git with a SCRIPTED runner: exact E1 pair
survived E2 writes and durable replay, historical rendering froze config inputs.
Coverage remained UNKNOWN; six diagnostic tests (103 total) did not persist coverage
with closure, nor prove no-read. No full runner/support certification follows.

Acquisition benchmark (local record): two
captures of 5000 files/~42MB cost owned J02 medians 11.7–13.3s vs native 1.6–1.8s.
N=3, two rounds, one machine, cached seeded incremental fixture; not equivalent safety,
cold-cache, end-to-end latency or performance guarantee. Host proof adds two captures;
wait is relocated, not eliminated. Optimize only after measuring preserved invariants.

Reject active owned-scanner/incremental work and duplicate strict Git substrate;
archive prior accepted 39-test standalone J02 evidence. Subsequent explicit owner
authorization on 2026-10-03 removed `packages/opencode-adapter/src/capture/`,
its barrel export and the two capture test files. It also removed experiment code
from `opencode-snapshot-spike` (restoring only experimental additions to core Git)
and `opencode-native-diff-spike` under the approved temporary directory.
Reports and links remain; old scripts/tests are no longer available to rerun those
historical measurements. `opencode-changeset-spike` remains intact, including its
tests and benchmark, as the active native historical proof. J01 and shipped V1
are unchanged; no checkout, branch, fork or issue was removed.
Current session diff remains insufficient. Reopen native read-only historical reuse,
not the old strict own-Git spike as accepted implementation.

## Consequences and gates

Keep the existing pablozr/opencode fork, checkout opencode-jevguard-fork, branch
episode-hooks, U01 baseline eb1a9ea4d91a7f5c603cebfc0a197cd846bcc13c. The throwaway
changeset-spike is evidence only; eventual implementation is fresh and controlled.
Issue #52870 awaits design for the former proposal: prepare revised/new U03 material,
then obtain publication authorization and design approval before U04. No remote
edit/closure, PR, commit/push, branch change or permanent fork distribution authorized.

Public API, positive finite coverage, no-read native seed, retained initial policy
and delivered history, object/root retention/expiry, closure recovery, overlap/writers,
numeric budgets, artifacts and official release remain unresolved gates. J02 is now
pending native coverage validation/acquisition, not completed by its archived scanner.
The 19-task map (local record) retains IDs and filenames.

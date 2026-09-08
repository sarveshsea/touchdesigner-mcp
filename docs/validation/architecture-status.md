# Architecture preview validation

Target: **2.2.0-architecture.1**, macOS Apple Silicon, TouchDesigner **2025.33230**.
This is a capability preview. It does not certify unrestricted restructuring.
The prior `v2.1.0-setdesign.1` release remains available for rollback.

## Live evidence

- API 1.5 bridge connected to the official installed TD build.
- Runtime catalog discovered 653 classes across COMP, TOP, CHOP, POP, SOP,
  MAT and DAT. Of these, 610 report support on the connected build/platform and
  43 report unsupported. Registry availability is not behavior validation.
- Repeated unchanged scans preserved project identity and revision.
- Native inspector installed, displayed live network rows, connected through the
  private descriptor, and reported no operator errors. Real `.tox` exports were
  produced for the inspector and the original seven-family example.
- Native collapse canary passed CHOP/TOP/SOP/DAT/POP boundary wires, ordering,
  operator identity preservation and protection against an unselected current
  node being swept into the group.
- Ten-second read-only watch diagnostic completed with six probes and no bridge,
  status, observer or RSS errors. This is not the required two-hour soak.

## Remaining release gates

- The two-hour mixed watch observation is in progress; no endurance pass is
  claimed until its final receipt is reviewed.
- Complete whole-project dependency census and end-to-end working-copy staging
  are not certified. Stock TD internals contain substantial opaque source;
  project-scoped scans do not prove that external inbound references are absent.
  The native incremented-save adapter passed its isolated preservation canary.
- No verified stock-engine/tooling manifest is shipped to exempt opaque code.
  The default service blocks such plans. Caller-supplied exemptions are rejected.
- Real 1k/10k operator frame-impact measurements, reopen matrix and full
  failure-injection acceptance are not yet certified.

A 300-second live whole-root attempt inspected 1,475 nodes and 8,803 edges before
its deadline. Instrumentation attributed 13.83 seconds to Python page work and
299.3 seconds to bridge round trips. This motivated asynchronous scan jobs with
progress, cancellation and an explicit maximum one-hour budget. Partial results
remain incomplete; system nodes are not silently dropped to manufacture closure.

## Current native limits

The [later full-root attempt](native-full-root-attempt.json) failed after
1,289,526 ms (21.5 minutes), 2,943 pages, 9,097 operators and 51,174 edges. It
reported a disconnected/incomplete graph after a bridge failure or invalid page.
This is a failed acceptance result. No complete dependency census is claimed.
Even a completed stock graph at this size exceeds the native staging limit of
5,000 operators; opaque stock source remains ineligible without verified adapters.
The current stock setup therefore cannot be staged by this preview.

The [event matrix](native-event-matrix.json) observed creation, rename, wiring,
rewiring, undo and deletion correctly. Visibility ranged from 2.459 to 10.555
seconds, including observer polling, scan work and adaptive backoff. The target
of two seconds was **not met**. These are eventual-correctness results.

The [native copy-save canary](native-save-canary.json) confirmed an incremented
active sibling copy, unchanged original bytes/identity, and preservation of the
asset directory. It does not validate a complete refactor transaction.

## Automated evidence

The existing JavaScript/TypeScript coverage gates remain at 80% for statements,
branches, functions and lines. Native Python tests now run under CI with branch
coverage and an 80% minimum. Unit/integration tests include real regex workers,
real local HTTP and detached daemon subprocesses, and generated Python against
fake TD objects. Those tests do not replace native TD acceptance.

The [synthetic benchmark receipt](architecture-benchmarks.json) records 1k,
10k and 50k-node CPU graph/classifier/diff runs. The 50k result is 657 ms on the
recorded Node environment. It excludes TouchDesigner, transport cadence and
per-frame GPU/render performance.

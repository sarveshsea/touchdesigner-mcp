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

- The two-hour mixed observation completed, but included interruptions and
  failures. It does not pass the uninterrupted watch endurance gate; see below.
- Complete whole-project dependency census and end-to-end working-copy staging
  are not certified. Stock TD internals contain substantial opaque source;
  project-scoped scans do not prove that external inbound references are absent.
  The native incremented-save adapter passed its isolated preservation canary.
- No verified stock-engine/tooling manifest is shipped to exempt opaque code.
  The default service blocks such plans. Caller-supplied exemptions are rejected.
- Per-frame impact measurements and full failure-injection acceptance are not
  certified. The owned 1k/10k graph census results below do not measure rendering.

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

## Live scale and export results

| Owned fixture | Collection time | Python page work | Bridge calls | Result |
|---|---:|---:|---:|---|
| [1,000 operators](architecture-live-1k.json) | 12.902 s | 0.850 s | 42 | Complete, fresh, cleanup passed |
| [10,000 operators](architecture-live-10k.json) | 901.582 s | 14.554 s | 681 | Complete, fresh, cleanup passed |

The 10k collection is too slow for a responsive whole-network refresh. Transport
waiting dominates these measurements; fixture setup/cleanup and background TD
work also contribute to total runtime. Both fixtures had cooking disabled. The
reported cook diagnostics are sparse CPU samples, not per-frame/GPU performance
or an overhead comparison against a watch-off baseline. Dependency closure of
the enclosing project is not claimed.

The [native inspector receipt](native-inspector-export.json) verifies a real
clean export and inert reimport, embedded sources, empty client and zero operator
errors. Native docking and click-to-focus also passed after correcting the build's pane enum access. Release packaging checks exact source and binary hashes before and after
copying the bundle. [Installed offline help indexing](native-offline-doc-index.json)
returned 34 documents within the bounded budget and correctly reported truncation.
No documentation mirror is distributed.

## Restart and persistent identity

A [real project reopen](native-project-reopen.json) preserved saved bytes, started
the inspector/observer and changed the session and project-root runtime ID. The
watch service recovered to a fresh 33-node map. One immediate probe during a
subsequent reopen timed out after 30 seconds; a later read recovered. No failed
mutation was blindly repeated.

The [fingerprint probe](native-memory-reopen.json) remained stable across a
same-file session restart; this sampled child retained its numeric ID. Separate
regressions deliberately reassign IDs and verify observed facts, decisions and
verified notes stay current while mutation plans reject replaced IDs/sessions.
Fingerprint version 2 excludes only runtime ID. Old provenance is left stale
until explicit reverification. Different save paths remain separate project
namespaces; no heuristic merges numbered saves or unrelated projects.

## Two-hour mixed watch observation

The [read-only observation receipt](native-watch-observation.json) covers
7,200.002 seconds, 3,389 probes and 227 service-status samples. It ran alongside
native scale fixtures, inspector reinstallation and deliberate service/project
restart tests. It recorded five bridge probe failures, 683 inactive or wrong-root
observer samples, eight watch-inactive status samples and eleven observer session
changes. There were 211 skipped sampling deadlines. **This is not an uninterrupted
two-hour watch acceptance pass.**

| Metric | Observed result |
|---|---:|
| Successful bridge probe RPC p95 / p99 | 1,521.5 / 3,594.7 ms |
| Longest successful probe | 24,747.7 ms |
| Maximum observer dirty queue / final queue | 72 / 0 |
| Maximum concurrent pending scans / final backlog | 2 / 0 |
| Daemon RSS first / last / maximum | 99.9 / 91.8 / 160.1 MB |
| TD RSS first / last / maximum | 1,024.4 / 1,305.2 / 2,310.1 MB |

MB means decimal megabytes. TD's endpoint RSS increased by 280.9 MB during this
mixed workload. Service restarts and fixture allocations confound endpoint memory
changes; no same-process leak or resource-count certification follows from them.
Probe percentiles measure bridge request latency, not rendering frame time. Cook
counters in the JSON are sparse last-cook samples, not per-frame distributions.

The final ten minutes contained 300 probes without bridge failures or inactive
observer samples, and 20 fresh service snapshots with no pending scans. The
watched graph was **33 nodes / 82 edges**, with complete shallow collection and
incomplete dependency analysis. This small-network recovery result does not
establish 10k watch performance, uninterrupted endurance or full dependency closure.

## Automated evidence

The final run passed **704 JavaScript/TypeScript tests and 46 Python tests**.
V8 coverage measured 87.73% statements, 83.96% branches, 86.89% functions and
88.79% lines; Python branch-inclusive coverage measured 89%.

The existing JavaScript/TypeScript coverage gates remain at 80% for statements,
branches, functions and lines. Native Python tests now run under CI with branch
coverage and an 80% minimum. Unit/integration tests include real regex workers,
real local HTTP and detached daemon subprocesses, and generated Python against
fake TD objects. Those tests do not replace native TD acceptance.

The [synthetic benchmark receipt](architecture-benchmarks.json) records 1k,
10k and 50k-node CPU graph/classifier/diff runs. The 50k result is 657 ms on the
recorded Node environment. It excludes TouchDesigner, transport cadence and
per-frame GPU/render performance.

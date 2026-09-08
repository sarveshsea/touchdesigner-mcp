# Architecture tools and local service

This fork adds seven architecture tools to the existing TouchDesigner MCP bridge. They inspect the live operator registry, map project dependencies, propose readable network structure, stage a restricted native refactor, and retain private evidence. They are authoring tools; the service is outside the artwork's render loop.

The implementation and its tests are not a claim that a particular artwork has passed native installation, refactoring, or a two-hour performance run. Keep the live release receipt separate from this usage guide.

## Components and lifecycle

```text
MCP client ── seven architecture tools ── local architecture daemon
                                             │
Native inspector ── authenticated loopback ────┤
                                             ├─ bounded graphs / plans / classification
                                             ├─ private JSON + Markdown sidecars
                                             └─ existing Python execution bridge ── TouchDesigner
                                                                                       │
                                                                        native observer / inspector
```

The existing MCP transport may be stdio or HTTP. The architecture client lazily starts one detached local daemon when an architecture tool is first used; importing the client does not start it. MCP request lifetimes do not own watch state. The native inspector and MCP tools share the daemon's graph revisions and transaction records.

The daemon binds an ephemeral IPv4 loopback port and publishes a private descriptor. Clients validate its owner, permissions, size, target, protocol and bearer token. A descriptor for a different TD host/port is rejected rather than silently reused. Keep the existing execution bridge local: its ability to execute Python is separate from the architecture service's narrow RPC interface.

Defaults:

| Setting | Default | Purpose |
|---|---|---|
| `TD_WEB_SERVER_HOST` | `http://127.0.0.1` | Existing TD bridge host |
| `TD_WEB_SERVER_PORT` | `9981` | Existing TD bridge port |
| `TD_ARCHITECTURE_STATE_DIR` | `~/.touchdesigner-mcp/architecture` | Absolute private state directory |
| `TD_ARCHITECTURE_DOC_ROOT` | Unset | Optional explicit local documentation root |

Install the native observer explicitly before using watch; catalog and graph reads do not silently install project nodes. Stopping watch stops its daemon timer and native observer. Closing an MCP client does not stop the detached daemon. A daemon shutdown closes its own service and timers; use `map_td_project` with `action: "stop"` before intentional shutdown when TD is reachable. Changing project or observer session invalidates old plans. A disconnect retains stale/disconnected evidence; it does not make it fresh again.

## Seven tools

The examples below show tool arguments, not Python code.

| Tool | Purpose | Important boundary |
|---|---|---|
| `get_td_operator_catalog` | Search registered operator classes and optional local documentation | Registration/support metadata is not an instantiation test |
| `map_td_project` | Refresh, watch, stop, inspect status or compare graph revisions | Partial scans and unresolved dependencies remain explicit |
| `classify_td_network` | Explain likely roles and propose a deterministic layout | No node movement; rule confidence is an inference |
| `plan_td_refactor` | Preview encapsulation of selected siblings, ports and reference repairs | Immutable, session/revision-bound plan with blocking reasons |
| `stage_td_refactor` | Apply a reviewed server-held plan in a new working copy, or read transaction status | Explicit mutation, checkpoint first; no blind retry |
| `get_td_memory` | Read project or explicitly promoted personal evidence | Freshness/provenance labels accompany notes |
| `record_td_memory` | Record, correct, retire or explicitly promote a note | Notes are evidence, never executable instructions |

### Inspect and watch

```json
{"query":"noise","family":"TOP","limit":20}
```

Send that to `get_td_operator_catalog`. Its runtime catalog is bounded and cached briefly. Entries distinguish registered availability, reported support and `tested: false`. Community references are documentation links; no asset is downloaded or imported. Optional local help indexing returns bounded document metadata, not arbitrary file contents.

```json
{"action":"refresh","rootPath":"/project1","maxNodes":10000,"pageSize":100,"dependencyAnalysis":false}
```

Send to `map_td_project` for a bounded overview. Use `action: "watch"` with `intervalMs: 2000` to continue observing the same root. `action: "status"` reads cached state; `action: "diff"` compares retained revisions; `action: "stop"` stops observation. One watched root is active at a time. Same-root scans share an in-flight task, failed watches back off, and periodic reconciliation complements the dirty ledger. The default scan budget is 60 seconds, with configurable limits; reaching a limit produces incomplete coverage rather than invented completeness.

```json
{"rootPath":"/project1"}
```

Send to `classify_td_network`. Roles include audio, timing, control, geometry, simulation, materials, rendering, typography and output. Evidence and conflicts remain visible. Layout proposals account for dependency cycles and pinned nodes. Classification does not rewrite the graph or create network boxes.

### Dependency census and source privacy

Graph edges distinguish containment, wires, component wires, typed parameter references, expressions, bindings, exports and ownership. Dependency direction is producer to consumer. Node IDs are valid only within a TD session. Fingerprints and revisions bind plans to observed state, including a separately checked wire census.

`complete` describes traversal coverage. `dependencyComplete` means the requested dependency census was inspected without omissions; it does **not** mean every dependency is resolved or safe to move. For refactoring, scan `/` with `dependencyAnalysis: true`. A complete scan of `/project1/small_subsystem` cannot establish that nothing outside it points inward.

Dependency analysis reads eligible source in TD, hashes it, and can identify static literal candidates. Raw source is not returned or persisted by the architecture graph pipeline. Expressions are not evaluated to discover references. Static candidates are evidence, not proof of all code behavior. Execute/callback source, dynamic references, storage and ownership can introduce unbounded dependencies. A filename, node name or apparent “tooling” label is not a trust exemption.

The graph still contains operator paths, types, tags, positions and relationships. Those can reveal project structure even without source text. Keep sidecars and exported reports private unless intentionally reviewed for sharing. The broader pre-existing Python execution tool is not made source-free by these architecture tools.

## Preview and stage a refactor

**Release gate:** end-to-end native staging is not yet validated. The live validation run found that TD can activate an incremented save filename. The save adapter now accepts only a fresh numbered file in the transaction’s exact sibling namespace and records requested/actual file paths and hashes; an isolated native save-helper retest has passed, but end-to-end staging remains unvalidated. A green preview or canary alone does not establish that result. TD documents incremented saves and link filenames in its [Preferences dialog](https://docs.derivative.ca/Dialogs%3APreferences_Dialog).

First obtain a fresh complete whole-project census:

```json
{"action":"refresh","rootPath":"/","dependencyAnalysis":true,"maxNodes":5000}
```

Then request a plan:

```json
{"paths":["/project1/audio/filter1","/project1/audio/level1"],"name":"analysis"}
```

Read the complete `plan_td_refactor` response: affected paths, boundary ports, constant-reference repairs and blocking reasons. A plan may be useful as a preview while remaining blocked. Palette changes, confidence scores and a successful scan are not authorization to bypass its guards.

The implemented transformation is native encapsulation of sibling operators, including nested siblings, into one new Base COMP. It is restricted to build **2025.33230**, subject to a positive native canary during staging. Existing operator IDs, ordinary boundary wires and supported constant OP references are preserved and verified. Port previews describe logical boundary ordering; native generated port nodes are verified after collapse.

Staging is blocked for incomplete/stale censuses, a new session, unsaved projects, existing target names, unsupported builds, an oversized read set, or ambiguous boundary ordering. Affected expressions, bindings, exports, wildcard references, source/code, runtime caches, clones, external `.tox` ownership, replicators, protected/locked nodes and object/panel COMP semantics require additional proof or an adapter. Unbounded opaque code elsewhere in the project may also block a seemingly simple group because it can refer inward dynamically. The public tools cannot accept caller-forged trust adapters. The default service does not silently exempt its own bridge by name.

When the plan is eligible and has been reviewed:

```json
{"action":"apply","planId":"refactor_<ID returned by the planner>"}
```

`stage_td_refactor` serializes the transaction, revalidates the graph/read set and complete wire census, writes a **non-overwriting sibling checkpoint `.toe`**, and verifies that TD has activated that copy before any collapse. It runs a disposable native canary, performs native collapse, repairs only known constant OP references, verifies unchanged identities/paths, boundary wires and the error baseline, and writes a second staged `.toe` on success. Selection/current state is restored. External `.tox` files and source files are not saved or rewritten by this operation.

The operation intentionally changes TD's active project to the working copy. The checkpoint is recovery evidence, not an ACID rollback guarantee. A failure may leave a partially changed working copy. If the bridge response is lost, use the returned transaction ID:

```json
{"action":"status","transactionId":"refactor_<transaction ID>"}
```

A matching completed receipt also produces a private Markdown comparison beside the JSON journal. It shows before/after operator paths, boundary groups, constant OP reference repairs and actual working-copy paths. Each section is capped at 64 rows and the report has a 60 KB budget; omitted counts remain explicit. A source-free plan summary is journaled before dispatch so later status reconciliation can produce the comparison after a lost response. Failed or pending transactions do not create a success report. If Markdown writing fails, the completed JSON receipt remains authoritative and reports `comparisonReport: "unavailable"`. If only the ancillary report-status journal update fails, the already saved complete receipt remains authoritative; the immediate response flags `comparisonStatusPersisted: false` without changing the transaction outcome.

Do not resend `apply` to guess whether a mutation happened. Keep the checkpoint and journal, inspect status, and explicitly choose recovery. The original saved artwork remains the rollback file; this is not a promise that arbitrary callbacks cannot have side effects.

## Native installation

Build the TypeScript service from the checkout, configure the existing TD bridge, and invoke an architecture read to start the local daemon. Then run this explicit setup in a Text DAT or Textport in a separate saved TD project:

```python
import sys
sys.path.insert(0, '/absolute/path/to/touchdesigner-mcp-fork/td')
from architecture.builder import install
receipt = install(root_path='/project1')
print(receipt)
```

The installer creates `/_td_architecture_inspector`, embeds its Python runtime in Text DATs, and opens a native panel window. It refuses to overwrite an existing node with that name. **DOCK** opens a Panel pane. The UI reuses 18 rows rather than making one widget per graph node; one asynchronous request is in flight at a time. It exposes scan/watch, classification, selection preview, staging, changes and memory. See [native inspector setup and protocol](inspector.md) for exact lifecycle, export and validation details.

No placeholder `.tox` is supplied as a substitute for a native export. After actual installation and validation, save the installed COMP to an explicit output `.tox` path. Service credentials stay outside the component.

## Private memory and sidecars

```text
~/.touchdesigner-mcp/architecture/
  service.json                         private connection descriptor; contains credential
  projects/<project-id>/graph.json     latest retained source-free graph evidence
  projects/<project-id>/memory.json    authoritative versioned project notes
  projects/<project-id>/notes.md       human-readable derived mirror
  personal/memory.json                 explicitly promoted reusable notes
  personal/notes.md                    human-readable derived mirror
  refactor/<transaction-id>.json       authoritative progress/recovery journal
  refactor/<transaction-id>.md         completed transaction comparison
  soaks/<run-id>/                      optional private observation reports
```

The state location is chosen by the host, not supplied by note callers. Private file permissions and bounded reads/writes protect local storage; this is not encrypted storage. JSON is authoritative, so edit notes through the tools rather than editing their Markdown mirror. Note retention is bounded to 128 note identities with up to four versions each. Project notes become personal only through an explicit promotion action.

Provenance includes build, source identity and node/graph fingerprint. Missing provenance is unverified; changed fingerprints, build, missing nodes or incomplete observations make evidence stale. Retiring or correcting a note preserves bounded history. Do not place tokens, raw source, private artwork assets or personal machine paths in release documentation, sample notes or version control.

Fingerprint version 2 excludes runtime operator IDs, which can change when a saved project reopens. Paths, types, positions, flags and captured source hashes remain fingerprint evidence. Refactor plans still bind the session and operator IDs separately. Older ID-bearing fingerprints become stale when compared with a new scan; they are never silently relabeled as current. Re-observe and explicitly correct their provenance when the claim is verified again.

## Observe a two-hour watch

Start and verify watch through the tool first, then run:

```sh
npm run build:dist
node scripts/architecture-soak.mjs --duration 7200 --sample 2 --status-interval 30 --root /project1
```

The script reads existing observer status and TD counters every two seconds, and cached daemon graph status plus process RSS every 30 seconds. It does not start/stop watch, drain its queue, request fresh scans, force cooks, install operators or stage changes. `--help` works without contacting the service. `--out` selects a **new** output directory; the default lives in private state. SIGINT/SIGTERM produce an interrupted receipt after the current read.

JSONL samples stream to disk with bounded in-memory histograms. The summary includes duration, read failures, inactive watch samples, session changes, observed graph revision changes, queue/scans maxima and endpoint growth, RSS changes, and approximate p50/p95/p99 sampled cook/RPC times. Missing counters remain null. It never writes raw graphs, source, descriptor tokens or song/artwork metadata.

These are observation receipts, not automatic acceptance. A two-second sample of the latest cook time cannot establish per-frame p95/p99 latency, actual dropped frames or a 60 fps guarantee. Timeline counters are not render FPS. Use a separate native frame-time recorder for those claims and compare a matching watch-off baseline to quantify observation overhead. A completed duration does not make errors, queue growth or memory growth acceptable. Review the report and preserve its measurement limitations.

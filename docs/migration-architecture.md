# Migrating to the architecture service

The architecture extension is additive to the existing TouchDesigner MCP bridge. Existing artwork networks and shader sources do not need to be restructured to use its catalog, graph, classification or memory tools. Refactoring is a separate explicit action with stricter eligibility checks.

## Release assets

Use the matching **v2.2.0-architecture.1** assets from the fork's GitHub prerelease:

- `sarveshsea-touchdesigner-mcp-2.2.0-architecture.1.tgz`: compiled MCP server, including the shared architecture daemon. The MCPB launcher pins this same tarball; it is an alternative client installer, not the native TD component.
- `touchdesigner-architecture-2.2.0-architecture.1.zip`: matching API 1.5 bridge and supporting modules, inert `td/architecture/inspector.tox`, embedded/external inspector sources, an original seven-family `.tox` example, rules and validation documentation. Extract the whole bundle; keep the bridge modules beside their supplied loader.
- `SHA256SUMS`: verify downloaded files before installation. `inspector.build.json` additionally binds the native inspector to its seven source modules and tested TD build.

In a separately saved TD project, install the bridge from the extracted bundle if one is not already connected. Start the new MCP server and invoke a catalog or map read to launch the architecture service. Import `td/architecture/inspector.tox`, open its viewer, click **CONNECT**, choose the intended root, then **WATCH** and **DOCK**. Imports are deliberately inactive until CONNECT. An existing inspector is not replaced automatically.

The prerelease is built from the feature branch while the review remains open. When building from source, check out `v2.2.0-architecture.1` explicitly; the default branch can still contain the rollback version. Restart the MCP host after changing its pinned package. Do not interrupt an active refactor transaction to upgrade the daemon.

## Preserve and install

1. Preserve the current `.toe`, installed bridge component and its matching supporting modules. Work in a separately saved copy for the first native installation and refactor trial.
2. Use the repository's documented dependency installation, then run `npm run build:dist`. Configure `TD_WEB_SERVER_HOST` and `TD_WEB_SERVER_PORT` consistently for the MCP process and architecture daemon. The local defaults are `http://127.0.0.1` and `9981`.
3. Invoke `get_td_operator_catalog` or `map_td_project` to start the architecture daemon lazily. A disconnected result is not a successful TD connection. Check the reported build and graph freshness.
4. Install the native observer/inspector explicitly. In TD, run:

   ```python
   import sys
   sys.path.insert(0, '/absolute/path/to/touchdesigner-mcp-fork/td')
   from architecture.builder import install
   receipt = install(root_path='/project1')
   print(receipt)
   ```

   This creates `/_td_architecture_inspector` and opens a native window. It refuses to replace an existing component with that name. Reuse the current viewer or test the updated installer in a fresh project; do not rename/delete unrelated nodes to make an installation appear successful.
5. Request `map_td_project` with `action: "watch"` and the intended `rootPath`. Verify native observer activity, daemon `watching: true`, graph freshness and coverage. The **DOCK** button opens the inspector in a Panel pane. [Inspector documentation](inspector.md) covers native export and exact controls.

Loading the JavaScript module alone does not start a daemon. Catalog/graph reads do not create TD nodes. A native `.tox` must be exported from an actually installed and validated component; a source archive or renamed text file is not that artifact.

## Existing workflow to new workflow

| Earlier workflow | Architecture workflow |
|---|---|
| Repeated ad hoc Python inventories | Bounded `map_td_project` snapshots and explicit watch/status/diff |
| Guessing operators from examples | Runtime `get_td_operator_catalog` with support/availability distinctions |
| Moving nodes to make the graph readable | `classify_td_network` returns evidence and a layout proposal before edits |
| Moving a group and repairing strings afterward | `plan_td_refactor` inventories boundaries; `stage_td_refactor` applies an eligible reviewed plan in a new `.toe` |
| Conversation-only project knowledge | Project-scoped `record_td_memory` and provenance-aware `get_td_memory` |
| Assuming every remembered convention applies globally | Explicit promotion from project notes to personal notes |

These seven tools share one daemon state. Keep watch on the root you want to inspect; starting watch on a different root replaces the watched root. Native panel polling reads service state and does not run graph scanning in a render callback.

## What can prevent migration or staging

An architecture read can work while refactoring remains blocked. For dependency closure, refresh `/` with `dependencyAnalysis: true`; a nested scan cannot rule out outside references. `dependencyComplete` means inspection coverage, not universally resolved dependencies. Inspect blocking reasons rather than treating this flag as permission to move nodes.

The first refactor implementation targets native sibling encapsulation and known constant OP references on **2025.33230**, with a positive disposable canary required during staging. Object/panel COMP semantics, external `.tox` ownership, clones, replicators, code, expressions, binds, exports, wildcard references and runtime storage can require unsupported repairs. Opaque code outside the group can still refer inward and block it. The default service does not automatically trust a bridge, inspector or application node because of its name. Do not remove dependency findings or fabricate adapter receipts to force an artwork through the gate.

Plans do not survive changed graph revisions, operator fingerprints, wire topology, project identity or observer session. Refresh and produce a new preview after edits or restart. A plan ID is held by the service; a caller cannot supply replacement stage scripts or arbitrary output paths through the public tool.

## Working-copy and recovery behavior

End-to-end native staging remains a release gate. TD filename increment/link preferences can produce an active numbered copy instead of the exact requested save path; the adapter now accepts only fresh same-directory members of the exact transaction filename namespace, while recording requested and actual paths. An isolated native save-helper retest has passed; full staging still requires end-to-end validation before use on a working artwork.

Staging writes a uniquely named sibling checkpoint `.toe` and confirms TD has activated that copy before collapse. A successful run writes a separate staged `.toe`. It does not overwrite the original `.toe`, save external `.tox` files, or rewrite source files. The active project changes to the working copy; account for that before subsequent manual saves.

A completed transaction adds a bounded human-readable `.md` comparison alongside its private JSON journal. JSON remains authoritative; failed/pending transactions do not receive a success report.

A failed or uncertain transaction retains a journal and checkpoint. It is not an automatic undo or an ACID transaction. Query `stage_td_refactor` with `action: "status"` and its transaction ID after a lost response. Do not blindly retry `apply`. Inspect the working copy and explicitly open the original/checkpoint if recovery is needed. Leave any partial staged artifacts intact until their purpose is understood.

## Private state, upgrades and removal

State defaults to `~/.touchdesigner-mcp/architecture`. If using `TD_ARCHITECTURE_STATE_DIR`, set the same absolute directory for TD and the service process. Keep the directory private and owner-controlled. `service.json` is a credential-bearing process descriptor, not configuration to commit or copy between machines. Project graph/notes, personal promoted notes, transaction journals and soak receipts are sidecars outside the artwork; see [the architecture state layout](architecture-service.md#private-memory-and-sidecars).

Before intentionally changing service versions or bridge targets, stop watch while TD is reachable. Then stop the owned daemon normally. Do not remove a live descriptor or kill an unrelated PID to bypass an ownership/target error. A healthy compatible daemon can be reused; a malformed, incompatible or unauthenticated descriptor requires investigation. Rebuild the sources, invoke a read to start the updated service, and request a fresh scan. Do not reuse old session-bound plans or assume old note provenance is current.

To stop using the feature, stop watch and close the inspector. Preserve sidecars and artwork copies until recovery is no longer needed. Removal of the native inspector component is a deliberate project edit; the tools do not delete it automatically when an MCP client disconnects. Removing the architecture extension should not require changing the artwork's rendering network.

## Release checks and truthful reporting

Run the automated tests appropriate to the changed modules, then validate native installation, polling, selection preview, docking and an actual `.tox` export. Test refactoring in disposable projects for every supported family and inspect IDs, wires, constant references, selection and checkpoint behavior. Synthetic TD fixtures establish code behavior, not native compatibility.

After starting watch, the read-only runner can observe it for two hours:

```sh
node scripts/architecture-soak.mjs --duration 7200 --sample 2 --status-interval 30 --root /project1
```

It writes private JSONL samples and a summary; it does not launch the watch itself. Review errors, session changes, queue growth, scan backlog and process RSS. Its bounded histogram percentiles describe sampled cook/RPC metrics and cannot replace a per-frame performance capture. Run a matching watch-off baseline separately for overhead comparisons. Do not report a two-hour pass, production-ready refactoring or live `.tox` validation from the existence of the script or green unit tests alone.

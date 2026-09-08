# Native architecture inspector

The optional inspector is a native TouchDesigner Container COMP. It uses the same local architecture service and graph state as the MCP tools. It does not embed a browser or execute network requests in a render callback.

## Install and export

Start the architecture service, then run this setup from a Text DAT or Textport in a separate saved TouchDesigner project:

```python
import sys
sys.path.insert(0, '/absolute/path/to/touchdesigner-mcp-fork/td')
from architecture.builder import install
receipt = install(root_path='/project1')
print(receipt)
```

The installer creates `/_td_architecture_inspector` and opens its native window. Native widgets use explicit `ui_` names; each newly owned operator name is verified and normalized if TouchDesigner adds a numeric suffix. It **refuses to overwrite any operator already using that name**, including an earlier inspector. Reuse an existing inspector through its viewer or test a new build in a clean project. A setup failure removes only the newly created inspector subtree.

The **DOCK** action opens a Panel pane to the right of the current pane. You can also point any Panel pane at the inspector COMP. Network rows focus an existing Network Editor pane; they do not edit the inspected node or its selection flags.

For distribution, build a **new inactive inspector**, rather than saving a connected component. Stop the existing controller and destroy only its explicitly tagged inspector COMP after saving your working project. Reload the `architecture` package from the current checkout before rebuilding; cached Python imports must not generate a receipt for changed source files.

```python
# In a fresh project or after removing the owned inspector only:
from architecture.builder import install_clean_export, export_clean
receipt = install_clean_export()
panel = op(receipt['path'])
export_clean(panel, '/absolute/path/to/touchdesigner-mcp-fork/td/architecture/inspector.tox',
             build='2025.33230')
```

`install_clean_export()` does not connect, poll, observe, open a window, or retain the current project root. Autostart remains off across delayed creation and project-start callbacks. The distributed inspector requires **CONNECT** after import; open its viewer or window to reach that button. Connecting turns it into a personal runtime instance, which is no longer eligible for pristine export.

The runtime sources are embedded in Text DATs, so the `.tox` does not need the checkout after import. Bootstrap checks their embedded SHA-256 hashes before executing them. Clean export verifies source hashes against the checkout, exact bounded descendant inventory and parameter/content hashes, initial UI labels, neutral filter values, empty storage, no cached WebClient response, and inactive startup/client/observer operators. It rejects modified or previously activated instances rather than attempting to scrub them.

`export_clean()` verifies the running TouchDesigner build before calling its real native `save`, requires a nonempty binary no larger than 4 MiB, rechecks the inactive component, then writes `td/architecture/inspector.build.json`. The receipt contains `schemaVersion: 1`, the pinned build `2025.33230`, `cleanExport: true`, `autostart: false`, seven source-file SHA-256 hashes under `sources`, and `binary: {path: "inspector.tox", bytes, sha256}`. All paths in that receipt are relative filenames. Packaging validates the receipt against the actual checkout and binary bytes; any source change requires a new native export. Hashes provide reproducibility and mismatch detection, not cryptographic proof of publisher identity. No placeholder binary is substituted for an actual export.

## Controls

- **CONNECT:** activate an imported pristine inspector and begin asynchronous service polling. The service must already be running.
- **Network:** searchable operator paths, family and classified role. Clicking a row shows its operator type, incoming/outgoing relationship counts from the returned subset, unresolved relationships, role confidence and the first classification evidence rule in the existing message line. These bounded counts do not claim dependency completeness.
- **Classification:** role and confidence for the same graph; evidence remains in the shared service response.
- **Changes:** the preview target, affected paths, external ports, planned reference repairs and blocking reasons. A blocked preview cannot be staged. A changed graph revision disables its old preview.
- **Memory:** bounded service memory records, searchable locally.
- **SCAN / WATCH:** request a refresh or watched graph through `map_td_project` with `wait: false`. The service acknowledges a background job immediately and owns scan budgeting and dirty-ledger draining. The status line shows visited/remaining counts and an incomplete scan state, including when no graph exists yet; retained snapshots are never labeled fresh during an active scan.
- **CLASSIFY:** request classification for the chosen root.
- **PREVIEW SELECTION:** use the network editor's selected operators, or the last focused row if none are selected. The subsystem name is editable above the action row. Empty selections and service validation errors are shown in the message line.
- **STAGE PREVIEW:** send the currently reviewed plan ID to `stage_td_refactor`. Its transaction implementation controls checkpointing and recovery; the inspector does not independently rewrite the artwork.

Exactly **18 row buttons** are reused across pages. There is no COMP per operator and no full-network image rendering. The client accepts at most 4 MiB per state response. Network and Classification request 18 rows at a time, with server-side search and role filtering across the scanned graph. Pagination uses the server total and offset, so networks larger than 500 operators remain reachable without instantiating additional widgets. Changes and Memory retain bounded local paging (at most 5,000 local rows). The summary shows connection, graph freshness, revision, scan completeness and transaction state. A disconnect retains the last snapshot and labels it disconnected.

## Local connection

The service publishes a private descriptor at:

```text
~/.touchdesigner-mcp/architecture/service.json
```

Set `TD_ARCHITECTURE_STATE_DIR` before launching TouchDesigner to use a different directory. The descriptor contains `{url, token, pid, version}`; `url` must use HTTP with an explicit `127.0.0.1` or `::1` port. On POSIX the file must belong to the current user and have no group/other permissions (normally `0600`). Symbolic links, oversized files, remote addresses and malformed credentials are rejected.

The native Web Client DAT posts `{method, params}` to `/rpc` with an `Authorization: Bearer …` request header. It expects `{ok: true, result: …}` or `{ok: false, error: {code, message}}`. Descriptor reads allow token/port changes after service restart. Scan/watch/classify actions request summary acknowledgments instead of returning a full graph into the native DAT; paged inspector-state calls fetch the visible rows. Responses correlate the actual TouchDesigner Web Client connection ID with the pending request, ignoring canceled or mismatched late responses. One asynchronous request is allowed at a time, with a 10-second native request timeout and a 12-second client expiry. The next poll is scheduled through a delayed wall-time `run`, every two seconds; no Execute DAT frame-start/frame-end callbacks are enabled.

## Observer protocol

The installed observer is exposed as `sys.modules['_td_mcp_architecture']`:

```python
observer.start('/project1')
observer.watch(['/project1', '/project1/audio', '/project1/render'])
observer.status()
observer.drain(256)
observer.stop()
```

`start()` creates a new `session_id` and computes `project_identity` from project file identity, root path and root operator ID. `dirty_revision` increments for each accepted change. `status()` and `drain()` include `active`, `session_id`, `project_identity`, `dirty_revision`, `pending`, `dropped`, `coverage` and `watched_count`. `drain()` adds `events` and `remaining`.

Each event contains `{revision, kind, path, parentPath, at}`. Events retain identity only. Repeated adjacent changes coalesce within 150 ms while the revision still advances. The ledger holds at most 2,048 events; cumulative `dropped` means coverage was lost and the service should perform a full refresh. Drain limits are 1–1,024.

Coverage is explicitly **registered paths**, not a claim of exhaustive wildcard monitoring. The collector should register its scanned nodes through `watch()` (maximum 5,000 paths including the root). Child-count/rename callbacks invalidate watched COMP identities so subsequent scans can discover added operators. The root is watched immediately after installation. The inspector's owned subtree is excluded. Selected/current flag changes are ignored.

OP Execute pre-cook and post-cook toggles are disabled and corresponding callbacks are absent. Destruction callbacks in TouchDesigner do not supply the deleted OP, so they invalidate the watched root. Observations cannot prove the completeness of dynamic expressions or dependency analysis.

## Validation

The Python tests use fake TD operators to verify callback toggles, ledger bounds, revision changes, startup embedding, overwrite protection, native row limits, selection preview, staging guards, private descriptor handling, asynchronous RPC and disconnect behavior:

```sh
python3 -m pytest tests/python/test_architecture_observer.py tests/python/test_architecture_inspector.py tests/python/test_architecture_builder.py
ruff check td/architecture tests/python/test_architecture*.py
```

Native instantiation, Web Client callback compatibility, docking, actual `.tox` export and performance remain live TouchDesigner acceptance checks. Fake operators do not establish those results.

API references: [OP Execute DAT](https://derivative.ca/UserGuide/OP_Execute_DAT), [OP Execute callbacks](https://derivative.ca/UserGuide/OpexecuteDAT_Class), [Web Client request API](https://derivative.ca/UserGuide/WebclientDAT_Class), and [Network Editor focus and pane methods](https://derivative.ca/UserGuide/NetworkEditor_Class).

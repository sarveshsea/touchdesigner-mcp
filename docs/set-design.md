# Set-design authoring fork

This MIT-licensed fork builds on [8beeeaaat/touchdesigner-mcp](https://github.com/8beeeaaat/touchdesigner-mcp). It turns repeated authoring scripts from a large generative scene project into bounded, reusable MCP tools. TouchDesigner owns rendering and simulation; the MCP is an authoring and inspection bridge.

## What this release changes

- `get_td_network_snapshot`: root-inclusive bounded hierarchy, session-local IDs, node positions/sizes, cooking flags, ordinary/component wires and direct errors/warnings. Default depth 2 and 100 nodes; maximum depth 8 and 500 nodes. Explicit truncation means an incomplete report cannot masquerade as a complete project inventory. No DAT contents or parameter values are read. It never requests a cook.
- `layout_td_network`: deterministic grid for at most 200 immediate children. Dry run is the default. Inspect the before/after plan, then apply explicitly. The complete request is validated before writes. Only coordinates change; selection, current flags, topology, parameter expressions and simulation are untouched. Setter failures trigger best-effort coordinate restoration with explicit failure details.
- `get_top_image`: existing operators survive collisions with temporary capture names. Cleanup owns only the temporary TOP created by that invocation.
- Runtime endpoint configuration replaces executable environment interpolation in generated API code. Requests have a bounded timeout; a client timeout cannot cancel Python already executing in TD. Inspect state before repeating a mutation.
- MCP package versions and TD API versions remain independent. These tools reuse the execution endpoint on API 1.5.0; no replacement `.tox` is needed for this release.

## Install this fork

Requires Node.js (CI pins `.node-version`) and a working local TouchDesigner MCP component. Keep its supporting modules together and follow the [upstream component installation guide](https://github.com/8beeeaaat/touchdesigner-mcp/blob/main/docs/installation.md) when installing the bridge for the first time.

Build from the fork:

```sh
git clone https://github.com/sarveshsea/touchdesigner-mcp.git
cd touchdesigner-mcp
npm ci
npm run build
node dist/cli.js --stdio --host=http://127.0.0.1 --port=9981
```

Configure an MCP host to run `node` with the absolute path to this checkout's `dist/cli.js`, followed by `--stdio`. Do not use `npx touchdesigner-mcp-server@latest`: that is upstream, not this fork.

The GitHub prerelease includes an npm-format `.tgz` and an MCPB launcher. The MCPB uses `npx` with the exact fork tarball URL, so it requires Node/npm and network access on first installation. It is not a self-contained/offline binary. There is no npm registry publication for this fork release. The existing API 1.5.0 component is unchanged and is not repackaged as a new TD build.

Release evidence is recorded in [release validation](release-validation.md). For contributors, run `npm run build`, `npm run lint`, `npm test`, and `npm run coverage`; CI enforces at least 80% across all four V8 coverage metrics. Live application tests require an explicit opt-in and an isolated fixture.

`TD_WEB_SERVER_TIMEOUT_MS` accepts 1000–120000 milliseconds (default 30000). A longer timeout only changes how long the client waits; it does not make TD execution asynchronous.

## A repeatable development loop

1. Read `get_td_info`, then snapshot a bounded COMP such as `/project1/show`. Inspect `truncated` and refine the scope rather than requesting the entire machine's project state.
2. Inspect an operator's documented parameters before changing it. Separate audio, world geometry, GPU simulation, rendering and controls into owned COMPs with explicit inputs/outputs.
3. Preview a layout with `layout_td_network({parentPath:'/project1/show',dryRun:true})`. Set `dryRun:false` only after checking the planned scope. Apply recomputes the plan against current state; it does not reserve a transaction.
4. Capture a TOP for visual review and inspect the node errors. A successful shader compile is not proof of visual quality or frame-rate stability.
5. Save your project through an explicitly requested save operation. This fork's layout does not save, rename, collapse or reparent anything.

A layout preview describes the chosen grid, not semantic grouping. The artist decides the hierarchy. Automatic collapse/reparent is deliberately outside this release: real TD tests showed that collapse includes the current node and can leave relative references stale. A future tool must preserve expressions, selectors and object identities, with preview and restoration evidence.

## Security and operating limits

Both the TD execution bridge and MCP transport should stay on loopback. Arbitrary Python is an intentional existing capability, so do not expose the bridge as an unauthenticated internet service. The new convenience tools do not turn it into a sandbox. Explicitly configured remote hosts require an independently secured deployment.

Snapshots are bounded structural reports, not project backups. Direct diagnostics may contain text generated by your own operators; inspect reports before sharing them publicly. Live scene data, audio, account credentials, private artwork and machine paths are not included in this repository or its validation receipt.

## Development roadmap

1. **Reference-aware refactoring:** inspect constant OP references, expressions and external assets; preview hierarchy changes; preserve current/selection flags; prove recovery in disposable networks before changing a show.
2. **Performance sampling:** bounded frame-end measurements recorded outside rendering, with build/hardware/quality context, p95/p99 timings and resource trends. Never label a single cook-time snapshot a benchmark.
3. **Project preflight:** explicit asset/dependency inventories, missing files, shader diagnostics and versioned show manifests. No network downloads in frame callbacks.
4. **Cue and set tooling:** versioned scene/cue packages, output-layout manifests and reusable scene contracts. Actual controller mappings and venue-specific multi-output calibration require hardware tests.
5. **Developer learning:** small runnable examples and failure-oriented tests for coordinate spaces, instancing, POP lifetimes, shader interfaces and repeatable captures.

These are future milestones, not delivered features or a claim of festival production readiness. Improvements should remain small, documented, tested and suitable for an upstream contribution when appropriate.

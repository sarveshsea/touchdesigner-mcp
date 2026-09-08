# Validation: 2.1.0-setdesign.1

Validated on 2026-09-08. This is an authoring-tool prerelease, not a festival-performance certification.

## Automated checks

- Build and generated API clients: passed.
- TypeScript, Python, YAML and Biome checks: passed; one inherited optional-chain warning remains in `.claude/hooks/integration-test-guard.mjs`.
- Unit, mocked integration and MCP transport tests: **440 passed**.
- The separate existing live-TD suite has **24 opt-in tests skipped by default**. CI never connects to an artist's application.
- V8 coverage: **92.61% statements, 86.97% branches, 82.15% functions, 92.86% lines**. All four have an 80% CI threshold. Embedded Python behavior is also exercised in actual Python subprocesses; V8 percentages are not Python coverage claims.
- `npm audit --audit-level=moderate`: zero known vulnerabilities at validation time. The MCPB build dependency uses a patched `tmp` override; this is not a guarantee against undisclosed vulnerabilities.

## Actual TouchDesigner and installable package

Tested against TouchDesigner **2025.33230**, Apple Silicon macOS, bridge API **1.5.0**, using Node.js **22.22.3**. CI separately pins Node.js through `.node-version`.

`node tests/live/authoring-smoke.mjs` starts the built server over MCP stdio and owns one temporary COMP. It verifies:

1. Tool registration and the read-only snapshot annotation.
2. Actual hierarchy, connected TOPs and bounded/truncated snapshot output.
3. A layout preview makes no coordinate changes; applying produces the planned coordinates.
4. A real JPEG capture preserves a deliberately colliding operator and cleans up only its own temporary TOP.

The same smoke test passed after installing the packed `.tgz` into a fresh temporary directory with production dependencies only. To test another local build, set `TD_MCP_CLI` to its absolute `dist/cli.js` path. The fixture refuses an existing target and cleans up only the COMP ID it created. No artwork is exported into the test receipt.

The MCPB manifest was schema-validated and packaged with the pinned CLI. Its exact-version GitHub tarball launcher was inspected. A native MCPB host installation has not been tested; it requires Node/npm and network access on first install.

## Release boundary

- Existing bridge component retained; no new `.tox` is claimed.
- No account credentials, audio, scene files or private operator contents are shipped.
- No npm registry or MCP registry publication is claimed. Artifacts are distributed on GitHub with SHA-256 checksums.
- Layout does not reparent or collapse operators. Coordinate restoration after a setter failure is best effort and reports failures.
- Hardware controller mapping, multi-output calibration, large-show performance sampling and long-duration endurance remain future work.

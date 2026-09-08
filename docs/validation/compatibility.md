# Architecture preview compatibility

Release candidate: `2.2.0-architecture.1`. Runtime capability checks are authoritative;
a version match alone does not certify a project or GPU configuration.

| Environment | Catalog / bounded map | Live observer / native inspector | Encapsulation |
|---|---|---|---|
| TD 2025.33230, macOS Apple Silicon, matching observer 1 | Native discovery and small-network scans exercised | Native panel, asynchronous requests and structural events exercised | Five-family collapse and incremented-copy save canaries passed; full staging **not certified** |
| TD 2025.33230 with API 1.5 bridge only | Available through Python execution | Updated observer/inspector bundle required | Not certified |
| Other TD builds/platforms | Discover runtime metadata; preserve unknown families/types; report absent capabilities | Capability negotiation required; no native validation claim | Native staging build guard rejects untested builds |
| TD 2023.11600 | Original installation preserved; not tested with this preview | Not tested | Unsupported |

All sixteen existing tools remain registered. The seven added architecture tools
use the same MCP transports and a private shared local daemon. The observer does
not use cook callbacks. The native inspector is optional for snapshots/catalogs,
and required for event-driven watch.

A successful canary is a narrow measurement, not permission to ignore unresolved
references. Plans with incomplete dependency coverage, opaque affected code,
unsupported ownership or stale identities remain blocked. No stock-engine or
MCP-tooling exemption manifest is shipped. See [validation status](architecture-status.md)
for measured failures and outstanding acceptance gates.

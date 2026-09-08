# Operator and community discovery

`getOperatorCatalog(executor, { query?, family?, limit?, offset?, docRoot? })` reads the running TouchDesigner registry. It never creates, imports, cooks or tests an operator. Runtime names, family membership and primitive class metadata remain exact; custom families survive discovery. Known families are COMP, TOP, CHOP, POP, DAT, MAT and SOP. A family absent from the current registry is not invented as locally available.

Each entry reports `availability: registered` and `tested: false`. `support` is `reported-supported` or `reported-unsupported` only when the runtime exposes boolean `isSupported` or the observed `supported` boolean/0–1 flag; otherwise it is `unknown`. `supportSource` identifies the exact source field, and its original value is retained. Labels, component subtype and input/output limits are omitted when unavailable. `kind` derives from an observed boolean `isFilter`; it is not guessed from an operator name. Neither registration nor reported support proves the current GPU, license, project or wiring has been tested.

The catalog unions the runtime `families` and optional `opTypes` collections. It bounds registry size at 8,192 entries, reads pages of 128, and caches for 30 seconds per executor/build/registry shape. Each request checks the build again. A changing build, malformed page or conflicting duplicate fails the scan; a reached discovery bound is marked incomplete. Returned rows are detached from cache. Queries are plain substring filters, family matching is case-insensitive, and responses have at most 200 operators with `total` and `nextOffset` for pagination.

## Offline documentation

`docRoot` is a low-level internal catalog option, not a public tool parameter. The daemon obtains the installed offline-help directory only from the explicit `TD_ARCHITECTURE_DOC_ROOT` environment setting. The public `get_td_operator_catalog` tool rejects `docRoot`; queries never select filesystem roots. Internal callers must authorize the absolute directory before passing it. The catalog has no ambient filesystem search or home-directory discovery.

Indexing reads only `.htm`, `.html` and `.md` files under that root. Symlink roots, ancestor links and linked entries are rejected/skipped. Bounds are 1,024 directory entries, 256 documents, four nested directory levels, 32 KiB per file and 1 MiB total input. The cache holds at most four roots for five minutes. Bounds produce `truncated: true` when the traversal stops; the index is a bounded aid, not complete installed-help coverage.

Results contain relative filenames, short plain-text titles and summaries. They never contain raw HTML, executable script/style content, absolute paths, file timestamps or directory listings. No HTML is republished, no local file-serving endpoint is installed, and no remote requests occur during indexing. A query only filters the cached document records; it cannot navigate the filesystem. Missing or unsafe roots return a generic error without a private path. Use a read-only installed help directory; this is not a sandbox for an adversarial process concurrently replacing filesystem entries.

## Curated references — no automatic imports

| Reference | Use | License boundary |
|---|---|---|
| [Derivative OP Snippets](https://docs.derivative.ca/OP_Snippets) | Inspect examples showing operator inputs and behavior. | Derivative distribution terms and the selected example's notices. |
| [TouchDesigner Palette](https://docs.derivative.ca/Palette) | Find reusable components and learning examples. | Check the selected component and included notices. |
| [FunctionStore_tools](https://github.com/function-store/FunctionStore_tools) | Study workflow, operator placement and authoring tools. | The repository is MIT; verify the exact version and bundled component licenses before reuse. |
| [Olib](https://olib.amb-service.net/) | Discover community components. | Licenses are per component; a catalog listing does not grant blanket redistribution permission. |

Each record includes an explicit `author` and `testedBuilds`. Derivative is credited for OP Snippets and the Palette; Daniel Molnar (Function Store) is credited for FunctionStore_tools. Olib attribution remains `null` here rather than being guessed. All four `testedBuilds` arrays are empty: these are discovery references, and no component/build compatibility test is claimed.

These records are links and brief original summaries. Opening a reference is distinct from installing it. No download, `.tox` import, self-update or dependency installation is triggered by catalog discovery. Test selected components in an isolated project, record their version/license, and measure their behavior on the target build before incorporating them.

Operator-family and class-field references: [Operator Family](https://docs.derivative.ca/Operator_Family), [OP Class](https://docs.derivative.ca/OP_Class), and the installed `Td_Module.htm` documentation for `families`. Runtime data remains authoritative for this catalog; unavailable metadata stays unknown.

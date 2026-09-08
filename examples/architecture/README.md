# Synthetic architecture example

This original fixture contains CHOP controls, a TOP image chain, SOP geometry,
a material, a table and a mixed nested COMP. On a POP-capable build it also adds
a point generator. No third-party media or components are imported.

In TouchDesigner Textport, load this source with `exec` and call `build()`.
The source is a deliberately explicit setup script, not a dependency scanner.
It refuses to overwrite an existing target. Select the two middle CHOP nodes to
explore a refactor preview; eligibility still depends on the entire project.
The example is not an exemption from unresolved code elsewhere in the network.

The 1k/10k/50k synthetic benchmark is reproducible with
`node tests/benchmarks/architectureGraph.ts` after `npm run build:dist`.

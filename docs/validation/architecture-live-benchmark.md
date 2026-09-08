# Owned-fixture live graph benchmark

This runner is an explicit live test. It creates a temporary Base COMP and 999 or 9,999 children, then removes that fixture in bounded batches. The current project is never saved. Existing operators and their parameters are not edited.

After building the current source, run only when other full scans and structural mutations are stopped:

```sh
TD_LIVE_TESTS=1 node tests/benchmarks/architectureLiveGraph.ts --live --counts=1000 --max-duration-ms=300000
TD_LIVE_TESTS=1 node tests/benchmarks/architectureLiveGraph.ts --live --counts=10000 --max-duration-ms=1200000
```

Capture stdout as a receipt conforming to `architecture-live-benchmark.schema.json`. Receipts contain aggregate timings and counts, not project paths, temporary ownership nonces, source bodies or credentials. No live result is provided by this document.

The fixture mixes constant/null/select CHOPs, empty Base COMPs, and Text DATs containing static reference examples. The fixture's cooking is disabled and viewers are off. Collection measures the actual bridge and generated Python metadata census with source dependency analysis disabled; it does not measure rendering throughput. Creation, collection and cleanup occur sequentially. Creation/deletion batches contain at most 100 nodes; graph pages contain at most 500 operators. The default collection page is 100. Each scenario defaults to a one-hour budget, configurable with `--max-duration-ms` from 1,000 to 3,600,000; the commands above cap setup plus collection at five and twenty minutes respectively. Cleanup attempts have a separate five-minute ceiling.

`collectionMs` measures the collection call. `bridgeRoundTripMs` aggregates successful page request durations. `pythonScanMs` sums timing reported by available Python pages; compare `pythonTimingSamples` with `collectionCalls` before treating it as a total. Before/after diagnostics sample the fixture plus at most 32 children through passive reads. CPU cook time refers to the last measured cook, and memory figures cover only sampled operators. These values are not FPS or whole-project performance measurements. The underlying properties are documented in the [Derivative OP API](https://docs.derivative.ca/NullCOMP_Class).

A complete fixture census does not certify dependencies from the surrounding project: `dependencyComplete` normally remains false for this scoped collection. The benchmark never exempts opaque system references or changes graph completeness rules.

Cleanup checks the exact temporary root, ownership nonce and returned operator identity. Foreign children, unexpected nested contents or a changed root identity cause cleanup to stop and report failure. A failed cleanup leaves the fixture for inspection; it does not delete unknown nodes. SIGINT/SIGTERM request cancellation followed by cleanup. A forced process kill or unavailable bridge can prevent cleanup, so a receipt must show `cleanupComplete: true` before the run is considered successful.

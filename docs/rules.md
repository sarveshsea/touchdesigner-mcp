# Explainable network roles and coordinate proposals

`classifyNetwork(graph, options?)` consumes a source-free `ProjectGraph`. It returns classifications, coordinate proposals and warnings. It never contacts TouchDesigner, changes operators, reads DAT contents or evaluates parameter expressions. The exported `classifierOptionsSchema`, `ruleSchema` and `rulePackSchema` validate the public inputs. The default editable rule pack is a TypeScript-exported JSON-shaped value in `src/architecture/classifier/rules.ts`, so package builds include it without asset-copy configuration.

Every classification carries its role, an estimated confidence from 0 to 1, all matching rule evidence and competing roles. Confidence describes evidence strength; it is not a measured probability. Supported roles are input, audio, timing, control, geometry, simulation, materials, rendering, post, typography, output, ui, utilities, documentation, mixed and unknown. Unknown operators remain unknown when there is no evidence; generic families fall back to utilities. Containers aggregate their direct children from deepest to shallowest, yielding mixed when multiple meaningful roles coexist.

## Precedence and custom rules

Precedence is explicit: path override (1000), `role:<role>` or `td-role:<role>` tags (950), custom structural rules (800 plus rule priority), known operator types (700), component contents (500), observed producer/consumer context (450), strongly typed SOP/MAT/POP families (300), regex hints (110 plus rule priority), generic family fallback (100). Conflicting top-ranked roles yield mixed and retain both explanations. Name matching cannot override operator-type evidence. A path override can explicitly select unknown or mixed.

```json
{
  "overrides": {"/project1/custom_solver": "simulation"},
  "pins": ["/project1/important_note"],
  "rulePack": {
    "version": 1,
    "rules": [
      {"id": "team-notes", "role": "documentation", "priority": 20,
       "match": {"families": ["DAT"], "tags": ["team:notes"]}},
      {"id": "weak-audio-name", "role": "audio",
       "match": {"nameRegex": "^audio_"}}
    ]
  },
  "regexTimeoutMs": 500,
  "columnGap": 100,
  "rowGap": 60
}
```

Rules are additive to the built-in pack. Different selector kinds are ANDed; entries within a family/type/tag list are alternatives. Family and operator-type comparisons ignore case; tags and regex matching are case-sensitive. Regex strings use JavaScript syntax without flags. Rules require unique IDs, at least one selector and an integer priority from 0 to 99. A pack contains at most 128 rules and each pattern is limited to 256 characters.

## Regex isolation and graph bounds

User regex is compiled and matched only inside a `worker_threads` module, never the MCP event loop or TouchDesigner process. There is no eval-based worker bootstrap. The default wall-clock budget is 500ms, configurable from 25–2000ms. Timeout or worker failure discards regex evidence and returns a warning; other classification remains available. Invalid patterns are skipped with rule-ID warnings. The worker caps regex rules at 32, node inputs at 50,000 / eight million characters, returned matches at 50,000 and its heap at 64MiB. At most two regex workers run concurrently; excess requests skip regex with a warning rather than queueing unbounded work. Truncation is reported; regex coverage is never implied to be complete after a warning.

The graph is capped at 50,000 nodes and 500,000 edges; resolved dependency expansion has the same edge bound. Node paths, names, tag counts and finite source coordinates are validated. Unresolved edges do not establish topology; incomplete graph/dependency coverage is surfaced as a warning. This classifier cannot discover missing dependencies or certify a proposed structural rewrite.

## Layout behavior

Iterative strongly connected components preserve feedback-group identity, including cross-parent cycles. Coordinates are computed per existing parent: resolved producer-to-consumer dependencies flow left to right, feedback members share a column, and role ordering organizes independent groups. No proposal reparents, collapses, rewires or edits source code. Parameter references place source DATs/materials before consumers. Dimensions reserve space between movable nodes.

Explicit pins, `layout:pin`, annotation/dock flags, annotation operators and protected/owned nodes retain their coordinates. A `source-code` ownership label alone does not pin a DAT. New layout islands start below the lowest pinned node in each parent to avoid collisions without a quadratic obstacle search. Pins can prevent strict left-to-right ordering and can spatially split a feedback group; the group identity remains present in the proposal. These are previews requiring a separate validated coordinate-apply action.

Run `npx vitest run tests/unit/architecture/classifier*.test.ts`. The scale fixtures benchmark 1,000, 10,000 and 50,000 nodes with feedback islands and pinned annotations; timings and coarse heap deltas are printed with `--disableConsoleIntercept`. They measure the Node classifier, not live TouchDesigner frame performance.

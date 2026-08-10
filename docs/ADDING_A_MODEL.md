# Adding a model

## 1. Create the package

```text
models/example/
  package.json
  src/
    index.ts
    plugin.ts
    runner.ts
  tests/
  Dockerfile            optional server-native runner
```

Keep the numerical engine private to the package. Expose only a model plugin and stable result types.

## 2. Declare the manifest

A `ModelManifest` declares:

- identity and version;
- scientific description/category;
- required alignment, tree, or selection inputs;
- typed parameter definitions used to generate the UI;
- browser/server runtimes;
- result artifact kinds and citation.

Do not put analysis-specific controls into the application shell. If a parameter belongs to a method, it belongs in its manifest.

## 3. Validate a workspace

Validation should produce structured issues with a code, severity, message, and responsible artifact. Validate scientific preconditions before allocating model arrays or submitting server work.

Typical checks include alphabet, alignment width, frame, stop-codon policy, taxon/tree agreement, rooting, branch lengths, partitioning, and selection cardinality.

## 4. Supply executors

Implement one or more adapters behind the same job specification:

- browser WebGPU/WASM worker;
- remote jobs API;
- native batch runner/container.

Browser and server builds should derive from the same numerical core whenever possible. Keep execution location out of the model's scientific parameter schema.

## 5. Register it

Add the plugin to the model catalog exported by the web application and to the server registry. The sidebar and generated parameter panel should require no analysis-specific changes. Add a result renderer only when generic result tracks/tables are insufficient.

## 6. Add golden tests

Include small deterministic inputs and outputs from the canonical implementation. Test parsers, validation, numerical parity, runtime fallback, cancellation, serialization, and migration of any versioned result schema.

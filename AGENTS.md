# Repo agent notes

This repository is a sibling of `vscode-kotlin-test-adapter`; both share the
same toolchain (TypeScript + vitest, packaged via `vsce` / `bun`).

When updating the analyzer (`src/coroutineAnalyzer.ts`):

- Keep the public types (`SuspensionPoint`, `SuspendKind`) backwards-compatible
  — they are consumed by `extension.ts` and by the unit tests.
- Always update `test/coroutineAnalyzer.test.ts` for new detection rules.
- Do **not** introduce dependencies on `vscode` from the analyzer; it must
  remain trivially unit-testable in plain Node.

When changing decorations / providers:

- Re-use `getOrComputePoints(doc)` so every provider shares one analysis pass
  per document version.
- Decoration types are recreated on activation only — never per update.

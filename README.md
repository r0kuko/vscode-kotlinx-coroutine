# Kotlinx Coroutines Insight for VS Code

<p align="center">
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.80-007ACC?logo=visualstudiocode&logoColor=white" />
  <img alt="Kotlin" src="https://img.shields.io/badge/Kotlin-2.x-7F52FF?logo=kotlin&logoColor=white" />
  <img alt="Coroutines" src="https://img.shields.io/badge/kotlinx.coroutines-1.9-3DDC84" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

A Visual Studio Code extension that brings JetBrains-style **coroutine insight**
to any Kotlin file: every suspension point is highlighted in the gutter, and
extra navigation / hover affordances make it trivial to reason about *where*
your coroutine actually suspends.

## Features

| | |
|---|---|
| **Gutter icon** at every suspension point | Uses the official JetBrains `suspendCall` glyph (light + dark variants). |
| **Inlay hint** (`suspend` / `await`) at call sites | Eyes-on-keyboard reminder that this call yields the dispatcher. |
| **CodeLens** above every `suspend fun` | Shows the number of suspension points contained inside. |
| **Hover** on builders, suspend calls, `.await()` and Flow terminals | Cheat-sheet documentation for `runBlocking`, `withContext`, `withTimeoutOrNull`, … |
| **Status-bar counter** on Kotlin files | Click to jump to the next suspension point. |
| **Navigation commands** | `Alt+↓` / `Alt+↑` cycle through suspension points; great for code reviews. |
| **Pure regex tokenizer, zero LSP required** | A 2 000-line file is analyzed in well under a millisecond. Updates run debounced on every keystroke. |

### Detected constructs

- `suspend fun foo(...)` declarations
- Coroutine builders: `runBlocking`, `launch`, `async`, `withContext`,
  `coroutineScope`, `supervisorScope`, `withTimeout(OrNull)`, `flow`,
  `channelFlow`, `callbackFlow`, `produce`, `actor`, `runTest`
- Stdlib suspend calls: `delay`, `yield`, `awaitAll`, `awaitCancellation`,
  `join`, `joinAll`, `select`, `suspendCancellableCoroutine`, …
- `.await()` on `Deferred` / `Job`
- Flow terminal operators: `collect`, `collectLatest`, `first(OrNull)`,
  `last(OrNull)`, `single(OrNull)`, `toList`, `toSet`, `count`, `fold`,
  `reduce`, `launchIn`, `stateIn`, `shareIn`
- Calls to other `suspend fun`s declared earlier in the same file

You can extend the dictionary via:

```jsonc
// .vscode/settings.json
{
  "kotlinxCoroutines.extraSuspendFunctions": ["myInternalAwait", "fetchPage"],
  "kotlinxCoroutines.extraCoroutineBuilders": ["myScope.background"]
}
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `kotlinxCoroutines.gutterIcons.enabled`     | `true`  | Show the suspendCall arrow in the gutter. |
| `kotlinxCoroutines.inlayHints.enabled`      | `true`  | Show inline `suspend` / `await` hints. |
| `kotlinxCoroutines.codeLens.enabled`        | `true`  | Show "N suspension points" CodeLens above suspend funs. |
| `kotlinxCoroutines.statusBar.enabled`       | `true`  | Show a status-bar counter on Kotlin files. |
| `kotlinxCoroutines.extraSuspendFunctions`   | `[]`    | Extra bare names to treat as suspend calls. |
| `kotlinxCoroutines.extraCoroutineBuilders`  | `[]`    | Extra bare names to treat as coroutine builders. |

## Sample project

The repository ships with a ready-to-debug Gradle sample under
[`sample/`](sample). Press <kbd>F5</kbd> in this repo to launch a new
Extension Development Host pre-opened on the sample workspace and watch the
suspendCall arrows light up across `Main.kt`, `FlowDemo.kt` and the unit test.

```
sample/
├── settings.gradle.kts        # includes :app and :flowDemo
├── build.gradle.kts
├── app/
│   ├── build.gradle.kts
│   └── src/{main,test}/kotlin/sample/app/
└── flowDemo/
    ├── build.gradle.kts
    └── src/main/kotlin/sample/flowdemo/
```

## Building the extension

```bash
bun install                  # or: npm install
bun run compile              # or: npm run compile
bun run test                 # vitest unit tests
node scripts/generate_icon.js   # (re)generate images/icon.png
```

Then either press <kbd>F5</kbd> or package with `vsce package`.

## How it works

The extension does **not** rely on a Kotlin language server. Instead it ships
a minimal Kotlin tokenizer that:

1. Strips comments and string literals (preserving newlines for accurate line
   numbers).
2. Locates every `suspend fun` and computes the byte range of its body via
   brace matching.
3. Walks identifiers, classifying calls as coroutine builder / suspend call /
   `.await()` / Flow terminal based on a curated dictionary plus the
   user-supplied extension lists.
4. Tracks coroutine-builder lambda bodies as additional "suspend contexts" so
   that hover messages can warn when a suspending call appears outside any
   coroutine.

This pure-text approach makes per-keystroke updates trivially cheap while
covering the 95 % of real-world coroutine code. Pull requests adding more
detectors are very welcome.

## License

MIT.

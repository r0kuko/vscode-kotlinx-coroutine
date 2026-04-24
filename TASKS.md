# Backlog

- [ ] Generate `images/icon.png` (run `node scripts/generate_icon.js` once `npm install` has been done).
- [ ] LSP-aware resolution (use `kotlin-lsp` when available) to detect cross-file suspend calls without the user having to whitelist them.
- [ ] Quick-fix to wrap a "suspend call outside coroutine" warning in `runBlocking { ... }` or `coroutineScope { ... }`.
- [ ] Inline visualization of `Dispatchers.IO` / `Dispatchers.Default` switches.
- [ ] CodeLens "Run with virtual time" on `runTest { ... }` blocks.
- [ ] Tree view of coroutine scopes for the active file.

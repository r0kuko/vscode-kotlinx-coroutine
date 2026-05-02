/**
 * Lightweight, regex-based Kotlin coroutine analyzer.
 *
 * Goal: identify suspension points (calls that suspend the current coroutine)
 * and structural elements (suspend functions, coroutine builders) in a Kotlin
 * source file *without* a full LSP / PSI.
 *
 * The analyzer trades absolute precision for speed and zero-dependency
 * portability — it can analyze a 2000-line file in well under a millisecond,
 * which is what makes "JetBrains-like" decorations feasible on every keystroke.
 *
 * What we detect:
 *  1. `suspend fun foo(...)`               → SuspendFunctionDeclaration
 *  2. Coroutine-builder calls               → CoroutineBuilder
 *     (runBlocking, launch, async, withContext, coroutineScope,
 *      supervisorScope, withTimeout(OrNull), flow, channelFlow,
 *      callbackFlow, produce, actor, runTest, ...)
 *  3. Calls to well-known suspend functions → SuspendCall
 *     (delay, yield, awaitAll, join, joinAll, awaitCancellation, select,
 *      withContext, withTimeout, ...)
 *  4. `.await()` on Deferred / Job          → SuspendCall
 *  5. Flow terminal operators               → SuspendCall
 *     (collect, collectLatest, collectIndexed, launchIn, stateIn, shareIn,
 *      collectAsState)
 *     NOTE: operators like first/last/toList are intentionally excluded because
 *     they exist on plain Collection/Sequence too and cannot be distinguished
 *     from Flow terminals without type information.
 *  6. Calls to suspend functions declared earlier in the same file.
 *
 * What we deliberately skip:
 *  - Calls inside string templates / comments (we strip both first).
 *  - Cross-file resolution. Configurable `extraSuspendFunctions` lets users
 *    extend the dictionary for their own helpers.
 */

/**
 * Tags emitted for every suspension-related code point.
 *
 *  - `suspendFunction`     — top-level `suspend fun foo(...)`.
 *  - `suspendMethod`       — `suspend fun foo(...)` declared inside a
 *                            `class` / `object` / `interface` body.
 *  - `suspendDeclaration`  — fallback when the surrounding context cannot be
 *                            determined (e.g. anonymous object literals).
 *  - `suspendFunctionDecl` — legacy alias kept for backwards-compatibility
 *                            with the very first release; emitted alongside
 *                            the new declaration kinds. New code should match
 *                            on the more specific kind.
 *  - `coroutineBuilder` / `suspendCall` / `awaitCall` / `flowTerminal` —
 *                            call-site classifications, unchanged.
 */
export type SuspendKind =
    | 'suspendFunctionDecl'
    | 'suspendDeclaration'
    | 'suspendFunction'
    | 'suspendMethod'
    | 'coroutineBuilder'
    | 'suspendCall'
    | 'awaitCall'
    | 'flowTerminal';

/** Subset of kinds that flag a `suspend fun` declaration (same gutter icon). */
export const SUSPEND_DECLARATION_KINDS: ReadonlySet<SuspendKind> = new Set<SuspendKind>([
    'suspendFunctionDecl',
    'suspendDeclaration',
    'suspendFunction',
    'suspendMethod',
]);

/** True for any kind that should render the suspendCall gutter icon. */
export function isSuspensionMarker(kind: SuspendKind): boolean {
    return (
        kind === 'coroutineBuilder' ||
        kind === 'suspendCall' ||
        kind === 'awaitCall' ||
        kind === 'flowTerminal' ||
        SUSPEND_DECLARATION_KINDS.has(kind)
    );
}

export interface AnalysisRange {
    /** 0-based line. */
    line: number;
    /** 0-based character offset of the first character of the match. */
    startChar: number;
    /** 0-based character offset just past the last character of the match. */
    endChar: number;
}

export interface SuspensionPoint extends AnalysisRange {
    kind: SuspendKind;
    /** The matched identifier (e.g. `delay`, `await`, `runBlocking`). */
    name: string;
    /** Human-readable description used for hovers / inlay hints. */
    description: string;
    /** True when the point sits inside a `suspend` function body or builder. */
    insideSuspendContext: boolean;
}

export interface AnalyzerOptions {
    extraSuspendFunctions?: readonly string[];
    extraCoroutineBuilders?: readonly string[];
}

/** Built-in coroutine builders from kotlinx.coroutines. */
export const BUILTIN_BUILDERS: ReadonlySet<string> = new Set([
    'runBlocking',
    'launch',
    'async',
    'withContext',
    'coroutineScope',
    'supervisorScope',
    'withTimeout',
    'withTimeoutOrNull',
    'flow',
    'channelFlow',
    'callbackFlow',
    'produce',
    'actor',
    'runTest',
    'runComposeUiTest',
]);

/** Built-in suspend functions from kotlinx.coroutines stdlib. */
export const BUILTIN_SUSPEND_CALLS: ReadonlySet<string> = new Set([
    'delay',
    'yield',
    'awaitAll',
    'awaitCancellation',
    'join',
    'joinAll',
    'select',
    'selectUnbiased',
    'withContext',
    'withTimeout',
    'withTimeoutOrNull',
    'coroutineScope',
    'supervisorScope',
    'currentCoroutineContext',
    'suspendCancellableCoroutine',
    'suspendCoroutine',
]);

/**
 * Flow terminal operators that suspend and are *unambiguously* Flow-specific.
 * Operators like `first`, `last`, `toList`, `count` etc. are intentionally
 * omitted: they also exist on `Collection` / `Sequence` / `Iterable` and
 * cannot be distinguished from Flow terminals by regex alone, leading to
 * false positives on plain list/collection access.
 */
export const FLOW_TERMINALS: ReadonlySet<string> = new Set([
    // collect family — the lambda overload is Flow-only in practice
    'collect',
    'collectLatest',
    'collectIndexed',
    // Flow lifecycle / sharing operators
    'launchIn',
    'stateIn',
    'shareIn',
    // Compose integration
    'collectAsState',
]);

/**
 * Strip Kotlin line comments, block comments and string contents (keeping
 * quotes) so that subsequent regex scans don't match identifiers inside them.
 * Line/character positions are preserved by replacing stripped content with
 * spaces or newlines.
 */
export function stripCommentsAndStrings(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        // Line comment
        if (c === '/' && c2 === '/') {
            while (i < n && src[i] !== '\n') {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }
        // Block comment (handle nested /* */ which Kotlin allows)
        if (c === '/' && c2 === '*') {
            let depth = 1;
            out += '  ';
            i += 2;
            while (i < n && depth > 0) {
                if (src[i] === '/' && src[i + 1] === '*') {
                    depth++;
                    out += '  ';
                    i += 2;
                } else if (src[i] === '*' && src[i + 1] === '/') {
                    depth--;
                    out += '  ';
                    i += 2;
                } else {
                    out += src[i] === '\n' ? '\n' : ' ';
                    i++;
                }
            }
            continue;
        }
        // Triple-quoted raw string """ ... """
        if (c === '"' && c2 === '"' && src[i + 2] === '"') {
            out += '"""';
            i += 3;
            while (i < n) {
                if (src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
                    out += '"""';
                    i += 3;
                    break;
                }
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }
        // Regular string literal
        if (c === '"') {
            out += '"';
            i++;
            while (i < n && src[i] !== '"' && src[i] !== '\n') {
                if (src[i] === '\\' && i + 1 < n) {
                    out += '  ';
                    i += 2;
                } else {
                    out += ' ';
                    i++;
                }
            }
            if (i < n && src[i] === '"') {
                out += '"';
                i++;
            }
            continue;
        }
        // Char literal
        if (c === "'") {
            out += "'";
            i++;
            while (i < n && src[i] !== "'" && src[i] !== '\n') {
                if (src[i] === '\\' && i + 1 < n) {
                    out += '  ';
                    i += 2;
                } else {
                    out += ' ';
                    i++;
                }
            }
            if (i < n && src[i] === "'") {
                out += "'";
                i++;
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

interface SuspendFunctionRange {
    name: string;
    /** Line (0-based) of the `fun` keyword. */
    line: number;
    /** Offset of the body's opening brace `{`. -1 for expression body / abstract. */
    bodyStart: number;
    /** Offset just past the matching closing brace. -1 if not found. */
    bodyEnd: number;
    /**
     * Lexical context of the declaration:
     *  - `topLevel`: declared outside any class/object/interface body.
     *  - `member`:   declared inside a `class`/`object`/`interface` body.
     *  - `unknown`:  surrounding context could not be determined cheaply.
     */
    context: 'topLevel' | 'member' | 'unknown';
}

/**
 * Find every `suspend fun` declaration. Returns the function name range and
 * the byte offsets of its body (matched braces). Used both to surface
 * declaration decorations and to determine whether a call site is inside a
 * suspend context.
 */
export function findSuspendFunctions(stripped: string, raw: string): SuspendFunctionRange[] {
    const out: SuspendFunctionRange[] = [];
    // `suspend` may be preceded by other modifiers (private, override, inline,
    // operator, infix, ...). Match the keyword + `fun` + name.
    const re = /\bsuspend\b[^\n;{}]*?\bfun\b\s+(?:<[^>]*>\s+)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
        const name = m[1];
        const declLine = lineOf(stripped, m.index);
        // Find the body opener `{` or `=` (expression body) on the same line span.
        let i = m.index + m[0].length;
        let bodyStart = -1;
        let bodyEnd = -1;
        let parens = 0;
        while (i < stripped.length) {
            const ch = stripped[i];
            if (ch === '(') parens++;
            else if (ch === ')') parens--;
            else if (parens === 0 && ch === '{') {
                bodyStart = i;
                bodyEnd = matchBrace(raw, i);
                break;
            } else if (parens === 0 && ch === '=') {
                // Expression body — extend to next top-level newline at brace depth 0.
                bodyStart = i;
                let j = i + 1;
                let depth = 0;
                while (j < raw.length) {
                    const cj = raw[j];
                    if (cj === '{' || cj === '(' || cj === '[') depth++;
                    else if (cj === '}' || cj === ')' || cj === ']') depth--;
                    else if (cj === '\n' && depth <= 0) break;
                    j++;
                }
                bodyEnd = j;
                break;
            } else if (parens === 0 && (ch === ';' || ch === '\n')) {
                // Could be abstract / interface decl with no body — stop scanning.
                if (ch === ';') break;
                // Allow newlines inside parameter list; keep going for one more line
                // only if we haven't seen `(` yet.
            }
            i++;
        }
        out.push({
            name,
            line: declLine,
            bodyStart,
            bodyEnd,
            context: classifyDeclarationContext(stripped, m.index),
        });
    }
    return out;
}

/**
 * Classify the lexical context of a declaration that starts at `declOffset`
 * by scanning braces backwards. Robust enough for normal Kotlin layouts; if
 * the file is malformed we degrade to `'unknown'`.
 */
function classifyDeclarationContext(
    stripped: string,
    declOffset: number,
): 'topLevel' | 'member' | 'unknown' {
    let depth = 0;
    for (let i = declOffset - 1; i >= 0; i--) {
        const c = stripped[i];
        if (c === '}') {
            depth++;
        } else if (c === '{') {
            if (depth === 0) {
                // We sit directly inside this brace — find the keyword that
                // introduced it to tell `class` / `object` / `interface` from
                // a function body, lambda, when expression, …
                const head = stripped.slice(Math.max(0, i - 400), i);
                // Anonymous object literal: `object : SomeType { ... }`.
                // IntelliJ surfaces these with the generic `suspendDeclaration`
                // glyph because the override does not belong to a *named*
                // class/object/interface.
                if (/\bobject\s*:[^{}]*$/.test(head)) {
                    return 'unknown';
                }
                if (/\bcompanion\s+object\b[^{}]*$/.test(head)) {
                    return 'member';
                }
                if (
                    /\b(class|object|interface|enum\s+class)\b[^{}]*$/.test(head)
                ) {
                    return 'member';
                }
                // Inside any other brace block: it's a local function.
                return 'topLevel';
            }
            depth--;
        }
    }
    return depth === 0 ? 'topLevel' : 'unknown';
}

/** Return the offset just past the `}` that matches the `{` at `openIdx`. */
function matchBrace(src: string, openIdx: number): number {
    let depth = 0;
    let i = openIdx;
    let inString: '"' | '"""' | "'" | null = null;
    while (i < src.length) {
        const c = src[i];
        if (inString === '"""') {
            if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
                inString = null;
                i += 3;
                continue;
            }
            i++;
            continue;
        }
        if (inString === '"') {
            if (c === '\\') { i += 2; continue; }
            if (c === '"') { inString = null; i++; continue; }
            i++;
            continue;
        }
        if (inString === "'") {
            if (c === '\\') { i += 2; continue; }
            if (c === "'") { inString = null; i++; continue; }
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') { inString = '"""'; i += 3; continue; }
        if (c === '"') { inString = '"'; i++; continue; }
        if (c === "'") { inString = "'"; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
        i++;
    }
    return -1;
}

function lineOf(src: string, offset: number): number {
    let line = 0;
    for (let i = 0; i < offset && i < src.length; i++) {
        if (src[i] === '\n') line++;
    }
    return line;
}

function charOf(src: string, offset: number): number {
    let i = offset;
    while (i > 0 && src[i - 1] !== '\n') i--;
    return offset - i;
}

/** Main entry point. */
export function analyze(source: string, options: AnalyzerOptions = {}): SuspensionPoint[] {
    const stripped = stripCommentsAndStrings(source);
    const suspendFns = findSuspendFunctions(stripped, source);
    const builders = new Set(BUILTIN_BUILDERS);
    for (const b of options.extraCoroutineBuilders ?? []) builders.add(b);
    const suspendCalls = new Set(BUILTIN_SUSPEND_CALLS);
    for (const s of options.extraSuspendFunctions ?? []) suspendCalls.add(s);
    const localSuspendNames = new Set(suspendFns.map(f => f.name));

    /**
     * Suspend contexts are byte-ranges in `source` where calls to suspend
     * functions are syntactically allowed: the body of any `suspend fun`, plus
     * the lambda body of any coroutine builder call.
     */
    const suspendContexts: Array<[number, number]> = [];
    for (const f of suspendFns) {
        if (f.bodyStart >= 0 && f.bodyEnd > f.bodyStart) {
            suspendContexts.push([f.bodyStart, f.bodyEnd]);
        }
    }

    const points: SuspensionPoint[] = [];

    // ── Pass 1: coroutine builder calls. We intentionally walk identifiers so
    //   that `myScope.launch { ... }` is matched but `Job.launch` (member ref)
    //   without a following `(` or `{` is not.
    const idRe = /\b([A-Za-z_][\w]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(stripped)) !== null) {
        const name = m[1];
        const start = m.index;
        const end = start + name.length;
        // Skip identifiers in declaration position: `fun NAME(`, `class NAME`,
        // `val NAME`, `var NAME`, `object NAME`, `interface NAME`, `package`,
        // `import`.
        if (isDeclarationPosition(stripped, start)) continue;
        // Determine if it's a call: next non-space char must be `(` or `{` or
        // (for member dispatch) the identifier may be after a `.`.
        const nextChar = peekNonSpace(stripped, end);
        const isCallLike = nextChar === '(' || nextChar === '{';
        if (!isCallLike) continue;

        const insideSuspend = inAnyRange(suspendContexts, start);
        const line = lineOf(stripped, start);
        const startChar = charOf(stripped, start);
        const endChar = startChar + name.length;

        if (builders.has(name)) {
            points.push({
                kind: 'coroutineBuilder',
                name,
                description: builderDescription(name),
                line,
                startChar,
                endChar,
                insideSuspendContext: insideSuspend,
            });
            // Builder lambdas are also suspend contexts. Record the lambda body.
            const lambdaStart = findLambdaBraceAfterCall(stripped, end);
            if (lambdaStart >= 0) {
                const lambdaEnd = matchBrace(source, lambdaStart);
                if (lambdaEnd > lambdaStart) {
                    suspendContexts.push([lambdaStart, lambdaEnd]);
                }
            }
            continue;
        }
        if (suspendCalls.has(name) || localSuspendNames.has(name)) {
            points.push({
                kind: 'suspendCall',
                name,
                description: suspendCallDescription(name),
                line,
                startChar,
                endChar,
                insideSuspendContext: insideSuspend,
            });
            continue;
        }
        if (FLOW_TERMINALS.has(name) && stripped[start - 1] === '.') {
            points.push({
                kind: 'flowTerminal',
                name,
                description: `Flow terminal operator '${name}' — suspends until the upstream completes`,
                line,
                startChar,
                endChar,
                insideSuspendContext: insideSuspend,
            });
            continue;
        }
        if (name === 'await' && stripped[start - 1] === '.') {
            points.push({
                kind: 'awaitCall',
                name,
                description: 'Awaits a Deferred result — suspends until completion',
                line,
                startChar,
                endChar,
                insideSuspendContext: insideSuspend,
            });
            continue;
        }
    }

    // ── Pass 2: suspend function declarations themselves (so users can see at a
    //   glance which functions suspend). We emit *two* points per declaration:
    //   the legacy `suspendFunctionDecl` (kept for backwards-compatibility) and
    //   a context-specific `suspendFunction` / `suspendMethod` /
    //   `suspendDeclaration` kind. The dedup pass collapses anything that ends
    //   up with identical coordinates and kind.
    for (const f of suspendFns) {
        const lineStartOffset = nthLineStart(stripped, f.line);
        const inLine = stripped.slice(lineStartOffset, lineStartOffset + 400);
        const idx = inLine.search(new RegExp(`\\bfun\\s+(?:<[^>]*>\\s+)?(?:[A-Za-z_][\\w.]*\\.)?${escapeRe(f.name)}\\b`));
        if (idx < 0) continue;
        const nameInLine = inLine.indexOf(f.name, idx);
        if (nameInLine < 0) continue;
        const specific: SuspendKind =
            f.context === 'member'
                ? 'suspendMethod'
                : f.context === 'topLevel'
                    ? 'suspendFunction'
                    : 'suspendDeclaration';
        const sharedDescription = declarationDescription(f.name, specific);
        for (const kind of [specific, 'suspendFunctionDecl' as SuspendKind]) {
            points.push({
                kind,
                name: f.name,
                description: sharedDescription,
                line: f.line,
                startChar: nameInLine,
                endChar: nameInLine + f.name.length,
                insideSuspendContext: true,
            });
        }
    }

    // Dedup + stable sort.
    points.sort((a, b) => a.line - b.line || a.startChar - b.startChar);
    return dedup(points);
}

function dedup(points: SuspensionPoint[]): SuspensionPoint[] {
    const out: SuspensionPoint[] = [];
    let prev: SuspensionPoint | undefined;
    for (const p of points) {
        if (
            prev &&
            prev.line === p.line &&
            prev.startChar === p.startChar &&
            prev.endChar === p.endChar &&
            prev.kind === p.kind
        ) {
            continue;
        }
        out.push(p);
        prev = p;
    }
    return out;
}

function nthLineStart(src: string, line: number): number {
    if (line === 0) return 0;
    let seen = 0;
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '\n') {
            seen++;
            if (seen === line) return i + 1;
        }
    }
    return src.length;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inAnyRange(ranges: Array<[number, number]>, offset: number): boolean {
    for (const [a, b] of ranges) {
        if (offset >= a && offset < b) return true;
    }
    return false;
}

function peekNonSpace(src: string, from: number): string | null {
    let i = from;
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n')) i++;
    return i < src.length ? src[i] : null;
}

/**
 * Returns the offset of the `{` that starts the trailing-lambda of a call
 * whose name ends at `afterName` (e.g. `launch { ... }` or `launch(ctx) { ... }`).
 * Returns -1 if no trailing lambda is found.
 */
function findLambdaBraceAfterCall(src: string, afterName: number): number {
    let i = afterName;
    // Skip whitespace.
    while (i < src.length && /\s/.test(src[i])) i++;
    // Optional argument list `( ... )`.
    if (src[i] === '(') {
        let depth = 1;
        i++;
        while (i < src.length && depth > 0) {
            const c = src[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            i++;
        }
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    return src[i] === '{' ? i : -1;
}

/**
 * True if the identifier starting at `start` is in declaration position
 * (immediately preceded by `fun`, `class`, `object`, `interface`, `val`,
 * `var`, `package`, `import`, `typealias`, `enum class`, ...).
 */
function isDeclarationPosition(src: string, start: number): boolean {
    let i = start - 1;
    while (i >= 0 && (src[i] === ' ' || src[i] === '\t')) i--;
    if (i < 0) return false;
    // Walk back over a previous identifier.
    let endId = i + 1;
    while (i >= 0 && /[\w]/.test(src[i])) i--;
    const prev = src.slice(i + 1, endId);
    return (
        prev === 'fun' ||
        prev === 'class' ||
        prev === 'object' ||
        prev === 'interface' ||
        prev === 'val' ||
        prev === 'var' ||
        prev === 'package' ||
        prev === 'import' ||
        prev === 'typealias' ||
        prev === 'enum'
    );
}

function declarationDescription(name: string, kind: SuspendKind): string {
    switch (kind) {
        case 'suspendMethod':
            return `suspend fun ${name} — suspending member; callers must already be in a coroutine.`;
        case 'suspendFunction':
            return `suspend fun ${name} — top-level suspending function; callers must be in a coroutine context.`;
        default:
            return `suspend fun ${name} — may suspend the calling coroutine.`;
    }
}

function builderDescription(name: string): string {
    switch (name) {
        case 'runBlocking':
            return 'runBlocking { ... } — blocks the current thread until the coroutine completes. Avoid in production code.';
        case 'launch':
            return 'launch { ... } — starts a new coroutine without returning a result (returns Job).';
        case 'async':
            return 'async { ... } — starts a new coroutine returning a Deferred<T>. Pair with .await().';
        case 'withContext':
            return 'withContext(ctx) { ... } — switches the coroutine context (e.g. Dispatchers.IO). Suspends.';
        case 'coroutineScope':
            return 'coroutineScope { ... } — structured concurrency scope; fails fast if any child fails.';
        case 'supervisorScope':
            return 'supervisorScope { ... } — like coroutineScope, but child failures do not cancel siblings.';
        case 'withTimeout':
            return 'withTimeout(ms) { ... } — throws TimeoutCancellationException on timeout.';
        case 'withTimeoutOrNull':
            return 'withTimeoutOrNull(ms) { ... } — returns null on timeout instead of throwing.';
        case 'flow':
            return 'flow { emit(...) } — cold Flow builder. Body runs each time the flow is collected.';
        case 'channelFlow':
            return 'channelFlow { send(...) } — concurrent Flow builder backed by a Channel.';
        case 'callbackFlow':
            return 'callbackFlow { ... awaitClose { ... } } — bridges callback-based APIs into Flow.';
        case 'produce':
            return 'produce { send(...) } — coroutine that produces a stream of values into a ReceiveChannel.';
        case 'actor':
            return 'actor { for (msg in channel) ... } — coroutine that consumes messages from a Channel.';
        case 'runTest':
            return 'runTest { ... } — runs a coroutine test with virtual time (kotlinx-coroutines-test).';
        default:
            return `Coroutine builder '${name}'`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// withContext block tracker
// ─────────────────────────────────────────────────────────────────────────────

/** A `withContext(Dispatchers.X) { … }` block with its opening/closing brace positions. */
export interface WithContextBlock {
    /** The dispatcher label to display, e.g. `"IO"`, `"Default"`, `"Main"`. */
    dispatcherName: string;
    /** 0-based line of the opening `{`. */
    openLine: number;
    /** 0-based character offset of the opening `{`. */
    openChar: number;
    /** 0-based line of the matching closing `}`. */
    closeLine: number;
    /** 0-based character offset of the closing `}`. */
    closeChar: number;
}

/**
 * Find all `withContext(Dispatchers.X) { … }` blocks in `source` and return
 * the position of each opening and matching closing brace.
 *
 * Brace matching is done on the stripped source to ignore `{` / `}` inside
 * string literals and comments.
 */
export function findWithContextBlocks(source: string): WithContextBlock[] {
    const stripped = stripCommentsAndStrings(source);
    const blocks: WithContextBlock[] = [];

    // Matches: withContext(Dispatchers.IO) {
    //          withContext(Dispatchers.Main.immediate) {  (dot-separated)
    const HEADER_RE =
        /\bwithContext\s*\(\s*Dispatchers\s*\.\s*(\w+(?:\.\w+)?)\s*\)\s*\{/g;

    /** Convert a flat character offset in `stripped` to { line, char }. */
    function offsetToPos(offset: number): { line: number; char: number } {
        let line = 0;
        let lineStart = 0;
        for (let i = 0; i < offset; i++) {
            if (stripped[i] === '\n') { line++; lineStart = i + 1; }
        }
        return { line, char: offset - lineStart };
    }

    for (const m of stripped.matchAll(HEADER_RE)) {
        const braceOffset = m.index! + m[0].length - 1; // offset of opening '{'
        const open = offsetToPos(braceOffset);

        // Walk forward to find the matching closing brace.
        let depth = 1;
        let i = braceOffset + 1;
        while (i < stripped.length && depth > 0) {
            if (stripped[i] === '{') depth++;
            else if (stripped[i] === '}') depth--;
            i++;
        }
        const closeOffset = i - 1; // offset of closing '}'
        const close = offsetToPos(closeOffset);

        blocks.push({
            dispatcherName: m[1],
            openLine: open.line,
            openChar: open.char,
            closeLine: close.line,
            closeChar: close.char,
        });
    }

    return blocks;
}

function suspendCallDescription(name: string): string {
    switch (name) {
        case 'delay':
            return 'delay(ms) — non-blocking sleep; cancellable suspension point.';
        case 'yield':
            return 'yield() — yields control of the dispatcher to other coroutines.';
        case 'awaitAll':
            return 'awaitAll(...) — suspends until all Deferreds complete; cancels remaining on failure.';
        case 'awaitCancellation':
            return 'awaitCancellation() — suspends until the current coroutine is cancelled.';
        case 'join':
            return 'job.join() — suspends until the Job completes (success, failure, or cancellation).';
        case 'joinAll':
            return 'joinAll(...) — suspends until every Job completes.';
        case 'select':
            return 'select { ... } — suspends on multiple alternatives; resumes on the first ready one.';
        case 'withContext':
            return 'withContext(ctx) — switches dispatcher / context for a block. Suspends across the boundary.';
        case 'currentCoroutineContext':
            return 'currentCoroutineContext() — returns the calling coroutine\'s context.';
        case 'suspendCancellableCoroutine':
            return 'suspendCancellableCoroutine { cont -> ... } — bridges callback APIs into a cancellable suspend.';
        case 'suspendCoroutine':
            return 'suspendCoroutine { cont -> ... } — bridges callback APIs (no cancellation support).';
        default:
            return `Suspending call to '${name}'.`;
    }
}

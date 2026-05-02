/**
 * Detect common Kotlin coroutine anti-patterns that are likely to cause real
 * bugs (deadlocks, leaks, blocking the thread).
 *
 * This module has zero dependencies on `vscode` and can be unit-tested in
 * plain Node / vitest.
 */

import { type SuspensionPoint, stripCommentsAndStrings } from './coroutineAnalyzer';

export type ProblemSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface CoroutineProblem {
    line: number;
    startChar: number;
    endChar: number;
    message: string;
    severity: ProblemSeverity;
    /** Short machine-readable identifier, e.g. `'COR001'`. */
    code: string;
}

/**
 * Scan `source` for coroutine anti-patterns and return the list of problems.
 *
 * @param source  Raw Kotlin source text.
 * @param points  Suspension points already produced by `analyze()` for this
 *                file. Avoids re-running the full analysis pass.
 */
export function detectAntiPatterns(
    source: string,
    points: SuspensionPoint[],
): CoroutineProblem[] {
    const stripped = stripCommentsAndStrings(source);
    const lines = stripped.split('\n');
    const problems: CoroutineProblem[] = [];

    // ── COR001: runBlocking inside a suspend context ───────────────────────────
    // `runBlocking` inside a `suspend fun` or coroutine builder body blocks the
    // OS thread.  On a single-threaded dispatcher (e.g. `Dispatchers.Main`) this
    // causes an immediate deadlock.  Use `coroutineScope { }` instead.
    for (const p of points) {
        if (p.name === 'runBlocking' && p.insideSuspendContext) {
            problems.push({
                line: p.line,
                startChar: p.startChar,
                endChar: p.endChar,
                message:
                    '`runBlocking` inside a `suspend` function blocks the OS thread and will deadlock ' +
                    'on single-threaded dispatchers (e.g. `Dispatchers.Main`). ' +
                    'Use `coroutineScope { }` to stay within structured concurrency.',
                severity: 'warning',
                code: 'COR001',
            });
        }
    }

    // ── COR002: GlobalScope.launch / GlobalScope.async ─────────────────────────
    // `GlobalScope` creates coroutines that are not bound to any lifecycle.
    // They live until the process exits and cannot be cancelled together, making
    // coroutine leaks almost inevitable.
    const GLOBAL_SCOPE_RE = /\bGlobalScope\s*\.\s*(launch|async)\b/g;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        for (const m of lines[lineIdx].matchAll(GLOBAL_SCOPE_RE)) {
            problems.push({
                line: lineIdx,
                startChar: m.index!,
                endChar: m.index! + m[0].length,
                message:
                    `\`GlobalScope.${m[1]}\` is non-structured concurrency — the coroutine is not ` +
                    'bound to any lifecycle and will not be cancelled automatically. ' +
                    'Use a structured scope (`viewModelScope`, `lifecycleScope`, `coroutineScope { }`) instead.',
                severity: 'warning',
                code: 'COR002',
            });
        }
    }

    // ── COR003: Thread.sleep() inside Kotlin code ──────────────────────────────
    // `Thread.sleep` blocks the OS thread; other coroutines scheduled on the
    // same thread cannot run.  Inside a coroutine, use `delay()` which merely
    // suspends the coroutine.
    const THREAD_SLEEP_RE = /\bThread\s*\.\s*sleep\s*\(/g;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        for (const m of lines[lineIdx].matchAll(THREAD_SLEEP_RE)) {
            // Exclude the trailing `(` from the highlighted range.
            problems.push({
                line: lineIdx,
                startChar: m.index!,
                endChar: m.index! + m[0].length - 1,
                message:
                    '`Thread.sleep()` blocks the OS thread. ' +
                    'Inside a coroutine, use `delay()` — it suspends without blocking the thread ' +
                    'and is cancellable.',
                severity: 'information',
                code: 'COR003',
            });
        }
    }

    // ── COR004: async { ... }.await() ──────────────────────────────────────────
    // `async { body }.await()` is semantically equivalent to
    // `withContext(coroutineContext) { body }` but allocates an extra child
    // `Job` and requires two suspension points instead of one.
    // Only single-line occurrences are detected (multi-line would require a
    // full brace-matching pass).
    const ASYNC_AWAIT_RE = /\basync\s*\{([^{}]*)\}\s*\.await\(\)/g;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        for (const m of lines[lineIdx].matchAll(ASYNC_AWAIT_RE)) {
            problems.push({
                line: lineIdx,
                startChar: m.index!,
                endChar: m.index! + m[0].length,
                message:
                    '`async { … }.await()` unnecessarily allocates a child `Job`. ' +
                    'Replace with `withContext(coroutineContext) { … }` for the same semantics ' +
                    'with less overhead.',
                severity: 'warning',
                code: 'COR004',
            });
        }
    }

    return problems;
}

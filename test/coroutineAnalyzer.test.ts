import { describe, it, expect } from 'vitest';
import {
    analyze,
    stripCommentsAndStrings,
    findSuspendFunctions,
    BUILTIN_BUILDERS,
    BUILTIN_SUSPEND_CALLS,
} from '../src/coroutineAnalyzer';

const SAMPLE = `
package demo

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

suspend fun fetchUser(id: Int): String {
    delay(100) // network call
    return "user-$id"
}

fun main() = runBlocking {
    val a = async { fetchUser(1) }
    val b = async { fetchUser(2) }
    println(a.await() + b.await())

    launch(Dispatchers.IO) {
        withContext(Dispatchers.Default) {
            yield()
        }
    }

    val nums = flow {
        emit(1)
        emit(2)
    }
    nums.collect { println(it) }

    // delay should NOT be matched in comments
    val s = "delay should NOT be matched in strings"
}
`;

describe('stripCommentsAndStrings', () => {
    it('blanks out line comments while preserving newlines', () => {
        const out = stripCommentsAndStrings('val x = 1 // hello\nval y = 2');
        expect(out).toContain('\n');
        expect(out).not.toContain('hello');
        expect(out.split('\n').length).toBe(2);
    });

    it('blanks out block comments and string contents', () => {
        const src = 'fun a() { /* delay */ val s = "delay" }';
        const out = stripCommentsAndStrings(src);
        expect(out).not.toContain('delay');
        expect(out.length).toBe(src.length);
    });

    it('handles triple-quoted strings', () => {
        const src = 'val s = """delay yield""" + "x"';
        const out = stripCommentsAndStrings(src);
        expect(out).not.toContain('delay');
        expect(out).not.toContain('yield');
    });
});

describe('findSuspendFunctions', () => {
    it('locates suspend fun declarations', () => {
        const stripped = stripCommentsAndStrings(SAMPLE);
        const fns = findSuspendFunctions(stripped, SAMPLE);
        expect(fns.map(f => f.name)).toContain('fetchUser');
    });

    it('matches even with extra modifiers', () => {
        const src = 'private inline suspend fun foo() { }';
        const stripped = stripCommentsAndStrings(src);
        const fns = findSuspendFunctions(stripped, src);
        expect(fns.map(f => f.name)).toEqual(['foo']);
    });
});

describe('analyze', () => {
    const points = analyze(SAMPLE);
    const byName = (n: string) => points.filter(p => p.name === n);

    it('flags coroutine builders', () => {
        expect(byName('runBlocking').some(p => p.kind === 'coroutineBuilder')).toBe(true);
        expect(byName('launch').some(p => p.kind === 'coroutineBuilder')).toBe(true);
        expect(byName('async').length).toBeGreaterThanOrEqual(2);
        expect(byName('flow').some(p => p.kind === 'coroutineBuilder')).toBe(true);
    });

    it('flags suspend stdlib calls', () => {
        expect(byName('delay').some(p => p.kind === 'suspendCall')).toBe(true);
        expect(byName('yield').some(p => p.kind === 'suspendCall')).toBe(true);
        expect(byName('withContext').some(p => p.kind === 'coroutineBuilder' || p.kind === 'suspendCall')).toBe(true);
    });

    it('flags .await() calls', () => {
        const awaits = byName('await').filter(p => p.kind === 'awaitCall');
        expect(awaits.length).toBe(2);
    });

    it('flags Flow terminal operators after a dot', () => {
        expect(byName('collect').some(p => p.kind === 'flowTerminal')).toBe(true);
    });

    it('flags suspend function declarations (legacy + specific kinds)', () => {
        expect(byName('fetchUser').some(p => p.kind === 'suspendFunctionDecl')).toBe(true);
        // Top-level suspend fun → suspendFunction.
        expect(byName('fetchUser').some(p => p.kind === 'suspendFunction')).toBe(true);
        expect(byName('fetchUser').some(p => p.kind === 'suspendMethod')).toBe(false);
    });

    it('classifies suspend members as suspendMethod', () => {
        const src = `
            class Repo {
                suspend fun load(): Int { return 42 }
            }
            object Cache {
                suspend fun put(k: String, v: Int) { /* */ }
            }
            interface Api {
                suspend fun call(): String
            }
            suspend fun freeFn() { }
        `;
        const out = analyze(src);
        const named = (n: string) => out.filter(p => p.name === n);
        expect(named('load').some(p => p.kind === 'suspendMethod')).toBe(true);
        expect(named('put').some(p => p.kind === 'suspendMethod')).toBe(true);
        expect(named('call').some(p => p.kind === 'suspendMethod')).toBe(true);
        expect(named('freeFn').some(p => p.kind === 'suspendFunction')).toBe(true);
        // Legacy alias still emitted for every declaration.
        for (const n of ['load', 'put', 'call', 'freeFn']) {
            expect(named(n).some(p => p.kind === 'suspendFunctionDecl')).toBe(true);
        }
    });

    it('classifies overrides in anonymous-object literals as suspendDeclaration', () => {
        const src = `
            interface Api { suspend fun call(): String }
            fun make(): Api = object : Api {
                override suspend fun overridden(): String { return "x" }
            }
        `;
        const out = analyze(src);
        const overrides = out.filter(p => p.name === 'overridden');
        expect(overrides.some(p => p.kind === 'suspendDeclaration')).toBe(true);
        expect(overrides.some(p => p.kind === 'suspendMethod')).toBe(false);
        expect(overrides.some(p => p.kind === 'suspendFunctionDecl')).toBe(true);
    });

    it('treats calls to local suspend functions as suspendCall', () => {
        expect(byName('fetchUser').some(p => p.kind === 'suspendCall')).toBe(true);
    });

    it('does not match identifiers inside strings or comments', () => {
        expect(byName('delay').length).toBe(1); // only the real delay() call
    });

    it('marks call sites as inside a suspend context', () => {
        const delayPt = byName('delay').find(p => p.kind === 'suspendCall');
        expect(delayPt?.insideSuspendContext).toBe(true);
        const collectPt = byName('collect').find(p => p.kind === 'flowTerminal');
        expect(collectPt?.insideSuspendContext).toBe(true);
    });

    it('produces points sorted by line then column', () => {
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1];
            const b = points[i];
            const ord = a.line - b.line || a.startChar - b.startChar;
            expect(ord).toBeLessThanOrEqual(0);
        }
    });

    it('honours extraSuspendFunctions option', () => {
        const src = `fun outer() { ourCustomSuspend() }`;
        const enriched = analyze(src, { extraSuspendFunctions: ['ourCustomSuspend'] });
        expect(enriched.find(p => p.name === 'ourCustomSuspend')).toBeTruthy();
        const baseline = analyze(src);
        expect(baseline.find(p => p.name === 'ourCustomSuspend')).toBeFalsy();
    });

    it('does not match identifiers in declaration position', () => {
        const src = 'class launch { fun async() = Unit }';
        const out = analyze(src);
        expect(out.find(p => p.name === 'launch' && p.kind === 'coroutineBuilder')).toBeFalsy();
        expect(out.find(p => p.name === 'async')).toBeFalsy();
    });
});

describe('builtin sets', () => {
    it('contains the canonical builders', () => {
        for (const n of ['runBlocking', 'launch', 'async', 'withContext', 'flow']) {
            expect(BUILTIN_BUILDERS.has(n)).toBe(true);
        }
    });
    it('contains the canonical suspend calls', () => {
        for (const n of ['delay', 'yield', 'awaitAll']) {
            expect(BUILTIN_SUSPEND_CALLS.has(n)).toBe(true);
        }
    });
});

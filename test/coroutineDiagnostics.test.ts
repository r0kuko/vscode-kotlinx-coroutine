import { describe, it, expect } from 'vitest';
import { detectAntiPatterns } from '../src/coroutineDiagnostics';
import { findWithContextBlocks } from '../src/coroutineAnalyzer';
import { analyze } from '../src/coroutineAnalyzer';

// ─────────────────────────────────────────────────────────────────────────────
// detectAntiPatterns
// ─────────────────────────────────────────────────────────────────────────────

describe('detectAntiPatterns', () => {
    it('COR001: flags runBlocking inside a suspend function', () => {
        const src = `
suspend fun bad() {
    runBlocking {
        delay(100)
    }
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        const cor001 = problems.filter(p => p.code === 'COR001');
        expect(cor001).toHaveLength(1);
        expect(cor001[0].severity).toBe('warning');
        expect(cor001[0].message).toContain('coroutineScope');
    });

    it('COR001: does NOT flag runBlocking at top-level (outside suspend)', () => {
        const src = `
fun main() = runBlocking {
    delay(100)
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        expect(problems.filter(p => p.code === 'COR001')).toHaveLength(0);
    });

    it('COR002: flags GlobalScope.launch', () => {
        const src = `
fun bad() {
    GlobalScope.launch { delay(100) }
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        const cor002 = problems.filter(p => p.code === 'COR002');
        expect(cor002).toHaveLength(1);
        expect(cor002[0].message).toContain('GlobalScope.launch');
    });

    it('COR002: flags GlobalScope.async', () => {
        const src = `
fun bad() {
    GlobalScope.async { delay(100) }
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        expect(problems.filter(p => p.code === 'COR002')).toHaveLength(1);
    });

    it('COR002: does not flag regular GlobalScope reference in a string', () => {
        const src = `
fun doc() {
    println("Use GlobalScope.launch only sparingly")
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        expect(problems.filter(p => p.code === 'COR002')).toHaveLength(0);
    });

    it('COR003: flags Thread.sleep()', () => {
        const src = `
fun bad() {
    launch {
        Thread.sleep(1000)
    }
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        const cor003 = problems.filter(p => p.code === 'COR003');
        expect(cor003).toHaveLength(1);
        expect(cor003[0].severity).toBe('information');
        expect(cor003[0].message).toContain('delay()');
    });

    it('COR003: does not flag Thread.sleep in a comment', () => {
        const src = `
// Thread.sleep(1000) -- don't use this
fun ok() { delay(100) }`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        expect(problems.filter(p => p.code === 'COR003')).toHaveLength(0);
    });

    it('COR004: flags single-line async{}.await()', () => {
        const src = `
fun bad() = runBlocking {
    val x = async { compute() }.await()
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        const cor004 = problems.filter(p => p.code === 'COR004');
        expect(cor004).toHaveLength(1);
        expect(cor004[0].message).toContain('withContext');
    });

    it('COR004: does not flag async{} without immediate .await()', () => {
        const src = `
fun ok() = runBlocking {
    val d = async { compute() }
    val x = d.await()
}`;
        const points = analyze(src);
        const problems = detectAntiPatterns(src, points);
        expect(problems.filter(p => p.code === 'COR004')).toHaveLength(0);
    });

    it('returns empty list for clean code', () => {
        const src = `
suspend fun fetch(): String {
    return withContext(Dispatchers.IO) { "result" }
}
fun main() = runBlocking {
    println(fetch())
}`;
        const points = analyze(src);
        expect(detectAntiPatterns(src, points)).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// findWithContextBlocks
// ─────────────────────────────────────────────────────────────────────────────

describe('findWithContextBlocks', () => {
    it('finds a single withContext block', () => {
        const src = `
fun foo() = runBlocking {
    withContext(Dispatchers.IO) {
        delay(10)
    }
}`;
        const blocks = findWithContextBlocks(src);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].dispatcherName).toBe('IO');
        expect(blocks[0].closeLine).toBeGreaterThan(blocks[0].openLine);
    });

    it('finds nested withContext blocks', () => {
        const src = `
fun foo() = runBlocking {
    withContext(Dispatchers.IO) {
        withContext(Dispatchers.Default) {
            yield()
        }
    }
}`;
        const blocks = findWithContextBlocks(src);
        expect(blocks).toHaveLength(2);
        const names = blocks.map(b => b.dispatcherName).sort();
        expect(names).toEqual(['Default', 'IO']);
    });

    it('handles Dispatchers.Main.immediate', () => {
        const src = `
suspend fun ui() {
    withContext(Dispatchers.Main.immediate) {
        render()
    }
}`;
        const blocks = findWithContextBlocks(src);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].dispatcherName).toBe('Main.immediate');
    });

    it('ignores withContext in a string literal', () => {
        const src = `
val s = "withContext(Dispatchers.IO) { }"
`;
        const blocks = findWithContextBlocks(src);
        expect(blocks).toHaveLength(0);
    });

    it('returns empty for code with no withContext', () => {
        const src = `
suspend fun foo() {
    delay(100)
}`;
        expect(findWithContextBlocks(src)).toHaveLength(0);
    });
});

package sample.app

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/**
 * Showcase file dedicated to the four JetBrains gutter icons used by the
 * Kotlinx Coroutines Insight extension. Open this file to see each glyph
 * side-by-side without the noise of a full demo.
 *
 *  ┌──────────────────────────┬──────────────────────────────────────────────┐
 *  │ Icon (light / dark)      │ When it appears                              │
 *  ├──────────────────────────┼──────────────────────────────────────────────┤
 *  │ suspendCall              │ Every call site that suspends                │
 *  │ suspendFunction          │ Top-level `suspend fun foo(...)`             │
 *  │ suspendMethod            │ `suspend fun` inside class/object/interface  │
 *  │ suspendDeclaration       │ Suspend declaration whose context can't be   │
 *  │                          │ resolved cheaply (anonymous object literals) │
 *  └──────────────────────────┴──────────────────────────────────────────────┘
 */

// ─── 1. suspendFunction ──────────────────────────────────────────────────────
// Every line below should render the JetBrains `suspendFunction` glyph in the
// gutter (a red ↪ on the function name, NOT the suspendCall arrow).

suspend fun topLevelOne(): Int {
    delay(1)            // ← suspendCall
    return 1
}

suspend fun topLevelTwo(name: String): String = withContext(Dispatchers.Default) {
    delay(1)            // ← suspendCall
    "hello, $name"
}

suspend fun topLevelThree(values: Flow<Int>): Int =
    values.fold(0) { acc, v -> acc + v }   // ← suspendCall (flowTerminal: fold)


// ─── 2. suspendMethod ────────────────────────────────────────────────────────
// Every `suspend fun` inside a class/object/interface body should render the
// JetBrains `suspendMethod` glyph (red M).

class UserRepository {
    suspend fun loadById(id: Int): String {
        delay(1)        // ← suspendCall
        return "user-$id"
    }

    suspend fun loadAll(): List<String> = coroutineScope {
        val a = async { loadById(1) }
        val b = async { loadById(2) }
        listOf(a.await(), b.await())   // ← suspendCall × 2 (awaitCall)
    }
}

object UserCache {
    private val store = mutableMapOf<Int, String>()

    suspend fun put(id: Int, value: String) {
        delay(1)        // ← suspendCall
        store[id] = value
    }

    suspend fun get(id: Int): String? {
        yield()         // ← suspendCall
        return store[id]
    }
}

interface UserApi {
    suspend fun call(): String                               // ← suspendMethod (no body)
    suspend fun callOrNull(): String? = null                 // ← suspendMethod (default body)
}

class CompanionDemo {
    companion object {
        suspend fun create(): CompanionDemo {                // ← suspendMethod
            delay(1)    // ← suspendCall
            return CompanionDemo()
        }
    }
}


// ─── 3. suspendDeclaration ───────────────────────────────────────────────────
// `suspend fun` inside an anonymous-object literal (`object : T { ... }`)
// is treated as an unresolved declaration context and renders the JetBrains
// `suspendDeclaration` glyph (red S).

fun anonymousApi(): UserApi = object : UserApi {
    override suspend fun call(): String {                    // ← suspendDeclaration
        delay(1)        // ← suspendCall
        return "anonymous"
    }

    override suspend fun callOrNull(): String? {             // ← suspendDeclaration
        return call()   // ← suspendCall (local)
    }
}


// ─── 4. suspendCall (everything else) ────────────────────────────────────────
// All call sites — coroutine builders, suspend stdlib, .await(), Flow
// terminals — render the original suspendCall glyph.

fun callShowcase(): Unit = runBlocking {                     // ← suspendCall (builder)
    val repo = UserRepository()
    val users = repo.loadAll()                               // ← suspendCall (member call)
    UserCache.put(1, users.first())                          // ← suspendCall (member call)

    val flow: Flow<Int> = flowOf(1, 2, 3)
    flow.collect { println(it) }                             // ← suspendCall (flowTerminal)

    withTimeoutOrNull(50) {                                  // ← suspendCall (builder)
        delay(10)                                            // ← suspendCall
    }
}

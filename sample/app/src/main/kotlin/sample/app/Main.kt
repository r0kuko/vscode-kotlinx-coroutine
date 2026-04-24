package sample.app

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlin.system.measureTimeMillis

/**
 * A whirlwind tour of kotlinx.coroutines that exercises every detector in the
 * Kotlinx Coroutines Insight extension. Every line that suspends should have
 * the suspendCall arrow rendered in the gutter on the left, plus a subtle
 * `suspend` (or `await`) inlay hint on the right.
 */

suspend fun fetchUser(id: Int): String {
    delay(50)                                 // suspendCall
    return "user-$id"
}

suspend fun fetchOrders(user: String): List<String> = coroutineScope {
    val a = async { delay(40); "$user/order-A" }
    val b = async { delay(60); "$user/order-B" }
    listOf(a.await(), b.await())              // awaitCall x2
}

fun main() = runBlocking {                    // coroutineBuilder
    println("== concurrency ==")
    val time = measureTimeMillis {
        val u1 = async { 
            fetchUser(1) 
        }       // coroutineBuilder
        val u2 = async { fetchUser(2) }
        val users = awaitAll(u1, u2)          // suspendCall (awaitAll)
        println(users)
    }
    println("took ${time}ms")

    println("== withContext ==")
    val orders = withContext(Dispatchers.Default) {   // coroutineBuilder
        fetchOrders("alice")                  // local suspend call
    }
    println(orders)

    println("== timeouts ==")
    val maybe = withTimeoutOrNull(75) {       // coroutineBuilder
        delay(1000)
        "done"
    }
    println("withTimeoutOrNull → $maybe")

    println("== flow ==")
    ticker(intervalMs = 30, count = 5)
        .map { it * it }
        .filter { it % 2 == 1 }
        .collect { println("tick² = $it") }   // flowTerminal

    println("== supervisor ==")
    supervisorScope {                          // coroutineBuilder
        val good = launch { delay(20); println("good done") }
        val bad = launch { delay(10); println("bad about to throw"); throw RuntimeException("boom") }
        good.join()                            // suspendCall (join)
        bad.join()
    }

    println("== select / channel ==")
    val ch = produce {                         // coroutineBuilder
        repeat(3) { send("msg-$it"); delay(10) }
    }
    for (msg in ch) println(msg)
}

private fun ticker(intervalMs: Long, count: Int): Flow<Int> = flow {
    repeat(count) {
        delay(intervalMs)                      // suspendCall (inside flow {})
        emit(it)
    }
}

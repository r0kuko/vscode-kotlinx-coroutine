package sample.flowdemo

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.*
import kotlinx.coroutines.flow.*

/**
 * Showcases the Flow / Channel APIs and a few less-common builders so the
 * extension's detectors get exercised across the board.
 */

suspend fun searchSuggestions(query: String): Flow<String> = channelFlow {
    val deferred = listOf(
        async { delay(30); send("$query-suggestion-1") },
        async { delay(20); send("$query-suggestion-2") },
        async { delay(10); send("$query-suggestion-3") },
    )
    deferred.joinAll()                          // suspendCall (joinAll)
}

suspend fun typeahead(): Unit = coroutineScope {
    val typed = flowOf("co", "cor", "coro", "corou")
    typed
        .debounce(15)
        .flatMapLatest { searchSuggestions(it) }
        .collectLatest { println("hint: $it") }  // flowTerminal
}

fun bridgeCallback(): Flow<Int> = callbackFlow {
    val handle = SimulatedSubscription { value ->
        trySend(value)
    }
    awaitClose { handle.cancel() }              // suspendCall (awaitClose)
}

private class SimulatedSubscription(onValue: (Int) -> Unit) {
    init { repeat(3) { onValue(it) } }
    fun cancel() = Unit
}

fun main() = runBlocking {
    typeahead()
    bridgeCallback().take(3).toList()          // flowTerminal (toList)
        .also { println("collected: $it") }
}

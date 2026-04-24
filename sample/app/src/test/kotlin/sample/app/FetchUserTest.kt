package sample.app

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlin.test.Test
import kotlin.test.assertEquals

class FetchUserTest {
    @Test
    fun `fetchUser returns suffixed id`() = runTest {        // coroutineBuilder (runTest)
        val name = fetchUser(42)                              // suspendCall (local)
        assertEquals("user-42", name)
    }
}

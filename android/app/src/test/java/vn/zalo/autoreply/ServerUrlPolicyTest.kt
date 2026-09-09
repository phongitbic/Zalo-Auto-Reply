package vn.zalo.autoreply

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlPolicyTest {
    @Test
    fun acceptsPublicHttpVps() {
        assertEquals(
            "http://160.191.51.229:3001",
            ServerUrlPolicy.normalize("http://160.191.51.229:3001/")
        )
    }

    @Test
    fun stillRejectsUnsupportedSchemesAndPaths() {
        assertNull(ServerUrlPolicy.normalize("ftp://160.191.51.229:3001"))
        assertNull(ServerUrlPolicy.normalize("http://160.191.51.229:3001/api"))
    }
}

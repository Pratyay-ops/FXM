package io.github.pratyayops.fxm.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SourcesTest {
  @Test
  fun `sources with the same file key serve the same bytes`() {
    val first = Source(streamUrl(sig = 1), fileKey = "googlevideo:251:1:4000000:")
    // A fresh resolution: new signature, the same format and file.
    assertTrue(StreamIdentity.sameBytes(first, Source(streamUrl(sig = 2), fileKey = "googlevideo:251:1:4000000:")))
    assertTrue(StreamIdentity.sameBytes(first, first.copy(headers = mapOf("Referer" to "r"))))
    // Equal URLs always do, with or without a key.
    assertTrue(StreamIdentity.sameBytes(Source("https://archive.org/download/x/a.flac"), Source("https://archive.org/download/x/a.flac")))
  }

  @Test
  fun `another file, or a URL without a key, serves other bytes`() {
    val first = Source(streamUrl(sig = 1), fileKey = "googlevideo:251:1:4000000:")
    assertFalse(StreamIdentity.sameBytes(first, Source(streamUrl(itag = 140, sig = 2), fileKey = "googlevideo:140:1:3000000:")))
    // Native code reads nothing out of the URLs themselves.
    assertFalse(StreamIdentity.sameBytes(Source(streamUrl(sig = 1)), Source(streamUrl(sig = 2))))
    assertFalse(StreamIdentity.sameBytes(first, Source(streamUrl(sig = 2))))
    assertFalse(StreamIdentity.sameBytes(Source("https://archive.org/a.flac"), Source("https://archive.org/b.flac")))
  }

  @Test
  fun `entry URIs name slots and nothing else`() {
    assertEquals("fxm-entry://slot/42", EntryUris.uri(42))
    assertEquals(42L, EntryUris.keyOf(EntryUris.uri(42)))
    assertNull(EntryUris.keyOf("https://media.test/a.webm"))
    assertNull(EntryUris.keyOf("fxm-entry://slot/"))
    assertNull(EntryUris.keyOf("fxm-entry://slot/4x"))
    assertNull(EntryUris.keyOf("fxm-entry://slot/42/more"))
    assertNull(EntryUris.keyOf("fxm-entry://other/42"))
    assertNull(EntryUris.keyOf("fxm-entry://slot/" + "9".repeat(19)))
  }

  @Test
  fun `the table gives each slot its URL and the headers it may set`() {
    val table = SourceTable()
    val headers =
      mapOf(
        "Referer" to "https://www.youtube.com/",
        "range" to "bytes=0-1",
        "If-Range" to "x",
        "Accept-Encoding" to "gzip",
        "Cookie" to "SID=secret",
        "Connection" to "close",
      )
    table.put(1, Source("https://media.test/a", headers))
    val request = table.requestFor(1)
    assertEquals("https://media.test/a", request.url)
    assertEquals(mapOf("Referer" to "https://www.youtube.com/"), request.headers)
    table.put(1, Source("https://media.test/b"))
    assertEquals("https://media.test/b", table.requestFor(1).url)
  }

  @Test
  fun `slots the web app did not send cannot be fetched`() {
    val table = SourceTable()
    table.put(1, Source("https://media.test/a"))
    table.put(2, Source("https://media.test/b"))
    table.retain(setOf(2))
    assertNull(table[1])
    try {
      table.requestFor(1)
      fail("expected an UnknownEntryException")
    } catch (expected: UnknownEntryException) {
      // Media3 opens nothing but FXM's own entries.
    }
    table.clear()
    assertNull(table[2])
  }
}

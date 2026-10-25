package io.github.pratyayops.fxm.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SourcesTest {
  @Test
  fun `stream URLs of the same file serve the same bytes`() {
    assertTrue(StreamIdentity.sameBytes(streamUrl(), streamUrl()))
    // A fresh resolution: new signature, the same format and file.
    assertTrue(StreamIdentity.sameBytes(streamUrl(sig = 1), streamUrl(sig = 2)))
    // itag 18 has no clen; itag and lmt still name the file.
    assertTrue(StreamIdentity.sameBytes(streamUrl(itag = 18, clen = null, sig = 1), streamUrl(itag = 18, clen = null, sig = 2)))
    assertTrue(StreamIdentity.sameBytes("https://archive.org/download/x/a.flac", "https://archive.org/download/x/a.flac"))
  }

  @Test
  fun `another format or file serves other bytes`() {
    assertFalse(StreamIdentity.sameBytes(streamUrl(itag = 251), streamUrl(itag = 140)))
    assertFalse(StreamIdentity.sameBytes(streamUrl(lmt = "1"), streamUrl(lmt = "2")))
    assertFalse(StreamIdentity.sameBytes(streamUrl(clen = 1), streamUrl(clen = 2)))
    assertFalse(StreamIdentity.sameBytes("${streamUrl(sig = 1)}&dur=2.0", "${streamUrl(sig = 2)}&dur=3.0"))
    assertTrue(StreamIdentity.sameBytes("${streamUrl(sig = 1)}&dur=2.0", "${streamUrl(sig = 2)}&dur=2.0"))
    assertFalse(StreamIdentity.sameBytes("https://archive.org/a.flac", "https://archive.org/b.flac"))
    // Without the fields that name the file, only equal URLs count.
    val bare = "https://rr1---sn-fxmtest.googlevideo.com/videoplayback?itag=251"
    assertFalse(StreamIdentity.sameBytes(bare, "$bare&sig=2"))
    // Not googlevideo, however it is spelled.
    val lookalike = streamUrl().replace("googlevideo.com", "googlevideo.com.example.test")
    assertFalse(StreamIdentity.sameBytes(lookalike, lookalike.replace("sig=1", "sig=2")))
    assertFalse(StreamIdentity.sameBytes("not a url", "not a url either"))
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

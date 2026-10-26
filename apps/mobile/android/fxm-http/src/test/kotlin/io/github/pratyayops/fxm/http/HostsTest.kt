package io.github.pratyayops.fxm.http

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostsTest {
  @Test
  fun `wildcards match sub-domains at any depth but not the domain`() {
    assertTrue(Hosts.matches("rr1---sn-x.googlevideo.com", "*.googlevideo.com"))
    assertTrue(Hosts.matches("a.b.archive.org", "*.archive.org"))
    assertFalse(Hosts.matches("archive.org", "*.archive.org"))
    assertFalse(Hosts.matches("evilarchive.org", "*.archive.org"))
    assertTrue(Hosts.matches("lrclib.net", "lrclib.net"))
    assertFalse(Hosts.matches("www.lrclib.net", "lrclib.net"))
  }

  @Test
  fun `only plain HTTPS URLs on the default port match a rule`() {
    assertEquals(HostClass.INNERTUBE, Hosts.ruleFor("https://music.youtube.com/youtubei/v1/search".toHttpUrl())?.hostClass)
    assertEquals(HostClass.GOOGLEVIDEO, Hosts.ruleFor("https://rr4---sn-a.googlevideo.com/videoplayback".toHttpUrl())?.hostClass)
    assertEquals(HostClass.SPOTIFY, Hosts.ruleFor("https://api-partner.spotify.com/pathfinder/v2/query".toHttpUrl())?.hostClass)
    assertNull(Hosts.ruleFor("http://music.youtube.com/".toHttpUrl()))
    assertNull(Hosts.ruleFor("https://music.youtube.com:8443/".toHttpUrl()))
    assertNull(Hosts.ruleFor("https://user:pw@music.youtube.com/".toHttpUrl()))
    assertNull(Hosts.ruleFor("https://example.com/".toHttpUrl()))
  }

  @Test
  fun `a path prefix limits its rule`() {
    assertEquals(HostClass.LASTFM_WEB, Hosts.ruleFor("https://www.last.fm/player/station/music/x".toHttpUrl())?.hostClass)
    assertNull(Hosts.ruleFor("https://www.last.fm/user/x".toHttpUrl()))
  }

  @Test
  fun `host and port are written as JavaScript's URL host`() {
    assertEquals("example.org", Hosts.hostPort("https://Example.ORG/x".toHttpUrl()))
    assertEquals("example.org:8443", Hosts.hostPort("https://example.org:8443/".toHttpUrl()))
    assertEquals("[::1]:8443", Hosts.hostPort("https://[::1]:8443/".toHttpUrl()))
  }

  @Test
  fun `user hosts are normalized like the web transports compare them`() {
    assertEquals("invidious.example.org", UserHosts.normalize("  Invidious.Example.ORG "))
    assertEquals("example.org", UserHosts.normalize("example.org:443"))
    assertEquals("example.org:8443", UserHosts.normalize("example.org:8443"))
    assertEquals("xn--bcher-kva.example", UserHosts.normalize("bücher.example"))
    for (bad in listOf("", "https://example.org", "example.org/path", "user@example.org", "a b", "example.org:99999", "example.org?x")) {
      assertNull(bad, UserHosts.normalize(bad))
    }
  }
}

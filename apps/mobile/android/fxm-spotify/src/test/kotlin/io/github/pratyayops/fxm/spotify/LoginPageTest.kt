package io.github.pratyayops.fxm.spotify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginPageTest {
  @Test
  fun `finds Spotify's login cookie among the others, and only a cookie value`() {
    assertEquals("AQB-1", LoginPage.sessionCookie("sp_t=device; sp_dc=AQB-1; sp_key=k"))
    assertEquals("AQB-1", LoginPage.sessionCookie("  sp_dc = AQB-1  "))
    assertEquals("AQB=1", LoginPage.sessionCookie("sp_dc=AQB=1"))
    for (none in
      listOf(
        null,
        "",
        "sp_t=device",
        "sp_dc_old=1; xsp_dc=2",
        "sp_dc=",
        "sp_dc=with space",
        "sp_dc=\"quoted\"",
        "sp_dc=${"x".repeat(4097)}",
      )) {
      assertNull(none, LoginPage.sessionCookie(none))
    }
  }

  @Test
  fun `lets the window go to Spotify's login pages and Apple's sign-in, over HTTPS`() {
    for (allowed in
      listOf(
        LoginPage.START_URL,
        LoginPage.PASSWORD_RESET_URL,
        "https://accounts.spotify.com/en/login/password",
        "https://challenge.spotify.com/c/abc",
        "https://open.spotify.com/",
        "https://spotify.com/",
        "https://appleid.apple.com/auth/authorize?client_id=x",
      )) {
      assertEquals(allowed, Navigation.Allowed, LoginPage.navigation(allowed))
    }
  }

  @Test
  fun `says why Google and Facebook can't sign in there`() {
    assertEquals(
      Navigation.NotHere("Google"),
      LoginPage.navigation("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
    )
    for (facebook in
      listOf("https://www.facebook.com/dialog/oauth", "https://m.facebook.com/", "https://facebook.com/")) {
      assertEquals(facebook, Navigation.NotHere("Facebook"), LoginPage.navigation(facebook))
    }
  }

  @Test
  fun `keeps every other place and scheme closed`() {
    for (elsewhere in
      listOf(
        "http://accounts.spotify.com/login",
        "https://spotify.com.example.org/",
        "https://notspotify.com/",
        "https://www.apple.com/",
        "https://www.google.com/search?q=spotify",
        "intent://open#Intent;scheme=spotify;end",
        "spotify:track:70LcF31zb1H0PyJoS1Sx1r",
        "javascript:alert(1)",
        "file:///data/data/io.github.pratyayops.fxm/files",
        "about:blank",
      )) {
      assertEquals(elsewhere, Navigation.Elsewhere, LoginPage.navigation(elsewhere))
    }
  }

  @Test
  fun `gives the window a User-Agent without the phone's model, still marked as a WebView`() {
    val webView =
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015; wv) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36"
    val agent = LoginPage.loginUserAgent(webView)
    assertEquals(
      "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
      agent,
    )
    assertFalse(agent.contains("Pixel"))
    assertFalse(agent.contains("Build/"))
    assertTrue(agent.contains("; wv)"))
    val tablet = webView.replace(" Mobile", "")
    assertFalse(LoginPage.loginUserAgent(tablet).contains("Mobile"))
    assertEquals("SomethingElse/1.0", LoginPage.loginUserAgent("SomethingElse/1.0"))
  }
}

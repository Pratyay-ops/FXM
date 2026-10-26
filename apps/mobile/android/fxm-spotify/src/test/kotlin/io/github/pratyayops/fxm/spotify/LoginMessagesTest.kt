package io.github.pratyayops.fxm.spotify

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class LoginMessagesTest {
  @Test
  fun `reads the token parameters as JavaScript sends them`() {
    val options =
      JSONObject().put("params", JSONObject().put("reason", "transport").put("totpVer", "7"))
    assertEquals(
      mapOf("reason" to "transport", "totpVer" to "7"),
      LoginMessages.tokenParams(options),
    )
    for (bad in
      listOf(
        JSONObject(),
        JSONObject().put("params", "reason=transport"),
        JSONObject().put("params", JSONObject().put("totpVer", 7)),
      )) {
      try {
        LoginMessages.tokenParams(bad)
        fail("accepted $bad")
      } catch (e: LoginFailure) {
        assertEquals(LoginErrorCode.BAD_REQUEST, e.code)
        assertNull(e.retryAfterMs)
      }
    }
  }

  @Test
  fun `answers with where the login stands, and with Spotify's status and body`() {
    val state = LoginMessages.state(loggedIn = true, available = false)
    assertEquals(true, state.getBoolean("loggedIn"))
    assertEquals(false, state.getBoolean("available"))
    assertEquals(2, state.length())
    val answer = LoginMessages.answer(TokenAnswer(401, JSONObject.NULL))
    assertEquals(401, answer.getInt("status"))
    assertEquals(JSONObject.NULL, answer.get("json"))
    val token = LoginMessages.answer(TokenAnswer(200, JSONObject().put("isAnonymous", false)))
    assertEquals(false, token.getJSONObject("json").getBoolean("isAnonymous"))
  }

  @Test
  fun `the rate limiter frees a slot once the oldest leaves the window`() {
    val limiter = RateLimiter(2, 1000)
    assertNull(limiter.tryAcquire(0))
    assertNull(limiter.tryAcquire(400))
    assertEquals(600L, limiter.tryAcquire(400))
    assertNull(limiter.tryAcquire(1000))
    assertEquals(400L, limiter.tryAcquire(1000))
  }
}

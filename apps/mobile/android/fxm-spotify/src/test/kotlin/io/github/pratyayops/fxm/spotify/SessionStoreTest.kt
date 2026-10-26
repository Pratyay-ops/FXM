package io.github.pratyayops.fxm.spotify

import java.io.File
import java.io.IOException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SessionStoreTest {
  private val cipher = MemoryCipher()
  private val file = MemoryFile()
  private val store = SessionStore(file, cipher)

  @Test
  fun `keeps the login sealed, never in plain text`() {
    assertFalse(store.isLoggedIn())
    assertNull(store.cookie())
    store.save(COOKIE)
    assertTrue(store.isLoggedIn())
    assertEquals(COOKIE, store.cookie())
    val kept = file.text ?: ""
    assertEquals(SessionStore.FORMAT, kept.lines().first())
    assertFalse("the cookie is in the file", kept.contains(COOKIE))
    assertFalse(kept.contains(COOKIE.takeLast(12)))
  }

  @Test
  fun `a new login replaces the earlier one, each sealed with a nonce of its own`() {
    store.save(COOKIE)
    val first = file.text?.lines()?.get(1)
    store.save("AQ-another-login")
    assertEquals("AQ-another-login", store.cookie())
    store.save("AQ-another-login")
    val third = file.text?.lines()?.get(1)
    assertTrue(first != null && third != null && first != third)
  }

  @Test
  fun `logging out deletes the login and its key`() {
    store.save(COOKIE)
    store.forget()
    assertNull(file.text)
    assertEquals(1, cipher.forgotten)
    assertFalse(store.isLoggedIn())
    assertNull(store.cookie())
  }

  @Test
  fun `a login that no longer opens is deleted, and counts as logged out`() {
    store.save(COOKIE)
    // As after a restore onto another phone, or a keystore that lost the key.
    cipher.key = MemoryCipher.newKey()
    assertNull(store.cookie())
    assertNull(file.text)
    assertFalse(store.isLoggedIn())

    store.save(COOKIE)
    cipher.key = null
    assertNull(store.cookie())
    assertNull(file.text)
  }

  @Test
  fun `a keystore failure that may pass keeps the login, and says so`() {
    store.save(COOKIE)
    // As secure hardware that is busy or out of reach surfaces, e.g. during the hourly token call.
    cipher.openFailures.add(ProviderException("The keystore is busy"))
    val failure = assertThrows(LoginFailure::class.java) { store.cookie() }
    assertEquals(LoginErrorCode.STORAGE, failure.code)
    assertTrue(store.isLoggedIn())
    assertEquals(0, cipher.forgotten)
    assertEquals(COOKIE, store.cookie())
  }

  @Test
  fun `only a failure that lasts deletes the login`() {
    for (lasting in
      listOf(
        SessionKeyGone("gone"),
        AEADBadTagException("another key"),
        UnrecoverableKeyException("damaged"),
      )) {
      store.save(COOKIE)
      cipher.openFailures.add(lasting)
      assertNull(lasting.toString(), store.cookie())
      assertNull(lasting.toString(), file.text)
      assertFalse(store.isLoggedIn())
    }
    assertFalse(SessionStore.isPermanent(ProviderException("busy")))
    assertFalse(SessionStore.isPermanent(java.security.KeyStoreException("not loaded")))
    assertFalse(SessionStore.isPermanent(IllegalStateException("anything else")))
  }

  @Test
  fun `a key that fails to seal is replaced with a new one, once`() {
    store.save("AQ-an-earlier-login")
    cipher.sealFailures.add(ProviderException("The key was invalidated"))
    store.save(COOKIE)
    assertEquals(1, cipher.forgotten)
    assertEquals(COOKIE, store.cookie())
  }

  @Test
  fun `a key that never seals fails the save, and leaves no login that can't open`() {
    store.save("AQ-an-earlier-login")
    cipher.sealFailures.add(ProviderException("The key was invalidated"))
    cipher.sealFailures.add(ProviderException("The keystore is gone"))
    assertThrows(ProviderException::class.java) { store.save(COOKIE) }
    // The earlier login's key is gone, and with it the earlier login.
    assertNull(file.text)
    assertFalse(store.isLoggedIn())
  }

  @Test
  fun `logging out fails only when the login is still kept`() {
    store.save(COOKIE)
    cipher.forgetFailure = ProviderException("The keystore is busy")
    store.forget()
    assertNull("the file is gone, and the login with it", file.text)

    store.save(COOKIE)
    cipher.forgetFailure = null
    file.deleteFailure = IOException("The disk failed")
    store.forget()
    assertEquals("the key is gone, so the login never opens", 1, cipher.forgotten)

    cipher.forgetFailure = ProviderException("The keystore is busy")
    assertThrows(IOException::class.java) { store.forget() }
  }

  @Test
  fun `a damaged file is deleted, and counts as logged out`() {
    for (damaged in
      listOf(
        "",
        "not a login",
        "${SessionStore.FORMAT}\n!!!\nAAAA\n",
        "${SessionStore.FORMAT}\nAAAAAAAAAAAAAAAA\n\n",
        "fxm-spotify-session/2\nAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAA\n",
        // A nonce of 3 bytes, which the keystore never makes; then bytes too short for a tag.
        "${SessionStore.FORMAT}\nAAAA\nAAAAAAAAAAAAAAAAAAAAAAAA\n",
        "${SessionStore.FORMAT}\nAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAA==\n",
      )) {
      file.text = damaged
      assertFalse(damaged, store.isLoggedIn())
      assertNull(damaged, store.cookie())
      assertNull(damaged, file.text)
    }
  }

  @Test
  fun `bytes sealed for another purpose never open as the login`() {
    store.save(COOKIE)
    val lines = (file.text ?: "").lines()
    val other = cipher.seal(COOKIE.toByteArray(), "something else".toByteArray())
    val b64 = { bytes: ByteArray -> java.util.Base64.getEncoder().encodeToString(bytes) }
    file.text = "${lines[0]}\n${b64(other.iv)}\n${b64(other.data)}\n"
    assertNull(store.cookie())
  }

  @Test
  fun `refuses to keep what is no cookie value, and keeps the earlier login`() {
    store.save(COOKIE)
    for (bad in listOf("", "with space", "semi;colon", "quo\"te", "x".repeat(4097))) {
      try {
        store.save(bad)
        fail("kept $bad")
      } catch (e: IllegalArgumentException) {
        // Refused.
      }
    }
    assertEquals(COOKIE, store.cookie())
  }

  @Test
  fun `the file on disk is replaced whole, and deleted with its temporary file`() {
    // Inside the module's build folder (Gradle runs the tests in the module), never elsewhere.
    val dir = File("build/tmp/session-file-${System.nanoTime()}").apply { mkdirs() }
    try {
      val onDisk = FileSessionFile(File(dir, "session"))
      assertNull(onDisk.read())
      onDisk.write("one")
      onDisk.write("two")
      assertEquals("two", onDisk.read())
      assertEquals(listOf("session"), dir.list()?.toList())
      File(dir, "session.tmp").writeText("left over")
      onDisk.delete()
      assertNull(onDisk.read())
      assertEquals(emptyList<String>(), dir.list()?.toList())
      onDisk.delete()

      // A file that stays (here a folder with something in it, which File.delete() refuses).
      val stuck = File(dir, "stuck").apply { mkdirs() }
      File(stuck, "inside").writeText("x")
      assertThrows(IOException::class.java) { FileSessionFile(stuck).delete() }
    } finally {
      dir.deleteRecursively()
    }
  }
}

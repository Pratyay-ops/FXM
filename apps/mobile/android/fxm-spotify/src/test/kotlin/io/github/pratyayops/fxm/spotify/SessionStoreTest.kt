package io.github.pratyayops.fxm.spotify

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
  fun `a damaged file is deleted, and counts as logged out`() {
    for (damaged in
      listOf(
        "",
        "not a login",
        "${SessionStore.FORMAT}\n!!!\nAAAA\n",
        "${SessionStore.FORMAT}\nAAAAAAAAAAAAAAAA\n\n",
        "fxm-spotify-session/2\nAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAA\n",
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
    } finally {
      dir.deleteRecursively()
    }
  }
}

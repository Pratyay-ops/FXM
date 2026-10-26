package io.github.pratyayops.fxm.spotify

import java.io.File
import java.io.IOException
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

/** Bytes sealed with AES-GCM: the nonce, and the ciphertext with its tag. */
class Sealed(val iv: ByteArray, val data: ByteArray)

/**
 * Seals the kept login. On a device it is [KeystoreCipher], whose key never leaves the Android
 * Keystore; the tests use a key in memory.
 */
interface SessionCipher {
  /** Seals [plain], bound to [aad]. */
  fun seal(plain: ByteArray, aad: ByteArray): Sealed

  /** Opens what [seal] sealed with the same [aad]. Throws when it can't (another key, damage). */
  fun open(sealed: Sealed, aad: ByteArray): ByteArray

  /** Deletes the key, so nothing sealed with it opens again. */
  fun forget()
}

/** Where the sealed login is kept: a [FileSessionFile] in the app's no-backup folder. */
interface SessionFile {
  /** The kept text, or `null` when there is none. */
  fun read(): String?

  /** Replaces the kept text, all at once. */
  fun write(text: String)

  /** Deletes it. */
  fun delete()
}

/**
 * A [SessionFile] on disk. It is written to a temporary file next to it, then renamed over it, so
 * a crash never leaves half a login. Put it in `Context.getNoBackupFilesDir()`: app-private, and
 * never in a backup, whatever the backup rules say.
 */
class FileSessionFile(private val file: File) : SessionFile {
  private val temporary = File(file.parentFile, "${file.name}.tmp")

  override fun read(): String? =
    try {
      if (file.isFile) file.readText(Charsets.UTF_8) else null
    } catch (e: IOException) {
      null
    }

  override fun write(text: String) {
    file.parentFile?.mkdirs()
    temporary.writeText(text, Charsets.UTF_8)
    if (!temporary.renameTo(file)) {
      temporary.delete()
      throw IOException("The Spotify login could not be kept")
    }
  }

  override fun delete() {
    temporary.delete()
    file.delete()
  }
}

/**
 * The Spotify login FXM keeps: the `sp_dc` cookie the login window read, sealed by [cipher] and
 * kept in [file]. Only native code reads it, for the token call ([SpotifyTokenCall]).
 *
 * The file holds three lines: the format, the nonce and the sealed bytes, both in base64. The
 * format line is also the sealing's associated data, so the bytes of another format never open
 * as this one's.
 */
class SessionStore(private val file: SessionFile, private val cipher: SessionCipher) {
  /** Keeps [cookie] in place of an earlier login. Throws when it can't (the keystore, the disk). */
  @Synchronized
  fun save(cookie: String) {
    require(LoginPage.isCookieValue(cookie)) { "Not a cookie value" }
    val sealed = cipher.seal(cookie.toByteArray(Charsets.UTF_8), AAD)
    val iv = sealed.iv.toByteString().base64()
    val data = sealed.data.toByteString().base64()
    file.write("$FORMAT\n$iv\n$data\n")
  }

  /** Whether a login is kept. It isn't opened here: [cookie] finds out whether it still opens. */
  @Synchronized
  fun isLoggedIn(): Boolean = parse(file.read()) != null

  /**
   * The kept cookie, or `null` when there is none. A login that doesn't open any more (its key is
   * gone, the file is damaged) is deleted, so the user is asked to log in again.
   */
  @Synchronized
  fun cookie(): String? {
    val text = file.read() ?: return null
    val sealed = parse(text)
    val cookie =
      sealed?.let {
        try {
          String(cipher.open(it, AAD), Charsets.UTF_8)
        } catch (e: Exception) {
          null
        }
      }
    if (cookie == null || !LoginPage.isCookieValue(cookie)) {
      forget()
      return null
    }
    return cookie
  }

  /** Deletes the kept login and its key. */
  @Synchronized
  fun forget() {
    file.delete()
    try {
      cipher.forget()
    } catch (e: Exception) {
      // The key is gone already, or the keystore can't be reached: the file is gone either way.
    }
  }

  private fun parse(text: String?): Sealed? {
    val lines = text?.split('\n') ?: return null
    if (lines.size < 3 || lines[0] != FORMAT) return null
    val iv = lines[1].decodeBase64() ?: return null
    val data = lines[2].decodeBase64() ?: return null
    if (iv.size == 0 || data.size == 0) return null
    return Sealed(iv.toByteArray(), data.toByteArray())
  }

  companion object {
    /** The file's first line, and the sealing's associated data. */
    const val FORMAT = "fxm-spotify-session/1"

    private val AAD = FORMAT.toByteArray(Charsets.UTF_8)
  }
}

package io.github.pratyayops.fxm.spotify

import android.security.keystore.KeyPermanentlyInvalidatedException
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

/** Bytes sealed with AES-GCM: the nonce, and the ciphertext with its tag. */
class Sealed(val iv: ByteArray, val data: ByteArray)

/** The key that sealed the login is gone (deleted, or never on this phone): it never opens. */
class SessionKeyGone(message: String) : GeneralSecurityException(message)

/**
 * Seals the kept login. On a device it is [KeystoreCipher], whose key never leaves the Android
 * Keystore; the tests use a key in memory.
 */
interface SessionCipher {
  /** Seals [plain], bound to [aad]. */
  fun seal(plain: ByteArray, aad: ByteArray): Sealed

  /**
   * Opens what [seal] sealed with the same [aad]. Throws when it can't: [SessionKeyGone] when the
   * key is gone, `AEADBadTagException` for bytes of another key or damaged ones, and anything
   * else for a failure that may pass, such as a keystore busy for a moment.
   */
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

  /** Deletes it. Throws when it is still there afterwards. */
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
    // Both, even when the first fails: a temporary file a crash left holds a sealed login too.
    val left = listOf(temporary, file).filter { !it.delete() && it.exists() }
    if (left.isNotEmpty()) throw IOException("The Spotify login could not be deleted")
  }
}

/**
 * The Spotify login FXM keeps: the `sp_dc` cookie the login window read, sealed by [cipher] and
 * kept in [file]. Only native code reads it, for the token call ([SpotifyTokenCall]).
 *
 * The file holds three lines: the format, the nonce and the sealed bytes, both in base64. The
 * format line is also the sealing's associated data, so the bytes of another format never open
 * as this one's.
 *
 * A login that never opens again (its key is gone or invalidated, the file is damaged) is
 * deleted, and the user is asked to log in again. One that can't be opened just now, because the
 * keystore failed in a way that may pass, stays kept ([isPermanent]).
 */
class SessionStore(private val file: SessionFile, private val cipher: SessionCipher) {
  /**
   * Keeps [cookie] in place of an earlier login. A key that fails to seal is replaced with a new
   * one, once: an invalidated or damaged key never seals again. Throws when the login can't be
   * kept (the keystore, the disk).
   */
  @Synchronized
  fun save(cookie: String) {
    require(LoginPage.isCookieValue(cookie)) { "Not a cookie value" }
    val plain = cookie.toByteArray(Charsets.UTF_8)
    val sealed =
      try {
        cipher.seal(plain, AAD)
      } catch (e: Exception) {
        cipher.forget()
        // What the old key sealed never opens without it: the earlier login goes with it.
        deleteFile()
        cipher.seal(plain, AAD)
      }
    val iv = sealed.iv.toByteString().base64()
    val data = sealed.data.toByteString().base64()
    file.write("$FORMAT\n$iv\n$data\n")
  }

  /** Whether a login is kept. It isn't opened here: [cookie] finds out whether it still opens. */
  @Synchronized
  fun isLoggedIn(): Boolean = parse(file.read()) != null

  /**
   * The kept cookie, or `null` when there is none. A login that never opens again is deleted, so
   * the user is asked to log in again. Throws a [LoginFailure] ([LoginErrorCode.STORAGE]) when the
   * keystore can't open it just now: then it stays kept.
   */
  @Synchronized
  fun cookie(): String? {
    val text = file.read() ?: return null
    val sealed = parse(text) ?: return drop()
    val plain =
      try {
        cipher.open(sealed, AAD)
      } catch (e: Exception) {
        if (isPermanent(e)) return drop()
        throw LoginFailure(LoginErrorCode.STORAGE, "FXM couldn't open its Spotify login just now")
      }
    val cookie = String(plain, Charsets.UTF_8)
    return if (LoginPage.isCookieValue(cookie)) cookie else drop()
  }

  /**
   * Deletes the kept login and its key. Either is enough for the login never to open again, so it
   * throws only when neither could be deleted.
   */
  @Synchronized
  fun forget() {
    val fileGone = deleteFile()
    val keyGone =
      try {
        cipher.forget()
        true
      } catch (e: Exception) {
        // The keystore can't be reached: the login doesn't open without its file either.
        false
      }
    if (!fileGone && !keyGone) throw IOException("The Spotify login could not be deleted")
  }

  /** Deletes the file, and says whether it is gone. */
  private fun deleteFile(): Boolean =
    try {
      file.delete()
      true
    } catch (e: IOException) {
      false
    }

  /** Deletes a login that never opens again, as far as it can: it counts as logged out. */
  private fun drop(): String? {
    try {
      forget()
    } catch (e: IOException) {
      // It doesn't open either way; the next look tries to delete it again.
    }
    return null
  }

  private fun parse(text: String?): Sealed? {
    val lines = text?.split('\n') ?: return null
    if (lines.size < 3 || lines[0] != FORMAT) return null
    val iv = lines[1].decodeBase64() ?: return null
    val data = lines[2].decodeBase64() ?: return null
    // The keystore's GCM nonces are 12 bytes, and the bytes hold at least the tag and a cookie.
    if (iv.size != IV_BYTES || data.size <= TAG_BYTES) return null
    return Sealed(iv.toByteArray(), data.toByteArray())
  }

  companion object {
    /** The file's first line, and the sealing's associated data. */
    const val FORMAT = "fxm-spotify-session/1"

    private val AAD = FORMAT.toByteArray(Charsets.UTF_8)
    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16

    /**
     * Whether [error], from opening the kept login, means it never opens again: its key is gone,
     * invalidated or can't be recovered, or the bytes don't match it (another key, damage). Any
     * other failure may pass: the Android Keystore also fails for a moment, e.g. while its secure
     * hardware is busy or out of reach (`android.security.KeyStoreException.isTransientFailure`).
     */
    fun isPermanent(error: Exception): Boolean =
      error is SessionKeyGone ||
        error is AEADBadTagException ||
        error is UnrecoverableKeyException ||
        error is KeyPermanentlyInvalidatedException
  }
}

package io.github.pratyayops.fxm.spotify

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals the kept login with an AES-256-GCM key in the Android Keystore. The key never leaves it,
 * so the app's files alone don't open the login, and uninstalling the app deletes it. The
 * keystore picks every nonce. The key needs no unlocked screen: the token call also runs with
 * the screen off, while music plays.
 */
class KeystoreCipher(private val alias: String = ALIAS) : SessionCipher {
  override fun seal(plain: ByteArray, aad: ByteArray): Sealed {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key() ?: createKey())
    cipher.updateAAD(aad)
    val data = cipher.doFinal(plain)
    return Sealed(cipher.iv, data)
  }

  override fun open(sealed: Sealed, aad: ByteArray): ByteArray {
    val key = key() ?: throw GeneralSecurityException("The Spotify login's key is gone")
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed.iv))
    cipher.updateAAD(aad)
    return cipher.doFinal(sealed.data)
  }

  override fun forget() {
    keyStore().deleteEntry(alias)
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  private fun key(): SecretKey? = keyStore().getKey(alias, null) as? SecretKey

  private fun createKey(): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
    generator.init(
      KeyGenParameterSpec.Builder(
          alias,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  companion object {
    /** The key's name in the app's keystore. */
    const val ALIAS = "fxm-spotify-session"

    private const val PROVIDER = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
  }
}

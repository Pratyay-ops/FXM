package io.github.pratyayops.fxm.player

import androidx.media3.common.PlaybackException
import androidx.media3.datasource.HttpDataSource
import io.github.pratyayops.fxm.http.FxmHttpException

/**
 * Media3's playback errors as the web app's `EngineError` types: what the stream lifecycle needs
 * to decide what to resolve next (`planStreamRecovery` in `@fxm/core`). The HTTP status goes
 * along wherever there was one, so a 403 can be told from an expired or dead URL.
 */
object Failures {
  /** Statuses after which retrying the same URL is pointless: the web app resolves a new one. */
  val GIVE_UP_STATUSES: Set<Int> = setOf(401, 403, 404, 410)

  /** How deep to follow an error's causes. */
  private const val MAX_DEPTH = 8

  /**
   * The failure for a Media3 [errorCode] (`PlaybackException.ERROR_CODE_*`), with the HTTP
   * [status] the server answered, and whether FXM's own network rules refused the request.
   */
  fun classify(errorCode: Int, status: Int?, refusedByRules: Boolean, message: String): Failure {
    if (refusedByRules) return Failure(FailureType.UNSUPPORTED, null, message)
    val type =
      when (errorCode) {
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
        -> FailureType.UNSUPPORTED
        in PARSING_AND_DECODING, in AUDIO_OUTPUT -> FailureType.DECODE
        else -> FailureType.NETWORK
      }
    return Failure(type, if (type == FailureType.NETWORK) status else null, message)
  }

  /** The HTTP status in [error]'s causes, where a server answered with one. */
  fun httpStatus(error: Throwable?): Int? =
    causes(error).filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode

  /** Whether fxm-http's request policy refused the request (a host off FXM's table, …). */
  fun refusedByRules(error: Throwable?): Boolean = causes(error).any { it is FxmHttpException }

  /** Whether Media3 tried to open a playlist item that is not one of FXM's entries. */
  fun unknownEntry(error: Throwable?): Boolean = causes(error).any { it is UnknownEntryException }

  /** The failure for Media3's [error]. */
  fun of(error: PlaybackException): Failure =
    classify(
      error.errorCode,
      httpStatus(error),
      refusedByRules(error) || unknownEntry(error),
      describe(error),
    )

  private fun describe(error: PlaybackException): String {
    val status = httpStatus(error)
    // Never the URL: it carries tokens. The error code's name and the status say enough.
    return if (status != null) "${error.errorCodeName} (HTTP $status)" else error.errorCodeName
  }

  private fun causes(error: Throwable?): Sequence<Throwable> =
    generateSequence(error) { it.cause }.take(MAX_DEPTH)

  /** `ERROR_CODE_PARSING_*` and `ERROR_CODE_DECODER_*`/`DECODING_*`. */
  private val PARSING_AND_DECODING = 3000..4999

  /** `ERROR_CODE_AUDIO_TRACK_*`: the device's audio output failed. */
  private val AUDIO_OUTPUT = 5000..5999
}

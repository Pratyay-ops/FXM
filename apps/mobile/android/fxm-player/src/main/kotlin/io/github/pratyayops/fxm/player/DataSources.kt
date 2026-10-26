package io.github.pratyayops.fxm.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy

/**
 * Turns a playlist item's URI into the request for its stream: the entry's current URL and its
 * per-URL headers from [SourceTable], for every connection Media3 opens (the first, and one per
 * seek or reconnect). The data source under it is OkHttp on fxm-http's shared client, so FXM's
 * host, header and cookie rules apply. Requests stay plain `GET`s: from the start without a
 * `Range` header, and `Range: bytes=<n>-` after a seek, never in chunks.
 */
class EntryResolver(private val table: SourceTable) : ResolvingDataSource.Resolver {
  override fun resolveDataSpec(dataSpec: DataSpec): DataSpec {
    val key =
      EntryUris.keyOf(dataSpec.uri.toString())
        ?: throw UnknownEntryException("FXM's player only plays its own entries")
    val request = table.requestFor(key)
    return dataSpec.withUri(Uri.parse(request.url)).withAdditionalHeaders(request.headers)
  }
}

/**
 * Media3's retries for one loading stream, minus the ones that cannot help: a URL the server
 * refused or no longer has (401, 403, 404, 410), a request FXM's network rules refused, and an
 * item that is not FXM's. Those fail at once, so the web app can resolve a fresh URL.
 */
class LoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
  override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
    val error = loadErrorInfo.exception
    val status = Failures.httpStatus(error)
    if (status != null && status in Failures.GIVE_UP_STATUSES) return C.TIME_UNSET
    if (Failures.refusedByRules(error) || Failures.unknownEntry(error)) return C.TIME_UNSET
    return super.getRetryDelayMsFor(loadErrorInfo)
  }
}

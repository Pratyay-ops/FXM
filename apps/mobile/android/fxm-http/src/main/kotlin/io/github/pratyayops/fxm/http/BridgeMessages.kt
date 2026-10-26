package io.github.pratyayops.fxm.http

import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.encodeUtf8
import org.json.JSONArray
import org.json.JSONObject

/**
 * The FxmHttp plugin's messages, as packages/platform/src/android-http.ts sends and reads them:
 * `request` options become an OkHttp [Request], and heads and chunks become JSON. Malformed
 * options throw an [FxmHttpException] with [BridgeErrorCode.BAD_REQUEST], as `fetch` throws a
 * `TypeError` for them.
 */
object BridgeMessages {
  private val ID = Regex("[A-Za-z0-9._:-]{1,100}")
  private val TOKEN = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")
  private val NEEDS_BODY = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")

  /** The `Content-Type` `fetch` gives a text body that has none. */
  const val TEXT_CONTENT_TYPE = "text/plain;charset=UTF-8"

  /** The id and the OkHttp request that `request` options describe. */
  fun request(options: JSONObject): Pair<String, Request> {
    val id = id(options)
    val url =
      (options.opt("url") as? String)?.toHttpUrlOrNull()
        ?: throw bad("The URL is not an absolute HTTPS URL")
    val method = (options.opt("method") as? String ?: "GET").uppercase()
    if (!TOKEN.matches(method)) throw bad("Invalid method")

    val headers = Headers.Builder()
    val given = options.optJSONObject("headers")
    if (given != null) {
      for (name in given.keys()) {
        val value = given.opt(name) as? String ?: throw bad("Header values must be strings")
        if (!TOKEN.matches(name)) throw bad("Invalid header name")
        try {
          headers.add(name, value)
        } catch (e: IllegalArgumentException) {
          throw bad("Invalid value for the $name header")
        }
      }
    }

    val text = options.opt("body") as? String
    val bytes: ByteString? =
      when (options.opt("bodyEncoding") as? String ?: "utf8") {
        "utf8" -> text?.encodeUtf8()
        "base64" -> text?.let { it.decodeBase64() ?: throw bad("The body is not valid base64") }
        else -> throw bad("Unknown body encoding")
      }
    if (bytes != null && (method == "GET" || method == "HEAD")) {
      throw bad("$method requests cannot have a body")
    }
    var contentType = headers["Content-Type"]
    if (bytes != null && contentType == null && options.opt("bodyEncoding") != "base64") {
      contentType = TEXT_CONTENT_TYPE
      headers.add("Content-Type", contentType)
    }
    // Encoded by hand, because a String body would get "; charset=utf-8" added to its type.
    val body: RequestBody? =
      bytes?.toRequestBody(contentType?.toMediaTypeOrNull())
        ?: if (method in NEEDS_BODY) ByteString.EMPTY.toRequestBody(null) else null

    val redirect =
      when (options.opt("redirect") as? String ?: "follow") {
        "follow" -> RedirectMode.FOLLOW
        "manual" -> RedirectMode.MANUAL
        "error" -> RedirectMode.ERROR
        else -> throw bad("Unknown redirect mode")
      }
    val request =
      try {
        Request.Builder()
          .url(url)
          .headers(headers.build())
          .method(method, body)
          .tag(RedirectMode::class.java, redirect)
          .build()
      } catch (e: IllegalArgumentException) {
        throw bad(e.message ?: "Invalid request")
      }
    return id to request
  }

  /** The `id` of `read` and `abort` options. */
  fun id(options: JSONObject): String {
    val id = options.opt("id") as? String
    if (id == null || !ID.matches(id)) throw bad("Invalid request id")
    return id
  }

  /** How many bytes a `read` asks for, within the plugin's limit. */
  fun maxBytes(options: JSONObject): Int {
    val requested = (options.opt("maxBytes") as? Number)?.toLong() ?: BridgeProtocol.READ_BYTES.toLong()
    return requested.coerceIn(1, BridgeProtocol.MAX_READ_BYTES.toLong()).toInt()
  }

  /** The hosts of `approveHosts` and `revokeHosts` options, normalized ([UserHosts.normalize]). */
  fun hosts(options: JSONObject): List<String> {
    val array = options.optJSONArray("hosts") ?: throw bad("hosts must be a list")
    return (0 until array.length()).map { index ->
      val entry = array.opt(index) as? String ?: throw bad("Hosts must be strings")
      UserHosts.normalize(entry) ?: throw bad("Not a host name: $entry")
    }.distinct()
  }

  /** The `request` result. */
  fun head(id: String, head: ResponseHead): JSONObject =
    JSONObject()
      .put("id", id)
      .put("status", head.status)
      .put("statusText", head.statusText)
      .put("url", head.url)
      .put("redirected", head.redirected)
      .put(
        "headers",
        JSONArray().apply {
          for ((name, value) in head.headers) put(JSONArray().put(name).put(value))
        },
      )
      .put("body", head.hasBody)

  /** The `read` result: the bytes in base64, so every byte survives the bridge. */
  fun chunk(chunk: Chunk): JSONObject =
    JSONObject().put("data", chunk.bytes.base64()).put("done", chunk.done)

  /** A list of hosts, for the approval methods' results. */
  fun hostList(key: String, hosts: Collection<String>): JSONObject =
    JSONObject().put(key, JSONArray(hosts.sorted()))

  private fun bad(message: String) = FxmHttpException(BridgeErrorCode.BAD_REQUEST, message)
}

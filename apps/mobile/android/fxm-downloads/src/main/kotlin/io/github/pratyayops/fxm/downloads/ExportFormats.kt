package io.github.pratyayops.fxm.downloads

/** How an exported file is named and typed: its extension and MediaStore MIME type. */
data class ExportFormat(val extension: String, val mimeType: String)

/**
 * The name and type a download gets in Music/FXM. Downloads keep the stream's original bytes, so
 * the container decides: the extension must make Android's media scanner file the song as audio
 * (`.webm` would make it a video), and the MIME type must be an `audio/` type, which MediaStore's
 * audio collection requires. YouTube's itag 18 is a video file: it gets no export until stage 4.2
 * can take its audio out (ARCHITECTURE.md §14: downloads that come out as video files are the
 * trap to avoid).
 */
object ExportFormats {
  /** The longest name, in UTF-8 bytes with the extension: under the 255 most file systems allow. */
  const val MAX_NAME_BYTES = 200

  /** The name of a song with neither title nor artist. */
  const val FALLBACK_NAME = "FXM download"

  /**
   * The format of a download of [codec] in [container] (the names of `@fxm/core`'s `Codec` and
   * `Container`) whose [media] is `audio` or `muxed-video`; `null` when it can't be exported.
   */
  fun of(codec: String, container: String, media: String): ExportFormat? {
    if (media != "audio") return null
    return when (container) {
      // WebM is Matroska: `.mka` is audio to the scanner, `.webm` a video.
      "webm" -> if (codec == "opus" || codec == "vorbis") ExportFormat("mka", "audio/x-matroska") else null
      "ogg" ->
        when (codec) {
          "opus" -> ExportFormat("opus", "audio/ogg")
          "vorbis" -> ExportFormat("ogg", "audio/ogg")
          "flac" -> ExportFormat("oga", "audio/ogg")
          else -> null
        }
      "mp4", "m4a" -> if (codec == "aac" || codec == "alac") ExportFormat("m4a", "audio/mp4") else null
      "flac" -> if (codec == "flac") ExportFormat("flac", "audio/flac") else null
      "mp3" -> if (codec == "mp3") ExportFormat("mp3", "audio/mpeg") else null
      "wav" -> if (codec == "pcm") ExportFormat("wav", "audio/x-wav") else null
      else -> null
    }
  }

  /**
   * The file name of a song: `Artist, Other artist - Title.ext`, or the title alone. Characters
   * file systems refuse (`/ \ : * ? " < > |` and control characters) become spaces, runs of
   * spaces one, leading dots go (a hidden file), and the name is cut to [MAX_NAME_BYTES].
   */
  fun displayName(title: String, artists: List<String>, extension: String): String {
    val credit = artists.map(::clean).filter { it.isNotEmpty() }.joinToString(", ")
    val name = clean(title).let { if (credit.isEmpty()) it else if (it.isEmpty()) credit else "$credit - $it" }
    val base = fit(name.ifEmpty { FALLBACK_NAME }, MAX_NAME_BYTES - extension.length - 1)
    return "$base.$extension"
  }

  /**
   * [displayName] or, while [taken] says it is in use, `Name (1).ext`, `Name (2).ext` and so on,
   * as MediaStore names copies (on Android 9 and older FXM picks the name itself).
   */
  fun unique(displayName: String, taken: (String) -> Boolean): String {
    if (!taken(displayName)) return displayName
    val (base, extension) = split(displayName)
    for (number in 1..MAX_COPIES) {
      val candidate = "$base ($number)$extension"
      if (!taken(candidate)) return candidate
    }
    throw DownloadFileException(DownloadFiles.IO, "Too many songs are named $displayName")
  }

  /**
   * Which of [names], the files in Music/FXM as long as a song FXM would save as [displayName], is
   * that song saved before: the name itself, else its lowest numbered copy (`Name (1).ext`), the
   * name it got when another song had taken its own ([unique]). `null` when none is.
   */
  fun savedBefore(displayName: String, names: Collection<String>): String? {
    if (displayName in names) return displayName
    return names.mapNotNull { name -> copyNumber(name, displayName)?.let { number -> number to name } }.minByOrNull { it.first }?.second
  }

  /** The number of [name] as a numbered copy of [displayName] (`Name (3).ext`: 3), else `null`. */
  fun copyNumber(name: String, displayName: String): Int? {
    val (base, extension) = split(displayName)
    val prefix = "$base ("
    val suffix = ")$extension"
    if (name.length <= prefix.length + suffix.length || !name.startsWith(prefix) || !name.endsWith(suffix)) return null
    val digits = name.substring(prefix.length, name.length - suffix.length)
    if (digits.length > COPY_DIGITS || digits.startsWith("0") || !digits.all { it in '0'..'9' }) return null
    return digits.toInt()
  }

  /** The most numbered copies of one name [unique] tries (MediaStore stops at 31). */
  private const val MAX_COPIES = 999

  /** The digits of the highest copy number [copyNumber] reads. */
  private const val COPY_DIGITS = 4

  /** [displayName]'s base and its extension with the dot (empty when it has none). */
  private fun split(displayName: String): Pair<String, String> {
    val dot = displayName.lastIndexOf('.')
    return if (dot > 0) displayName.substring(0, dot) to displayName.substring(dot) else displayName to ""
  }

  private val REFUSED = Regex("[/\\\\:*?\"<>|\\p{Cntrl}]")
  private val SPACES = Regex("\\s+")

  private fun clean(text: String): String = text.replace(REFUSED, " ").replace(SPACES, " ").trim().trimStart('.').trim()

  /** [text] cut to at most [maxBytes] UTF-8 bytes, never inside a character, without a trailing dot or space. */
  private fun fit(text: String, maxBytes: Int): String {
    if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text
    val out = StringBuilder()
    var bytes = 0
    var index = 0
    while (index < text.length) {
      val codePoint = text.codePointAt(index)
      val chars = Character.charCount(codePoint)
      val size = String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8).size
      if (bytes + size > maxBytes) break
      out.appendCodePoint(codePoint)
      bytes += size
      index += chars
    }
    return out.toString().trimEnd('.', ' ').ifEmpty { FALLBACK_NAME }
  }
}

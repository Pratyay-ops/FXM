package io.github.pratyayops.fxm.downloads

import java.io.File
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DownloadFilesTest {
  @get:Rule val temp = TemporaryFolder()

  /** Room on a storage of 20 GB, as much free as a test says. */
  private class FakeSpace(var free: Long = 5_000_000_000, val size: Long = 20_000_000_000) : DownloadFiles.Space {
    override fun usable() = free

    override fun total() = size
  }

  private fun store(space: DownloadFiles.Space = FakeSpace()) = DownloadFiles(File(temp.root, "files/downloads"), space)

  private fun code(block: () -> Unit): String {
    try {
      block()
    } catch (e: DownloadFileException) {
      return e.code
    }
    fail("expected a DownloadFileException")
    throw AssertionError()
  }

  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  @Test
  fun `a download is written in order, flushed, closed and read back`() {
    val files = store()
    val opened = files.open("a-1")
    assertEquals(0L, opened.size)
    assertEquals(3L, files.write(opened.handle, 0, bytes(1, 2, 3)))
    assertEquals(5L, files.write(opened.handle, 3, bytes(4, 5)))
    files.flush(opened.handle)
    assertEquals(5L, files.size(opened.handle))
    files.close(opened.handle)
    // Closing twice, or a handle nobody knows, is fine.
    files.close(opened.handle)
    files.close("w999")
    assertEquals(5L, files.stat("a-1")?.size)
    assertArrayEquals(bytes(1, 2, 3, 4, 5), File(temp.root, "files/downloads/a-1").readBytes())
    assertEquals(listOf("a-1"), files.list())
    assertEquals(5L, files.bytesWritten)
  }

  @Test
  fun `the folder is made when the storage is first used`() {
    val files = store()
    assertFalse(files.directory.exists())
    assertTrue(files.ready())
    assertTrue(files.directory.isDirectory)
    // A file where the folder should be: the storage can't work.
    val blocked = DownloadFiles(temp.newFile("not-a-folder"), FakeSpace())
    assertFalse(blocked.ready())
    assertEquals(DownloadFiles.UNAVAILABLE, code { blocked.open("a") })
  }

  @Test
  fun `a download continues from the size of its file`() {
    val files = store()
    val first = files.open("a")
    files.write(first.handle, 0, bytes(1, 2))
    files.close(first.handle)
    val again = files.open("a")
    assertEquals(2L, again.size)
    files.write(again.handle, 2, bytes(3))
    // Writing past the end leaves zeros in the gap, as the other storages do.
    files.write(again.handle, 5, bytes(9))
    assertEquals(6L, files.size(again.handle))
    assertEquals(2L, files.truncate(again.handle, 2))
    assertEquals(4L, files.truncate(again.handle, 4))
    files.close(again.handle)
    assertArrayEquals(bytes(1, 2, 0, 0), files.read("a", 0, 10)!!.bytes)
  }

  @Test
  fun `one writer per file, and a page's writers go with it`() {
    val files = store()
    val page = Any()
    val writer = files.open("a", page)
    assertEquals(DownloadFiles.BUSY, code { files.open("a", page) })
    assertEquals(DownloadFiles.BUSY, code { files.remove("a") })
    assertEquals(DownloadFiles.BUSY, code { files.completeFile("a") })
    assertEquals(setOf("a"), files.openNames)
    // The next page finds the file its predecessor left open, and takes it over.
    val next = Any()
    val taken = files.open("a", next)
    assertEquals(DownloadFiles.NOT_FOUND, code { files.write(writer.handle, 0, bytes(1)) })
    files.write(taken.handle, 0, bytes(1))
    files.open("b", next)
    files.closeOwnedBy(page)
    assertEquals(setOf("a", "b"), files.openNames)
    files.closeOwnedBy(next)
    assertEquals(emptySet<String>(), files.openNames)
    files.remove("a")
    assertNull(files.stat("a"))
    // Removing a file that is gone is fine.
    files.remove("a")
  }

  @Test
  fun `names other than the manager's are refused before the file system is touched`() {
    val files = store()
    for (name in listOf("", "../escape", "a/b", "a.webm", "con", "LPT1", "x".repeat(65), "naïve")) {
      assertEquals(name, DownloadFiles.BAD_REQUEST, code { files.open(name) })
      assertEquals(name, DownloadFiles.BAD_REQUEST, code { files.remove(name) })
      assertEquals(name, DownloadFiles.BAD_REQUEST, code { files.stat(name) })
    }
    assertFalse(File(temp.root, "escape").exists())
    assertTrue(DownloadFiles.isSafeName("2f1c0d3e-9a4b-4c5d-8e6f-7a8b9c0d1e2f"))
    // Files the manager didn't name are not its own.
    File(temp.root, "files/downloads").mkdirs()
    File(temp.root, "files/downloads/notes.txt").writeText("x")
    File(temp.root, "files/downloads/folder").mkdirs()
    assertEquals(emptyList<String>(), files.list())
  }

  @Test
  fun `downloads leave Android's low-storage reserve free`() {
    val space = FakeSpace(free = 600L * 1024 * 1024)
    val files = store(space)
    // 5 % of 20 GB is more than 500 MiB: the reserve is 500 MiB.
    assertEquals(500L * 1024 * 1024, files.reserve())
    assertEquals(100L * 1024 * 1024, files.available())
    val writer = files.open("a")
    files.write(writer.handle, 0, ByteArray(1024))
    space.free = files.reserve() + 10
    assertEquals(DownloadFiles.NO_SPACE, code { files.write(writer.handle, 1024, ByteArray(11)) })
    assertEquals(DownloadFiles.NO_SPACE, code { files.truncate(writer.handle, 5000) })
    // Overwriting what is there takes no room; shrinking neither.
    files.write(writer.handle, 0, ByteArray(512))
    assertEquals(10L, files.truncate(writer.handle, 10))
    // On a small storage the reserve is 5 %.
    assertEquals(100_000L, DownloadFiles.reserveBytes(2_000_000))
  }

  @Test
  fun `a full disk is reported as no space, other failures as IO`() {
    assertEquals(DownloadFiles.NO_SPACE, DownloadFiles.failure("m", IOException("write failed: ENOSPC (No space left on device)")).code)
    assertEquals(DownloadFiles.NO_SPACE, DownloadFiles.failure("m", IOException("x", IOException("No space left on device"))).code)
    assertEquals(DownloadFiles.IO, DownloadFiles.failure("m", IOException("EIO")).code)
    val own = DownloadFileException(DownloadFiles.BUSY, "m")
    assertTrue(DownloadFiles.failure("other", own) === own)
  }

  @Test
  fun `reads come in chunks, and a gone file reads as nothing`() {
    val files = store()
    val writer = files.open("a")
    files.write(writer.handle, 0, bytes(1, 2, 3, 4, 5))
    files.close(writer.handle)
    val chunk = files.read("a", 3, 10)!!
    assertArrayEquals(bytes(4, 5), chunk.bytes)
    assertEquals(5L, chunk.size)
    assertArrayEquals(ByteArray(0), files.read("a", 9, 10)!!.bytes)
    assertNull(files.read("missing", 0, 1))
    assertEquals(DownloadFiles.BAD_REQUEST, code { files.read("a", -1, 1) })
    assertEquals(File(temp.root, "files/downloads/a").canonicalFile, files.completeFile("a").canonicalFile)
    assertEquals(DownloadFiles.NOT_FOUND, code { files.completeFile("missing") })
  }

  @Test
  fun `handles that were never opened are unknown`() {
    val files = store()
    for (call in listOf<() -> Unit>(
      { files.write("w1", 0, bytes(1)) },
      { files.truncate("w1", 0) },
      { files.flush("w1") },
      { files.size("w1") },
    )) {
      assertEquals(DownloadFiles.NOT_FOUND, code(call))
    }
    val writer = files.open("a")
    assertEquals(DownloadFiles.BAD_REQUEST, code { files.write(writer.handle, -1, bytes(1)) })
    assertEquals(DownloadFiles.BAD_REQUEST, code { files.truncate(writer.handle, -1) })
  }

  @Test
  fun `every failure has a code the web app knows`() {
    assertEquals(DownloadFiles.BUSY, DownloadFiles.codeOf(DownloadFileException(DownloadFiles.BUSY, "a-1 is open")))
    assertEquals(DownloadFiles.NO_SPACE, DownloadFiles.codeOf(IOException("write failed: ENOSPC (No space left on device)")))
    assertEquals(DownloadFiles.IO, DownloadFiles.codeOf(IOException("Music/FXM can't be created")))
    assertEquals(DownloadFiles.IO, DownloadFiles.codeOf(SecurityException("no")))
    assertEquals(DownloadFiles.IO, DownloadFiles.codeOf(InterruptedException()))
  }
}

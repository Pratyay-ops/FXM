package io.github.pratyayops.fxm.http

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.plugin.CapacitorHttp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DisabledCapacitorHttpTest {
  /** A call that records how the plugin answered, without a bridge. */
  private class RecordedCall(method: String) :
    PluginCall(null, DisabledCapacitorHttp.NAME, "1", method, JSObject()) {
    var code: String? = null
    var message: String? = null

    override fun reject(msg: String?, code: String?, ex: Exception?, data: JSObject?) {
      this.message = msg
      this.code = code
    }
  }

  /**
   * The plugin methods [type] declares itself: those of the HTTP plugin, without the listener and
   * permission methods every plugin inherits.
   */
  private fun pluginMethods(type: Class<*>): Set<String> =
    type.declaredMethods
      .filter { it.isAnnotationPresent(PluginMethod::class.java) }
      .map { it.name }
      .toSet()

  @Test
  fun `it takes the place of Capacitor's own CapacitorHttp plugin, method for method`() {
    // The bridge keys plugins by name: the annotation's, else the class's simple name.
    val builtIn = CapacitorHttp::class.java
    val builtInName =
      builtIn.getAnnotation(CapacitorPlugin::class.java)!!.name.ifEmpty { builtIn.simpleName }
    val ours = DisabledCapacitorHttp::class.java.getAnnotation(CapacitorPlugin::class.java)!!.name
    assertEquals(builtInName, ours)
    val builtInMethods = pluginMethods(builtIn)
    assertTrue(builtInMethods.containsAll(listOf("request", "get", "post", "delete")))
    assertEquals(builtInMethods, pluginMethods(DisabledCapacitorHttp::class.java))
  }

  @Test
  fun `every call is refused`() {
    val plugin = DisabledCapacitorHttp()
    for (method in pluginMethods(DisabledCapacitorHttp::class.java)) {
      val call = RecordedCall(method)
      DisabledCapacitorHttp::class.java.getMethod(method, PluginCall::class.java).invoke(plugin, call)
      assertEquals(method, "UNAVAILABLE", call.code)
      assertEquals(method, DisabledCapacitorHttp.MESSAGE, call.message)
    }
  }
}

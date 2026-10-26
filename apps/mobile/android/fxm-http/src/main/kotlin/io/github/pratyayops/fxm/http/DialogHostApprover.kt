package io.github.pratyayops.fxm.http

import android.app.Activity
import androidx.appcompat.app.AlertDialog

/**
 * Asks the user in a system dialog, which the WebView's JavaScript can neither show nor answer.
 * Dismissing it counts as "Don't allow". Without a usable activity the answer is
 * [Answer.UNAVAILABLE].
 */
class DialogHostApprover(private val activity: () -> Activity?) : HostApprover {
  override fun confirm(hosts: List<String>, answer: (Answer) -> Unit) {
    val activity = activity()
    if (activity == null || activity.isFinishing || activity.isDestroyed) {
      return answer(Answer.UNAVAILABLE)
    }
    activity.runOnUiThread {
      if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread answer(Answer.UNAVAILABLE)
      var answered = false
      val reply = { result: Answer ->
        if (!answered) {
          answered = true
          answer(result)
        }
      }
      val resources = activity.resources
      AlertDialog.Builder(activity)
        .setTitle(resources.getQuantityString(R.plurals.fxm_http_approve_title, hosts.size))
        .setMessage(
          resources.getQuantityString(
            R.plurals.fxm_http_approve_message,
            hosts.size,
            hosts.joinToString("\n"),
          ),
        )
        .setPositiveButton(R.string.fxm_http_approve_allow) { _, _ -> reply(Answer.ALLOWED) }
        .setNegativeButton(R.string.fxm_http_approve_deny) { _, _ -> reply(Answer.DENIED) }
        .setOnDismissListener { reply(Answer.DENIED) }
        .show()
    }
  }
}

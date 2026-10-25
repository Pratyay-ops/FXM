package io.github.pratyayops.fxm.http

import java.util.concurrent.atomic.AtomicBoolean

/** The user's answer to a request to approve hosts. */
enum class Answer {
  ALLOWED,
  DENIED,

  /** Nobody could be asked: no screen to show the question on. */
  UNAVAILABLE,
}

/** Asks the user whether FXM may contact hosts. The app shows a system dialog ([DialogHostApprover]). */
fun interface HostApprover {
  /** Asks about [hosts]; [answer] must be called exactly once, on any thread. */
  fun confirm(hosts: List<String>, answer: (Answer) -> Unit)
}

/**
 * Approves hosts outside FXM's host table: those the user has not approved yet are put to them
 * through [approver], at most one question per host at a time, and the answers are kept in
 * [store]. Because the question is a system dialog, the web app (or anything running in it)
 * cannot approve a host by itself.
 */
class HostApprovals(private val store: ApprovedHosts, private val approver: HostApprover) {
  private class Waiter(
    val hosts: List<String>,
    val remaining: MutableSet<String>,
    val done: (List<String>) -> Unit,
    val failed: (BridgeError) -> Unit,
  ) {
    var unavailable = false
  }

  private val asking = mutableSetOf<String>()
  private val waiters = mutableListOf<Waiter>()

  /**
   * Approves normalized [hosts]: [done] gets those approved afterwards (all of them once the user
   * allows), [failed] a [BridgeErrorCode.NO_ACTIVITY] error when nobody could be asked.
   */
  fun approve(hosts: List<String>, done: (List<String>) -> Unit, failed: (BridgeError) -> Unit) {
    val ask: List<String>
    val approvedAlready: Boolean
    synchronized(this) {
      val missing = hosts.filter { it !in store }
      approvedAlready = missing.isEmpty()
      if (approvedAlready) {
        ask = emptyList()
      } else {
        waiters.add(Waiter(hosts, missing.toMutableSet(), done, failed))
        ask = missing.filter { it !in asking }
        asking.addAll(ask)
      }
    }
    if (approvedAlready) return done(hosts)
    if (ask.isEmpty()) return
    val once = AtomicBoolean()
    approver.confirm(ask) { answer -> if (once.compareAndSet(false, true)) answered(ask, answer) }
  }

  private fun answered(hosts: List<String>, answer: Answer) {
    val finished = mutableListOf<Waiter>()
    synchronized(this) {
      asking.removeAll(hosts.toSet())
      if (answer == Answer.ALLOWED) store.add(hosts)
      val iterator = waiters.iterator()
      while (iterator.hasNext()) {
        val waiter = iterator.next()
        if (!waiter.remaining.removeAll(hosts.toSet())) continue
        if (answer == Answer.UNAVAILABLE) waiter.unavailable = true
        if (waiter.remaining.isEmpty()) {
          iterator.remove()
          finished.add(waiter)
        }
      }
    }
    for (waiter in finished) {
      val approved = waiter.hosts.filter { it in store }
      if (waiter.unavailable && approved.size < waiter.hosts.size) {
        waiter.failed(BridgeError(BridgeErrorCode.NO_ACTIVITY, "FXM is not on screen to ask"))
      } else {
        waiter.done(approved)
      }
    }
  }
}

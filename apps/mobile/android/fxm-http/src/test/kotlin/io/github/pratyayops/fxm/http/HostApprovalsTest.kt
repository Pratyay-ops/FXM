package io.github.pratyayops.fxm.http

import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostApprovalsTest {
  /** Records each question and answers when the test says so. */
  private class FakeApprover : HostApprover {
    val questions = CopyOnWriteArrayList<List<String>>()
    private val answers = CopyOnWriteArrayList<(Answer) -> Unit>()

    override fun confirm(hosts: List<String>, answer: (Answer) -> Unit) {
      questions.add(hosts)
      answers.add(answer)
    }

    fun answer(index: Int, answer: Answer) = answers[index](answer)
  }

  private class Outcome {
    var approved: List<String>? = null
    var error: BridgeError? = null
  }

  private val store = InMemoryApprovedHosts(listOf("known.example"))
  private val approver = FakeApprover()
  private val approvals = HostApprovals(store, approver)

  private fun approve(vararg hosts: String) =
    Outcome().also { outcome -> approvals.approve(hosts.toList(), { outcome.approved = it }, { outcome.error = it }) }

  @Test
  fun `hosts approved before are not asked about again`() {
    val outcome = approve("known.example")
    assertEquals(listOf("known.example"), outcome.approved)
    assertTrue(approver.questions.isEmpty())
  }

  @Test
  fun `allowing approves and remembers the hosts`() {
    val outcome = approve("known.example", "new.example")
    assertEquals(listOf(listOf("new.example")), approver.questions)
    assertNull(outcome.approved)
    approver.answer(0, Answer.ALLOWED)
    assertEquals(listOf("known.example", "new.example"), outcome.approved)
    assertTrue("new.example" in store)
  }

  @Test
  fun `denying approves nothing new`() {
    val outcome = approve("new.example")
    approver.answer(0, Answer.DENIED)
    assertEquals(emptyList<String>(), outcome.approved)
    assertTrue("new.example" !in store)
  }

  @Test
  fun `concurrent requests for a host share one question`() {
    val first = approve("new.example")
    val second = approve("new.example", "other.example")
    assertEquals(listOf(listOf("new.example"), listOf("other.example")), approver.questions)
    approver.answer(0, Answer.ALLOWED)
    assertEquals(listOf("new.example"), first.approved)
    assertNull(second.approved)
    approver.answer(1, Answer.DENIED)
    assertEquals(listOf("new.example"), second.approved)
  }

  @Test
  fun `without a screen to ask on, the request fails`() {
    val outcome = approve("new.example")
    approver.answer(0, Answer.UNAVAILABLE)
    assertEquals(BridgeErrorCode.NO_ACTIVITY, outcome.error?.code)
    assertNull(outcome.approved)
  }

  @Test
  fun `a second answer to one question is ignored`() {
    val outcome = approve("new.example")
    approver.answer(0, Answer.DENIED)
    approver.answer(0, Answer.ALLOWED)
    assertEquals(emptyList<String>(), outcome.approved)
    assertTrue("new.example" !in store)
  }
}

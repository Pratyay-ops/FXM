import { showFeedback } from '../search/feedback'

/**
 * Shows the confirmation or failure of a library action, e.g. "Added to Road trip", in the app's
 * one toast (`FeedbackToast`). The shell renders that toast on every page, so an action taken in
 * the sidebar is confirmed wherever the user is; screen readers announce it, and a message whose
 * time has passed never shows later, out of context.
 */
export function showStatus(text: string): void {
  showFeedback(text)
}

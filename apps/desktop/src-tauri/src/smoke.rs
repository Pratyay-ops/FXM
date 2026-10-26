//! The end of the live smoke test (apps/desktop/smoke), started only in a build with the `smoke`
//! feature, which no release build turns on: the hidden page emits its progress and its report
//! as events, and the app prints each on a line of stdout and exits with the report's verdict.

use tauri::{AppHandle, Listener, Runtime};

/// The event the smoke page emits with a line of progress.
pub const LOG_EVENT: &str = "fxm-smoke-log";

/// The event the smoke page emits with its report.
pub const REPORT_EVENT: &str = "fxm-smoke-report";

/// What starts a progress line on stdout, for `smoke/run.mjs`.
pub const LOG_PREFIX: &str = "FXM_SMOKE_LOG ";

/// What starts the report's line on stdout, for `smoke/run.mjs`.
pub const REPORT_PREFIX: &str = "FXM_SMOKE_REPORT ";

/// Whether a report says the test passed: its `ok` is `true`.
pub fn passed(report: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(report)
        .ok()
        .and_then(|report| report.get("ok")?.as_bool())
        .unwrap_or(false)
}

/// Prints the page's progress, then its report, and exits: 0 when it passed, 1 otherwise.
pub fn listen<R: Runtime>(app: &AppHandle<R>) {
    app.listen(LOG_EVENT, |event| {
        println!("{LOG_PREFIX}{}", event.payload());
    });
    let handle = app.clone();
    app.listen(REPORT_EVENT, move |event| {
        let report = event.payload();
        println!("{REPORT_PREFIX}{report}");
        handle.exit(if passed(report) { 0 } else { 1 });
    });
}

#[cfg(test)]
mod tests {
    use super::passed;

    #[test]
    fn only_a_report_that_says_ok_passes() {
        assert!(passed(r#"{"ok":true,"steps":[]}"#));
        assert!(!passed(r#"{"ok":false,"steps":[]}"#));
        assert!(!passed(r#"{"steps":[]}"#));
        assert!(!passed("not json"));
    }
}

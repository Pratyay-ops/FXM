//! What the web app can't learn from its webview about where it runs (stage 7.3): the
//! operating system and its version, the webview's version and whether there is a tray icon.
//!
//! The macOS version decides between Opus and AAC: WebKit plays Opus in WebM only from macOS
//! 15.4, and a WKWebView's User-Agent names macOS 10.15.7 on every version. The versions also go
//! into the live smoke test's report.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::tray::Tray;

/// Where the desktop app runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEnvironment {
    /// The operating system, as Rust names it: `macos`, `windows` or `linux`.
    pub os: &'static str,
    /// Its version, such as `15.5.0`, where FXM reads it: macOS only for now.
    pub os_version: Option<String>,
    /// The webview's version: WebKit's on macOS, WebView2's on Windows, WebKitGTK's on Linux.
    pub webview_version: Option<String>,
    /// Whether FXM has a tray icon.
    pub tray: bool,
}

/// Where the desktop app runs.
#[tauri::command]
pub fn desktop_environment<R: Runtime>(app: AppHandle<R>) -> DesktopEnvironment {
    DesktopEnvironment {
        os: std::env::consts::OS,
        os_version: os_version(),
        webview_version: tauri::webview_version().ok(),
        tray: app.try_state::<Tray<R>>().is_some(),
    }
}

/// The macOS version, such as `15.5.0`.
#[cfg(target_os = "macos")]
pub fn os_version() -> Option<String> {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    Some(format!(
        "{}.{}.{}",
        version.majorVersion, version.minorVersion, version.patchVersion
    ))
}

/// The OS version where FXM doesn't read it yet: Windows and Linux.
#[cfg(not(target_os = "macos"))]
pub fn os_version() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::os_version;

    #[test]
    fn reads_the_macos_version_as_three_numbers() {
        let version = os_version();
        if cfg!(target_os = "macos") {
            let version = version.expect("macOS reports its version");
            let parts: Vec<u32> = version
                .split('.')
                .map(|part| part.parse().expect("a number"))
                .collect();
            assert_eq!(parts.len(), 3, "{version}");
            assert!(
                parts[0] >= 11,
                "FXM supports macOS 11 and later, not {version}"
            );
        } else {
            assert_eq!(version, None);
        }
    }
}

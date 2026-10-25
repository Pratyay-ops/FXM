//! macOS: closing the main window while it is in full screen (stage 7.3).
//!
//! Hiding a window in full screen (`orderOut:`) leaves its Space behind, empty and black, until
//! the user swipes away: AppKit takes a window out of its full-screen Space only when the window
//! leaves full screen or closes. Electron apps meet the same problem (electron#20263). So the
//! close button first takes the window out of full screen, and hides it once AppKit says that it
//! has left: `NSWindowDidExitFullScreenNotification`, posted when the animation has ended. Tauri
//! can't tell when that is: tao marks the window as windowed as soon as it is asked to leave.

use std::{cell::RefCell, ptr::NonNull, rc::Rc, time::Instant};

use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{NSWindow, NSWindowDidExitFullScreenNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
use tauri::{Manager, Runtime, Window};

use crate::window::PendingHide;

/// What `addObserverForName:object:queue:usingBlock:` returns, kept to remove the observer.
type Observer = Retained<ProtocolObject<dyn NSObjectProtocol>>;

/// Takes `window` out of full screen and hides it once it has left. When AppKit can't be
/// watched, the window only leaves full screen and stays in sight: the next close hides it.
pub fn exit_then_hide<R: Runtime>(window: &Window<R>) {
    if let Some(pending) = window.try_state::<PendingHide>()
        && watch_exit(window).is_ok()
    {
        pending.start(Instant::now());
    }
    if window.set_fullscreen(false).is_err()
        && let Some(pending) = window.try_state::<PendingHide>()
    {
        pending.cancel();
    }
}

/// Hides `window` the first time AppKit says that it has left full screen, if the hide is still
/// pending then (see [`PendingHide`]).
fn watch_exit<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let ns_window = window.ns_window()?;
    // SAFETY: Tauri hands out the window's NSWindow, which lives as long as the window, and
    // window events, which call this, run on the main thread.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast::<NSWindow>() };
    let observer: Rc<RefCell<Option<Observer>>> = Rc::default();
    let block = {
        let observer = Rc::clone(&observer);
        let window = window.clone();
        RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(observer) = observer.borrow_mut().take() {
                let observer: &AnyObject = (*observer).as_ref();
                // SAFETY: the observer is the one `addObserverForName` returned for this block.
                unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer) };
            }
            // Hidden once AppKit and tao have handled the notification.
            let hidden = window.clone();
            let _ = window.app_handle().run_on_main_thread(move || {
                if hidden.state::<PendingHide>().take(Instant::now()) {
                    let _ = hidden.hide();
                }
            });
        })
    };
    let object: &AnyObject = ns_window.as_ref();
    // SAFETY: the name is AppKit's and the object the window it is posted for. Without a queue
    // the block runs on the thread that posts the notification, and AppKit posts window
    // notifications on the main thread, the only one that touches the block's `Rc`.
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidExitFullScreenNotification),
            Some(object),
            None,
            &block,
        )
    };
    *observer.borrow_mut() = Some(token);
    Ok(())
}

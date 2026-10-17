//! Held by the daemon and fed as things change, because the deny class reads
//! it on every shell call and cannot wait for it to be worked out.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const IDLE_AFTER: Duration = Duration::from_secs(10 * 60);

// Lock and idle have no event Tori can subscribe to without an observer on the
// main run loop, and a few seconds late is nothing next to ten minutes.
const POLL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Screen {
    pub shown: bool,
    pub locked: bool,
    pub idle: bool,
}

impl Screen {
    /// A window that has just attached, before its first report: somebody opened it.
    pub const OPENED: Screen = Screen {
        shown: true,
        locked: false,
        idle: false,
    };

    pub fn watched(self) -> bool {
        self.shown && !self.locked && !self.idle
    }
}

pub fn idle(quiet: Duration) -> bool {
    quiet >= IDLE_AFTER
}

pub fn attended(window: Option<Screen>, phone_visible: bool) -> bool {
    window.is_some_and(Screen::watched) || phone_visible
}

// `None` with no window attached.
#[derive(Default)]
pub struct Attachment(Mutex<Option<Screen>>);

impl Attachment {
    pub fn window(&self, screen: Option<Screen>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = screen;
    }

    pub fn attached(&self, phone_visible: bool) -> bool {
        attended(*self.0.lock().unwrap_or_else(|e| e.into_inner()), phone_visible)
    }
}

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let now = read(&app);
            if last != Some(now) {
                last = Some(now);
                super::rpc_presence(now);
            }
            std::thread::sleep(POLL);
        }
    });
}

fn read(app: &AppHandle) -> Screen {
    let shown = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    Screen {
        shown,
        locked: mac::locked(),
        idle: idle(mac::quiet()),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void};
    use std::time::Duration;

    type Ref = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> Ref;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDictionaryGetValue(dict: Ref, key: Ref) -> Ref;
        fn CFStringCreateWithCString(alloc: Ref, s: *const c_char, encoding: u32) -> Ref;
        fn CFGetTypeID(cf: Ref) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(b: Ref) -> u8;
        fn CFRelease(cf: Ref);
    }

    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = u32::MAX;
    const UTF8: u32 = 0x0800_0100;

    pub fn quiet() -> Duration {
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
        Duration::from_secs_f64(secs.max(0.0))
    }

    // The key is present only while the screen is locked. No session dictionary
    // at all means no console session, which is not a locked one.
    pub fn locked() -> bool {
        unsafe {
            let session = CGSessionCopyCurrentDictionary();
            if session.is_null() {
                return false;
            }
            let key = CFStringCreateWithCString(std::ptr::null(), c"CGSSessionScreenIsLocked".as_ptr(), UTF8);
            let value = CFDictionaryGetValue(session, key);
            let locked =
                !value.is_null() && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value) != 0;
            CFRelease(key);
            CFRelease(session);
            locked
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use std::time::Duration;

    pub fn quiet() -> Duration {
        Duration::ZERO
    }

    pub fn locked() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AWAY: Screen = Screen {
        shown: true,
        locked: false,
        idle: true,
    };

    #[test]
    fn only_a_shown_unlocked_busy_window_attends() {
        assert!(attended(Some(Screen::OPENED), false));
        for screen in [
            Screen {
                shown: false,
                ..Screen::OPENED
            },
            Screen {
                locked: true,
                ..Screen::OPENED
            },
            AWAY,
        ] {
            assert!(!attended(Some(screen), false), "{screen:?}");
        }
        assert!(!attended(None, false));
    }

    #[test]
    fn a_visible_phone_attends_whatever_the_window() {
        assert!(attended(None, true));
        assert!(attended(Some(AWAY), true));
    }

    #[test]
    fn idle_starts_at_ten_minutes() {
        assert!(!idle(Duration::from_secs(599)));
        assert!(idle(Duration::from_secs(600)));
    }

    #[test]
    fn the_attachment_follows_the_last_report() {
        let a = Attachment::default();
        assert!(!a.attached(false), "no window yet");
        a.window(Some(Screen::OPENED));
        assert!(a.attached(false));
        a.window(Some(Screen {
            locked: true,
            ..Screen::OPENED
        }));
        assert!(!a.attached(false));
        a.window(Some(Screen::OPENED));
        a.window(None);
        assert!(!a.attached(false), "the window dropped");
    }
}

//! Keeps the Mac from idle sleeping while the remote front listens, since a
//! sleeping Mac drops every phone. A closed lid on battery still sleeps.

use std::ffi::{c_char, c_void, CString};

type CFStringRef = *const c_void;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(alloc: *const c_void, text: *const c_char, encoding: u32) -> CFStringRef;
    fn CFRelease(cf: *const c_void);
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

const UTF8: u32 = 0x0800_0100;
const LEVEL_ON: u32 = 255;

/// Held while alive. IOKit drops it with the process too, so a crash cannot leak it.
pub struct Awake(u32);

impl Awake {
    pub fn hold(reason: &str) -> Option<Self> {
        let kind = cf_string("PreventUserIdleSystemSleep")?;
        let Some(name) = cf_string(reason) else {
            unsafe { CFRelease(kind) };
            return None;
        };
        let mut id = 0;
        let status = unsafe { IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) };
        unsafe {
            CFRelease(kind);
            CFRelease(name);
        }
        (status == 0).then_some(Self(id))
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        unsafe { IOPMAssertionRelease(self.0) };
    }
}

fn cf_string(text: &str) -> Option<CFStringRef> {
    let text = CString::new(text).ok()?;
    let cf = unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) };
    (!cf.is_null()).then_some(cf)
}

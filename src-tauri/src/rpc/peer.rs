//! Which code is on the other end of the daemon's socket. The window and a tab
//! attach prove they are Tori by the signature the kernel holds for the peer,
//! since anything running as this user can read the file token.

use std::os::fd::AsRawFd;
use std::sync::OnceLock;

use core_foundation_sys::base::{kCFAllocatorDefault, CFIndex, CFRelease, CFTypeRef, OSStatus};
use core_foundation_sys::data::{CFDataCreate, CFDataGetBytePtr, CFDataGetLength, CFDataRef};
use core_foundation_sys::dictionary::{
    kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate, CFDictionaryGetValue,
    CFDictionaryRef,
};
use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithBytes, CFStringRef};
use security_framework_sys::code_signing::{
    kSecGuestAttributeAudit, SecCSFlags, SecCodeCheckValidity, SecCodeCopyGuestWithAttributes, SecCodeCopySelf,
    SecCodeRef, SecRequirementCreateWithString, SecRequirementRef, SecStaticCodeRef,
};

pub type AuditToken = [u32; 8];

const RELEASE: &str = "anchor apple generic and certificate leaf[subject.OU] = \"C328TXY8Q3\"";

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecCodeInfoUnique: CFStringRef;
    fn SecCodeCopySigningInformation(code: SecStaticCodeRef, flags: SecCSFlags, info: *mut CFDictionaryRef)
        -> OSStatus;
}

struct Owned(CFTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: every `Owned` holds a reference a Copy or Create call returned.
        unsafe { CFRelease(self.0) }
    }
}

fn owned<T>(made: *mut T) -> Option<Owned> {
    (!made.is_null()).then(|| Owned(made as CFTypeRef))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Peer {
    Tori,
    Foreign,
    SelfUnsigned,
}

fn sockopt<T: Default>(socket: &impl AsRawFd, name: libc::c_int) -> Option<T> {
    let mut value = T::default();
    let mut len = std::mem::size_of::<T>() as libc::socklen_t;
    // SAFETY: `value` is a plain buffer of `len` bytes that outlives the call.
    let got = unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_LOCAL,
            name,
            (&raw mut value).cast(),
            &mut len,
        )
    };
    (got == 0 && len as usize == std::mem::size_of::<T>()).then_some(value)
}

pub fn audit_token(socket: &impl AsRawFd) -> Option<AuditToken> {
    sockopt(socket, libc::LOCAL_PEERTOKEN)
}

pub fn pid(socket: &impl AsRawFd) -> Option<libc::pid_t> {
    sockopt(socket, libc::LOCAL_PEERPID)
}

fn own() -> Option<Owned> {
    let mut code: SecCodeRef = std::ptr::null_mut();
    // SAFETY: `code` is an out pointer the call fills or leaves null.
    unsafe { SecCodeCopySelf(0, &mut code) };
    owned(code)
}

fn guest(token: &AuditToken) -> Option<Owned> {
    // SAFETY: each Create returns a new reference or null, and the dictionary
    // retains the key and value it is given.
    unsafe {
        let data = owned(CFDataCreate(
            kCFAllocatorDefault,
            token.as_ptr().cast(),
            std::mem::size_of::<AuditToken>() as CFIndex,
        ) as *mut std::ffi::c_void)?;
        let keys = [kSecGuestAttributeAudit.cast::<std::ffi::c_void>()];
        let values = [data.0];
        let attrs = owned(CFDictionaryCreate(
            kCFAllocatorDefault,
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        ) as *mut std::ffi::c_void)?;
        let mut code: SecCodeRef = std::ptr::null_mut();
        SecCodeCopyGuestWithAttributes(std::ptr::null_mut(), attrs.0.cast(), 0, &mut code);
        owned(code)
    }
}

fn cdhash(code: &Owned) -> Option<Vec<u8>> {
    // SAFETY: `info` is filled or left null, and the cdhash is read out of it
    // before it is released.
    unsafe {
        let mut info: CFDictionaryRef = std::ptr::null();
        SecCodeCopySigningInformation(code.0 as SecStaticCodeRef, 0, &mut info);
        let info = owned(info as *mut std::ffi::c_void)?;
        let hash = CFDictionaryGetValue(info.0.cast(), kSecCodeInfoUnique.cast()) as CFDataRef;
        if hash.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(CFDataGetBytePtr(hash), CFDataGetLength(hash) as usize).to_vec())
    }
}

fn requirement(text: &str) -> Option<Owned> {
    // SAFETY: the text is released on return, the parsed requirement by its owner.
    unsafe {
        let text = owned(CFStringCreateWithBytes(
            kCFAllocatorDefault,
            text.as_ptr(),
            text.len() as CFIndex,
            kCFStringEncodingUTF8,
            0,
        ) as *mut std::ffi::c_void)?;
        let mut parsed: SecRequirementRef = std::ptr::null_mut();
        SecRequirementCreateWithString(text.0.cast(), 0, &mut parsed);
        owned(parsed)
    }
}

// Against the kernel's view of the running process, so a binary swapped on
// disk under it reads as invalid rather than as whatever is there now.
fn valid(code: &Owned, requirement: Option<&Owned>) -> bool {
    let requirement = requirement.map_or(std::ptr::null_mut(), |r| r.0 as SecRequirementRef);
    // SAFETY: both references are live for the call, and a null requirement asks for validity alone.
    unsafe { SecCodeCheckValidity(code.0 as SecCodeRef, 0, requirement) == 0 }
}

/// Read once: a rebuild rewrites the binary under a running daemon.
pub fn own_cdhash() -> Option<&'static [u8]> {
    static OWN: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    OWN.get_or_init(|| own().filter(|code| valid(code, None)).and_then(|code| cdhash(&code)))
        .as_deref()
}

/// An unsigned build has no signature to prove itself by, so it shows the file token instead.
pub fn unless_signed<T>(token: impl FnOnce() -> Option<T>) -> Option<T> {
    own_cdhash().is_none().then(token).flatten()
}

pub fn check(mine: Option<&[u8]>, peer: Option<AuditToken>) -> Peer {
    let Some(mine) = mine else { return Peer::SelfUnsigned };
    let Some(code) = peer.as_ref().and_then(guest) else {
        return Peer::Foreign;
    };
    if valid(&code, None) && cdhash(&code).as_deref() == Some(mine) {
        return Peer::Tori;
    }
    match !cfg!(debug_assertions) && requirement(RELEASE).is_some_and(|r| valid(&code, Some(&r))) {
        true => Peer::Tori,
        false => Peer::Foreign,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn a_connection_from_this_binary_carries_its_own_cdhash() {
        let mine = own_cdhash().expect("the test binary is signed");
        let (a, _b) = UnixStream::pair().unwrap();
        let code = guest(&audit_token(&a).unwrap()).unwrap();
        assert_eq!(cdhash(&code).as_deref(), Some(mine));
        assert_eq!(check(Some(mine), audit_token(&a)), Peer::Tori);
    }
}

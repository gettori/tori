//! Process trees, signals, and the process table.

use std::io;
use std::process::{Child, Command};

// A std command that opens no console window on Windows, where a console
// program started from a GUI app flashes one otherwise. Every non-PTY spawn in
// the crate starts here.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let cmd = Command::new(program);
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    cmd
}

// A child and everything it spawns, killable as one: a process group on Unix,
// a Job Object on Windows.
pub struct Group {
    pid: u32,
    #[cfg(windows)]
    job: windows::Win32::Foundation::HANDLE,
}

// SAFETY: the job handle is owned by this value alone and Job Object calls are
// thread safe, so moving or sharing it across threads is sound.
#[cfg(windows)]
unsafe impl Send for Group {}
#[cfg(windows)]
unsafe impl Sync for Group {}

impl Group {
    // Marks `cmd` to start a tree of its own. Call before spawning, then
    // `Group::adopt` the child; `Group::spawn` does both for a std child.
    pub fn prepare(cmd: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        let _ = cmd;
    }

    #[cfg(unix)]
    pub fn adopt(pid: u32) -> io::Result<Self> {
        Ok(Self { pid })
    }

    // Anything the child spawns before it joins the job escapes it. Every
    // caller adopts straight after spawn, which keeps that window to the
    // child's own startup.
    #[cfg(windows)]
    pub fn adopt(pid: u32) -> io::Result<Self> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        // SAFETY: plain Win32 calls on handles this function owns and closes.
        unsafe {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null())?;
            let assigned = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).and_then(|process| {
                let r = AssignProcessToJobObject(job, process);
                let _ = CloseHandle(process);
                r
            });
            if let Err(e) = assigned {
                let _ = CloseHandle(job);
                return Err(e.into());
            }
            Ok(Self { pid, job })
        }
    }

    pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Self)> {
        Self::prepare(cmd);
        let mut child = cmd.spawn()?;
        match Self::adopt(child.id()) {
            Ok(group) => Ok((child, group)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(e)
            }
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn kill_tree(&self) {
        #[cfg(unix)]
        // SAFETY: killpg only sends a signal, to the group this child leads.
        unsafe {
            libc::killpg(self.pid as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        // SAFETY: the job handle is live until drop.
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Group {
    fn drop(&mut self) {
        // SAFETY: closing the handle this value owns. The job outlives it for as
        // long as a process is still in it.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

pub fn kill(pid: u32) {
    #[cfg(unix)]
    signal(pid, libc::SIGKILL);
    #[cfg(windows)]
    terminate_process(pid);
}

// Asks `pid` to exit: SIGTERM on Unix. Windows has no such request for a
// process without a console window, so it is the same as `kill` there.
pub fn terminate(pid: u32) {
    #[cfg(unix)]
    signal(pid, libc::SIGTERM);
    #[cfg(windows)]
    terminate_process(pid);
}

#[cfg(unix)]
fn signal(pid: u32, sig: libc::c_int) {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return };
    if pid > 1 {
        // SAFETY: kill only sends a signal; pids 0 and 1 are refused above.
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

#[cfg(windows)]
fn terminate_process(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: plain Win32 calls on a handle this function owns and closes.
    unsafe {
        if let Ok(process) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(process, 1);
            let _ = CloseHandle(process);
        }
    }
}

pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 checks permission and existence and sends nothing.
        pid > 1 && unsafe { libc::kill(pid, 0) } == 0
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: plain Win32 calls on a handle this function owns and closes.
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let alive = GetExitCodeProcess(process, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
            let _ = CloseHandle(process);
            alive
        }
    }
}

struct Entry {
    pid: u32,
    parent: Option<u32>,
    name: String,
    command_line: String,
}

// The process table read once, command lines included, so a sweep asks the
// OS one time however many processes it looks for.
pub struct Snapshot {
    entries: Vec<Entry>,
}

// How many full snapshots this thread has taken, so a test can assert a sweep
// reads the process table once.
#[cfg(test)]
thread_local! {
    pub static TAKEN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl Snapshot {
    pub fn take() -> Self {
        #[cfg(test)]
        TAKEN.with(|n| n.set(n.get() + 1));
        Self::read(sysinfo::ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always))
    }

    // Names and parents only. Reading every command line is the slow part, and
    // a walk down from one pid needs none of them.
    pub fn tree() -> Self {
        Self::read(sysinfo::ProcessRefreshKind::nothing())
    }

    fn read(kind: sysinfo::ProcessRefreshKind) -> Self {
        use sysinfo::{ProcessesToUpdate, System};
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        let entries = system
            .processes()
            .values()
            .map(|p| Entry {
                pid: p.pid().as_u32(),
                parent: p.parent().map(|pid| pid.as_u32()),
                name: p.name().to_string_lossy().into_owned(),
                command_line: p
                    .cmd()
                    .iter()
                    .map(|arg| arg.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" "),
            })
            .collect();
        Self { entries }
    }

    // Pid and command line of every process whose space-joined command line
    // matches `pattern`, the way `pgrep -f` matches.
    pub fn matching(&self, pattern: &regex::Regex) -> Vec<(u32, &str)> {
        self.entries
            .iter()
            .filter(|e| pattern.is_match(&e.command_line))
            .map(|e| (e.pid, e.command_line.as_str()))
            .collect()
    }

    pub fn children_of(&self, pid: u32) -> Vec<u32> {
        self.entries
            .iter()
            .filter(|e| e.parent == Some(pid))
            .map(|e| e.pid)
            .collect()
    }

    // The executable name of `pid`, as `ps -o ucomm=` prints it.
    pub fn command_name(&self, pid: u32) -> Option<&str> {
        self.entries
            .iter()
            .find(|e| e.pid == pid)
            .map(|e| e.name.as_str())
            .filter(|n| !n.is_empty())
    }
}

// What holds a terminal other than the shell Tori spawned in it, if anything:
// the foreground process group on Unix. Windows has no foreground group, so
// there it is the shell's first child, whatever the shell is running.
pub fn foreign_foreground(master: &dyn portable_pty::MasterPty, shell: u32) -> Option<u32> {
    #[cfg(unix)]
    {
        let pgrp = u32::try_from(master.process_group_leader()?).ok()?;
        (pgrp != shell).then_some(pgrp)
    }
    #[cfg(windows)]
    {
        let _ = master;
        Snapshot::tree().children_of(shell).first().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::testing::{shell_command, sleep_command};
    use std::time::{Duration, Instant};

    fn wait_until(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn this_process_is_alive_and_a_reaped_child_is_not() {
        assert!(pid_alive(std::process::id()));
        let mut child = sleep_command(0).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!pid_alive(pid));
    }

    #[test]
    fn killing_a_group_takes_the_grandchild_with_it() {
        #[cfg(unix)]
        let script = "sleep 30 & wait";
        #[cfg(windows)]
        let script = "ping -n 30 127.0.0.1 >NUL";
        let (mut child, group) = Group::spawn(&mut shell_command(script)).unwrap();
        assert_eq!(group.pid(), child.id());
        let mut grandchild = None;
        assert!(wait_until(|| {
            grandchild = Snapshot::take().children_of(child.id()).first().copied();
            grandchild.is_some()
        }));
        group.kill_tree();
        assert!(wait_until(|| child.try_wait().ok().flatten().is_some()));
        assert!(wait_until(|| !pid_alive(grandchild.unwrap())));
    }

    #[test]
    fn kill_ends_a_child() {
        let mut child = sleep_command(30).spawn().unwrap();
        kill(child.id());
        assert!(wait_until(|| child.try_wait().ok().flatten().is_some()));
    }

    #[test]
    fn a_snapshot_sees_this_process_and_its_children() {
        let mut child = sleep_command(30).spawn().unwrap();
        let snap = Snapshot::take();
        let me = std::process::id();
        assert!(snap.command_name(me).is_some());
        assert!(snap.children_of(me).contains(&child.id()));
        let exe = std::env::current_exe().unwrap();
        let name = regex::escape(&exe.file_name().unwrap().to_string_lossy());
        let pattern = regex::Regex::new(&name).unwrap();
        assert!(snap.matching(&pattern).iter().any(|(pid, _)| *pid == me));
        child.kill().ok();
        child.wait().ok();
    }
}

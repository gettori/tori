//! The app level socket: one JSON-RPC protocol per Tori process, which the CLI,
//! the MCP server and later a WebSocket are all fronts on. See
//! [[adr_one_protocol_several_fronts]].
//!
//! Found two ways. A process Tori spawns gets `TORI_SOCK` and `TORI_TOKEN` in
//! its env; anything else reads the `rpc.json` bridge file, the same shape and
//! the same lifetime rule as the askpass one in `crate::credential`.

pub mod auth;
pub mod client;
pub mod frame;
pub mod hub;
pub mod methods;
pub mod server;
pub mod transport;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use tauri::AppHandle;

use auth::Credential;
use hub::Hub;
use server::{Server, AUTH_TIMEOUT};
use transport::{Transport, UnixTransport};

pub const ENV_SOCK: &str = "TORI_SOCK";
pub const ENV_TOKEN: &str = "TORI_TOKEN";

static SOCKET: OnceLock<(String, String)> = OnceLock::new();
static CLI_DIR: OnceLock<PathBuf> = OnceLock::new();

pub struct RpcState {
    transport: Arc<UnixTransport>,
    pub hub: Arc<Hub>,
}

impl RpcState {
    /// Called at exit. The bridge file goes only if it still names this
    /// instance, so quitting one of two running copies leaves the other findable.
    pub fn shutdown(&self) {
        let path = bridge_path();
        let ours = self.transport.sock_path().to_string_lossy();
        if crate::credential::socket_in_file(&path).is_some_and(|(sock, _)| sock == ours) {
            let _ = std::fs::remove_file(path);
        }
        self.transport.shutdown();
    }
}

pub fn start(app: AppHandle) -> std::io::Result<RpcState> {
    let transport = Arc::new(UnixTransport::bind()?);
    let token = crate::chat::approval::random_token();
    let hub = Arc::new(Hub::default());
    let server = Arc::new(Server {
        credential: Credential::Token(token.clone()),
        hub: hub.clone(),
        backend: Box::new(methods::TauriBackend { app }),
        auth_timeout: AUTH_TIMEOUT,
    });
    server::serve(transport.clone() as Arc<dyn Transport>, server);

    let sock = transport.sock_path().to_string_lossy().into_owned();
    if let Err(e) = crate::credential::write_bridge(&bridge_path(), &sock, &token) {
        eprintln!("tori: rpc bridge file not written: {e}");
    }
    let _ = SOCKET.set((sock, token));
    match link_cli(transport.sock_path()) {
        Ok(dir) => {
            let _ = CLI_DIR.set(dir);
        }
        Err(e) => eprintln!("tori: cli not linked onto PATH: {e}"),
    }
    Ok(RpcState { transport, hub })
}

/// A `bin/tori` link beside the socket, so it goes with the socket's private
/// dir at exit and two running copies each put their own binary first.
fn link_cli(sock: &std::path::Path) -> std::io::Result<PathBuf> {
    let dir = sock.parent().unwrap_or(sock).join("bin");
    std::fs::create_dir_all(&dir)?;
    std::os::unix::fs::symlink(std::env::current_exe()?, dir.join("tori"))?;
    Ok(dir)
}

/// `path` with the directory holding the `tori` link in front. Unchanged when
/// the socket never came up, since a `tori` that cannot reach anything is worse
/// than none.
pub fn path_with_cli(path: &str) -> String {
    match CLI_DIR.get() {
        Some(dir) if path.is_empty() => dir.to_string_lossy().into_owned(),
        Some(dir) => format!("{}:{path}", dir.to_string_lossy()),
        None => path.to_string(),
    }
}

/// Env for a process Tori spawns. Empty when the socket never came up.
pub fn child_env() -> Vec<(String, String)> {
    SOCKET
        .get()
        .map(|(sock, token)| vec![(ENV_SOCK.to_string(), sock.clone()), (ENV_TOKEN.to_string(), token.clone())])
        .unwrap_or_default()
}

pub(crate) fn bridge_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".config/tori/rpc.json")
}

//! Turns the remote front on and off to match `settings.remote`. Off, or a
//! changed address or port, shuts the listener and drops every remote client;
//! the unix socket is never touched.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::auth::Credential;
use super::awake::Awake;
use super::devices::Devices;
use super::pairing::{Offer, Pairing};
use super::server::{serve, Server};
use super::transport::Transport;
use super::ws::WsTransport;
use crate::settings::Remote as Config;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Status {
    Off,
    Listening { url: String },
    Failed { error: String },
}

struct Running {
    transport: Arc<WsTransport>,
    _awake: Option<Awake>,
}

pub struct Remote {
    server: Arc<Server>,
    devices: Arc<Devices>,
    pairing: Arc<Pairing>,
    state: Mutex<(Option<Running>, Status)>,
}

impl Remote {
    pub fn new(server: Arc<Server>, devices: Arc<Devices>, pairing: Arc<Pairing>) -> Self {
        Self {
            server,
            devices,
            pairing,
            state: Mutex::new((None, Status::Off)),
        }
    }

    pub fn apply(&self, config: &Config) -> Status {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let wanted = if config.enabled {
            Some(address(config, &interfaces()))
        } else {
            None
        };
        if let (Some(Ok(addr)), Some(running)) = (&wanted, &state.0) {
            if running.transport.addr() == *addr {
                return state.1.clone();
            }
        }
        // A live code names the old address, so it goes with the listener.
        if let Some(running) = state.0.take() {
            running.transport.shutdown();
            self.pairing.cancel();
        }
        state.1 = match wanted {
            None => Status::Off,
            Some(Err(error)) => Status::Failed { error },
            Some(Ok(addr)) => match WsTransport::bind(addr) {
                Err(e) => Status::Failed {
                    error: format!("{addr}: {e}"),
                },
                Ok(transport) => {
                    let transport = Arc::new(transport);
                    let url = format!("ws://{}", transport.addr());
                    let credential = Arc::new(Credential::Remote {
                        devices: self.devices.clone(),
                        pairing: self.pairing.clone(),
                    });
                    serve(transport.clone() as Arc<dyn Transport>, credential, self.server.clone());
                    state.0 = Some(Running {
                        transport,
                        _awake: Awake::hold("Tori remote front is listening"),
                    });
                    Status::Listening { url }
                }
            },
        };
        state.1.clone()
    }

    pub fn stop(&self) {
        self.apply(&Config::default());
    }

    pub fn status(&self) -> Status {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).1.clone()
    }

    /// A pairing code for the address being listened on.
    pub fn start_pairing(&self) -> Result<Offer, String> {
        let Status::Listening { url } = self.status() else {
            return Err("turn remote access on before pairing a device".into());
        };
        self.devices.writable()?;
        self.pairing.start(&url, crate::owned_state::now_ms())
    }

    pub fn cancel_pairing(&self) {
        self.pairing.cancel();
    }
}

fn address(config: &Config, offered: &[Interface]) -> Result<SocketAddr, String> {
    let text = config
        .address
        .as_deref()
        .filter(|a| !a.is_empty())
        .ok_or("pick an address to listen on")?;
    let ip: IpAddr = text.parse().map_err(|_| format!("{text} is not an IP address"))?;
    if ip.is_unspecified() {
        return Err("listening on every address is not offered; pick one".into());
    }
    // Refused here and not only left out of the picker: the front speaks plain
    // ws://, and settings.json can still name a LAN address an older build saved.
    if !ip.is_loopback() && !offered.iter().any(|i| i.address == ip.to_string()) {
        return Err(format!(
            "{text} is neither Tailscale nor this Mac itself, and the connection is not encrypted on any other network"
        ));
    }
    Ok(SocketAddr::new(ip, config.port))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Tailscale,
    Loopback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Interface {
    pub name: String,
    pub address: String,
    pub kind: Kind,
}

// `None` is an address the picker never offers.
pub fn classify(name: &str, ip: Ipv4Addr) -> Option<Kind> {
    let [a, b, ..] = ip.octets();
    match () {
        _ if ip.is_loopback() => Some(Kind::Loopback),
        // Tailscale hands out 100.64.0.0/10 on a utun.
        _ if name.starts_with("utun") && a == 100 && (64..128).contains(&b) => Some(Kind::Tailscale),
        // Everything else is refused, a LAN too: a device's credential would
        // cross it unencrypted.
        _ => None,
    }
}

const TAILSCALE_APP: &str = "/Applications/Tailscale.app";
const TAILSCALE_DOWNLOAD: &str = "https://tailscale.com/download/mac";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Tailscale {
    Missing,
    Stopped,
    Connected { address: String },
}

// Connected is checked first: a CLI-only install has no app in /Applications.
pub fn tailscale() -> Tailscale {
    if let Some(i) = interfaces().into_iter().find(|i| i.kind == Kind::Tailscale) {
        return Tailscale::Connected { address: i.address };
    }
    if std::path::Path::new(TAILSCALE_APP).exists() {
        Tailscale::Stopped
    } else {
        Tailscale::Missing
    }
}

/// Opens the Tailscale app, or its download page when it is not installed.
/// The destination is fixed here so the webview cannot open anything else.
pub fn open_tailscale() -> Result<(), String> {
    let mut open = std::process::Command::new("open");
    if std::path::Path::new(TAILSCALE_APP).exists() {
        open.arg(TAILSCALE_APP);
    } else {
        open.arg(TAILSCALE_DOWNLOAD);
    }
    crate::exec::spawn_detached(&mut open).map_err(|e| e.to_string())
}

pub fn interfaces() -> Vec<Interface> {
    let mut found = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return found;
    }
    let mut at = head;
    while let Some(ifa) = unsafe { at.as_ref() } {
        at = ifa.ifa_next;
        let Some(addr) = (unsafe { ifa.ifa_addr.as_ref() }) else {
            continue;
        };
        if addr.sa_family as i32 != libc::AF_INET {
            continue;
        }
        let v4 = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in) };
        let ip = Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr));
        let name = unsafe { std::ffi::CStr::from_ptr(ifa.ifa_name) }
            .to_string_lossy()
            .into_owned();
        if let Some(kind) = classify(&name, ip) {
            found.push(Interface {
                name,
                address: ip.to_string(),
                kind,
            });
        }
    }
    unsafe { libc::freeifaddrs(head) };
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picker_offers_tailscale_and_loopback_and_nothing_else() {
        assert_eq!(
            classify("en0", Ipv4Addr::new(192, 168, 1, 20)),
            None,
            "a LAN is not encrypted"
        );
        assert_eq!(classify("utun4", Ipv4Addr::new(100, 101, 7, 9)), Some(Kind::Tailscale));
        assert_eq!(classify("lo0", Ipv4Addr::LOCALHOST), Some(Kind::Loopback));
        assert_eq!(classify("en0", Ipv4Addr::UNSPECIFIED), None);
        assert_eq!(classify("en0", Ipv4Addr::new(169, 254, 3, 4)), None);
        assert_eq!(
            classify("utun2", Ipv4Addr::new(10, 8, 0, 2)),
            None,
            "another VPN's tunnel"
        );
        assert_eq!(
            classify("en0", Ipv4Addr::new(100, 101, 7, 9)),
            None,
            "100.x off a utun is a carrier LAN"
        );
    }

    #[test]
    fn a_saved_lan_address_is_refused_and_tailscale_and_loopback_are_not() {
        let tailnet = [Interface {
            name: "utun4".into(),
            address: "100.101.7.9".into(),
            kind: Kind::Tailscale,
        }];
        let at = |address: &str| address_of(address, &tailnet);
        assert_eq!(at("100.101.7.9"), Ok("100.101.7.9:47821".parse().unwrap()));
        assert_eq!(at("127.0.0.1"), Ok("127.0.0.1:47821".parse().unwrap()));
        assert!(at("192.168.1.20").unwrap_err().contains("not encrypted"));
        assert!(
            address_of("100.101.7.9", &[]).is_err(),
            "Tailscale that has since stopped"
        );
    }

    fn address_of(ip: &str, offered: &[Interface]) -> Result<SocketAddr, String> {
        address(
            &Config {
                enabled: true,
                address: Some(ip.into()),
                port: 47821,
            },
            offered,
        )
    }

    #[test]
    fn off_drops_every_remote_client_and_leaves_the_unix_socket_alone() {
        use crate::rpc::server::tests::StubBackend;
        use crate::rpc::transport::UnixTransport;
        use serde_json::{json, Value};
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        use tungstenite::Message;

        let dir = std::env::temp_dir().join(format!(
            "tori-remote-{}-{}",
            std::process::id(),
            crate::chat::approval::random_token()
        ));
        let devices = Arc::new(Devices::open(dir.join("devices.json")));
        let secret = devices.mint("test").unwrap().1;
        let server = Arc::new(Server {
            hub: Default::default(),
            backend: Box::<StubBackend>::default(),
            auth_timeout: std::time::Duration::from_secs(5),
        });
        let unix = Arc::new(UnixTransport::bind().unwrap());
        let local = Arc::new(Credential::Local {
            process: "tok".into(),
            children: Default::default(),
        });
        serve(unix.clone(), local, server.clone());
        let ended = Arc::new(Mutex::new(Vec::new()));
        let log = ended.clone();
        let remote = Remote::new(
            server,
            devices,
            Arc::new(Pairing::new(Box::new(move |e| log.lock().unwrap().push(e)))),
        );
        assert!(remote.start_pairing().is_err(), "no pairing while off");

        let bad = Config {
            enabled: true,
            address: Some("203.0.113.9".into()),
            port: 0,
        };
        assert!(
            matches!(remote.apply(&bad), Status::Failed { .. }),
            "an address not on this Mac binds nothing"
        );

        let on = Config {
            enabled: true,
            address: Some("127.0.0.1".into()),
            port: 0,
        };
        let Status::Listening { url } = remote.apply(&on) else {
            panic!("{:?}", remote.status())
        };
        let ws = |_| {
            let (mut client, _) = tungstenite::connect(url.as_str()).unwrap();
            client
                .send(Message::text(
                    json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": secret}}).to_string(),
                ))
                .unwrap();
            assert!(matches!(client.read().unwrap(), Message::Text(_)));
            client
        };
        let mut phones: Vec<_> = (0..2).map(ws).collect();
        let offer = remote.start_pairing().unwrap();
        assert_eq!(offer.url, url);

        let mut shell = UnixStream::connect(unix.sock_path()).unwrap();
        let mut lines = BufReader::new(shell.try_clone().unwrap());
        let mut call = |line: Value| {
            shell.write_all(format!("{line}\n").as_bytes()).unwrap();
            let mut reply = String::new();
            lines.read_line(&mut reply).unwrap();
            serde_json::from_str::<Value>(&reply).unwrap()
        };
        assert_eq!(
            call(json!({"jsonrpc": "2.0", "id": 0, "method": "auth", "params": {"token": "tok"}}))["result"],
            json!({})
        );

        assert_eq!(remote.apply(&Config { enabled: false, ..on }), Status::Off);
        assert_eq!(
            *ended.lock().unwrap(),
            vec![crate::rpc::pairing::Ended::Cancelled],
            "turning off cancels the live code"
        );
        for phone in &mut phones {
            match phone.read() {
                Ok(Message::Close(Some(frame))) => assert_eq!(u16::from(frame.code), 1001, "going away, not abnormal"),
                other => panic!("a remote client is told it is closing, got {other:?}"),
            }
            assert!(phone.read().is_err(), "then its connection ends");
        }
        let list = call(json!({"jsonrpc": "2.0", "id": 1, "method": "sessions.list", "params": {}}));
        assert_eq!(list["result"][0]["id"], json!("s1"), "the unix client still answers");

        unix.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

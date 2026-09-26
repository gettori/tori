//! The devices allowed on a network front, each with its own credential. Only
//! a hash is kept, so the file alone cannot be replayed as a login.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created_ms: u64,
    hash: String,
    // The phone's own id for itself, kept across pairings, so pairing it again
    // replaces its entry instead of adding a second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    install: Option<String>,
}

pub struct Devices {
    path: PathBuf,
    list: Mutex<Vec<Device>>,
    // Why the file on disk could not be read. Writing over it would drop
    // every device it holds, so minting is refused until it is fixed.
    unreadable: Option<String>,
}

impl Devices {
    /// A missing file is an empty list, and so is an unreadable one: no device gets in.
    pub fn open(path: PathBuf) -> Self {
        let (list, unreadable) = match std::fs::read_to_string(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(e) => (Vec::new(), Some(e.to_string())),
            Ok(text) => match serde_json::from_str(&text) {
                Ok(list) => (list, None),
                Err(e) => (Vec::new(), Some(e.to_string())),
            },
        };
        Self { path, list: Mutex::new(list), unreadable }
    }

    /// Adds a device and returns it with its credential, the only time the
    /// credential is ever seen.
    pub fn mint(&self, name: &str) -> Result<(Device, String), String> {
        self.mint_install(name, None).map(|(device, credential, _)| (device, credential))
    }

    /// `mint`, also dropping every device paired before from the same
    /// `install`; their ids come back so their connections can be closed.
    pub fn mint_install(&self, name: &str, install: Option<&str>) -> Result<(Device, String, Vec<String>), String> {
        self.writable()?;
        let credential = random_hex::<32>()?;
        let device = Device {
            id: random_hex::<8>()?,
            name: name.to_string(),
            created_ms: crate::owned_state::now_ms(),
            hash: hash(&credential),
            install: install.map(str::to_string),
        };
        let mut list = self.lock();
        let before = list.clone();
        let replaced: Vec<String> = list.iter().filter(|d| install.is_some() && d.install.as_deref() == install).map(|d| d.id.clone()).collect();
        list.retain(|d| !replaced.contains(&d.id));
        list.push(device.clone());
        let text = serde_json::to_string_pretty(&*list).map_err(|e| e.to_string())?;
        if let Err(e) = crate::owned_state::write_private(&self.path, &text) {
            *list = before;
            return Err(e);
        }
        Ok((device, credential, replaced))
    }

    /// Removes a device, so its credential stops working. `false` when no
    /// device has that id.
    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        self.writable()?;
        let mut list = self.lock();
        let Some(at) = list.iter().position(|d| d.id == id) else { return Ok(false) };
        let removed = list.remove(at);
        let text = serde_json::to_string_pretty(&*list).map_err(|e| e.to_string())?;
        if let Err(e) = crate::owned_state::write_private(&self.path, &text) {
            list.insert(at, removed);
            return Err(e);
        }
        Ok(true)
    }

    pub fn list(&self) -> Vec<Device> {
        self.lock().clone()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.lock().iter().any(|d| d.id == id)
    }

    /// Refused while the file on disk could not be read, since writing over it
    /// would drop every device it holds.
    pub fn writable(&self) -> Result<(), String> {
        match &self.unreadable {
            Some(why) => Err(format!("{} could not be read ({why}); fix or remove it before changing devices", self.path.display())),
            None => Ok(()),
        }
    }

    /// The id of the device holding `credential`.
    pub fn find(&self, credential: &str) -> Option<String> {
        let hash = hash(credential);
        self.lock().iter().find(|d| d.hash == hash).map(|d| d.id.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Device>> {
        self.list.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn hash(credential: &str) -> String {
    format!("{:x}", Sha256::digest(credential.as_bytes()))
}

fn random_hex<const N: usize>() -> Result<String, String> {
    let mut buf = [0u8; N];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use std::sync::Arc;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tori-devices-{}-{name}-{}", std::process::id(), random_hex::<4>().unwrap()));
        dir.join("devices.json")
    }

    #[test]
    fn a_minted_credential_is_found_after_a_reload_and_never_stored() {
        let path = temp_path("reload");
        let (device, credential) = Devices::open(path.clone()).mint("phone").unwrap();
        assert_eq!(credential.len(), 64);

        let reloaded = Devices::open(path.clone());
        assert_eq!(reloaded.find(&credential), Some(device.id));
        assert_eq!(reloaded.find("not-a-credential"), None);
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert!(!std::fs::read_to_string(&path).unwrap().contains(&credential));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_revoked_device_is_gone_after_a_reload() {
        let path = temp_path("revoke");
        let devices = Devices::open(path.clone());
        let (kept, kept_secret) = devices.mint("tablet").unwrap();
        let (gone, gone_secret) = devices.mint("phone").unwrap();
        assert_eq!(devices.revoke(&gone.id), Ok(true));
        assert_eq!(devices.revoke(&gone.id), Ok(false));

        let reloaded = Devices::open(path.clone());
        assert_eq!(reloaded.list(), vec![kept.clone()]);
        assert_eq!(reloaded.find(&gone_secret), None);
        assert_eq!(reloaded.find(&kept_secret), Some(kept.id));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn concurrent_mints_all_survive_a_reload() {
        let path = temp_path("concurrent");
        let devices = Arc::new(Devices::open(path.clone()));
        let minted: Vec<String> = (0..8)
            .map(|i| {
                let devices = devices.clone();
                std::thread::spawn(move || devices.mint(&format!("d{i}")).unwrap().1)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();

        let reloaded = Devices::open(path.clone());
        for credential in &minted {
            assert!(reloaded.find(credential).is_some());
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}

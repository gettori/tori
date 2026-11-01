//! Alerts to phones whose app is closed, through the relay. Each is sealed
//! with the key its phone made, so the relay and FCM carry it unread.

use std::sync::Arc;

use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use serde_json::json;

use super::devices::Devices;

const RELAY: &str = "https://relay.gettori.app";
// The phone opens nothing sealed for another purpose under the same key.
const AAD: &[u8] = b"tori-push-v1";
// The relay refuses more; folder and branch are dropped before that happens.
const MAX_SEALED: usize = 1024;
const TTL_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Alert {
    pub kind: &'static str,
    pub project: String,
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

impl Alert {
    pub fn cleared(session: &str) -> Self {
        Self {
            kind: "cleared",
            project: String::new(),
            session: session.to_string(),
            folder: None,
            branch: None,
        }
    }

    // A cleared alert only cancels what is shown, so it spends none of FCM's
    // high priority budget, which is kept for alerts that end in a notification.
    fn priority(&self) -> &'static str {
        if self.kind == "cleared" {
            "normal"
        } else {
            "high"
        }
    }
}

pub fn kind_of(reason: Option<crate::presence::Reason>) -> &'static str {
    use crate::presence::Reason;
    match reason {
        Some(Reason::Approval) => "approval",
        Some(Reason::Question) => "question",
        Some(Reason::Budget) => "budget",
        Some(Reason::Forge) => "forge",
        Some(Reason::Denied) => "denied",
        Some(Reason::Waiting) | None => "waiting",
    }
}

pub fn send(devices: Arc<Devices>, alerts: Vec<Alert>) {
    let phones = devices.pushes();
    if alerts.is_empty() || phones.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let relay = std::env::var("TORI_RELAY").unwrap_or_else(|_| RELAY.to_string());
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .build()
            .into();
        for (id, push) in &phones {
            for alert in &alerts {
                let Some(data) = sealed(alert, &push.key) else { continue };
                let body = json!({
                    "handle": push.handle,
                    "data": data,
                    "tag": alert.session,
                    "ttl": TTL_SECS,
                    "priority": alert.priority(),
                });
                let gone = agent
                    .post(format!("{relay}/send"))
                    .send_json(&body)
                    .is_ok_and(|r| r.status() == 410);
                if gone {
                    let _ = devices.drop_push_if_handle(id, &push.handle);
                    break;
                }
            }
        }
    });
}

fn sealed(alert: &Alert, key: &str) -> Option<String> {
    let full = seal(&payload(alert)?, key)?;
    if full.len() <= MAX_SEALED {
        return Some(full);
    }
    let short = Alert {
        folder: None,
        branch: None,
        ..alert.clone()
    };
    let short = seal(&payload(&short)?, key)?;
    (short.len() <= MAX_SEALED).then_some(short)
}

fn payload(alert: &Alert) -> Option<Vec<u8>> {
    let mut value = serde_json::to_value(alert).ok()?;
    value["v"] = json!(1);
    serde_json::to_vec(&value).ok()
}

// base64 of the nonce, then the ciphertext with its tag, the layout the phone
// opens with `AES/GCM/NoPadding`.
fn seal(plain: &[u8], key: &str) -> Option<String> {
    let key = base64::engine::general_purpose::STANDARD.decode(key).ok()?;
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).ok()?);
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).ok()?;
    let mut buf = plain.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(AAD), &mut buf)
        .ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&buf);
    Some(base64::engine::general_purpose::STANDARD.encode(out))
}

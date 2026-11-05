// A link carries a kind and an id and nothing else; the pack itself comes from
// the signed index through `packs_resolve`, so a page, a hijacked scheme or a
// crafted URL gains nothing beyond the dialog the user then reads.
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

use super::Kind;

pub const EVENT: &str = "packs://link";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    pub kind: Kind,
    pub id: String,
}

pub fn parse(url: &Url) -> Option<Link> {
    if url.host_str() != Some("install") || !matches!(url.path(), "" | "/") {
        return None;
    }
    let mut kind = None;
    let mut id = None;
    for (key, value) in url.query_pairs() {
        match &*key {
            "kind" => kind = Kind::ALL.into_iter().find(|k| k.folder() == value),
            "id" => id = Some(value.into_owned()),
            _ => {}
        }
    }
    let link = Link { kind: kind?, id: id? };
    super::is_catalog_id(&link.id).then_some(link)
}

// The first link stays until the window takes it and later ones are dropped,
// not queued, so a page cannot line installs up behind the one being read.
#[derive(Default)]
pub struct Pending(Mutex<Option<Link>>);

impl Pending {
    pub fn hold(&self, link: Link) -> bool {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_some() {
            return false;
        }
        *slot = Some(link);
        true
    }

    pub fn take(&self) -> Option<Link> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

pub fn watch(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let Some(link) = parse(&url) else { continue };
            if !handle.state::<Pending>().hold(link) {
                continue;
            }
            if let Err(e) = handle.emit(EVENT, ()) {
                eprintln!("tori: the window was not told of a pack link: {e}");
            }
        }
    });
}

#[tauri::command]
pub fn packs_take_link(pending: State<'_, Pending>) -> Option<Link> {
    pending.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(s: &str) -> Option<Link> {
        parse(&Url::parse(s).unwrap())
    }

    #[test]
    fn an_install_link_names_a_kind_and_an_id_under_either_scheme() {
        let nord = Link {
            kind: Kind::Themes,
            id: "nord".into(),
        };
        assert_eq!(link("tori://install?kind=themes&id=nord"), Some(nord.clone()));
        assert_eq!(link("tori-dev://install?kind=themes&id=nord"), Some(nord.clone()));
        assert_eq!(link("tori://install/?id=nord&kind=themes&utm=x"), Some(nord));
        assert_eq!(
            link("tori://install?kind=lsp&id=csharp"),
            Some(Link {
                kind: Kind::Lsp,
                id: "csharp".into()
            })
        );
    }

    #[test]
    fn anything_but_an_install_with_a_pack_id_is_ignored() {
        for url in [
            "tori://open?folder=/r/personal/tori/wt&session=s%201",
            "tori://pair?url=https://x&code=1234",
            "tori://install",
            "tori://install?kind=themes",
            "tori://install?id=nord",
            "tori://install?kind=plugins&id=nord",
            "tori://install?kind=Themes&id=nord",
            "tori://install?kind=themes&id=Nord",
            "tori://install?kind=themes&id=../nord",
            "tori://install?kind=themes&id=nord.toml",
            "tori://install?kind=themes&id=",
            "tori://install/more?kind=themes&id=nord",
            "tori://install.example.com?kind=themes&id=nord",
        ] {
            assert_eq!(link(url), None, "{url}");
        }
    }

    #[test]
    fn one_link_is_held_until_taken_and_the_rest_are_dropped() {
        let pending = Pending::default();
        let first = Link {
            kind: Kind::Themes,
            id: "nord".into(),
        };
        let second = Link {
            kind: Kind::Lsp,
            id: "csharp".into(),
        };
        assert!(pending.hold(first.clone()));
        assert!(!pending.hold(second.clone()));
        assert_eq!(pending.take(), Some(first));
        assert_eq!(pending.take(), None);
        assert!(pending.hold(second));
    }
}

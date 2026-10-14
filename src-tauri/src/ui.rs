use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

type Emit = dyn Fn(&str, Value) + Send + Sync;

#[derive(Clone)]
pub struct Ui(Arc<Emit>);

impl Ui {
    pub fn new(emit: impl Fn(&str, Value) + Send + Sync + 'static) -> Self {
        Self(Arc::new(emit))
    }

    pub fn emit(&self, event: &str, payload: impl Serialize) {
        (self.0)(event, serde_json::to_value(payload).unwrap_or(Value::Null));
    }
}

impl From<&AppHandle> for Ui {
    fn from(app: &AppHandle) -> Self {
        let app = app.clone();
        Self::new(move |event, payload| {
            let _ = app.emit(event, payload);
        })
    }
}

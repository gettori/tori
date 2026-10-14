use std::sync::Arc;

use crate::chat::serve::Served;
use crate::rpc::states::SessionStates;
use crate::ui::Ui;

#[derive(Clone)]
pub struct Desk {
    pub ui: Ui,
    pub chats: Arc<Served>,
    pub states: Arc<SessionStates>,
}

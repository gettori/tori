package app.gettori.tori.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class PushService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val store = PushStore(this)
    if (!store.on) return
    val alert = Alerts.open(message.data["p"] ?: return, store.key) ?: return
    Alerts.show(this, alert)
  }

  // A new token makes the old handle useless. If the relay cannot be reached
  // here, the stored token stays the old one and `state` registers again.
  override fun onNewToken(token: String) {
    val store = PushStore(this)
    val relay = store.relay ?: return
    runCatching { store.save(relay, token, Relay.registerBlocking(relay, token)) }
  }
}

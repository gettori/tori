package app.gettori.tori.push

import com.google.firebase.messaging.FirebaseMessagingService

class PushService : FirebaseMessagingService() {
  // A new token makes the old handle useless. If the relay cannot be reached
  // here, the stored token stays the old one and `state` registers again.
  override fun onNewToken(token: String) {
    val store = PushStore(this)
    val relay = store.relay ?: return
    runCatching { store.save(relay, token, Relay.registerBlocking(relay, token)) }
  }
}

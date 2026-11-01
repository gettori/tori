package app.gettori.tori.push

import android.content.Context
import android.util.Base64
import java.security.SecureRandom

// App-private and excluded from backup by the app's extraction rules, so the
// key never leaves this phone. The service reads it with the app not running.
class PushStore(context: Context) {
  private val prefs = context.getSharedPreferences("tori.push", Context.MODE_PRIVATE)

  val on: Boolean get() = prefs.getString("handle", null) != null
  val handle: String? get() = prefs.getString("handle", null)
  val relay: String? get() = prefs.getString("relay", null)
  val token: String? get() = prefs.getString("token", null)

  val key: String
    get() = prefs.getString("key", null) ?: ByteArray(32).let { bytes ->
      SecureRandom().nextBytes(bytes)
      Base64.encodeToString(bytes, Base64.NO_WRAP).also { prefs.edit().putString("key", it).apply() }
    }

  fun save(relay: String, token: String, handle: String) {
    prefs.edit().putString("relay", relay).putString("token", token).putString("handle", handle).apply()
  }

  fun clear() {
    prefs.edit().clear().apply()
  }
}

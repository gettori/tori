package app.gettori.tori.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.concurrent.thread

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  private val store = PushStore(activity)
  private var tapped: JSObject? = null

  override fun load(webView: WebView) {
    super.load(webView)
    stashTap(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    stashTap(intent)
  }

  // The extras are removed, since a rotation or a resume delivers the intent
  // again and would open the same session twice.
  private fun stashTap(intent: Intent?) {
    val session = intent?.getStringExtra(SESSION_EXTRA) ?: return
    tapped = JSObject().apply {
      put("session", session)
      put("folder", intent.getStringExtra(FOLDER_EXTRA))
      put("branch", intent.getStringExtra(BRANCH_EXTRA))
      put("project", intent.getStringExtra(PROJECT_EXTRA) ?: "")
    }
    intent.removeExtra(SESSION_EXTRA)
    intent.removeExtra(FOLDER_EXTRA)
    intent.removeExtra(BRANCH_EXTRA)
    intent.removeExtra(PROJECT_EXTRA)
  }

  @Command
  fun opened(invoke: Invoke) {
    val tap = tapped
    tapped = null
    invoke.resolve(JSObject().apply { put("tap", tap ?: org.json.JSONObject.NULL) })
  }

  // Every connect asks, so a token refresh the service could not register is
  // registered here before the Mac is handed a handle FCM no longer accepts.
  @Command
  fun state(invoke: Invoke) {
    val relay = store.relay
    if (!store.on || relay == null || FirebaseApp.getApps(activity).isEmpty()) return invoke.resolve(pair())
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      val token = if (task.isSuccessful) task.result else null
      if (token == null || token == store.token) return@addOnCompleteListener invoke.resolve(pair())
      thread {
        runCatching { store.save(relay, token, Relay.registerBlocking(relay, token)) }
        invoke.resolve(pair())
      }
    }
  }

  @Command
  fun disable(invoke: Invoke) {
    store.clear()
    invoke.resolve()
  }

  @Command
  fun enable(invoke: Invoke) {
    val relay = invoke.getArgs().getString("relay")
    if (!relay.startsWith("https://")) return invoke.reject("The alert relay has to be https.")
    if (FirebaseApp.getApps(activity).isEmpty()) return invoke.reject("This build of Tori has no push setup.")
    val asked = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      getPermissionState("notifications") != PermissionState.GRANTED
    if (asked) requestPermissionForAlias("notifications", invoke, "permitted") else register(invoke, relay)
  }

  @PermissionCallback
  fun permitted(invoke: Invoke) {
    if (getPermissionState("notifications") != PermissionState.GRANTED) {
      return invoke.reject("Notifications are off for Tori. Turn them on in Android settings.")
    }
    register(invoke, invoke.getArgs().getString("relay"))
  }

  private fun register(invoke: Invoke, relay: String) {
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      if (!task.isSuccessful) {
        return@addOnCompleteListener invoke.reject(tokenFailure(task.exception?.message))
      }
      thread {
        try {
          store.save(relay, task.result, Relay.registerBlocking(relay, task.result))
          invoke.resolve(pair())
        } catch (e: RelayException) {
          invoke.reject("The alert relay refused this phone (${e.status}).")
        } catch (e: Exception) {
          invoke.reject("Couldn't reach the alert relay: ${e.message}")
        }
      }
    }
  }

  // What FCM fails with when the phone has no Google Play services to ask.
  private fun tokenFailure(message: String?): String = when {
    message == null -> "Couldn't get a push token."
    "SERVICE_NOT_AVAILABLE" in message || "MISSING_INSTANCEID_SERVICE" in message ->
      "This phone has no working Google Play services, which alerts with the app closed need."
    else -> "Couldn't get a push token: $message"
  }

  private fun pair(): JSObject = JSObject().apply {
    val handle = store.handle
    put("on", handle != null)
    if (handle != null) {
      put("handle", handle)
      put("key", store.key)
    }
  }
}

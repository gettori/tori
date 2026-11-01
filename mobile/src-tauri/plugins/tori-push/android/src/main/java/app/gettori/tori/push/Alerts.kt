package app.gettori.tori.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

const val SESSION_EXTRA = "app.gettori.tori.push.session"
const val FOLDER_EXTRA = "app.gettori.tori.push.folder"
const val BRANCH_EXTRA = "app.gettori.tori.push.branch"
const val PROJECT_EXTRA = "app.gettori.tori.push.project"

private const val CHANNEL = "alerts"
private val AAD = "tori-push-v1".toByteArray()

private val SAYS = mapOf(
  "approval" to "A session needs approval",
  "question" to "A session has a question",
  "budget" to "A session hit its budget",
  "waiting" to "A session is waiting",
  "forge" to "A pull request needs a look",
  "denied" to "A session had a command blocked",
  "done" to "A session finished",
)

object Alerts {
  fun open(sealed: String, key: String): JSONObject? = runCatching {
    val bytes = Base64.decode(sealed, Base64.DEFAULT)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(Base64.decode(key, Base64.DEFAULT), "AES"),
      GCMParameterSpec(128, bytes, 0, 12),
    )
    cipher.updateAAD(AAD)
    JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12))).takeIf { it.optInt("v") == 1 }
  }.getOrNull()

  fun show(context: Context, alert: JSONObject) {
    val manager = context.getSystemService(NotificationManager::class.java)
    val session = alert.optString("session").takeIf { it.isNotEmpty() } ?: return
    if (alert.optString("kind") == "cleared") return manager.cancel(session, 0)
    val says = SAYS[alert.optString("kind")] ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Alerts", NotificationManager.IMPORTANCE_HIGH))
    }
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val project = alert.optString("project")
    launch.putExtra(SESSION_EXTRA, session)
    launch.putExtra(PROJECT_EXTRA, project)
    alert.optString("folder").takeIf { it.isNotEmpty() }?.let { launch.putExtra(FOLDER_EXTRA, it) }
    alert.optString("branch").takeIf { it.isNotEmpty() }?.let { launch.putExtra(BRANCH_EXTRA, it) }
    val tap = PendingIntent.getActivity(
      context,
      session.hashCode(),
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    @Suppress("DEPRECATION")
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) android.app.Notification.Builder(context, CHANNEL)
      else android.app.Notification.Builder(context)
    val notification = builder
      .setSmallIcon(R.drawable.ic_stat_tori)
      .setContentTitle(project.ifEmpty { "Tori" })
      .setContentText(says)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    runCatching { manager.notify(session, 0, notification) }
  }
}

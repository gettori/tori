package app.gettori.tori.push

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

object Relay {
  fun registerBlocking(relay: String, token: String): String {
    val connection = URL("$relay/register").openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 10_000
      connection.readTimeout = 10_000
      connection.doOutput = true
      connection.setRequestProperty("content-type", "application/json")
      connection.outputStream.use { it.write(JSONObject().put("token", token).toString().toByteArray()) }
      if (connection.responseCode != 200) throw RelayException(connection.responseCode)
      return JSONObject(connection.inputStream.bufferedReader().readText()).getString("handle")
    } finally {
      connection.disconnect()
    }
  }
}

class RelayException(val status: Int) : Exception("relay answered $status")

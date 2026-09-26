package com.gettori.tori.mobile

import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Android 15 draws every app edge to edge and no longer resizes it for the
    // keyboard, so the WebView is padded clear of the bars and the keyboard here.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(0xFF15171C.toInt())
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val edge = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      view.setPadding(edge.left, edge.top, edge.right, edge.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}

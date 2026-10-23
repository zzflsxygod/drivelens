// SPDX-License-Identifier: AGPL-3.0-or-later
package com.zzflsxygod.drivelens

import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

/**
 * Edge-to-edge DriveLens shell.
 *  - system bar / cutout insets are pushed into the page as CSS variables (--a-sat …), see src/platform.ts
 *  - the keyboard shrinks the WebView (adjustResize has no effect edge-to-edge)
 *  - window.DriveLensAndroid: status-bar icon colour, share sheet, save image to Pictures
 */
class MainActivity : TauriActivity() {
  private var web: WebView? = null
  @Volatile private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0,\"ime\":false}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(Bridge(), "DriveLensAndroid")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val d = resources.displayMetrics.density
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      (v.layoutParams as? ViewGroup.MarginLayoutParams)?.let { lp ->
        val m = if (imeVisible) ime else 0
        if (lp.bottomMargin != m) { lp.bottomMargin = m; v.layoutParams = lp }
      }
      fun px(i: Int) = Math.round(i / d)
      insetsJson = "{\"top\":${px(bars.top)},\"right\":${px(bars.right)},\"bottom\":${if (imeVisible) 0 else px(bars.bottom)},\"left\":${px(bars.left)},\"ime\":$imeVisible}"
      v.post { (v as WebView).evaluateJavascript("window.__dlInsets && window.__dlInsets('$insetsJson')", null) }
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  inner class Bridge {
    @JavascriptInterface fun insets(): String = insetsJson

    @JavascriptInterface fun setDarkBars(dark: Boolean) {
      runOnUiThread {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.isAppearanceLightStatusBars = !dark
        c.isAppearanceLightNavigationBars = !dark
      }
    }

    /** Opens the system share sheet with a PNG. Returns "" or an error message. */
    @JavascriptInterface fun shareImage(base64: String, name: String, title: String): String = try {
      val dir = File(cacheDir, "share").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
      val f = File(dir, safeName(name)); f.writeBytes(Base64.decode(base64, Base64.DEFAULT))
      val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", f)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri(name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      runOnUiThread { startActivity(Intent.createChooser(send, title)) }
      ""
    } catch (e: Exception) { e.message ?: e.toString() }

    /** Saves a PNG to Pictures/DriveLens (Android 10+, no permission needed). "unsupported" below Android 10. */
    @JavascriptInterface fun saveImage(base64: String, name: String): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unsupported"
      return try {
        val values = ContentValues().apply {
          put(MediaStore.Images.Media.DISPLAY_NAME, safeName(name)); put(MediaStore.Images.Media.MIME_TYPE, "image/png")
          put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/DriveLens"); put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return "MediaStore insert failed"
        contentResolver.openOutputStream(uri)?.use { it.write(Base64.decode(base64, Base64.DEFAULT)) } ?: return "cannot write"
        values.clear(); values.put(MediaStore.Images.Media.IS_PENDING, 0); contentResolver.update(uri, values, null, null)
        ""
      } catch (e: Exception) { e.message ?: e.toString() }
    }
  }

  private fun safeName(n: String) = n.replace(Regex("[^\\p{L}\\p{N}._-]+"), "_").take(80).ifEmpty { "DriveLens.png" }
}

package com.sajid.dealskarachi

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#000000")
        window.navigationBarColor = Color.parseColor("#000000")
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#000000"))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // Android 15 (targetSdk 35) forces edge-to-edge: the app draws UNDER the
        // status/navigation bars, and WebView ignores CSS safe-area insets —
        // the UI looked shifted up / cut off. Fix: pad the WebView by the real
        // system-bar + cutout insets so content starts BELOW the status bar.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            web.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                )
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        // SECURITY: external links (YouTube/Instagram/TikTok/Maps) open in the real
        // app via the system — never navigate inside our own WebView. Cleartext HTTP
        // is blocked at manifest level (usesCleartextTraffic=false).
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                val scheme = url.scheme ?: return false
                // NOTE: scheme checks MUST come before host access — geo:/tel: URIs
                // have a NULL host, and returning false on null host caused
                // net::ERR_UNKNOWN_URL_SCHEME instead of opening the Maps/dialer.
                if (scheme == "tel") {
                    try { startActivity(Intent(Intent.ACTION_DIAL, url)) } catch (_: Exception) {}
                    return true
                }
                if (scheme == "geo" || scheme == "mailto" || scheme == "whatsapp" || scheme == "sms") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                    return true
                }
                if (scheme == "http" || scheme == "https") {
                    val host = url.host ?: return false
                    val internal = host == "raw.githubusercontent.com" ||
                            host == "unpkg.com" ||
                            host == "cdn.jsdelivr.net" ||
                            host == "i.ytimg.com" ||
                            host == "images.weserv.nl" ||   // thumbnail fallback proxy
                            host.endsWith(".tile.openstreetmap.org")
                    if (!internal) {
                        try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                        return true
                    }
                    return false
                }
                // intent:// and any other scheme → system
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                return true
            }
        }
        setContentView(web)
        web.loadUrl("file:///android_asset/prototype.html")
    }

    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}

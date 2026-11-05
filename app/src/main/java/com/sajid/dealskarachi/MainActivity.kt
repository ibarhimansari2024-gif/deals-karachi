package com.sajid.dealskarachi

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#08080a")
        window.navigationBarColor = Color.parseColor("#111014")
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#111014"))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = WebViewClient()
        web.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        setContentView(web)
        web.loadUrl("file:///android_asset/prototype.html")
    }

    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}

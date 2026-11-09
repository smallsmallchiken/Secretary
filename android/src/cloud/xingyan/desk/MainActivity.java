package cloud.xingyan.desk;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 桌宠远程控制：一个全屏 WebView 套在 server/desk 的控制页上。
 *
 * 不做原生 UI，是因为控制页本身在频繁改（按钮、状态卡），原生重写一遍
 * 等于维护两份。壳子只管三件事：全屏、返回键、断网兜底。
 */
public class MainActivity extends Activity {

    private WebView web;
    private FrameLayout root;
    private boolean failed = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(Color.parseColor("#111318"));
        w.setNavigationBarColor(Color.parseColor("#111318"));

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#111318"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#111318"));
        web.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 控制页一直在轮询状态，缓存反而会让人看到过期画面
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setLoadsImagesAutomatically(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        // 壳子只需要网页，别让它有本地文件能力
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url == null) return false;
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    // 同域留在壳里，外链交给浏览器
                    return !url.startsWith(Gen.HOST);
                }
                try {
                    v.getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (!failed) {
                    v.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    showOffline();
                }
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                // API 21-22 走这个旧回调
                if (Build.VERSION.SDK_INT < 23) {
                    showOffline();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient());

        root.addView(web);
        setContentView(root);

        web.loadUrl(Gen.URL);
    }

    /** 连不上电脑时别给用户看 WebView 自带的灰色错误页 */
    private void showOffline() {
        failed = true;
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>html,body{height:100%;margin:0;background:#111318;color:#eceef2;"
                + "font-family:-apple-system,Roboto,'PingFang SC',sans-serif;display:flex;"
                + "align-items:center;justify-content:center;text-align:center}"
                + ".b{padding:0 32px}.t{font-size:17px;margin:0 0 10px}"
                + ".d{font-size:13px;color:#8b91a0;line-height:1.7;margin:0 0 26px}"
                + "button{background:#ffc857;color:#1a1408;border:0;border-radius:12px;"
                + "padding:13px 30px;font-size:15px;font-weight:600}</style>"
                + "<div class=b><p class=t>连不上电脑</p>"
                + "<p class=d>检查电脑是否开机、<br>桌宠是否在运行、手机网络是否正常</p>"
                + "<button onclick=\"location.href='" + Gen.URL + "'\">重试</button></div>";
        web.loadDataWithBaseURL(Gen.HOST, html, "text/html", "utf-8", null);
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            if (web != null && web.canGoBack() && !failed) {
                web.goBack();
                return true;
            }
            finish();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.resumeTimers();
            // 回到前台立刻拉一次：锁屏期间 JS 定时器被挂起，画面可能还是旧的
            web.evaluateJavascript(
                    "(function(){try{if(window.__deskRefresh)window.__deskRefresh();}catch(e){}})()", null);
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

package cn.bitcoooin.advisor;

import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        /*
         * ⚠️ 这一句**必须自己调**，Capacitor 的 BridgeActivity 不会替我们调。
         *
         * `styles.xml` 的 `AppTheme.NoActionBarLaunch`（本 Activity 的主题，见
         * AndroidManifest）声明了 `postSplashScreenTheme = @style/AppTheme`，但
         * AndroidX 的 SplashScreen **只有在调用 installSplashScreen() 之后**才会把
         * 启动图主题**换回**那个 post 主题。
         *
         * 不调的话 Activity 会一直停在启动图主题上（父主题 Theme.SplashScreen，
         * 没有我们那套配色）——于是 `AppTheme` 里的
         * `android:windowBackground` / `statusBarColor` / `navigationBarColor`
         * （= app_shell #121316）**全部不生效**：
         *   · Android 15 以下：两条系统栏用 DeviceDefault 的默认色（偏黑）
         *   · Android 15+：强制 edge-to-edge、系统栏透明，WebView 又是内缩的
         *     （capacitor.config 里 overlaysWebView=false），露出来的是窗底 ——
         *     也就是启动图那层近黑底（#08090b）
         * 两种情形都会让「状态栏 / 底部导航条」比页面主背景（#121316）暗一档，
         * 正是用户报的「系统栏和主背景颜色不一样」。
         *
         * 调过之后主题切回 AppTheme，窗底与两条系统栏都变成 app_shell，
         * 和窄屏页面主背景（--panel #121316）一致。
         */
        SplashScreen splash = SplashScreen.installSplashScreen(this);

        /*
         * ⚠️ 注册自定义插件**必须在 `super.onCreate` 之前**（Capacitor 的约定：
         *    BridgeActivity 在 super 里就去捞插件表了，晚注册等于没注册）。
         *    `AlertWatch` = 「App 后台提醒」（前台服务 + 本地通知），
         *    给没有谷歌服务、FCM 用不了的手机用的（见 AlertWatchService.java）。
         */
        registerPlugin(AlertWatchPlugin.class);

        super.onCreate(savedInstanceState);

        /*
         * ★★ 把「系统栏背后那层」钉死成 app_shell（2026-10-05 第三次修）
         *
         * 用户第三次反馈：「安全区的主题色还是不对，不是我背景的黑色」——
         * 即状态栏那一横条比页面主背景（窄屏 --panel #121316）**亮一档、发灰**。
         *
         * 【为什么会灰】`targetSdkVersion = 36` → Android 15+ **强制 edge-to-edge**，
         *   状态栏是透明的，它的颜色 = 「背后那层」的颜色。背后是谁由 Capacitor 8
         *   内置的 `SystemBars` 插件决定（源码
         *   `com.getcapacitor.plugin.SystemBars#initWindowInsetsListener`）：
         *     · `WebView ≥140 && 页面有 viewport-fit=cover` → `setPadding(0,0,0,0)`，
         *       WebView 铺满整屏 → 背后 = **页面本身** = #121316 ✓
         *     · 否则 → `decorView.setPadding(...)`，**WebView 内缩** →
         *       背后 = **decorView 的底色** ✗
         *   而 `hasViewportCover` 初始值是 **false**（我们没配 `initialViewportFitValueHint`），
         *   要等 `onPageCommitVisible` 里跑完 JS 检测再 `requestApplyInsets()` 才可能
         *   切到铺满那条路 —— 启动那段窗口期一定是「内缩 + 露 decor 底色」。
         *
         * 【那块底色是什么】`SystemBars.setStyle()` 里写的是
         *   `decorView.setBackgroundColor(getThemeColor(windowBackground))`，
         *   也就是「**采样那一刻**当前主题解析出的 android:windowBackground」。
         *   但它在 `BridgeActivity.onCreate` 里执行，而上面那句
         *   `installSplashScreen` 已经 `applyStyle(Theme_SplashScreen, force=true)`
         *   往主题上叠了一层 —— 那条链是
         *     `Theme.SplashScreen → Base.Theme.SplashScreen → android:Theme.DeviceDefault.NoActionBar`
         *   （解 `core-splashscreen-1.2.0.aar` 的 res/values/values.xml 确认过），
         *   系统深色主题的 windowBackground 正是**深灰** ——
         *   和用户看到的「比页面亮一档的灰」完全对上。
         *   ⚠️ 这也解释了为什么前两次改 `statusBarColor` / `app_shell` /
         *      `enforceStatusBarContrast` 都没用：**根本不是那条属性在起作用**。
         *
         * 【修法】不再依赖「主题解析结果」，直接写死颜色。
         *   ★ 用 `post` 而不是直接调：`SystemBars` 的染色是
         *     `getBridge().executeOnMainThread(...)` 投出去的，直接调会被它随后覆盖；
         *     post 到消息队列末尾才排在它**后面**。
         */
        getWindow().getDecorView().post(this::paintSystemBarBackdrop);

        /*
         * ★ 2026-10-17：**别再让「白/黑屏什么都没有」发生**。
         *
         * 用户：「这个 APP 常驻在后台，但是我一打开的时候，会直接黑屏，什么内容都没有。」
         *
         * 这个壳原先是 `capacitor.config.json` 的 `server.url = https://bitcoooin.cn`，
         * 也就是**整个页面是从网上拉的**（不是打在本地的）——2026-10-19 已改回
         * **本地资源**（`frontend/dist` 随包内置，见 `capacitor.config.json`），
         * 第一屏不再依赖网络；但下面这些兜底仍然保留，防的是：
         *
         *   ① **WebView 的渲染进程被系统杀了**（后台待久了内存回收，华为那类 ROM 尤其爱干）。
         *      Capacitor 默认的 `onRenderProcessGone` 返回 false ⇒ 系统**直接把 App 进程崩掉**
         *      （用户之前报的「app 端一直闪退」很可能就是这个），
         *      或者 Activity 还活着但 WebView 是死的 ⇒ 一片黑。
         *   ② **本地页面没加载起来**（远程加载时代是「回前台时网还没通 / 到服务器的
         *      路径被掐」——这台机器上实测过移动网到服务器的 IPv4 会被黑洞几分钟）。
         *      原生 WebView 加载失败**没有错误页**，就是露出窗底色 = 看着像黑屏。
         *   ③ 只是**没重绘**：内容还在，但那一帧没画出来。
         *
         * 对策分别是：
         *   ① `onRenderProcessGone` 里**自己重建这个 Activity**并 return true（见下面）；
         *   ② 主文档加载出错时塞一页**自带的**「连不上服务器 · 重试」（不依赖网络）；
         *   ③ `onResume` 里逼一次重绘，实在没内容就重新加载。
         */
        installResilientWebViewClient();

        /* 回前台时用得上：记一下什么时候被切走（见 onPause） */
        pausedAt = System.currentTimeMillis();

        /*
         * 再钉两次（都是「主题刚变过」的时机，SystemBars 会重新按主题染一次色）：
         *
         * ① 启动图退场：那一刻主题才从启动图主题切回 AppTheme。
         *    ⚠️ 设了 `setOnExitAnimationListener` 就**必须自己 `provider.remove()`** ——
         *    否则启动图永远不消失、App 卡在第一屏（这是这个 API 的约定，不是可选）。
         * ② `onConfigurationChanged`（见下）：旋转 / 切深浅色时 Manifest 里声明了
         *    `configChanges`，Activity 不重建，但 `SystemBars` 会
         *    `handleOnConfigurationChanged` → 重新按主题染色 → 又变灰。
         */
        splash.setOnExitAnimationListener(provider -> {
            paintSystemBarBackdrop();
            provider.remove();
        });
    }

    /** 切后台的时刻（`0` = 还没切过 / 已经在前面）。用来判断「这次回来要不要查一下内容还在不在」 */
    private long pausedAt = 0;

    /** 这次进程里因为渲染进程死掉重建过几次（短时间内反复重建就别再建了，见下面） */
    private static int recreatedForRenderer = 0;

    /**
     * 给 WebView 换上一个「会自己恢复」的 `WebViewClient`。
     *
     * 为什么要**继承** Capacitor 的 `BridgeWebViewClient` 而不是换一个新的：
     * 插件通信（`shouldInterceptRequest` 那套本地资源代理、`launchIntent` 拦外链、
     * `onPageFinished` 通知各监听者）全在它里面 —— 自己写一个 `WebViewClient`
     * 会让 `Capacitor.Plugins` 整块失效。父类的行为全部保留，只多两条兜底。
     */
    private void installResilientWebViewClient() {
        if (getBridge() == null) return; // 理论上不会（super.onCreate 之后就有了）
        getBridge().setWebViewClient(
            new BridgeWebViewClient(getBridge()) {
                @Override
                public void onReceivedError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceError error
                ) {
                    super.onReceivedError(view, request, error);
                    /*
                     * ⚠️ 只认**主文档**（`isForMainFrame`）：某个图片 / 接口失败不该整页换掉。
                     *    其它子资源失败由页面自己重试（前端那套 `onNetworkResume`）。
                     */
                    if (request == null || !request.isForMainFrame()) return;
                    showOfflinePage(view, String.valueOf(error != null ? error.getDescription() : ""));
                }

                @Override
                public void onReceivedHttpError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceResponse errorResponse
                ) {
                    super.onReceivedHttpError(view, request, errorResponse);
                    /* 5xx 才算「服务器打不开」；4xx 是页面自己的事（比如接口 401），别换页 */
                    if (request == null || !request.isForMainFrame()) return;
                    if (errorResponse != null && errorResponse.getStatusCode() < 500) return;
                    showOfflinePage(
                        view,
                        errorResponse == null ? "" : "HTTP " + errorResponse.getStatusCode()
                    );
                }

                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    /*
                     * ★ 渲染进程没了（后台待太久被系统回收是最常见的）：
                     *   默认实现返回 false ⇒ **系统崩掉整个 App**。这里接管：
                     *   重建 Activity（新 WebView 会重新拉页面），并 return true 告诉系统
                     *   「我处理了，别杀我」。
                     * ⚠️ 返回 true 之后**这个 WebView 就废了**，一行都不能再碰 ——
                     *    所以下面只用 `recreate()`，不碰 `view`。
                     */
                    boolean handledBySuper = false;
                    try {
                        handledBySuper = super.onRenderProcessGone(view, detail);
                    } catch (Throwable ignored) {
                        /* 父类那条只转给监听者，出错也无所谓 */
                    }
                    if (recreatedForRenderer >= 3) {
                        /*
                         * 一分钟内已经重建三次还死 ⇒ 再重建也是白搭（可能是 ROM 在持续回收），
                         * 别让它变成「开一次崩一次」的死循环 —— 这次让系统自己收场。
                         */
                        return handledBySuper;
                    }
                    recreatedForRenderer++;
                    runOnUiThread(() -> MainActivity.this.recreate());
                    return true;
                }
            }
        );
    }

    /**
     * 加载失败时显示的**自带**那一页（不依赖网络，也不依赖前端有没有加载成功）。
     *
     * 用 `loadDataWithBaseURL` 而不是去 load 一个 assets 文件：不用往
     * `assets/`（`cap sync` 生成、不进 git）里塞东西，也没有 `file://` 的权限问题。
     *
     * ⚠️ 页面里**每 6 秒自己重试一次**（最多 20 次）：用户经常是「点开 App、
     *    数据网刚好还没连上」，让他盯着黑屏再手动点一下很不友好。
     *    重试就是 `location.replace(APP_URL)` —— 换成新导航，不往历史里堆。
     */
    private void showOfflinePage(WebView view, String reason) {
        final String appUrl = "https://bitcoooin.cn/";
        String detail = reason == null ? "" : reason.trim();
        if (detail.length() > 120) detail = detail.substring(0, 120);
        String html =
            "<!doctype html><html lang=zh-CN><head><meta charset=utf-8>"
                + "<meta name=viewport content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                + "<meta name=color-scheme content=dark>"
                + "<title>连不上服务器</title><style>"
                + "html,body{height:100%;margin:0}"
                + "body{background:#121316;color:#e8eaf0;display:flex;align-items:center;"
                + "justify-content:center;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Noto Sans SC',sans-serif;"
                + "padding:24px;box-sizing:border-box;text-align:center}"
                + ".w{max-width:340px}"
                + "h1{font-size:17px;margin:0 0 8px;font-weight:600}"
                + "p{color:#8b949e;font-size:13px;margin:0 0 6px}"
                + ".d{color:#5d646e;font-size:12px;word-break:break-all;margin:0 0 18px}"
                + "button{font:inherit;font-size:14px;padding:9px 22px;border-radius:8px;"
                + "border:1px solid #2e3540;background:#1b1f26;color:#e8eaf0}"
                + "button:active{background:#252b33}"
                + ".auto{color:#5d646e;font-size:12px;margin-top:14px}"
                + "</style></head><body><div class=w>"
                + "<h1>连不上服务器</h1>"
                + "<p>页面没加载出来 —— 多半是网络还没连上。</p>"
                + (detail.isEmpty() ? "" : "<p class=d>" + escapeHtml(detail) + "</p>")
                + "<button onclick=\"location.replace('" + appUrl + "')\">重新加载</button>"
                + "<p class=auto id=auto>6 秒后自动重试…</p>"
                + "</div><script>"
                + "(function(){var n=0;var el=document.getElementById('auto');"
                + "var t=setInterval(function(){n++;"
                + "if(n>20){clearInterval(t);el.textContent='自动重试已停 —— 点上面的按钮再试一次';return}"
                + "el.textContent=(6-n%6)+' 秒后自动重试…（第 '+n+' 次）';"
                + "if(n%6===0){location.replace('" + appUrl + "')}},1000)})()"
                + "</script></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    /** 上面那页里要塞错误原因 —— 那是系统给的字符串，挡一下 `<>` 就行 */
    private static String escapeHtml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /**
     * 系统栏背后那层 = `decorView` 的底色（WebView 内缩时露出来的就是它）。
     *
     * ⚠️ 这里**写死** `0xFF121316`，故意不去读 `@color/app_shell`：
     *    读颜色要过主题，而「主题那一刻被启动图主题叠过」正是这个 bug 的成因。
     *    （`R.color.app_shell` 在 `values/colors.xml`，那边**必须**保持同值 ——
     *      `#121316` = 前端窄屏的 `--panel`，也是 `capacitor.config.json` 里
     *      `android.backgroundColor` / `StatusBar.backgroundColor` 的值。）
     */
    private void paintSystemBarBackdrop() {
        getWindow().getDecorView().setBackgroundColor(0xFF121316);
    }

    @Override
    public void onPause() {
        pausedAt = System.currentTimeMillis();
        super.onPause();
    }

    /**
     * 回前台：**先确认内容还在**，再谈别的。
     *
     * 三种情形：
     *   · 待了一会儿（>5 分钟）回来，WebView 的**内容高度是 0** ⇒ 渲染进程其实没了 /
     *     页面是空的 —— 重新加载（否则就是用户看到的那片黑）。
     *   · 内容在，但可能没重绘（部分 ROM 回前台不复绘）⇒ `invalidate()` 逼一次。
     *   · 刚从「连不上」那一页回来（用户点了重试 / 网通了自动跳）—— 正常加载，不管。
     *
     * ⚠️ 用「离开超过 5 分钟」这个门槛，别每次切回来都查：正常切 tab 回来时
     *    `getContentHeight()` 也可能正好是 0（那一帧没量完），误判成空就会白刷一次。
     */
    @Override
    public void onResume() {
        super.onResume();
        final long away = pausedAt > 0 ? System.currentTimeMillis() - pausedAt : 0;
        pausedAt = 0;
        if (getBridge() == null) return;
        final WebView wv = getBridge().getWebView();
        if (wv == null) return;
        /* WebView 自己的计时器（定时器 / 动画）在后台会被系统停掉，回来要显式续上 */
        wv.onResume();
        wv.resumeTimers();
        wv.post(() -> {
            if (isFinishing() || isDestroyed()) return;
            String url = wv.getUrl();
            boolean blank = url == null || url.isEmpty() || "about:blank".equals(url);
            boolean emptyAfterLongAway = away > 5 * 60_000L && wv.getContentHeight() <= 0;
            if (blank || emptyAfterLongAway) {
                wv.loadUrl(getBridge() != null ? getBridge().getServerUrl() : "https://bitcoooin.cn");
            } else {
                wv.invalidate();
            }
        });
    }

    /**
     * 旋转屏幕 / 系统切深浅色：Activity 不重建（Manifest 里声明了 configChanges），
     * 但 `SystemBars` 会跟着重染一次色 → 又把上面钉的值冲掉，所以 super 之后补一钉。
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        getWindow().getDecorView().post(this::paintSystemBarBackdrop);
    }
}

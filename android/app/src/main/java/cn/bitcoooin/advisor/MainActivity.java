package cn.bitcoooin.advisor;

import android.content.res.Configuration;
import android.os.Bundle;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

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

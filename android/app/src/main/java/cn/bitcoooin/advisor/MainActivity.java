package cn.bitcoooin.advisor;

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
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
    }
}

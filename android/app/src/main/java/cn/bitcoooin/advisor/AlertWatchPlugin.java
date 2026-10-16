package cn.bitcoooin.advisor;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 「App 后台提醒」的**页面 ↔ 原生**接线（2026-10-16 用户选的方案）。
 *
 * 为什么自己写一个插件、而不是用现成的：
 *   · `@capacitor/push-notifications` 走的是 **FCM**，而用户那台华为**没有谷歌服务**，
 *     那条路是死的（`register()` 不报错也不回调）；
 *   · 我们要的是「App 自己跑个前台服务轮询 + 发本地通知」，没有任何现成插件做这件事。
 *
 * ⚠️ 前端**不 import 这个插件**：跟 `native.ts` 一样从 `window.Capacitor.Plugins.AlertWatch`
 *    上取（见 `frontend/src/watch.ts`）—— 静态 import 会让 Web 打包直接炸。
 */
@CapacitorPlugin(name = "AlertWatch", permissions = {@com.getcapacitor.annotation.Permission(
        alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class AlertWatchPlugin extends Plugin {

    /** 开：记下 token + 起服务（页面每次登录后都会调一次，幂等） */
    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token", "");
        Context ctx = getContext();
        AlertWatchService.setToken(ctx, token);
        /* 页面在哪个域下跑，服务就轮询哪个域（本地调试和线上是同一个包） */
        AlertWatchService.setBase(ctx, call.getString("base", ""));
        AlertWatchService.prefs(ctx).edit().putBoolean("enabled", true).apply();

        requestNotificationPermissionIfNeeded();

        Intent i = new Intent(ctx, AlertWatchService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
        call.resolve(statusObject());
    }

    /** 关：停服务 + 记下"用户不想要了"（被系统杀掉后也不会自己起来） */
    @PluginMethod
    public void stop(PluginCall call) {
        AlertWatchService.stop(getContext());
        call.resolve(statusObject());
    }

    /** 现在是什么状态（页面那张卡显示它） */
    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    /**
     * 立刻发一条本地通知 —— **先验"通知这条路通不通"**。
     *
     * 用户 2026-10-16 的原话是"我都看不到推送"，而等一条真实的「转可做」可能要等一整天，
     * 所以必须有个"现在就来一条"的按钮。
     */
    @PluginMethod
    public void testNotify(PluginCall call) {
        requestNotificationPermissionIfNeeded();
        AlertWatchService.notifyAlert(
                getContext(), 99, "Ait 测试提醒", "看到这条说明：不依赖谷歌服务的本地通知是通的");
        call.resolve(statusObject());
    }

    private JSObject statusObject() {
        Context ctx = getContext();
        boolean granted = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted =
                    ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                            == PackageManager.PERMISSION_GRANTED;
        }
        JSObject o = new JSObject();
        o.put("enabled", AlertWatchService.isEnabled(ctx));
        o.put("hasToken", !AlertWatchService.token(ctx).isEmpty());
        o.put("notificationsGranted", granted);
        o.put("since", AlertWatchService.prefs(ctx).getLong("since", -1L));
        return o;
    }

    /**
     * Android 13+ 的通知权限（`POST_NOTIFICATIONS`）。
     *
     * ⚠️ 不申请的话**通知会被系统静默丢掉**（代码不报错，用户什么也看不到）——
     *    这正是"收不到就得靠猜"的经典坑。
     */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            if (getActivity() != null) {
                ActivityCompat.requestPermissions(
                        getActivity(), new String[] {Manifest.permission.POST_NOTIFICATIONS}, 4201);
            }
        }
    }
}

package cn.bitcoooin.advisor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * **App 后台提醒**（2026-10-16 用户选的那条路）。
 *
 * 起因：用户的华为手机**没有谷歌服务（GMS）**，FCM（谷歌推送）在那台机器上**根本注册不上**
 * ——不报错也不给 token，路是死的。华为推送（HMS）要开发者账号 + 正式签名，代价太大。
 * 所以改成：**App 自己跑一个前台服务**，定时问一句"有没有新的「转可做」提醒"，
 * 有就发一条**本地通知**。完全不依赖谷歌 / 华为任何推送服务。
 *
 * 代价（用户知情）：
 *   · 常驻一条**不显眼但一直挂着**的通知（「Ait 正在盯着」）—— 前台服务必须要它，
 *     顺便也让人知道"提醒是活的"；
 *   · 轮询是 90 秒一次的小请求（服务端只回比 `since` 新的几条）；
 *   · 华为的省电策略可能把它杀掉 —— 要在「手机管家 → 应用启动管理」里允许自启动 /
 *     后台运行，并把电池优化设为"不允许优化"（`ProfileView` 那张卡上写了这句）。
 *
 * ⚠️ 为什么不直接用 WebSocket：这个服务只做"提醒"一件事，轮询足够（提醒的粒度本来就是
 *    15 分钟/1 小时），而长连接要处理重连/心跳/后台限制，复杂得多。
 * ⚠️ 状态全在 `SharedPreferences`（token / since）：进程被系统杀掉再拉起来能接着跑。
 */
public class AlertWatchService extends Service {

    /** 常驻通知的渠道（低优先级：不出声、不弹，只在通知栏里挂一条） */
    private static final String CHANNEL_ONGOING = "ait-watch";
    /** 提醒本身的渠道（高优先级：出声音 / 弹横幅） */
    private static final String CHANNEL_ALERT = "ait-alert";

    /** 常驻通知的固定 id（提醒用各自的行 id，别撞） */
    private static final int ONGOING_ID = 1;

    /** 多久问一次（毫秒）：提醒的粒度是 15 分钟 / 1 小时，90 秒足够，也不算费电 */
    private static final long POLL_MS = 90_000L;

    /** 拿不到 token 时重试的间隔（用户可能在别处登录了） */
    private static final long IDLE_MS = 10 * 60_000L;

    private static final String PREFS = "ait_watch";

    private Handler handler;
    private Runnable loop;
    private volatile boolean running;

    /* ---------------- 静态开关（给插件和 UI 用） ---------------- */

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean isEnabled(Context ctx) {
        return prefs(ctx).getBoolean("enabled", false);
    }

    /**
     * 页面把**当前站点**交进来（页面在哪个域下跑，服务就轮询哪个域）。
     *
     * ⚠️ 不把域名写死在 Java 里：本地调试（前端指到局域网）和线上是同一个包，
     *    页面加载的是哪个 origin，轮询就该打哪个 origin。
     */
    public static void setBase(Context ctx, String base) {
        String b = base == null ? "" : base.trim();
        if (b.isEmpty()) return;
        prefs(ctx).edit().putString("base", b).apply();
    }

    public static String base(Context ctx) {
        return prefs(ctx).getString("base", "https://bitcoooin.cn");
    }

    /** 页面把当前登录 token 交进来（服务轮询要用它认人） */
    public static void setToken(Context ctx, String token) {
        prefs(ctx).edit().putString("token", token == null ? "" : token).apply();
    }

    public static String token(Context ctx) {
        return prefs(ctx).getString("token", "");
    }

    /* ---------------- 前台服务骨架 ---------------- */

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        /*
         * ⚠️ Android 14（API 34）起：`startForeground` 必须声明类型，
         *    而且 Manifest 里要有对应的 `FOREGROUND_SERVICE_DATA_SYNC` 权限 ——
         *    少一样就是 `MissingForegroundServiceTypeException` 直接崩。
         *    我们干的活就是"周期性同步数据"，用 DATA_SYNC 最贴切。
         */
        Notification ongoing = ongoingNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ONGOING_ID, ongoing);
        }
        if (!running) {
            running = true;
            scheduleNext(1_000L);
        }
        /* 被系统杀掉之后不要自动重启（不然用户在界面上"关掉"之后它可能又活过来） */
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (handler != null && loop != null) handler.removeCallbacks(loop);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 停掉（界面上关掉开关 / 退出登录时调） */
    public static void stop(Context ctx) {
        prefs(ctx).edit().putBoolean("enabled", false).apply();
        ctx.stopService(new Intent(ctx, AlertWatchService.class));
    }

    private void scheduleNext(long delay) {
        loop = () -> {
            long next = POLL_MS;
            try {
                next = tick();
            } catch (Exception e) {
                /* 任何网络/解析问题都不该让服务死掉，下一轮再来 */
                next = POLL_MS;
            }
            if (running) handler.postDelayed(loop, next);
        };
        handler.postDelayed(loop, delay);
    }

    /**
     * 跑一轮。
     *
     * @return 下一轮隔多久（拿到 token 就按 POLL_MS，没 token 就慢一点等用户登录）
     */
    private long tick() {
        String token = token(this);
        if (token.isEmpty()) return IDLE_MS;

        SharedPreferences p = prefs(this);
        long since = p.getLong("since", -1L);

        /* 第一次跑：只问"现在最大 id 是多少"，从"现在"开始看 —— 别把历史提醒全弹一遍 */
        String path =
                since < 0
                        ? "/api/persist/alerts"
                        : "/api/persist/alerts?since=" + since;

        String body = httpGet(path, token);
        if (body == null) return POLL_MS;

        try {
            JSONObject json = new JSONObject(body);
            if (json.has("latest")) {
                long latest = json.optLong("latest", 0L);
                if (since < 0) {
                    p.edit().putLong("since", latest).apply();
                    return POLL_MS;
                }
            }
            JSONArray arr = json.optJSONArray("alerts");
            if (arr == null || arr.length() == 0) return POLL_MS;
            long maxId = since;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject a = arr.getJSONObject(i);
                long id = a.optLong("id", 0L);
                maxId = Math.max(maxId, id);
                notifyAlert(
                        this,
                        (int) (id % Integer.MAX_VALUE),
                        a.optString("symbol", "") + " " + a.optString("timeframe", "") + " 转可做",
                        summarize(a.optString("line", ""))
                );
            }
            p.edit().putLong("since", maxId).apply();
        } catch (Exception e) {
            /* JSON 坏了：下一轮再来 */
        }
        return POLL_MS;
    }

    /**
     * 那一大篇 Markdown 压成一行摘要（通知里放不下整篇）。
     *
     * ⚠️ 跟前端 `markdownToPlain` 一个思路：抹记号、压空白、截断。
     *    服务端已经存的是原文，这里只做"能读"。
     */
    private static String summarize(String line) {
        if (line == null) return "";
        String one = line.replaceAll("[*_`#>]", " ").replaceAll("\\s+", " ").trim();
        if (one.length() > 120) one = one.substring(0, 120) + "…";
        return one;
    }

    /** 一个极简的 GET（只用 HttpURLConnection，不引任何第三方库） */
    private String httpGet(String path, String token) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base(this) + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == 401) {
                /* 登录过期了：停掉并说一声（不然每 90 秒白跑一次） */
                prefs(this).edit().putString("token", "").apply();
                notifyAlert(this, 2, "Ait 后台提醒已暂停", "登录过期了，打开 App 重新登录就会自己恢复");
                stop(this);
                return null;
            }
            InputStream in = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            if (in == null) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String l;
            while ((l = r.readLine()) != null) sb.append(l);
            r.close();
            return code >= 200 && code < 300 ? sb.toString() : null;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* ---------------- 通知 ---------------- */

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ONGOING, "Ait 后台提醒（常驻）", NotificationManager.IMPORTANCE_MIN);
        ongoing.setDescription("App 在后台盯着「持久化分析」，转可做时提醒你");
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);

        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT, "AI 转可做提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("持久化分析：结论转成「可做」时提醒");
        nm.createNotificationChannel(alert);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private Notification ongoingNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ONGOING)
                .setContentTitle("Ait 正在盯着")
                .setContentText("结论转「可做」时会提醒你（不依赖谷歌服务）")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(openApp())
                .build();
    }

    /** 发一条提醒（`testNotify` 也走这儿，方便先验"通知这条路通不通"） */
    static void notifyAlert(Context ctx, int id, String title, String body) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ALERT)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openAppIntent(ctx))
                .build();
        nm.notify(id, n);
    }

    private static PendingIntent openAppIntent(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(ctx, 0, i, flags);
    }
}

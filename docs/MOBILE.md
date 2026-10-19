# 打包成 App（Android / iOS）

用 **Capacitor** 把现有的 Vue 前端装进原生壳，一套代码出双端。

> **后端和数据库不上手机。** 手机端只有界面，所有取数、算口径、调 DeepSeek、读库
> 仍然跑在 `bitcoooin.cn`（Docker + PostgreSQL），线上部署**一行没改**。
>
> 所以这个 App 是「外壳 + 你的界面 + 连你的服务器」，**必须联网**。

---

## 一、当前状态

|                                                  | 状态                                                 |
| ------------------------------------------------ | ---------------------------------------------------- |
| 前端改造（安全区 / API 基址 / hash 路由）        | ✅ 已完成                                            |
| Capacitor 接入（`capacitor.config.json` + 依赖） | ✅ 已完成                                            |
| **Android 工程 + APK**                           | ✅ **已跑通**（`android/`，产物约 9 MB）             |
| iOS 工程                                         | ⚠️ 未生成 —— 本机缺完整 Xcode 与 CocoaPods，见第四节 |

---

## 二、为什么这么改（改了什么）

打包后页面不再跑在 `bitcoooin.cn`，而是跑在 WebView 的本地 scheme 下
（Android `https://localhost`、iOS `capacitor://localhost`）。这一个前提牵出三处改动：

| 文件                       | 改了什么                                                                      | 不改会怎样                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frontend/src/platform.ts` | **新增**：判断「网页」还是「原生壳」                                          | —                                                                                                                                                                  |
| `frontend/src/api.ts`      | 新增 `API_BASE` / `apiUrl()`；`req()`、4 处 `EventSource`、`iconUrl()` 都走它 | `/api/...` 是相对路径，**全部打到 WebView 自己身上 → 全站 404**                                                                                                    |
| `frontend/src/router.ts`   | 原生壳里用 `createWebHashHistory()`                                           | 本地没有后端做 SPA 回退，刷新/直达子路径 **404 白屏**                                                                                                              |
| `frontend/index.html`      | viewport 加 `viewport-fit=cover` + theme-color + apple meta                   | 不写 `viewport-fit=cover`，`env(safe-area-inset-*)` **恒为 0**，现有底部导航安全区直接失效                                                                         |
| `frontend/src/style.css`   | 抽 `--safe-top` 变量，`#app` 的**三处** padding 全部带上                      | 全屏后第一行被**刘海**压住。⚠️ 只改基础那一处**没用**：`body.fixed-viewport #app` 和窄屏 `@media` 两条特异性/位置在后面，会把它整个盖掉 —— 实测手机上顶部只剩 10px |
| `capacitor.config.json`    | `StatusBar.overlaysWebView=false` + 深色状态栏                                | Android 的 `env(safe-area-inset-top)` **恒为 0**，光靠 CSS 兜不住（CSS 那套留作 overlay 模式的兜底）                                                               |

**在网页上这些改动全是空操作**（`isNativeShell()` 恒为 `false`、`env()` 恒为 `0`），
线上行为跟以前一模一样。

---

## 三、Android

### 一键出 APK

```bash
bash scripts/build-apk.sh
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`，装到手机：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

### ⚠️ 唯一的坑：JDK 21

Capacitor 8 要求 **JDK 21**。用 JDK 17 会报：

```
错误: 无效的源发行版：21
```

Homebrew 的 `openjdk@21` 是 **keg-only**（不链进 PATH），所以：

```bash
brew install openjdk@21        # 没装才需要
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
```

`scripts/build-apk.sh` 已经自动处理这段探测，手动跑 Gradle 时才需要自己 export。

### 其他依赖

- Android SDK：`~/Library/Android/sdk`（已有 `android-36` + `build-tools 36`）
- 工程里的 `android/local.properties` 是**本机路径**，已被 `android/.gitignore` 忽略，
  换机器要重新生成（Android Studio 打开一次即可）

### 用 Android Studio（改原生配置时）

```bash
npm run app:android      # 打前端 + cap sync + 打开 Android Studio
```

**装了 Capacitor 插件、改了 `capacitor.config.json`、动了 `frontend/src` 之后，
都必须先 `npm run app:sync` 再编译**，否则 App 里跑的还是旧前端。

### 出正式包（上架 / 分发）

现在编的是 **debug** 包（自用够）。要给别人装或上架，得先做签名：

```bash
keytool -genkey -v -keystore release.keystore -alias ca -keyalg RSA -keysize 2048 -validity 10000
```

再在 `android/app/build.gradle` 里配 `signingConfigs`，然后 `./gradlew assembleRelease`（APK）
或 `bundleRelease`（AAB，上 Google Play 用）。**`release.keystore` 绝对不能提交进仓库。**

---

## 四、iOS

本机现在**打不了**：`xcodebuild` 指向的是 Command Line Tools，且没装 CocoaPods。
补上环境后就能走：

```bash
# 1. 装完整 Xcode（App Store，约 7 GB），然后：
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

# 2. 装 CocoaPods
brew install cocoapods

# 3. 生成 iOS 工程并打开
npm run app:add:ios
npm run app:ios
```

- 真机调试需要 Apple 开发者账号（免费账号也能装，但 **7 天过期**）
- 上架 / TestFlight 需要付费账号：**$99 / 年**
- 分发流程：Xcode 归档 → TestFlight 内测 → App Store 审核

---

## 五、接口地址

原生壳里默认指向 `https://bitcoooin.cn`（见 `api.ts`）。
想指到别的服务器（比如本地起后端联调），构建时传环境变量：

```bash
VITE_API_BASE=http://192.168.1.10:8787 npm run ui:build && npx cap sync
```

> 本地联调时后端要监听 `0.0.0.0` 且手机与电脑同一局域网。
> ⚠️ 后端的 CORS 是**白名单**（`backend/src/server.ts` 的 `CORS_ORIGIN_RE`），
> 只放行 `bitcoooin.cn` + `https://localhost`（Android 壳）+ `capacitor://localhost`（iOS 壳）
>
> - 本机开发端口。**指到别的地址要记得把那个来源加进去**，否则请求会被浏览器拦掉。

---

## 六、常用命令

| 命令                      | 干什么                                              |
| ------------------------- | --------------------------------------------------- |
| `npm run apk`             | 一键出 Android APK（= `bash scripts/build-apk.sh`） |
| `npm run app:sync`        | 打前端 → 同步进**所有**已添加的原生工程             |
| `npm run app:android`     | sync 后用 Android Studio 打开                       |
| `npm run app:ios`         | sync 后用 Xcode 打开（需先装环境）                  |
| `npm run app:run:android` | sync 后直接跑到已连接的设备/模拟器                  |
| `npm run app:add:ios`     | 生成 iOS 工程（只需一次）                           |

---

## 六之二、推送（FCM，2026-10-15）

「持久化分析」结论**转可做**时会给手机推一条（App 被杀也能收到）。三处配合，缺一个就静默不生效：

| 在哪 | 是什么 | 少了会怎样 |
| --- | --- | --- |
| `android/app/google-services.json` | Firebase 控制台 → 项目设置 → 添加 Android 应用（包名 **`cn.bitcoooin.advisor`**）→ 下载 | Gradle 的 `google-services` 插件被跳过（`android/app/build.gradle` 里那个 `if`），App 拿不到 token |
| 服务器 `FCM_SERVICE_ACCOUNT_FILE` | Firebase 控制台 → 项目设置 → **服务账号** → 生成新的私钥 → 存 `/opt/crypto-advisor/firebase-sa.json` | 后端没法发；日志里一行「没配 FCM 服务账号」 |
| `@capacitor/push-notifications` | 已在 `package.json` 里；改完跑一次 `npm run app:sync` | — |

⚠️ **两个文件都不进 git**：`google-services.json` 含 API key（`.gitignore` 已加）、
私钥更是（服务器上 `chmod 600`，只给 `ubuntu`/容器读）。

### 点一遍（约 5 分钟，2026-10-15 写的）

1. <https://console.firebase.google.com> → 用 Google 账号登录 → **创建项目**（名字 `ait` 随便）；
   Google Analytics 那一步**可以关掉**，不关就跟着默认点。
2. 项目里加 Android 应用：**包名必须一字不差 `cn.bitcoooin.advisor`**（昵称随便；
   SHA-1 空着不填 —— 推送用不到）→ 下载 **`google-services.json`**。
   ⚠️ 后面「添加 SDK / Gradle」那几步**全部跳过**（依赖 `android/build.gradle` 里早配好了）。
3. 那个 json 放到 **`android/app/google-services.json`**。
4. 项目设置（左上齿轮）→ **服务账号** → 「生成新的私钥」→ 下载得到
   `…-firebase-adminsdk-….json`（**别放仓库里**）→ 传上服务器，整段 JSON **内联**进
   `/opt/crypto-advisor/.env` 的 `FCM_SERVICE_ACCOUNT=` → 重启 `ca-app`。
   ⚠️ **别用文件路径**：app 容器没挂那个目录，而且 `release.sh` 每次部署会把它清掉。
   具体命令与原因见 [DEPLOY.md](./DEPLOY.md) 的「App 推送（FCM）的凭据也要进这个 `.env`」。
5. `npm run apk` 打新包 → 装到手机 → **打开一次**（弹"允许通知"→ 允许）。
   这一步之后 `push_tokens` 里才有你的设备 —— 服务端只认表里有的设备。

代码在哪：前端 [frontend/src/push.ts]（申请权限 → 上报 token → 前台弹提示 → 点通知跳 K 线）、
后端 [backend/src/notify/push.ts]（服务账号 → JWT → 换 access_token → `messages:send`）、
token 仓储 `backend/src/db/push.ts` + `push_tokens` 表。

流程：**改完 → `npm run apk` → 把 APK 装到手机 → 打开 App（这时才会上报 token）**。
服务端只认 `push_tokens` 里有的设备，所以**先装新包再点「加入持久化分析」**。
改了通知渠道（`channel_id: 'ait-alert'`）要注意：Android 的渠道是**建了就改不掉**的，
`push.ts` 里 `createChannel()` 的参数只在第一次生效。

**怎么验**：网页「我的 → 账户信息」→ 那张**推送卡** → 「发一条测试推送」
（手机在手上就会立刻弹；卡上还列着报过哪些设备、哪个被标死、上次失败原因）。
不用等"转可做"——那可能要等一整天。

排查顺序（从下往上）：

```bash
# ① 服务端有没有这个设备（新包打开过一次才会有）
docker exec -it ca-postgres psql -U ca -d crypto_advisor -c "select device, disabled_at, last_error from push_tokens;"
# ② 服务端能不能发（没配会直接说）
docker compose -f docker-compose.prod.yml logs app | grep '\[push\]'
# ③ 手机侧：装的是不是带 google-services 的包（旧包永远收不到）
```

⚠️ 手机上**系统级**通知权限被关掉的话，App 里申请也弹不出来（`checkPermissions` 会一直
返回 `denied`）—— 去「设置 → 应用 → Ait → 通知」里开。

---

## 七、分发与下载链接

### 线上：挂在域名下

APK 放 `downloads/`，Caddy 按 **`/dl/*`** 直接发文件（目录由
`docker-compose.prod.yml` 挂进 caddy 容器：`./downloads → /srv/dl`）：

```
https://bitcoooin.cn/dl/entry-advisor-<版本>.apk
```

发一次：

```bash
bash scripts/release.sh          # 会连 downloads/ 一起打上去（Caddyfile 没变就不重建 caddy）
```

`scripts/build-apk.sh` 每次都会把新 APK 自动放进 `downloads/entry-advisor-<版本>.apk`，
版本号读的是 `package.json` 的 `version`。

### 本机：同一个 WiFi 下最快

```bash
cd downloads && python3 -m http.server 8899 --bind 0.0.0.0
# 手机浏览器打开 http://<本机局域网IP>:8899/entry-advisor-<版本>.apk
```

### 安装提示

这是 **debug 签名**的包，手机首次安装要在系统里允许「未知来源」。要长期分发 / 上架，
得先做正式签名（见第三节）。

---

## 八、鉴权与还没做的

1. ~~后端鉴权~~ ✅ **已完成**（2026-10-04）：用户名 + 密码（scrypt）登录、30 天会话、
   多端登录与设备管理、管理员两步验证（TOTP）。业务接口全部要登录，
   只有行情 / K 线 / 币种 / 图标 / 下载清单是公开的。
   - **会话自动续期**（2026-10-11）：token 不再是「签发那刻定死的 30 天」——
     每次带 token 的请求都会把有效期往后推（**同一 token 每分钟最多写一次库**，
     节流在 `server.ts` 的 `touchSoon()`）。
     推的规则：剩余**不足 20 天**才推、推到 30 天；**封顶在 `created_at + 90 天`**，
     所以 token 泄露也不会变相「永久」——撑死 90 天必须重新登录。
     相关常量在 `backend/src/db/users.ts`（`SESSION_RENEW_DAYS` / `SESSION_MAX_DAYS`）。
   - 请求要带 `Authorization: Bearer <token>`（`api.ts` 的 `req()` 自动加）；
     SSE（EventSource）发不了请求头，所以走 `?token=`。
   - ⚠️ **开了两步验证的账号，旧版 App 登不进去**（旧包拿到的是 `{needTotp}` 而不是 token）
     —— 要开 TOTP 就先重新打一版 APK。

2. **上架合规**
   - App Store 4.2 条款：纯网页壳会被判「Minimum Functionality」拒掉，需要足够的原生能力
   - 加密货币 / 预测类 App 审核极严，**中国区基本无法上架**；现实路径是海外区账号或内部分发（APK / TestFlight）
   - 免责声明要显著（「不是投资建议」），并作为审核说明材料

3. **原生体验打磨**
   - ~~Android 物理返回键~~ ✅ **已做**（`frontend/src/back-button.ts`）：
     能后退就路由后退，已经在落地页（`/contracts`）再按才真退出。
     按仓库约定**不 `import` `@capacitor/*`**（那些是 `devDependencies`，生产镜像不装），
     而是从 `window.Capacitor.Plugins.App` 取插件；**Web 上是空操作**。
     注：手势导航（从屏幕边缘往里滑）跟三键导航、`Esc` 键是**同一个事件**，一并覆盖。
   - ~~SSE 直播流切后台 / 锁屏后会挂起~~ ✅ **已做**：
     · `frontend/src/live.ts` 把「浏览器标签页」和「原生壳」的前后台并成一个信号
     （原生那边由 `native.ts` 接 `appStateChange` 灌进去）—— 光听 `visibilitychange`
     在原生壳里**不可靠**，有的机型回前台不补发它。
     · `api.ts` 的 `liveSse()`：切后台**当场断开**省电，回前台**立刻重连**；
     再加一个看门狗（后端 20 秒一次 `event: heartbeat`）收「僵尸连接」。
     重连后回调上层把断开期间的数据补回来（K 线重拉、行情重拉整表）。
   - ~~切一级 tab 会把 SSE 全断掉、切回来重开一条~~ ✅ **已做**（2026-10-06，
     用户：「切换页面 SSE 会断开重连吗……可以做一个前端全局的吗」）：
     · `api.ts` 里 `liveSse` 外面多了一层 `sharedSse`（按 path 复用）：**最后一个人走了
     先不关，留 30 秒宽限**，这期间有人再订同一条 path 就直接复用 —— 切页来回不重连、
     也不触发后端那轮 `wake()` 补账；同一条 path 的多个消费者（比如「合约」页和
     「我的」页看同一套 Key）现在共用一条连接，以前是各开各的。
     · 实测：`我的 → 开单分析 → 我的`（几秒内）**零 close、零 open**；离开超过 30 秒
     才真的 `close`，回来再 `open` 一条。
     · ⚠️ 为什么**没有**做成「登录后一直连着」的全局常连：后端的
     「没人看就不补展示字段」（省 25 权重）和「沉睡档」（空转 + 空仓 + 2 小时没动静
     才断上游 WS）**正是靠「有没有人在订阅」判断的**，常连会让这两处永远为假。
     宽期限只是把它们**推迟最多 30 秒**。改这块之前先看 `api.ts` 里那段注释。
     · 登出 / 换 token 时 `setAuthToken()` 会掉 `closeAllStreams()` 立刻全关
     （不然最多多活那 30 秒）。
   - ~~「我的」页来回切要重拉 Key / 重读库~~ ✅ **已做**（2026-10-06，用户：
     「交易所页面是 me 吗加页面缓存」）：
     · `App.vue` 的 `CACHED_VIEWS` 里加上 `MeView`（`<KeepAlive>` 名单），
       第一次进来才挂载，之后切走**不卸载** —— 切回来不用重拉 `/api/exchange-keys`、
       不重读库、`?p=` 那段原地保留。
     · ⚠️ 代价是**子页的订阅 / 定时器不会自己停**（组件活着），所以 `MeView` 自己盯住
       KeepAlive 的进出信号：`onActivated` / `onDeactivated` 维护 `pageAlive`。
       `ExchangeAccountLivePanel` 收的是 `:active="pane === 'exchange' && pageAlive"`
       （它自己在 `active=false` 时 `stopWork()`），另外几格
       （复盘 / 个人信息 / 管理，`ServerStatusView` 在轮询）用 `v-if="pageAlive && …"`
       保证**离开这一页就卸载**。
     · 实测：`我的 → 合约 → 我的`（几秒内）**一条 EventSource 都没新建、一条也没关**
       （交换所在 30 秒宽限里被复用），`/api/exchange-keys`、`/api/exchange/refresh`
       也都没有重发 —— 卡片和缩略走势原地还在。   - ~~应用图标、启动图、状态栏配色~~ ✅ **已做**：
     · 图标 / 启动图由 `scripts/make-icons.py` **代码生成**（27 张，含 5 档密度 ×
     普通 / 圆形 / 自适应前景），改色改比例重跑一遍就行，不用手改图。
     · 状态栏：`Style.DARK`（= 深底浅字）+ 主题里的状态栏 / 导航栏 / 窗底统一到 `#08090b`。
     ⚠️ `targetSdkVersion = 36` → Android 15+ **强制 edge-to-edge**，状态栏底色不再由
     主题决定，而是透出 WebView 内容（靠页面顶部的安全区内边距垫）。
     · 启动图底色 = App 主背景 → 冷启动不再白闪。

---

## 九、本地打包前端（不再远程加载）

> 2026-10-04 曾改成 `server.url` 远程加载（软更新）；2026-10-19 用户反馈
> 「App 打开先黑屏，过一会儿才出内容」——远程加载把「打开 App」绑死在网络上，
> 于是又改回**本地资源**：`frontend/dist` 随 APK 打进包，WebView 直接从本地
> `https://localhost` 读页面，**页面本身不再请求网络**。

`capacitor.config.json` 里只保留 scheme，不再配 `url`：

```json
"server": {"androidScheme": "https"}
```

**效果**：

- 打开 App **立刻**有界面（登录页 / 骨架），不会先黑屏等网页下载；
- 数据仍走服务器（`https://bitcoooin.cn`），断网时显示「网络不通」，但 UI 不空白；
- 页面源变成 `https://localhost`，`api.ts` 的 `API_BASE` 会指向
  `https://bitcoooin.cn`，后端 CORS 白名单已放行 `https://localhost`；
  路由用 hash（`#/...`），SSE / 下载链接也都走 `apiUrl()` 的绝对地址 ——
  这些在 `platform.ts` 一开始就是按「原生壳」写的，不用额外适配。

**代价（已知并接受）**：

- **每次改前端都要重新出包**：`npm run apk` 后重装，没有软更新了。
- 首次装这个版本时，页面源从 `bitcoooin.cn` 变成 `https://localhost`，
  `localStorage` 不共享 ⇒ **要重新登录一次**（token / 本地偏好都会清空）。
- App ≈ 自带页面的套壳客户端；**上架 App Store 仍会被 4.2
  「Minimum Functionality」判**（本来就没上架）。

**改完必须重新出包**：`capacitor.config.json`、`frontend/dist`（随
`npx cap sync` 拷进 `android/app/src/main/assets/public`）都只认安装包。

### 「App 常驻后台，再打开是一片黑」—— 三种原因与对策（2026-10-17）

用户 2026-10-17：「这个 APP 常驻在后台，但是我一打开的时候，会直接黑屏，什么内容都没有。」

**2026-10-19 之前这个壳是 `server.url` 远程加载**，WebView 里没有「页面」，一旦出事就是一片窗底色（近黑）。
现在 `frontend/dist` 已随包内置（见上一节），第一屏不再依赖网络；下面三条对策仍然保留，
覆盖「渲染进程被回收 / 本地页面加载失败 / 脚本没跑起来」。
三种原因、三条对策，**全部在安装包里**（要装 0.2.15+）：

| 原因 | 以前的表现 | 现在的对策（`MainActivity.java`） |
|---|---|---|
| **渲染进程被系统回收**（后台待久了内存不够，华为这类 ROM 尤其爱干） | Capacitor 默认的 `onRenderProcessGone` 返回 `false` ⇒ **系统直接崩掉 App**（就是之前报的「一直闪退」）；或者留下一个死界面 = 黑屏 | 接管它：`return true` + **重建 Activity**（新 WebView 自动重新加载）。连续 3 次还死就不再重建，免得变成「开一次崩一次」 |
| **回来时网还没通**（数据网刚唤醒 / 到服务器的 IPv4 被掐，这台机器实测过几分钟黑洞） | 远程加载时代：主文档加载失败**没有错误页** ⇒ 纯黑，只能杀进程重开 | `WebViewClient.onReceivedError`（只认 `isForMainFrame`；5xx 也管）→ 换成**自带**的「连不上服务器」页：说明 + 「重新加载」+ **每 6 秒自动重试**（最多 20 次）。本地资源时代主要防「本地页面没加载起来」 |
| **界面脚本没跑起来**（模块 404 / 初始化抛错） | `#app` 空着 + 深色底 = 黑屏，而且永远不动 | ① `frontend/index.html` 里一段**内联**看门狗：12 秒没挂载就露出「页面没起来 + 重新加载」；② `main.ts` 的 `app.config.errorHandler` / `unhandledrejection`：整棵树空了也露它 |

**别的两条**（同一次顺手加的）：`onResume` 里——离开超过 5 分钟且 `getContentHeight() <= 0`
（内容其实没了）就重新加载，否则 `invalidate()` 逼一次重绘（部分 ROM 回前台不复绘）；
`onPause` 记下离开时刻，用来做上面那个判断。

⚠️ **别把它当成前端 bug 去查**：这三条里前两条 JS 根本还没跑（页面都没下来），
前端能做的只有第三条。真机排查顺序：先看**装的是哪一版**（`我的 → 个人信息 → App 信息`），
0.2.15 之前的一律先升级再说。

⚠️ 改这几个 Java 文件**必须重新出包并重装**（`npm run apk`）——前端资源现在也随包内置，
改前端同样要重新出包；原生那层只认安装包。

### ⚠️⚠️ 装机版跑的是**手机里的 WebView**，不是我们本机的 Chrome

这条是 2026-10-07 用真机日志量出来的，坑很值钱：**页面一样的 CSS，浏览器里正常、App 里不对，
第一件事不是改 CSS，而是先问「那台手机的 WebView 是几版」。**

那台手机（Android 12 华为机）的 WebView 是 **Chrome 114**：

```
User-Agent: Mozilla/5.0 (Linux; Android 12; SUP-AL90 …; wv) … Chrome/114.0.5735.196 …
```

后果：**Chrome 121 才有的 CSS 特性在 App 里一律等于没写**（当时踩到的是 `scrollbar-width: none`
——「K 线页不要滚动条」在浏览器里好了、在 App 里那条杠还在）。所以：

- 写兼容性关键样式时，**别拿本机 Chrome（150+）当准**，先查一下这个特性在
  「手机 WebView 的版本」上有没有；要兜底就写**老引擎也认的那种老写法**
  （例：隐藏滚动条用 `::-webkit-scrollbar { display: none }`，**不要**用 `width: 0`）。
- 想知道手机上到底是几版：打开 App → **我的 → 个人信息 → 账户信息 → App 信息**
  （0.2.7 起那张体检单上有壳版本 / **WebView 版本** / 安全区实测值）。
- 顺带记一条同源的经验：**WebView 的根滚动条是原生控件画的**，
  CSS（`::-webkit-scrollbar` / `scrollbar-width`）**碰不到它** —— 只能让根视口别滚。

## 十、App 内检查更新（2026-10-19）

「我的 → 个人信息 → 账户信息」里有一张「版本」卡：

- **当前版本**：原生壳读 APK 的 `versionName` / `versionCode`；网页版读构建时注入的
  `__APP_VERSION__`（`vite.config.ts` 从 `package.json` 取）。
- **获取最新版本**：点一下读 `/api/downloads` 的最新一条，弹底部弹层：
  - 有新版本 → 显示版本 / 日期 / 大小 / 更新说明 + 「下载安装包」「取消」；
  - 已是最新 → 只显示「取消」。
- 下载链接还是 `/dl/<文件名>`，原生壳里用**跨域导航**交给系统浏览器
  （Capacitor 的 `Bridge.launchIntent`）；**不要**用 `window.open(url, '_system')` ——
  Capacitor 没开多窗口，Android WebView 会直接忽略。
- ⚠️ 页面随包内置，所以这里下载的新包**必须手动安装**才生效，不会自动覆盖。

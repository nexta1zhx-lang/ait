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

## 七、分发与下载链接

### 线上：挂在域名下

APK 放 `downloads/`，Caddy 按 **`/dl/*`** 直接发文件（目录由
`docker-compose.prod.yml` 挂进 caddy 容器：`./downloads → /srv/dl`）：

```
https://bitcoooin.cn/dl/entry-advisor-<版本>.apk
```

发一次：

```bash
bash scripts/release.sh          # 会连 downloads/ 一起打上去，并重建 caddy 容器
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

## 九、软更新（改前端不用再打包 APK）

用户 2026-10-04：「代码每次都要打包吗，能软更新吗」→ 已改成**远程加载**。

`capacitor.config.json` 的 `server.url` 指向线上：

```json
"server": {"url": "https://bitcoooin.cn", "androidScheme": "https"}
```

**效果**：App 的 WebView 每次启动直接加载 `https://bitcoooin.cn` 的最新前端，
所以改前端 → 只跑 `bash scripts/release.sh` 部署 Web 就行，**再也不用重新出包 / 重装**。

**代价（已知并接受）**：

- **必须联网**才能打开 App（本来就是「瘦客户端」，所有数据都在服务器）。
  服务器不可达时是 Capacitor 的错误页，**没有内置离线兜底**
  （内置的 `frontend/dist` 照旧随 `cap sync` 打进包，但 `server.url` 模式下用不到）。
- App ≈ 套壳网页 —— 自用 / APK / 内部分发没问题；**上架 App Store 会被 4.2
  「Minimum Functionality」判**（这条本来就在「还没做的」里）。
- 想用真机联调本地改动时，`server.url` 会一直拉线上 —— 临时把这一行删掉再
  `npx cap sync` 即可（改回来同理）。

**⚠️ 只改这一行不会立刻生效**：要**重新出一次包**（`npm run apk`）并重装，
之后才开始「改前端不用打包」。原生 / 依赖 / `capacitor.config.json` 的改动，
仍然要重新出包。

**兼容性**：`server.url` 下页面源就是 `bitcoooin.cn`，所以
`api.ts` 的 `API_BASE`（原生壳里写死 `https://bitcoooin.cn`）变成**同源**、CORS 用不上；
`platform.ts` 的 `isNativeShell()` 仍靠注入的 `window.Capacitor` 判为 true，
路由照旧 **hash** 模式（地址形如 `https://bitcoooin.cn/#/analyze`）；
原生插件（状态栏 / 返回键 / 前后台）照常工作。

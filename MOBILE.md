# 打包成 App（Android / iOS）

用 **Capacitor** 把现有的 Vue 前端装进原生壳，一套代码出双端。

> **后端和数据库不上手机。** 手机端只有界面，所有取数、算口径、调 DeepSeek、读库
> 仍然跑在 `bitcoooin.cn`（Docker + PostgreSQL），线上部署**一行没改**。
>
> 所以这个 App 是「外壳 + 你的界面 + 连你的服务器」，**必须联网**。

---

## 一、当前状态

| | 状态 |
| --- | --- |
| 前端改造（安全区 / API 基址 / hash 路由） | ✅ 已完成 |
| Capacitor 接入（`capacitor.config.json` + 依赖） | ✅ 已完成 |
| **Android 工程 + APK** | ✅ **已跑通**（`android/`，产物 4.1 MB） |
| iOS 工程 | ⚠️ 未生成 —— 本机缺完整 Xcode 与 CocoaPods，见第四节 |

---

## 二、为什么这么改（改了什么）

打包后页面不再跑在 `bitcoooin.cn`，而是跑在 WebView 的本地 scheme 下
（Android `https://localhost`、iOS `capacitor://localhost`）。这一个前提牵出三处改动：

| 文件 | 改了什么 | 不改会怎样 |
| --- | --- | --- |
| `frontend/src/platform.ts` | **新增**：判断「网页」还是「原生壳」 | — |
| `frontend/src/api.ts` | 新增 `API_BASE` / `apiUrl()`；`req()`、4 处 `EventSource`、`iconUrl()` 都走它 | `/api/...` 是相对路径，**全部打到 WebView 自己身上 → 全站 404** |
| `frontend/src/router.ts` | 原生壳里用 `createWebHashHistory()` | 本地没有后端做 SPA 回退，刷新/直达子路径 **404 白屏** |
| `frontend/index.html` | viewport 加 `viewport-fit=cover` + theme-color + apple meta | 不写 `viewport-fit=cover`，`env(safe-area-inset-*)` **恒为 0**，现有底部导航安全区直接失效 |
| `frontend/src/style.css` | `#app` 顶部补 `env(safe-area-inset-top)` | 全屏后第一行内容被**刘海**压住 |

**在网页上这些改动全是空操作**（`isNativeShell()` 恒为 `false`、`env()` 恒为 `0`），
线上行为跟以前一模一样。

---

## 三、Android

### 一键出 APK

```bash
bash build-apk.sh
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

`build-apk.sh` 已经自动处理这段探测，手动跑 Gradle 时才需要自己 export。

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

> 本地联调时后端要监听 `0.0.0.0` 且手机与电脑同一局域网；
> 后端已开 `Access-Control-Allow-Origin: *`，跨域不用另外配。

---

## 六、常用命令

| 命令 | 干什么 |
| --- | --- |
| `bash build-apk.sh` | 一键出 Android APK |
| `npm run app:sync` | 打前端 → 同步进**所有**已添加的原生工程 |
| `npm run app:android` | sync 后用 Android Studio 打开 |
| `npm run app:ios` | sync 后用 Xcode 打开（需先装环境） |
| `npm run app:run:android` | sync 后直接跑到已连接的设备/模拟器 |
| `npm run app:add:ios` | 生成 iOS 工程（只需一次） |

---

## 七、还没做（要正式发布再补）

1. **后端鉴权** ⚠️ 最重要
   后端接口现在**完全开放**（CORS `*`、无任何 token）。网页没人管，但 App 一旦发出去，
   等于把「分析 / 知识库 / 用量」全部接口公开给所有人，**任何人可以刷爆你的 DeepSeek 余额**。
   发布前至少加一层固定 token，规范做法是登录 + JWT。

2. **上架合规**
   - App Store 4.2 条款：纯网页壳会被判「Minimum Functionality」拒掉，需要足够的原生能力
   - 加密货币 / 预测类 App 审核极严，**中国区基本无法上架**；现实路径是海外区账号或内部分发（APK / TestFlight）
   - 免责声明要显著（「不是投资建议」），并作为审核说明材料

3. **原生体验打磨**
   - Android 物理返回键（`@capacitor/app` 的 `backButton`）—— 现在按下会直接退出 App
   - SSE 直播流在 App 切后台 / 锁屏后会被系统挂起，回前台要重连
   - 应用图标、启动图、状态栏配色（`@capacitor/status-bar`）

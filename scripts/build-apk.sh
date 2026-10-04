#!/usr/bin/env bash
#
# 构建 Android debug APK（自用安装包，不签名不上架）。
#
#   bash scripts/build-apk.sh
#
# 干了三件事：打前端 → 同步进原生工程 → Gradle 编 APK。
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
#
# ⚠️ Capacitor 8 要求 **JDK 21**（JDK 17 会报「无效的源发行版：21」）。
#    Homebrew 的 openjdk@21 是 keg-only，不装进 PATH，所以下面显式找一遍。
#
set -euo pipefail

# 脚本在 scripts/ 下，统一切到仓库根
# （下面全是相对仓库根的路径：package.json / android/ / downloads/）
cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- JDK 21
#
# ⚠️ 不能「JAVA_HOME 已设就直接用」：机器上常常已经有个 17（Homebrew 装的），
#    那样会跳过探测、编到一半报「无效的源发行版：21」。
#    所以这里**按版本挑**，认的只有 javac 21，别的都往下找。
pick_jdk() {
  for cand in \
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "$(/usr/libexec/java_home -v 21 2>/dev/null || true)" \
    "${JAVA_HOME:-}"; do
    [[ -n "$cand" && -x "$cand/bin/javac" ]] || continue
    if "$cand/bin/javac" -version 2>&1 | grep -q ' 21\.'; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

if ! JDK_HOME="$(pick_jdk)"; then
  echo "✗ 需要 JDK 21（Capacitor 8 硬性要求），没找到。装一个：" >&2
  echo "    brew install openjdk@21" >&2
  echo "  当前 JAVA_HOME=${JAVA_HOME:-未设置}" >&2
  exit 1
fi
export JAVA_HOME="$JDK_HOME"
echo "JAVA_HOME=$JAVA_HOME"
"$JAVA_HOME/bin/java" -version 2>&1 | head -1

# ------------------------------------------------- 版本号对齐 package.json
#
# ⚠️ 以前只把**文件名**写成 `entry-advisor-<版本>.apk`，而 APK **内部**的版本一直是
#    Capacitor 模板里的默认值（`versionName "1.0"` / `versionCode 1`）——
#    结果装到手机上「关于」里永远显示 1.0，根本分不出装的是哪一版，
#    而且 versionCode 不变的话 Android 也不认为它是「新版本」（用户 2026-10-04：
#    「app 版本号要区分」）。
#
# 现在**只在 package.json 一处维护版本号**，每次打包把它同步进去：
#   versionName = 原样（0.2.0）
#   versionCode = 主*10000 + 次*100 + 修订（0.2.0 → 200），单调递增
node -e '
  const fs = require("fs");
  const ver = require("./package.json").version;
  const [a, b, c] = ver.split(".").map(Number);
  const code = a * 10000 + b * 100 + (c || 0);
  const p = "android/app/build.gradle";
  let s = fs.readFileSync(p, "utf8");
  s = s
    .replace(/versionCode \d+/, `versionCode ${code}`)
    .replace(/versionName "[^"]*"/, `versionName "${ver}"`);
  fs.writeFileSync(p, s);
  console.log(`✓ APK 内部版本已对齐 package.json：versionName "${ver}" / versionCode ${code}`);
'

# ---------------------------------------------------------------- 构建
echo
echo "→ 打前端 + 同步到 Android 工程"
npm run app:sync

echo
echo "→ 编译 APK"
( cd android && ./gradlew assembleDebug )

APK="$(pwd)/android/app/build/outputs/apk/debug/app-debug.apk"
echo
echo "✓ 完成：$APK"

# 同时丢进 downloads/ —— 那是分发给别人下载的目录：
#   · 本机：python3 -m http.server（见 docs/MOBILE.md）
#   · 线上：compose 把它挂给 Caddy，链接 https://bitcoooin.cn/dl/<文件名>
# 版本号从 package.json 读，文件名带版本，不会新旧混淆。
VER="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
DEST="$(pwd)/downloads"
mkdir -p "$DEST"
cp "$APK" "$DEST/entry-advisor-$VER.apk"
echo "✓ 已放入下载目录：downloads/entry-advisor-$VER.apk"

# 别忘了在 releases.json 里补一条 —— 网页 /download 页就是读它拿到「介绍 + 更新说明」的，
# 没登记的话那一版会被列成「未登记」（能下，但说不清是什么）。
if [[ -f "$DEST/releases.json" ]] && ! grep -q "\"version\": \"$VER\"" "$DEST/releases.json"; then
  echo
  echo "⚠️  downloads/releases.json 里还没有 v$VER 这条 —— /download 页会把它列成「未登记」。"
  echo "    补一条（title / date / notes）再跑 scripts/release.sh。"
fi
ls -lh "$DEST"
echo
echo "装到手机（需要 adb）：adb install -r \"$APK\""
echo "本机下载：cd downloads && python3 -m http.server 8899 --bind 0.0.0.0"
echo "线上下载：https://bitcoooin.cn/dl/entry-advisor-$VER.apk（跑 bash scripts/release.sh 之后）"

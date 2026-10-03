#!/usr/bin/env bash
#
# 构建 Android debug APK（自用安装包，不签名不上架）。
#
#   bash build-apk.sh
#
# 干了三件事：打前端 → 同步进原生工程 → Gradle 编 APK。
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
#
# ⚠️ Capacitor 8 要求 **JDK 21**（JDK 17 会报「无效的源发行版：21」）。
#    Homebrew 的 openjdk@21 是 keg-only，不装进 PATH，所以下面显式找一遍。
#
set -euo pipefail

cd "$(dirname "$0")"

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
#   · 本机：python3 -m http.server（见 MOBILE.md）
#   · 线上：compose 把它挂给 Caddy，链接 https://bitcoooin.cn/dl/<文件名>
# 版本号从 package.json 读，文件名带版本，不会新旧混淆。
VER="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
DEST="$(pwd)/downloads"
mkdir -p "$DEST"
cp "$APK" "$DEST/entry-advisor-$VER.apk"
echo "✓ 已放入下载目录：downloads/entry-advisor-$VER.apk"
ls -lh "$DEST"
echo
echo "装到手机（需要 adb）：adb install -r \"$APK\""
echo "本机下载：cd downloads && python3 -m http.server 8899 --bind 0.0.0.0"
echo "线上下载：https://bitcoooin.cn/dl/entry-advisor-$VER.apk（跑 bash release.sh 之后）"

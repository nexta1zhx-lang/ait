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
if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/javac" ]]; then
  for cand in \
    "$(/usr/libexec/java_home -v 21 2>/dev/null || true)" \
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"; do
    if [[ -n "$cand" && -x "$cand/bin/javac" ]]; then
      export JAVA_HOME="$cand"
      break
    fi
  done
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "✗ 找不到 JDK 21。先装：brew install openjdk@21" >&2
  exit 1
fi
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
ls -lh "$APK"
echo
echo "装到手机（需要 adb）：adb install -r \"$APK\""

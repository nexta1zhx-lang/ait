<script setup lang="ts">
/*
 * 推荐三行（现在 / 开单 / 别碰）行首的**矢量图标**，带轻微动效。
 *
 * 用户：「现在 开单 别碰改为矢量图标 会动的」——
 * 这三行原来是一颗实心彩色胶囊（文字写在里面），现在文字拿出来，
 * 身份交给这个会动的小图标：一眼扫过去不用读字也知道这行是干嘛的。
 *
 * ⚠️ 颜色**不写死**：整张 SVG 全用 `currentColor`，
 *    由外面 `.rec-k` 的色调决定（现在=蓝 / 开单=绿 / 别碰=红），
 *    换配色只改 CSS，组件不用动。
 * ⚠️ 动效只碰 `transform` / `opacity`（不改宽高）→ **不影响布局**，
 *    不会把行高顶来顶去。`prefers-reduced-motion` 下面全部关掉。
 */
defineProps<{
  /** 跟 `splitRec()` 出来的 tone 一致：now / do / dont */
  tone: string
}>()
</script>

<template>
  <svg class="ri" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <!-- ① 现在：定位点 + 一圈圈扩散的呼吸光环 -->
    <template v-if="tone === 'now'">
      <circle class="ri-halo" cx="12" cy="12" r="8" />
      <circle class="ri-ring" cx="12" cy="12" r="6.6" />
      <circle class="ri-core" cx="12" cy="12" r="3.4" />
    </template>

    <!-- ② 开单：反复上冲的箭头（底下一条基线 = 入场） -->
    <template v-else-if="tone === 'do'">
      <g class="ri-rise">
        <path d="M12 18.5V7.5" />
        <path d="M7.4 12.1 12 7.5l4.6 4.6" />
      </g>
      <path class="ri-base" d="M6.2 20.6h11.6" />
    </template>

    <!-- ③ 别碰：禁止符（轻轻摇头） -->
    <template v-else>
      <g class="ri-shake">
        <circle cx="12" cy="12" r="8" />
        <path d="M6.4 6.4l11.2 11.2" />
      </g>
    </template>
  </svg>
</template>

<style scoped>
.ri {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: block;
  overflow: visible;
}

.ri path,
.ri circle {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ---------- ① 现在 ---------- */
.ri-halo,
.ri-core,
.ri-shake,
.ri-rise {
  transform-box: fill-box;
  transform-origin: center;
}

.ri-ring {
  stroke-width: 1.4;
  opacity: 0.4;
}

.ri-core {
  fill: currentColor;
  stroke: none;
  animation: ri-breathe 2s ease-in-out infinite;
}

/* 光环：从中心一圈圈推出去，推到边就消失 —— 就是「此刻」的那个点 */
.ri-halo {
  stroke-width: 1.4;
  animation: ri-ping 2s ease-out infinite;
}

@keyframes ri-ping {
  0% {
    transform: scale(0.42);
    opacity: 0.85;
  }
  70% {
    opacity: 0.12;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

@keyframes ri-breathe {
  0%,
  100% {
    opacity: 0.55;
  }
  45% {
    opacity: 1;
  }
}

/* ---------- ② 开单 ---------- */
/* 箭头往上顶一下再落回来（首尾同一位置 → 循环无跳变） */
.ri-rise {
  animation: ri-rise 1.5s ease-in-out infinite;
}

.ri-base {
  stroke-width: 1.6;
  opacity: 0.45;
}

@keyframes ri-rise {
  0%,
  100% {
    transform: translateY(2.4px);
    opacity: 0.5;
  }
  55% {
    transform: translateY(-1.6px);
    opacity: 1;
  }
}

/* ---------- ③ 别碰 ---------- */
/* 左右摇两下（像在摇头说不），然后静止一会儿再摇 —— 不吵 */
.ri-shake {
  animation: ri-shake 3s ease-in-out infinite;
}

@keyframes ri-shake {
  0%,
  58%,
  100% {
    transform: rotate(0deg);
  }
  64% {
    transform: rotate(-8deg);
  }
  70% {
    transform: rotate(7deg);
  }
  76% {
    transform: rotate(-5deg);
  }
  82% {
    transform: rotate(3deg);
  }
  88% {
    transform: rotate(0deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ri-halo,
  .ri-core,
  .ri-rise,
  .ri-shake {
    animation: none;
  }
  .ri-halo {
    opacity: 0;
  }
}
</style>

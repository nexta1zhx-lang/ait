<script setup lang="ts">
/**
 * **加入黑名单**的弹层（2026-10-10 那个确认框升级来的，2026-10-18 用户：
 * 「黑名单机制修改，可选择封禁时间，最大 24 小时」）。
 *
 * 以前是一个 `askConfirm`（时长写死在后端）；现在多了「封多久」这一档，
 * 而 `askConfirm` 的正文只能是文字（不支持控件），所以单开一个弹层：
 * 上面一句后果、中间一排时长档位、下面一颗确认键 —— 一次点完，不用二次确认。
 *
 * ⚠️ 时长档位是**固定几档**而不是滑条：手滑一下就是几小时的差别，
 *    档位点错了看一眼就知道改哪儿。
 * ⚠️ 上限以后端回的 `blacklistMaxHours` 为准（现在是 24），别在这儿写死。
 */
import {computed, ref, watch} from 'vue'
import {blacklistMaxHours} from '../blacklist'

const props = defineProps<{
  open: boolean
  /** 要关进去的币（基础币，`BTC`） */
  base: string
  /** 默认档位（后端给的默认时长，8） */
  defaultHours: number
  /** 正在提交 */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', hours: number): void
}>()

/** 能选的档位：1 / 2 / 4 / 8 / 12 / 24（上限那档跟着 `blacklistMaxHours` 走） */
const HOURS = [1, 2, 4, 8, 12, 24]

const hours = ref(props.defaultHours)

/* 每次打开都回到默认档；上限变了就把超出的档位收掉 */
const choices = computed(() => {
  const max = Math.max(1, blacklistMaxHours.value || 24)
  const list = HOURS.filter(h => h <= max)
  return list.includes(max) ? list : [...list, max]
})

watch(
  () => props.open,
  on => {
    if (on) hours.value = Math.min(props.defaultHours, choices.value.at(-1) ?? 24)
  }
)

/** 到了上限那句换个说法：「24 小时（一天）」 */
const label = (h: number): string => (h === 24 ? '24 小时' : `${h} 小时`)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet ban-sheet" role="dialog" aria-label="加入黑名单">
      <header class="sheet-head">
        <b>{{ base.toUpperCase() }} · 加入黑名单</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <p class="ban-lead">
        关进去之后 <b>{{ label(hours) }}</b> 内不能开 {{ base.toUpperCase() }} 的单。减仓 /
        平仓不受影响 —— 手里有仓随时能跑。
      </p>

      <div class="sheet-row">
        <span class="rk">封多久</span>
        <div class="ctl ban-picks">
          <button
            v-for="h in choices"
            :key="h"
            type="button"
            class="ghost tiny"
            :class="{on: hours === h}"
            @click="hours = h"
          >
            {{ h }}h
          </button>
        </div>
      </div>

      <p class="ban-dim">
        ⚠️ 到点自动解除。真想提前解开：连点币种旁边那颗「黑名单」图标八下（会再问一次）。
      </p>

      <button class="btn-run ban-go" :disabled="busy" @click="emit('confirm', hours)">
        {{ busy ? '加入中…' : `关 ${label(hours)}` }}
      </button>
    </section>
  </Teleport>
</template>

<style scoped>
/*
 * 只改这一层（别动全局 `.sheet` / `.sheet-row` —— 那几个别的弹层也在用）。
 */
.ban-lead {
  margin: 2px 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.ban-lead b {
  color: color-mix(in srgb, var(--bad) 80%, var(--text));
  font-weight: var(--fw-mid, 500);
}
/* 档位一行铺开：六个 1h…24h，390px 上刚好放得下（每个 ~44px） */
.ban-picks {
  flex-wrap: nowrap;
  gap: 5px;
}
.ban-picks button {
  padding: 5px 9px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ban-picks button.on {
  border-color: color-mix(in srgb, var(--bad) 55%, transparent);
  background: color-mix(in srgb, var(--bad) 16%, transparent);
  color: color-mix(in srgb, var(--bad) 90%, var(--text));
}
.ban-dim {
  margin: 10px 0 14px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
}
.ban-go {
  width: 100%;
}
</style>

/**
 * **Telegram 通知**（2026-10-15 用户：「结论变化时站内提示 + 同时往 Telegram 发一条（复用现成的）」）。
 *
 * 复用的是服务器上早就有的那一套：`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
 *（原来只给部署脚本 `scripts/deploy.sh` 和可用性看门狗 `scripts/alert-watchdog.sh` 用，
 * 藏在 `/etc/ait-alert.env`，不进 git）。
 *
 * ⚠️ 通知**永远不许影响主流程**：没配、网络不通、Telegram 报错 —— 一律只打一行日志。
 *    调用方（`analysis/persist.ts`）也不 await 它的失败。
 *
 * ⚠️ URL 里带 bot token，**不要**写进日志 / 错误信息（跟 `scripts/deploy.sh` 那边同一个规矩）：
 *    这里只用 curl 的退出码和「ok:true」判断，不回显响应体。
 */
const API = 'https://api.telegram.org'

/** 读一个环境变量（`env_file: .env` 会把服务器那份喂进来） */
function envOf(name: string): string {
  return (process.env[name] ?? '').trim().replace(/^["']|["']$/g, '')
}

export function telegramConfigured(): boolean {
  return !!envOf('TELEGRAM_BOT_TOKEN') && !!envOf('TELEGRAM_CHAT_ID')
}

/**
 * 发一条（best-effort）。
 *
 * @returns 发出去了 true；没配 / 失败 false（调用方只拿来打日志）
 */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = envOf('TELEGRAM_BOT_TOKEN')
  const chat = envOf('TELEGRAM_CHAT_ID')
  if (!token || !chat) {
    console.log('[notify] 没配 Telegram（TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID），跳过通知')
    return false
  }
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      // 不带 parse_mode：内容是行情结论，塞 HTML 还得转义，不值当
      body: new URLSearchParams({chat_id: chat, text, disable_web_page_preview: 'true'}),
      // 别让一条通知把这一轮分析卡住
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      console.warn(`[notify] Telegram 返回 ${res.status}（详情不回显，避免 token 进日志）`)
      return false
    }
    const body = (await res.json().catch(() => null)) as {ok?: boolean} | null
    if (!body?.ok) {
      console.warn('[notify] Telegram 未确认发送成功（详情不回显）')
      return false
    }
    return true
  } catch (e) {
    console.warn(`[notify] Telegram 发送失败：${(e as Error).name || 'error'}`)
    return false
  }
}

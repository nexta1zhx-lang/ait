/**
 * 提示词拼装 —— **正文全在数据库**（网页「我的 → AI 提示词」维护，即改即生效）。
 *
 * ★ 2026-10-11：输出契约（那串 JSON 骨架）**删掉了**。用户要的是「一句话自然语言」，
 *   格式由**正文自己**说（正文里写「只回一句话」就行），代码不再往后追加任何格式要求。
 *   所以这里只剩两件事：把正文当 system、把行情快照当 user。
 */

/**
 * system prompt = 数据库那份「分析预测」正文。
 *
 * ⚠️ 代码里没有兜底文案 —— 正文空了就直接报错，别静默地发一条空提示词给模型。
 */
export function buildSystemPrompt(promptText: string): string {
  const text = promptText.trim()
  if (!text)
    throw new Error(
      '分析预测提示词是空的 —— 去「我的 → AI 提示词」写一份（打勾才生效）。'
    )
  return text
}

/** user prompt = 行情快照 + 一句「请开始判断」 */
export function buildUserPrompt(context: string): string {
  const sep = '\n\n' + '='.repeat(60) + '\n\n'
  return [
    `【当前行情快照】\n\n${context}`,
    '请按我的提示词判断：现在这一单该不该开。'
  ].join(sep)
}

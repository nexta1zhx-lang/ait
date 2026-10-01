import readline from 'node:readline'

/** 交互式提问（回显输入） */
export function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * 交互式提问（不回显输入，用于 API Key 等敏感信息）。
 * 通过 terminal:false 关闭回显，手动打印提示语。
 */
export function askHidden(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    })
    process.stdout.write(question)
    rl.once('line', line => {
      rl.close()
      resolve(line.trim())
    })
  })
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY)
}

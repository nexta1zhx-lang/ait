#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import {Command} from 'commander'
import {loadConfig, ROOT_DIR} from './config'
import {fullSystem, loadRules} from './rules'
import {fetchSnapshot} from './data/market'
import {buildContext} from './context/builder'
import {judge} from './llm/client'
import {oneLineCost} from './llm/pricing'
import {listTags} from './db/knowledge'
import {loadTagTemplates} from './db/tags'
import {recordUsage} from './db/usage'
import {defaultUserId} from './db/users'
import {resolveUserLlm, saveUserLlm} from './db/llm-keys'
import {saveAnalysis, saveRulesVersion} from './db/analyses'
import {render} from './output/render'
import {ask, askHidden, isInteractive} from './util/prompt'
import {MarketType, Timeframe} from './types'

const program = new Command()

program
  .name('ca')
  .description('币圈开单分析：拉行情 → 切段读给模型 → 预测最大概率的走法')
  .argument('<symbol>', '交易对，如 BTC/USDT')
  .option('-e, --exchange <id>', '交易所（ccxt id，如 binance / okx）')
  .option(
    '-m, --market <type>',
    '市场类型: spot（现货）| swap（U 本位合约）| coinm（币本位）'
  )
  .option('-t, --timeframe <tf>', '主周期（图上那个）：5m|15m|1h|4h|1d', '1h')
  .option('-d, --days <n>', '主周期往前看多少天（= 图上那段有多长）')
  .option('--api-base <url>', '覆盖交易所公共 API 域名（默认域名不可达时使用）')
  .option('--json', '输出完整 JSON（便于程序消费，进度输出到 stderr）')
  .option('--api-key <key>', '直接传入 LLM API Key（本次生效，不写入 .env）')
  .option('--save-context <file>', '把发给 LLM 的上下文另存为文件')
  .showHelpAfterError()
  .action(async (symbol: string, opts: Record<string, unknown>) => {
    const log = (m: string) => process.stderr.write(m + '\n')
    try {
      const tfRaw = String(opts.timeframe ?? '')
      const timeframe = (
        ['5m', '15m', '1h', '4h', '1d'].includes(tfRaw) ? tfRaw : '1h'
      ) as Timeframe

      // 命令行没有登录态 —— 用第一个账号（建过号就归他名下）
      const userId = await defaultUserId().catch(() => null)
      // 用那把**默认**密钥；用量记到它名下
      const resolved = await resolveUserLlm(userId)
      /** 本次实际归属的密钥（临时 --api-key 就不归到任何一把） */
      let usedKeyId = resolved.keyId

      const config = loadConfig({
        exchange: opts.exchange ? String(opts.exchange) : undefined,
        timeframes: [timeframe],
        apiBase: opts.apiBase ? String(opts.apiBase) : undefined,
        marketType: opts.market
          ? (String(opts.market) as MarketType)
          : undefined,
        llm: resolved.llm
      })
      const rules = await loadRules()
      log(
        `• 我的提示词: ${rules.sources.join('、') || '（数据库里没有启用项）'}`
      )
      for (const w of rules.warnings) log(`  ⚠️  ${w}`)

      // 解析 API Key：命令行 > 账号里配的（「我的 → 模型配置」）> 交互式输入
      if (opts.apiKey) {
        config.llm.apiKey = String(opts.apiKey)
        usedKeyId = null // 临时给的，不算在任何一把密钥头上
      }
      if (!config.llm.apiKey) {
        if (!isInteractive()) {
          throw new Error(
            '这个账号还没配 API Key：在网页「我的 → 模型配置」里填，或用 --api-key 传入。'
          )
        }
        log('')
        log(`• 未检测到 API Key（接口: ${config.llm.baseUrl}）`)
        log('  请粘贴你的 API Key 后回车（输入过程不回显）；按 Ctrl+C 可取消。')
        const key = await askHidden('API Key: ')
        if (!key) throw new Error('未提供 API Key，已退出。')
        config.llm.apiKey = key
        usedKeyId = null
        // 存进**这个账号的默认那把密钥**（不再写 .env —— 配置已经按用户存库了）
        if (userId != null) {
          const save = await ask('是否保存到账号里以便下次自动使用？(y/N) ')
          if (/^y(es)?$/i.test(save)) {
            try {
              await saveUserLlm(userId, {apiKey: key})
              usedKeyId = resolved.keyId
              log('• 已保存到账号密钥（网页「我的 → 模型配置」里能看到）')
            } catch (e) {
              log(`• 保存失败：${(e as Error).message}（本次仍会使用该 Key）`)
            }
          }
        }
      }

      log(
        `• 拉取 ${symbol} 行情 (${config.exchange} / ${config.marketType}) ...`
      )
      const days = Math.max(1, Number(opts.days) || config.lookbackDays)
      const snapshot = await fetchSnapshot({
        exchangeId: config.exchange,
        symbol,
        timeframe,
        days,
        marketType: config.marketType,
        apiBase: config.apiBase,
        calibers: config.calibers
      })

      const context = buildContext(snapshot)
      if (opts.saveContext) {
        const f = path.resolve(String(opts.saveContext))
        fs.writeFileSync(f, context, 'utf8')
        log(`• 上下文已保存: ${f}`)
      }

      log(`• 调用大模型 (${config.llm.model}) ...`)

      // 可用的标签池：复用「标签模板 + 知识库里用过的标签」（跟网页同一条路径）
      let tags: string[] = []
      try {
        const [templates, used] = await Promise.all([
          loadTagTemplates(userId),
          listTags(userId)
        ])
        tags = [...new Set([...templates, ...used.map(u => u.tag)])]
      } catch {
        /* 忽略 */
      }

      const {result, meta} = await judge({
        snapshot,
        context,
        prompt: rules.system,
        tags,
        config
      })
      // 记账：这次判断烧了多少 token、多少钱
      const billed = await recordUsage({
        userId,
        llmKeyId: usedKeyId,
        kind: 'judge',
        model: meta.model,
        symbol: symbol.split('/')[0],
        timeframe,
        usage: meta.usage,
        attempts: meta.attempts,
        latencyMs: meta.latencyMs
      })

      // 存档：跟网页走同一张表，这样命令行做的分析也能在历史里看到
      let analysisId: number | null = null
      try {
        await saveRulesVersion({
          hash: rules.hash,
          system: fullSystem(rules.system),
          body: rules.body,
          sources: rules.sources
        })
        analysisId = await saveAnalysis({
          userId,
          symbol: symbol.split('/')[0],
          ccxtSymbol: snapshot.symbol,
          exchange: config.exchange,
          marketType: config.marketType,
          timeframes: [timeframe],
          chartTimeframe: '1h',
          judge: result,
          snapshot,
          meta: {model: meta.model, via: 'cli', days},
          model: meta.model,
          rulesHash: rules.hash,
          llmUsageId: billed?.id ?? null,
          usage: meta.usage,
          costUsd: billed?.costUsd ?? null,
          latencyMs: meta.latencyMs,
          attempts: meta.attempts
        })
      } catch (e) {
        console.warn('[cli] 存档失败:', (e as Error).message)
      }

      // 审计日志
      const logDir = path.join(ROOT_DIR, 'logs')
      fs.mkdirSync(logDir, {recursive: true})
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const logFile = path.join(
        logDir,
        `${stamp}_${symbol.replace('/', '-')}.json`
      )
      fs.writeFileSync(
        logFile,
        JSON.stringify(
          {
            symbol,
            exchange: config.exchange,
            timestamp: new Date(snapshot.timestamp).toISOString(),
            rules: {hash: rules.hash, sources: rules.sources},
            llm: {
              model: meta.model,
              raw: meta.raw,
              usage: meta.usage,
              attempts: meta.attempts,
              latencyMs: meta.latencyMs,
              costUsd: billed?.costUsd ?? 0
            },
            context,
            judge: result
          },
          null,
          2
        ),
        'utf8'
      )

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              symbol,
              exchange: config.exchange,
              price: snapshot.price,
              days,
              judge: result,
              llm: {
                model: meta.model,
                usage: meta.usage,
                attempts: meta.attempts,
                latencyMs: meta.latencyMs,
                costUsd: billed?.costUsd ?? 0
              },
              rules: {hash: rules.hash, sources: rules.sources},
              logFile
            },
            null,
            2
          ) + '\n'
        )
      } else {
        process.stdout.write(
          render(snapshot, result, {
            model: meta.model,
            disciplineEmpty: rules.sources.length === 0,
            disciplineHash: rules.hash,
            logFile,
            days,
            usageText: `${oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs)}${
              billed === null ? '（未记入统计）' : ''
            }`
          })
        )
      }
    } catch (e) {
      log(`\n❌ 出错：${(e as Error).message}`)
      process.exitCode = 1
    }
  })

program.parseAsync(process.argv)

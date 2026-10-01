#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import {Command} from 'commander'
import {loadConfig, ROOT_DIR} from './config'
import {loadRules} from './rules'
import {fetchSnapshot} from './data/market'
import {buildContext} from './context/builder'
import {judge, toDecision} from './llm/client'
import {oneLineCost} from './llm/pricing'
import {lessonsByGrade} from './db/knowledge'
import {recordUsage} from './db/usage'
import {validate} from './guardrails/validator'
import {render} from './output/render'
import {ask, askHidden, isInteractive} from './util/prompt'
import {saveKeyToEnv} from './util/llmkey'
import {LlmDecision, MarketType, Timeframe} from './types'

const program = new Command()

program
  .name('ca')
  .description(
    '币圈开单分析：拉数据 → 算指标 → 大模型按你的交易纪律判断 → 代码护栏校验'
  )
  .argument('<symbol>', '交易对，如 BTC/USDT')
  .option('-e, --exchange <id>', '交易所（ccxt id，如 binance / okx）')
  .option(
    '-m, --market <type>',
    '市场类型: spot（现货）| swap（U 本位合约）| coinm（币本位）'
  )
  .option('-t, --timeframes <list>', '周期，逗号分隔', '15m,1h,4h,1d')
  .option('-n, --recent <count>', '上下文中包含的最近 K 线数量', '30')
  .option('--api-base <url>', '覆盖交易所公共 API 域名（默认域名不可达时使用）')
  .option('--json', '输出完整 JSON（便于程序消费，进度输出到 stderr）')
  .option('--mock', '使用内置模拟决策（不调用 LLM，用于离线跑通）')
  .option('--api-key <key>', '直接传入 LLM API Key（本次生效，不写入 .env）')
  .option('--save-context <file>', '把发给 LLM 的上下文另存为文件')
  .showHelpAfterError()
  .action(async (symbol: string, opts: Record<string, unknown>) => {
    const log = (m: string) => process.stderr.write(m + '\n')
    try {
      const timeframes = String(opts.timeframes)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean) as Timeframe[]
      const recentCount = Math.max(1, Number(opts.recent) || 30)

      const config = loadConfig({
        exchange: opts.exchange ? String(opts.exchange) : undefined,
        timeframes,
        apiBase: opts.apiBase ? String(opts.apiBase) : undefined,
        marketType: opts.market
          ? (String(opts.market) as MarketType)
          : undefined,
        mock: opts.mock === true ? true : undefined
      })
      const rules = loadRules()
      log(`• 我的规则: ${rules.sources.join('、') || '（空）'} (${rules.hash})`)
      for (const w of rules.warnings) log(`  ⚠️  ${w}`)

      // 解析 API Key：命令行 > .env > 交互式输入
      if (!config.llm.mock) {
        if (opts.apiKey) config.llm.apiKey = String(opts.apiKey)
        if (!config.llm.apiKey) {
          if (!isInteractive()) {
            throw new Error(
              '未设置 LLM_API_KEY。请在 .env 填写，或用 --api-key 传入，或加 --mock 离线跑通。'
            )
          }
          log('')
          log(`• 未检测到 LLM_API_KEY（接口: ${config.llm.baseUrl}）`)
          log(
            '  请粘贴你的 API Key 后回车（输入过程不回显）；按 Ctrl+C 可取消。'
          )
          const key = await askHidden('API Key: ')
          if (!key) throw new Error('未提供 API Key，已退出。')
          config.llm.apiKey = key
          const save = await ask('是否保存到 .env 以便下次自动使用？(y/N) ')
          if (/^y(es)?$/i.test(save)) {
            if (saveKeyToEnv(key))
              log('• 已保存到 .env（并将 LLM_MOCK 设为 0）')
            else log('• 保存到 .env 失败，本次仍会使用该 Key。')
          }
        }
      } else {
        log('• 当前为「模拟决策」，不调用大模型。')
        log(
          '  要看真实分析：把 .env 中 LLM_MOCK 改为 0，运行时会提示输入 API Key。'
        )
      }

      log(
        `• 拉取 ${symbol} 行情 (${config.exchange} / ${config.marketType}) ...`
      )
      const snapshot = await fetchSnapshot({
        exchangeId: config.exchange,
        symbol,
        timeframes,
        limit: config.candlesLimit,
        recentTimeframe: '1h',
        recentCount,
        marketType: config.marketType,
        apiBase: config.apiBase
      })

      const context = buildContext(snapshot)
      if (opts.saveContext) {
        const f = path.resolve(String(opts.saveContext))
        fs.writeFileSync(f, context, 'utf8')
        log(`• 上下文已保存: ${f}`)
      }

      log(
        `• 调用大模型 (${config.llm.model}${config.llm.mock ? ' [mock]' : ''}) ...`
      )

      // 知识库经验（表不存在时忽略）
      let lessons = ''
      try {
        lessons = await lessonsByGrade()
      } catch {
        /* 忽略 */
      }

      const {result, meta} = await judge({
        snapshot,
        context,
        rules,
        lessons,
        config
      })

      const decision = toDecision(result)
      const guardrails = validate(decision, snapshot, config)

      // 记账：这次判断烧了多少 token、多少钱
      const billed = await recordUsage({
        kind: 'judge',
        model: meta.model,
        symbol,
        timeframe: config.timeframes.join(','),
        usage: meta.usage,
        mock: meta.mock,
        attempts: meta.attempts,
        latencyMs: meta.latencyMs
      })

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
              mock: meta.mock,
              raw: meta.raw,
              usage: meta.usage,
              attempts: meta.attempts,
              latencyMs: meta.latencyMs,
              costUsd: billed?.costUsd ?? 0
            },
            context,
            judge: result,
            decision,
            guardrails
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
              judge: result,
              decision,
              guardrails,
              llm: {
                model: meta.model,
                mock: meta.mock,
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
          render(snapshot, decision, guardrails, {
            model: meta.model,
            mock: meta.mock,
            disciplineEmpty: rules.sources.length === 0,
            disciplineHash: rules.hash,
            logFile,
            judge: result,
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

/** 把 API Key 写入 .env，并把 LLM_MOCK 设为 0 */

program.parseAsync(process.argv)

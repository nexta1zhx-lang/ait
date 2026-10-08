import {unzipSync} from 'fflate'
import type {C2cOrderInput} from './api'

export interface ParsedC2cExport {
  orders: C2cOrderInput[]
  ignored: number
}

const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_ROWS = 10000

function csvRecords(csv: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i++
      record.push(field)
      if (record.some(value => value.trim())) records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }
  if (field.length || record.length) {
    record.push(field)
    if (record.some(value => value.trim())) records.push(record)
  }
  if (quoted) throw new Error('CSV 格式错误：存在未闭合的引号')
  return records
}

function requiredIndex(headers: string[], label: string): number {
  const index = headers.indexOf(label)
  if (index < 0) throw new Error(`CSV 缺少「${label}」列，请使用币安 C2C 订单历史导出`)
  return index
}

function parseNumber(value: string, rowNumber: number, label: string): number {
  const number = Number(value.trim().replaceAll(',', ''))
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`第 ${rowNumber} 行「${label}」不是有效的正数`)
  }
  return number
}

function parseTimestamp(value: string, rowNumber: number): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(value.trim())
  if (!match) throw new Error(`第 ${rowNumber} 行创建时间格式无效`)
  const date = new Date(`${match[1]}T${match[2]}+08:00`)
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`第 ${rowNumber} 行创建时间无效`)
  }
  return date.toISOString()
}

function parseCsv(csv: string): ParsedC2cExport {
  const records = csvRecords(csv.replace(/^\uFEFF/, ''))
  if (records.length < 2) throw new Error('CSV 中没有订单记录')
  if (records.length - 1 > MAX_ROWS) throw new Error(`最多支持 ${MAX_ROWS} 条订单`)

  const headers = records[0].map(value => value.trim())
  const columns = {
    orderId: requiredIndex(headers, '订单编号'),
    side: requiredIndex(headers, '订单类型'),
    asset: requiredIndex(headers, '资产'),
    fiat: requiredIndex(headers, '法币类型'),
    fiatTotal: requiredIndex(headers, '总价格'),
    price: requiredIndex(headers, '价格'),
    quantity: requiredIndex(headers, '数量'),
    status: requiredIndex(headers, '状态'),
    timestamp: requiredIndex(headers, '创建时间')
  }

  const orders: C2cOrderInput[] = []
  let ignored = 0
  for (const [index, cells] of records.slice(1).entries()) {
    const rowNumber = index + 2
    const cell = (column: number) => (cells[column] ?? '').trim()
    const status = cell(columns.status).toLowerCase()
    if (status !== 'completed' && status !== '已完成') {
      ignored++
      continue
    }
    const asset = cell(columns.asset).toUpperCase()
    if (asset !== 'USDT') {
      ignored++
      continue
    }
    const sideValue = cell(columns.side).toLowerCase()
    if (sideValue !== 'buy' && sideValue !== 'sell') {
      throw new Error(`第 ${rowNumber} 行订单类型不是 Buy 或 Sell`)
    }
    const orderId = cell(columns.orderId)
    if (!orderId) throw new Error(`第 ${rowNumber} 行缺少订单编号`)
    orders.push({
      orderId,
      side: sideValue === 'buy' ? 'Buy' : 'Sell',
      asset: 'USDT',
      fiat: cell(columns.fiat).toUpperCase(),
      fiatTotal: parseNumber(cell(columns.fiatTotal), rowNumber, '总价格'),
      price: parseNumber(cell(columns.price), rowNumber, '价格'),
      quantity: parseNumber(cell(columns.quantity), rowNumber, '数量'),
      timestamp: parseTimestamp(cell(columns.timestamp), rowNumber)
    })
  }
  return {orders, ignored}
}

export async function parseBinanceC2cFile(file: File): Promise<ParsedC2cExport> {
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 15 MB，暂不支持导入')
  const lowerName = file.name.toLowerCase()
  let csv: string

  if (lowerName.endsWith('.csv')) {
    csv = await file.text()
  } else if (lowerName.endsWith('.zip')) {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const csvFiles = Object.entries(entries).filter(([name]) =>
      name.toLowerCase().endsWith('.csv')
    )
    if (csvFiles.length !== 1) {
      throw new Error('ZIP 中必须且只能包含一个 CSV 订单文件')
    }
    csv = new TextDecoder('utf-8').decode(csvFiles[0][1])
  } else {
    throw new Error('请选择币安 C2C 订单历史 ZIP 或 CSV 文件')
  }

  return parseCsv(csv)
}

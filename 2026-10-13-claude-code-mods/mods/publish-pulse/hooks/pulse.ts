export type Doc = { title: string; text: string }
// date/time 是这条片首发的日期和时刻；platform 是「抖音」，老稿没写抖音就是「首发」；others 是其他平台最后发出的日期
export type Last = { date: string; time?: string; title: string; platform: string; others?: string }
export type Next = { when: string; title: string; what: string }

// 「2026-10-08 14:59 已发」「2026-10-28 17:30 定时发出」「已发布(2026-07-13)」都算发过
// 字样可以隔一小段（「17:30 定时发出(已确认已发」）；取最近的那个，不跨过下一个日期
const DONE_AFTER = /(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?(?:(?!\d{4}-\d{2}-\d{2})[^;；\n]){0,30}?(?:已发|(?<![未没待])发出)/g
const DONE_BEFORE = /已发布[(（](\d{4}-\d{2}-\d{2})/g
const WHEN = /(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/
const DOUYIN = /抖音(?!数据)/
const OTHER_PLATFORMS = /YouTube|B ?站|视频号|小红书|TikTok|其余|其他/i

const HEAD_LINES = 60

// 网址里常带日期（幕后页链接之类），找日期前先去掉
const URL = /<?https?:\/\/[^\s>)]+>?/g

const headOf = (text: string) => text.split('\n').slice(0, HEAD_LINES).join('\n').replace(URL, '')

// 入口文件只看「## 进度」那一段；没有这一段就看开头
const progressOf = (text: string) => {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim().startsWith('## 进度'))
  if (start < 0) return headOf(text)

  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trim().startsWith('## '))

  return (end < 0 ? rest : rest.slice(0, end)).join('\n').replace(URL, '')
}

type Done = { date: string; time?: string; stamp: string; platform: 'douyin' | 'others' | 'misc' }

// 一段（分号隔开）里所有发过的记录；还没到时间的定时不算
const doneIn = (head: string, now: string): Done[] =>
  head.split(/[;；\n]/).flatMap(segment => {
    const platform = DOUYIN.test(segment) ? 'douyin' : OTHER_PLATFORMS.test(segment) ? 'others' : 'misc'

    return [...segment.matchAll(DONE_AFTER), ...segment.matchAll(DONE_BEFORE)].flatMap(m => {
      const date = m[1] ?? ''
      const time = m[2]?.padStart(5, '0')
      const stamp = `${date} ${time ?? '00:00'}`

      return date !== '' && stamp <= now ? [{ date, stamp, platform, ...(time && { time }) } as Done] : []
    })
  })

const byStamp = (a: Done, b: Done) => a.stamp.localeCompare(b.stamp)

// 一条片只认首发那天：有抖音记录就按抖音，后面补发其他平台不算「又发了一条」
export const lastPublished = (docs: readonly Doc[], now: string): Last | undefined => {
  let last: Last | undefined
  let lastStamp = ''

  for (const doc of docs) {
    const done = doneIn(headOf(doc.text), now)
    const douyin = done.filter(d => d.platform === 'douyin').sort(byStamp)[0]
    const first = douyin ?? [...done].sort(byStamp)[0]
    if (!first || first.stamp <= lastStamp) continue

    const others = done.filter(d => d.platform === 'others').sort(byStamp).pop()
    lastStamp = first.stamp
    last = {
      date: first.date,
      ...(first.time && { time: first.time }),
      title: doc.title,
      platform: douyin ? '抖音' : '首发',
      ...(others && { others: others.date }),
    }
  }

  return last
}

// 「已发」「已上线」都算这一行做完了
const DONE_LINE = /已发|已上线/

// 发布中 入口文件里还没做完、时间在 now 之后的那几行：每个项目取最早的一条，再按时间排
export const upcoming = (entries: readonly Doc[], now: string): Next[] => {
  const list: Next[] = []

  for (const entry of entries) {
    let next: Next | undefined

    for (const raw of progressOf(entry.text).split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('- ') || DONE_LINE.test(line)) continue

      const m = WHEN.exec(line)
      if (!m) continue

      const when = `${m[1]} ${m[2] ?? '23:59'}`.replace(/ (\d):/, ' 0$1:')
      if (when < now) continue

      if (next === undefined || when < next.when) {
        const what = line.slice(2).split(/[:：]/)[0]?.trim() ?? ''
        next = { when, title: entry.title, what }
      }
    }

    if (next) list.push(next)
  }

  return list.sort((a, b) => a.when.localeCompare(b.when))
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000)

const ago = (date: string, now: string) => {
  const days = daysBetween(date, now)

  return days === 0 ? '今天发' : `已发 ${days} 天`
}

// 「YouTube / B站 / 视频号」这种写成「3 平台」，其他原样
const shortWhat = (what: string) => {
  const parts = what.split('/').map(p => p.trim()).filter(Boolean)

  return parts.length > 1 ? `${parts.length} 平台` : what
}

export const formatNext = (next: Next) => `${next.when.slice(5)} ${next.title} ${shortWhat(next.what)}`

export const formatLast = (last: Last | undefined, now: string): string => {
  if (!last) return '⚪ 没找到发片记录'

  // 红黄绿灯只看首发：其他平台刚补发不代表新片刚发
  const days = daysBetween(last.date, now)
  const light = days <= 3 ? '🟢' : days <= 7 ? '🟡' : '🔴'
  const stamp = `${last.date.slice(5)}${last.time ? ` ${last.time}` : ''}`
  const others = last.others ? ` · 其他平台${ago(last.others, now)}` : ''

  return `${light} ${last.platform}${ago(last.date, now)}（${stamp}）${others} · ${last.title}`
}

// 状态栏一行：只有一条待发写全，多条只写日期+标题
export const formatPulse = (last: Last | undefined, next: readonly Next[], now: string): string => {
  const head = formatLast(last, now)
  if (next.length === 0) return head
  if (next.length === 1) return `${head} · 下一发 ${formatNext(next[0]!)}`

  return `${head} · 待发 ${next.length} 条：${next.map(n => `${n.when.slice(5, 10)} ${n.title}`).join('、')}`
}

// 插件环境的时区不一定是本地，按固定的 UTC 偏移算（小时，默认 8 = 北京时间）
export const localNow = (ms: number, offsetHours = 8) =>
  new Date(ms + offsetHours * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')

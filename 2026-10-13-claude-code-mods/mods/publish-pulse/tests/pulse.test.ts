import { describe, expect, test } from 'claude-code/testing'

import { formatPulse, lastPublished, localNow, upcoming } from '../hooks/pulse'

const ENTRIES = [
  {
    title: '智商倒挂',
    text: `## 进度
- 抖音:2026-10-08 14:59 已发(链接未登记)
- YouTube / B站 / 视频号 / 小红书 / TikTok:2026-10-13 14:59(抖音发布后 120 小时)
- 幕后页:本地已做好,未推送上线`,
  },
  {
    title: 'Opus 5.5 档位盲测',
    text: `## 进度
- 抖音:2026-09-30 22:38 已发(链接未登记)
- YouTube / 视频号:定时 2026-10-05 22:38;B站 / TikTok / 小红书:22:40`,
  },
]

const PUBLISHED = [
  { title: '双AI对决', text: '---\n状态: 已发布(2026-07-13);本文件=成片逐字稿\n---' },
  { title: 'Agent Teams', text: '---\nstatus: 视频抖音 2026-09-04 17:05 已发;其他平台定 2026-09-09\n---' },
]

const NOW = '2026-11-03 09:00'

describe('上次发片', () => {
  test('取所有「已发」里最新的首发', async () => {
    expect(lastPublished([...ENTRIES, ...PUBLISHED], NOW)).toEqual({
      date: '2026-10-08',
      time: '14:59',
      title: '智商倒挂',
      platform: '抖音',
    })
  })

  test('「已发布(日期)」的写法也认，没写抖音就叫首发', async () => {
    expect(lastPublished([PUBLISHED[0]!], NOW)).toEqual({ date: '2026-07-13', title: '双AI对决', platform: '首发' })
  })

  test('一条片后来补发其他平台，仍按首发那天算，补发日期单独记', async () => {
    const doc = {
      title: '模型如何看视频',
      text: `## 进度
- 抖音:**2026-10-15 15:08 已发**
- YouTube / B站 / 视频号 / 小红书 / TikTok:**2026-10-20 晚已发**`,
    }
    expect(lastPublished([doc], NOW)).toEqual({
      date: '2026-10-15',
      time: '15:08',
      title: '模型如何看视频',
      platform: '抖音',
      others: '2026-10-20',
    })
  })

  test('抖音行只写「定时发出」、后面跟链接，也算发了（今天其他平台发不能盖掉它）', async () => {
    const doc = {
      title: '智驾 1 秒看 36 帧',
      text: `## 进度
- 抖音:**2026-10-28 17:30 定时发出**:https://example.com/douyin/1
- 其余五平台:**2026-11-02 晚已发**:[YouTube](https://example.com/youtube/1)`,
    }
    expect(lastPublished([doc], NOW)).toEqual({
      date: '2026-10-28',
      time: '17:30',
      title: '智驾 1 秒看 36 帧',
      platform: '抖音',
      others: '2026-11-02',
    })
  })

  test('定时还没到点不算发了，到点就算', async () => {
    const doc = { title: '新片', text: '## 进度\n- 抖音:2026-11-05 17:30 定时发出' }

    expect(lastPublished([doc], '2026-11-05 17:29')).toBeUndefined()
    expect(lastPublished([doc], '2026-11-05 17:30')?.date).toBe('2026-11-05')
  })

  test('未发出不算发了', async () => {
    expect(lastPublished([{ title: '新片', text: '- 抖音:2026-10-28 未发出' }], NOW)).toBeUndefined()
  })

  test('抖音数据那行不算抖音发布记录', async () => {
    const doc = {
      title: '智商倒挂',
      text: `- 抖音数据(2026-10-16 已发布 8 天统计)
- 抖音:2026-10-08 14:59 已发`,
    }
    expect(lastPublished([doc], NOW)?.date).toBe('2026-10-08')
  })

  test('一行两个日期各认各的「已发」', async () => {
    const doc = { title: '粉色大象', text: '- 视频: 2026-10-09 确认已发布。抖音 2026-09-20 17:29 已发' }
    expect(lastPublished([doc], NOW)).toEqual({
      date: '2026-09-20',
      time: '17:29',
      title: '粉色大象',
      platform: '抖音',
    })
  })
})

describe('下一次定时发布', () => {
  test('跳过已发和已过时间的，取最早的未来一条', async () => {
    expect(upcoming(ENTRIES, '2026-10-08 22:00')).toEqual([
      { when: '2026-10-13 14:59', title: '智商倒挂', what: 'YouTube / B站 / 视频号 / 小红书 / TikTok' },
    ])
  })

  test('多个项目同时待发，全列出来并按时间排', async () => {
    const entries = [
      { title: '模型如何看视频', text: '## 进度\n- 抖音:**2026-10-15 15:00 已发**\n- YouTube / B站:2026-10-20 15:00 起可发' },
      { title: '视频制作流程全公开', text: '## 进度\n- 抖音:2026-10-13 17:48 已发\n- YouTube / B站 / 视频号:2026-10-18 17:48 起可发' },
    ]

    expect(upcoming(entries, '2026-10-15 16:00').map(n => n.title)).toEqual(['视频制作流程全公开', '模型如何看视频'])
  })

  test('「已上线」也算做完', async () => {
    const entry = { title: '智商倒挂', text: '## 进度\n- 文章版:**2026-10-15 已上线** https://example.com/' }

    expect(upcoming([entry], '2026-10-15 16:00')).toEqual([])
  })

  test('只看进度段，网址里的日期不算', async () => {
    const entry = {
      title: '智商倒挂',
      text: `## 进度
- 抖音:2026-10-08 14:59 已发
## 链接
- 幕后页(推送后生效):<https://example.github.io/2026-10-08-iq-inversion/>`,
    }

    expect(upcoming([entry], '2026-10-08 22:00')).toEqual([])
  })

  test('时间都过了就没有', async () => {
    expect(upcoming(ENTRIES, '2026-10-14 00:00')).toEqual([])
  })

  test('未来的「定时发出」还算待发', async () => {
    const entry = { title: '新片', text: '## 进度\n- 抖音:2026-11-05 17:30 定时发出' }

    expect(upcoming([entry], NOW)).toEqual([{ when: '2026-11-05 17:30', title: '新片', what: '抖音' }])
  })
})

describe('状态栏文字', () => {
  test('当天发过是绿灯，多平台缩写成几平台', async () => {
    const now = '2026-10-08 22:00'
    const text = formatPulse(lastPublished(ENTRIES, now), upcoming(ENTRIES, now), now)

    expect(text).toBe('🟢 抖音今天发（10-08 14:59） · 智商倒挂 · 下一发 10-13 14:59 智商倒挂 5 平台')
  })

  test('其他平台今天才发：灯和天数仍按抖音，其他平台单独说', async () => {
    const last = { date: '2026-10-28', time: '17:30', title: '智驾 1 秒看 36 帧', platform: '抖音', others: '2026-11-02' }

    expect(formatPulse(last, [], '2026-11-02 23:00')).toBe(
      '🟡 抖音已发 5 天（10-28 17:30） · 其他平台今天发 · 智驾 1 秒看 36 帧',
    )
  })

  test('超过 7 天亮红灯，没写时刻就只写日期', async () => {
    expect(formatPulse({ date: '2026-09-20', title: '粉色大象', platform: '抖音' }, [], '2026-10-08 10:00')).toBe(
      '🔴 抖音已发 18 天（09-20） · 粉色大象',
    )
  })

  test('多条待发只写日期和标题', async () => {
    const next = [
      { when: '2026-10-18 17:48', title: '视频制作流程全公开', what: 'YouTube / B站' },
      { when: '2026-10-20 15:00', title: '模型如何看视频', what: 'YouTube / B站' },
    ]

    const last = { date: '2026-10-15', time: '15:08', title: '模型如何看视频', platform: '抖音' }

    expect(formatPulse(last, next, '2026-10-15 16:00')).toBe(
      '🟢 抖音今天发（10-15 15:08） · 模型如何看视频 · 待发 2 条：10-18 视频制作流程全公开、10-20 模型如何看视频',
    )
  })

  test('默认按 UTC+8 换算', async () => {
    expect(localNow(Date.parse('2026-10-08T14:30:00Z'))).toBe('2026-10-08 22:30')
  })

  test('偏移可配', async () => {
    expect(localNow(Date.parse('2026-10-08T14:30:00Z'), -4)).toBe('2026-10-08 10:30')
  })
})

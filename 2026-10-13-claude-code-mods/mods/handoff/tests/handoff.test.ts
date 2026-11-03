import { describe, expect, test } from 'claude-code/testing'

import type { Handoff } from '../types'
import { FRESH_MS, TAKE, ago, cleanLine, isHandoffPath, isNear, mark, pickPending, recapOf, remember, titleOf } from '../hooks/handoff'

const NOW = 1_000_000_000_000
const R = '/Users/me/projects/video/Remotion'
const one = (over: Partial<Handoff> = {}): Handoff => ({
  path: `${R}/视频项目/2026-10-04-iq-inversion/交接稿-S6.md`,
  title: 'S6 路线图',
  cwd: R,
  sessionId: 'old',
  at: NOW - 12 * 60_000,
  status: 'pending',
  ...over,
})

describe('认交接稿', () => {
  test('文件名带「交接」的 md 才算', async () => {
    expect(isHandoffPath('/a/交接稿.md')).toBe(true)
    expect(isHandoffPath('/a/幕后页-交接.md')).toBe(true)
    expect(isHandoffPath('/a/README.md')).toBe(false)
    expect(isHandoffPath('/a/交接稿.txt')).toBe(false)
  })

  test('标题取第一个大标题，没有就用文件名', async () => {
    expect(titleOf('/a/交接稿-S6.md', '# 智商倒挂 S6 接着改\n正文')).toBe('智商倒挂 S6 接着改')
    expect(titleOf('/a/交接稿-S6.md', '正文')).toBe('交接稿-S6')
  })
})

describe('新对话该不该提示', () => {
  test('同目录、稿在目录底下、目录在稿旁边，都算近', async () => {
    expect(isNear(one(), R)).toBe(true)
    expect(isNear(one({ cwd: '/Users/me/projects/content' }), R)).toBe(true)
    expect(isNear(one({ cwd: '/x' }), `${R}/视频项目/2026-10-04-iq-inversion`)).toBe(true)
    expect(isNear(one({ cwd: '/x' }), '/Users/me/projects/course')).toBe(false)
  })

  test('只提示别的对话写的、24 小时内、还没接的，取最新一份', async () => {
    const list = [
      one({ path: '/a/交接稿-旧.md', at: NOW - 3 * 3_600_000 }),
      one(),
      one({ path: '/b/交接稿-本对话.md', sessionId: 'me' }),
      one({ path: '/c/交接稿-过期.md', at: NOW - FRESH_MS - 1 }),
      one({ path: '/d/交接稿-接过了.md', status: 'taken' }),
    ]

    expect(pickPending(list, R, 'me', NOW)?.title).toBe('S6 路线图')
  })

  test('同一份稿重写只留一条，标记状态', async () => {
    const list = remember([one()], one({ title: '新标题' }))
    expect(list.map(h => h.title)).toEqual(['新标题'])
    expect(mark(list, one().path, 'taken')[0]?.status).toBe('taken')
  })
})

describe('回「接」', () => {
  test('接、接手、接着做 算；别的话不算', async () => {
    for (const text of ['接', '接手', '接着做。']) expect(TAKE.test(text)).toBe(true)
    for (const text of ['接下来改 S7', '好']) expect(TAKE.test(text)).toBe(false)
  })

  test('几分钟前 / 几小时前', async () => {
    expect(ago(12 * 60_000)).toBe('12 分钟前')
    expect(ago(3 * 3_600_000)).toBe('3 小时前')
  })
})

describe('/clear 后接上', () => {
  const msg = (role: 'user' | 'assistant', text: string, files: string[] = []) => ({
    role,
    text,
    toolUses: files.map((file_path, i) => ({ tool_use_id: `t${i}`, tool: 'Edit', input: { file_path } })),
  })

  test('一句话都没聊就清空，不提示', async () => {
    expect(recapOf([], 's1', NOW)).toBeNull()
    expect(recapOf([msg('user', '<command-name>/clear</command-name>')], 's1', NOW)).toBeNull()
  })

  test('提示行取最后一句够长的话，短回复往前找', async () => {
    const r = recapOf([msg('user', '把文案里的 upgrade 那段改掉'), msg('assistant', '好的'), msg('user', '好')], 's1', NOW)
    expect(r?.line).toBe('把文案里的 upgrade 那段改掉')
  })

  test('卡片带原话、改过的文件、完整记录的位置，不带系统提醒', async () => {
    const r = recapOf(
      [msg('user', '<system-reminder>别露出来</system-reminder>改稿'), msg('assistant', '改完了', ['/a/稿.md', '/a/稿.md', '/b/表.md'])],
      'abc',
      NOW,
    )
    expect(r?.card).toContain('小陈：改稿')
    expect(r?.card).toContain('Claude：改完了')
    expect(r?.card).toContain('- /a/稿.md')
    expect(r?.card).toContain('abc.jsonl')
    expect(r?.card).not.toContain('别露出来')
    expect(r?.card.match(/稿\.md/g)?.length).toBe(1)
  })

  test('模型回的句子去掉结尾句号、压成一行', async () => {
    expect(cleanLine('  正在改 Mods 文案。\n')).toBe('正在改 Mods 文案')
  })
})

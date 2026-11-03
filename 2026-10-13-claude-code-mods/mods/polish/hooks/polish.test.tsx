import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'polish',
  component: 'Pane',
  requestId: 'polish',
  props: {
    title: 'Polish',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const run = (args: string) =>
  ({
    command: 'polish',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 180 },
  }) as const

const QUESTIONS = JSON.stringify({
  questions: [
    { q: '按什么归类？', hint: '按期数' },
    { q: '旧版本要留吗？', hint: '留着' },
    { q: '能删文件吗？', hint: '不能' },
  ],
})
const WRITTEN = '目标：把文件夹按期数归类。'

function stubEngine(
  on: On,
  log: { copied: string[]; submitted: string[]; closed: number; asked: string[] },
  replies: { questions?: string; written?: string; failWrites?: number } = {},
) {
  on('command.register', () => ({ value: { command: 'polish' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.close', () => {
    log.closed += 1

    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/demo' }))
  on('fs.list', () => ({
    value: [{ name: '文案', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('model.complete', (_, e) => {
    log.asked.push(e.prompt)
    if (e.model !== 'haiku' && (replies.failWrites ?? 0) > 0) {
      replies.failWrites = (replies.failWrites ?? 0) - 1

      return {
        value: {
          isAnswered: false,
          reason: 'empty-reply',
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }
    }
    const text =
      e.model === 'haiku'
        ? (replies.questions ?? QUESTIONS)
        : (replies.written ?? WRITTEN)

    return {
      value: {
        isAnswered: true,
        text,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
  })
  on('ui.copy', (_, e) => {
    log.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('prompt.submit', (_, e) => {
    log.submitted.push(e.text)

    return { text: e.text }
  })
}

const freshLog = () => ({
  copied: [] as string[],
  submitted: [] as string[],
  closed: 0,
  asked: [] as string[],
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`three questions, then both columns and both buttons on ${surface}`, async ($, on) => {
    const log = freshLog()
    stubEngine(on, log)
    await $.command.run(run('帮我整理文件夹'))

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /问题 1\/3/ }))?.text).toContain(
      '按什么归类',
    )

    await ui.input({ key: 'q0', text: '按期数' })
    expect(await ui.find({ type: 'Text', text: /问题 2\/3/ })).toBeDefined()
    // 直接回车等于跳过，流程照走。
    await ui.input({ key: 'q1', text: '' })
    expect(await ui.find({ type: 'Text', text: /问题 3\/3/ })).toBeDefined()
    await ui.input({ key: 'q2', text: '不能' })

    const writing = log.asked[1] ?? ''
    expect(writing).toContain('帮我整理文件夹')
    expect(writing).toContain('答：按期数')
    expect(writing).toContain('（用户跳过）')
    expect(writing).toContain('文案/')

    expect(await ui.find({ type: 'Text', text: /我的原话/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /帮我整理文件夹/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /详细提示词/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /目标：把文件夹/ })).toBeDefined()

    await ui.press({ key: 'copy' })
    expect(log.copied).toEqual([WRITTEN])
    expect(await ui.find({ type: 'Text', text: /已复制/ })).toBeDefined()
    expect(log.submitted).toEqual([])

    await ui.press({ key: 'run' })
    expect(log.submitted).toEqual([WRITTEN])
    expect(log.closed).toBe(1)
    await ui.unmount()
  })
}

test('a sentence-less command only says how to use it', async ($, on) => {
  const log = freshLog()
  stubEngine(on, log)

  const result = await $.command.run(run('  '))

  expect(result.text).toContain('用法')
  expect(log.asked).toEqual([])
})

test('a bad question reply falls back to the generic questions', async ($, on) => {
  stubEngine(on, freshLog(), { questions: '不是 JSON' })
  await $.command.run(run('写个脚本'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /通用问题/ })).toBeDefined()
  await ui.unmount()
})

test('a long prompt pages and keeps the buttons in the tree', async ($, on) => {
  const log = freshLog()
  stubEngine(on, log, { written: '很长的一行内容。'.repeat(200) })
  await $.command.run(run('写个脚本'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'q0', text: 'a' })
  await ui.input({ key: 'q1', text: 'b' })
  await ui.input({ key: 'q2', text: 'c' })

  expect(await ui.find({ type: 'Text', text: /第 1\/\d+ 页/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /第 2\/\d+ 页/ })).toBeDefined()
  expect(await ui.find({ key: 'copy' })).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeDefined()

  await ui.press({ key: 'copy' })
  // 复制的是全文，不是当前这一页。
  expect(log.copied[0]?.length).toBe('很长的一行内容。'.length * 200)
  await ui.unmount()
})

test('a narrow dock moves the result to the band above the prompt', async ($, on) => {
  const log = freshLog()
  stubEngine(on, log)
  // 这个钩子代表引擎自己的绘制：宽区域让位时画到这里。
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.command.run(run('帮我整理文件夹'))

  const narrow = {
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, bodyColumns: 36 },
  } as const
  const ui = await $.ui.mount(narrow)
  await ui.input({ key: 'q0', text: 'a' })
  await ui.input({ key: 'q1', text: 'b' })
  await ui.input({ key: 'q2', text: 'c' })
  expect(log.closed).toBe(1)
  await ui.unmount()

  const band = await $.ui.mount({
    plugin: 'polish',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 130,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect(await band.find({ type: 'Text', text: /我的原话/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /目标：把文件夹/ })).toBeDefined()

  await band.press({ key: 'copy' })
  expect(log.copied).toEqual([WRITTEN])
  await band.press({ key: 'run' })
  expect(log.submitted).toEqual([WRITTEN])
  // 发出去之后宽区域就空了，把位置还给别的 mod。
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine')
  await band.unmount()
})

test('a failed write says why and can be retried', async ($, on) => {
  stubEngine(on, freshLog(), { failWrites: 1 })
  await $.command.run(run('写个脚本'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'q0', text: 'a' })
  await ui.input({ key: 'q1', text: 'b' })
  await ui.input({ key: 'q2', text: 'c' })
  expect(await ui.find({ type: 'Text', text: /没写成/ })).toBeDefined()

  await ui.press({ key: 'retry' })
  expect(await ui.find({ type: 'Text', text: /目标：把文件夹/ })).toBeDefined()
  await ui.unmount()
})

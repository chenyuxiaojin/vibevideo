import { expect, mock, test } from 'claude-code/testing'

const pane = (bodyColumns: number) =>
  ({
    plugin: 'file-tree',
    component: 'Pane',
    requestId: 'file-tree',
    props: {
      title: '文件树',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

const entry = (name: string, kind: 'file' | 'dir') => ({
  name,
  kind,
  size: 0,
  mtimeMs: 0,
  isLink: false,
})

const DISK: Record<string, ReturnType<typeof entry>[]> = {
  '/proj': [entry('README.md', 'file'), entry('文案', 'dir')],
  '/proj/文案': [entry('稿子.md', 'file')],
}

const FILES: Record<string, string> = {
  '/proj/README.md': '# 标题\r\nhello\n',
  '/proj/文案/稿子.md': '第一句',
}

test('folders fold, a read flashes, a saved edit turns green', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('fs.list', (_, e) => ({ value: DISK[e.path] ?? [] }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: 12, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_, e) => ({ value: FILES[e.path] ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(40), surface })
    expect(await ui.find({ type: 'Text', text: /^文案$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /稿子\.md/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /2 个文件/ }))?.text).toBe(
      '2 个文件 · 0 个已保存',
    )
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...pane(40), surface: 'terminal' })

  await ui.press({ key: 'b:文案' })
  expect(await ui.find({ type: 'Text', text: /稿子\.md/ })).toBeDefined()
  await ui.press({ key: 'b:文案' })
  expect(await ui.find({ type: 'Text', text: /稿子\.md/ })).toBe(undefined)

  await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
  await clock.advance(300)
  const reading = await ui.find({ type: 'Text', text: /README\.md/ })
  expect(reading?.props.color).toBe('suggestion')
  expect(reading?.props.inverse).toBe(true)
  expect(await ui.find({ type: 'Text', text: '读' })).toBeDefined()

  await clock.advance(2000)
  const after = await ui.find({ type: 'Text', text: /README\.md/ })
  expect(after?.props.color).toBe(undefined)
  expect(after?.props.inverse).toBe(false)

  // An edit inside a closed folder opens it.
  await $.tool.call({
    tool: 'Edit',
    file_path: '/proj/文案/稿子.md',
    old_string: 'a',
    new_string: 'b',
  })
  await clock.advance(300)
  expect((await ui.find({ type: 'Text', text: /稿子\.md/ }))?.props.color).toBe(
    'warning',
  )

  await clock.advance(2000)
  const done = await ui.find({ type: 'Text', text: /稿子\.md/ })
  expect(done?.props.color).toBe('success')
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^文案$/ }))?.props.color).toBe(
    'success',
  )
  await ui.unmount()
})

test('a file opens a preview: beside the tree when wide, in its place when narrow', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'file-tree' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', (_, e) => ({ value: DISK[e.path] ?? [] }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: 12, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_, e) => ({ value: FILES[e.path] ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const wide = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  await wide.press({ key: 'b:README.md' })
  const page = await wide.find({ type: 'Markdown' })
  expect(page?.text).toBe('# 标题\nhello\n')
  expect(await wide.find({ type: 'Button', key: 'b:README.md' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /3 行/ })).toBeDefined()

  await wide.press({ key: 'source' })
  expect((await wide.find({ type: 'Code' }))?.text).toBe('# 标题\nhello\n')
  await wide.unmount()

  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ type: 'Code' })).toBeDefined()
  expect(await narrow.find({ type: 'Button', key: 'b:README.md' })).toBe(undefined)
  await narrow.press({ key: 'back' })
  expect(await narrow.find({ type: 'Code' })).toBe(undefined)
  expect(await narrow.find({ type: 'Button', key: 'b:README.md' })).toBeDefined()
  await narrow.unmount()
})

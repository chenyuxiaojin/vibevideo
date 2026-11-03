import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Preview, Touch, TreeRow } from '../types'

const PANE = 'file-tree'
const TITLE = '文件树'
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv'])
const MAX_ROWS = 2000
const MAX_DEPTH = 12
// A read takes milliseconds: keep it flashing long enough to be seen.
const FLASH_MS = 1600
const BLINK_MS = 300
const RESCAN_MS = 5000
// A touch whose tool never reported back (a lost hook) is dropped after this.
const STALE_MS = 10 * 60 * 1000
// One drawing draws 100000 characters in all: the preview keeps well under it.
const PREVIEW_LINES = 1000
const PREVIEW_CHARS = 40000
// $.fs.read refuses past 4 MiB.
const MAX_READ = 4 * 1024 * 1024
// From this wide the preview sits beside the tree; narrower, it takes the pane.
const SPLIT_COLUMNS = 96

const rows = atom({ plugin: 'file-tree', key: 'rows' } as const, [], {
  shape: 'rows-1',
})
const touches = atom({ plugin: 'file-tree', key: 'touches' } as const, [], {
  shape: 'touches-1',
})
const saved = atom({ plugin: 'file-tree', key: 'saved' } as const, [], {
  shape: 'saved-1',
})
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
const preview = atom({ plugin: 'file-tree', key: 'preview' } as const, null, {
  shape: 'preview-1',
})
const isSource = atom({ plugin: 'file-tree', key: 'isSource' } as const, false)
const isLit = atom({ plugin: 'file-tree', key: 'isLit' } as const, false)

let cwd = ''
let isScanning = false
let hasTouches = false
// The file last asked for: a slower load of an earlier pick is dropped.
let wanted = ''

type Icon = { glyph: string; color?: string }

// Seti's glyphs and colours, the icon theme VS Code ships by default.
const BLUE = '#519aba'
const YELLOW = '#cbcb41'
const ORANGE = '#e37933'
const GREEN = '#8dc149'
const PURPLE = '#a074c4'
const RED = '#cc3e44'
const ICONS: Record<string, Icon> = {}
const iconFor = (glyph: string, color: string | undefined, exts: string[]) => {
  for (const ext of exts) ICONS[ext] = { glyph, color }
}
iconFor('M↓', BLUE, ['md', 'mdx', 'markdown'])
iconFor('TS', BLUE, ['ts', 'tsx', 'mts', 'cts'])
iconFor('JS', YELLOW, ['js', 'jsx', 'mjs', 'cjs'])
iconFor('{}', YELLOW, ['json', 'jsonc', 'jsonl'])
iconFor('<>', ORANGE, ['html', 'htm', 'xml'])
iconFor('#', BLUE, ['css', 'scss', 'less'])
iconFor('py', BLUE, ['py'])
iconFor('$_', GREEN, ['sh', 'zsh', 'bash', 'command'])
iconFor('SW', ORANGE, ['swift'])
iconFor('≡', PURPLE, ['yml', 'yaml', 'toml', 'ini', 'env', 'plist', 'conf'])
iconFor('≡', undefined, ['txt', 'srt', 'vtt', 'log', 'csv'])
iconFor('▣', PURPLE, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'heic'])
iconFor('▶', RED, ['mp4', 'mov', 'webm', 'mkv'])
iconFor('♪', RED, ['mp3', 'wav', 'm4a', 'aac', 'flac'])
iconFor('PD', RED, ['pdf'])
iconFor('▤', YELLOW, ['zip', 'gz', 'tar', '7z', 'dmg'])
const GIT: Icon = { glyph: '◆', color: ORANGE }
const PLAIN: Icon = { glyph: '·' }

const BINARY = new Set([
  'jpg', 'jpeg', 'gif', 'webp', 'ico', 'heic', 'mp4', 'mov', 'webm', 'mkv',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'pdf', 'zip', 'gz', 'tar', '7z', 'dmg',
  'woff', 'woff2', 'ttf', 'otf', 'sqlite', 'db', 'psd', 'docx', 'xlsx', 'pptx',
  'key', 'pages', 'numbers',
])
const MARKDOWN = new Set(['md', 'mdx', 'markdown'])

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const iconOf = (name: string): Icon =>
  name.startsWith('.git') ? GIT : (ICONS[extOf(name)] ?? PLAIN)

// Every glyph takes two cells, so the names line up.
const pad = (glyph: string) => (glyph.length === 1 ? `${glyph} ` : glyph)

// The folders above a path, outermost first: `a/b/c.md` is `a`, `a/b`.
function ancestors(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join('/'))
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Decodes whole groups of four base64 characters.
function bytesOf(text: string): number[] {
  const out: number[] = []
  for (let at = 0; at + 4 <= text.length; at += 4) {
    const n = [0, 1, 2, 3].reduce(
      (sum, i) => (sum << 6) | Math.max(0, BASE64.indexOf(text.charAt(at + i))),
      0,
    )
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  return out
}

const sizeOf = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

async function cwdOf($: EngineInterface): Promise<string> {
  if (cwd === '') cwd = await $.session.cwd()
  return cwd
}

function relative(root: string, file: string): string | undefined {
  if (!file.startsWith('/')) return file.replace(/^\.\//, '')
  return file.startsWith(root + '/') ? file.slice(root.length + 1) : undefined
}

async function scan(
  $: EngineInterface,
  dir: string,
  base: string,
  depth: number,
  out: TreeRow[],
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_ROWS) return
  const entries = await $.fs.list(dir).catch(() => [])
  const sorted = entries
    .filter(entry => !SKIP.has(entry.name))
    .sort((a, b) =>
      (a.kind === 'dir') !== (b.kind === 'dir')
        ? a.kind === 'dir'
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    )
  for (const entry of sorted) {
    if (out.length >= MAX_ROWS) return
    const path = base === '' ? entry.name : `${base}/${entry.name}`
    const isDir = entry.kind === 'dir'
    out.push({ path, name: entry.name, depth, isDir })
    if (isDir) await scan($, `${dir}/${entry.name}`, path, depth + 1, out)
  }
}

async function loadPreview($: EngineInterface, path: string): Promise<void> {
  const abs = `${await cwdOf($)}/${path}`
  const ext = extOf(path)
  const empty: Preview = {
    path,
    kind: 'missing',
    text: '',
    lines: 0,
    hiddenLines: 0,
    size: 0,
    mtimeMs: 0,
    width: 0,
    height: 0,
  }
  let next: Preview
  const stat = await $.fs.stat(abs).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') {
    next = { ...empty, text: '这个文件已经不在了' }
  } else {
    const meta = { ...empty, size: stat.size, mtimeMs: stat.mtimeMs }
    if (ext === 'png' && stat.size <= MAX_READ) {
      // A PNG's width and height sit in its first 24 bytes (the IHDR chunk).
      const { base64 } = await $.fs.read(abs, { as: 'bytes' })
      const head = bytesOf(base64.slice(0, 32))
      const byte = (at: number) => head[at] ?? 0
      const word = (at: number) =>
        ((byte(at) << 24) | (byte(at + 1) << 16) | (byte(at + 2) << 8) | byte(at + 3)) >>> 0
      next = { ...meta, kind: 'image', width: word(16), height: word(20) }
    } else if (BINARY.has(ext) || stat.size > MAX_READ) {
      next = { ...meta, kind: 'binary' }
    } else {
      const raw = await $.fs.read(abs)
      if (raw.includes('\u0000')) {
        next = { ...meta, kind: 'binary' }
      } else {
        // Code and Markdown take tab and newline as their only control characters.
        const all = raw
          .replace(/\r\n?/g, '\n')
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
          .split('\n')
        const text = all.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
        const shown = text.split('\n').length
        next = {
          ...meta,
          kind: MARKDOWN.has(ext) ? 'markdown' : 'code',
          text,
          lines: all.length,
          hiddenLines: all.length - shown,
        }
      }
    }
  }
  if (wanted === path) await update($, preview, () => next)
}

async function select($: EngineInterface, path: string): Promise<void> {
  wanted = path
  await loadPreview($, path).catch(() => undefined)
}

async function closePreview($: EngineInterface): Promise<void> {
  wanted = ''
  await update($, preview, () => null)
}

async function toggle($: EngineInterface, dir: string): Promise<void> {
  await update($, expanded, list =>
    list.includes(dir)
      ? list.filter(one => one !== dir && !one.startsWith(dir + '/'))
      : [...list, dir],
  )
}

// Opens the folders down to a file, as VS Code reveals the file it works on.
async function reveal($: EngineInterface, path: string): Promise<void> {
  const dirs = ancestors(path)
  const open = new Set(await read($, expanded))
  if (dirs.every(dir => open.has(dir))) return
  await update($, expanded, list => [
    ...list,
    ...dirs.filter(dir => !list.includes(dir)),
  ])
}

async function refresh($: EngineInterface): Promise<void> {
  if (isScanning) return
  isScanning = true
  try {
    const out: TreeRow[] = []
    await scan($, await cwdOf($), '', 0, out)
    const old = await read($, rows)
    if (JSON.stringify(old) !== JSON.stringify(out)) {
      await update($, rows, () => out)
    }
    // A preview follows its file: changed on disk, it is read again.
    const shown = await read($, preview)
    if (shown !== null && shown.kind !== 'missing') {
      const stat = await $.fs
        .stat(`${await cwdOf($)}/${shown.path}`)
        .catch(() => undefined)
      if (stat === undefined || stat.mtimeMs !== shown.mtimeMs) {
        wanted = shown.path
        await loadPreview($, shown.path).catch(() => undefined)
      }
    }
  } finally {
    isScanning = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (!hasTouches) return
  const now = await $.clock.now()
  const list = await read($, touches)
  const live = list.filter(touch =>
    touch.isRunning ? now < touch.until + STALE_MS : now < touch.until,
  )
  if (live.length !== list.length) {
    const ids = new Set(live.map(touch => touch.id))
    await update($, touches, all => all.filter(touch => ids.has(touch.id)))
  }
  hasTouches = live.length > 0
  await update($, isLit, lit => hasTouches && !lit)
}

const rowKey = (path: string) => `f:${path}`
const pressKey = (path: string) => `b:${path}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    hasTouches = false
    await update($, touches, () => [])
    await $.command.register({
      name: 'file-tree',
      description: '在右侧打开文件树面板',
    })
    $.clock.every(BLINK_MS, () => void tick($))
    $.clock.every(RESCAN_MS, () => void refresh($))
    await refresh($)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'file-tree' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '文件树面板已打开。' }
  })

  on(
    'tool.call',
    { tool: ['Read', 'Edit', 'Write', 'NotebookEdit'] },
    async ($, e, next) => {
      const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
      const path = relative(await cwdOf($), file)
      if (path === undefined) return next(e)

      const kind = e.tool === 'Read' ? 'read' : 'edit'
      const touch: Touch = {
        id: e.tool_use_id,
        path,
        kind,
        until: (await $.clock.now()) + FLASH_MS,
        isRunning: true,
      }
      await update($, touches, list => [
        ...list.filter(one => one.id !== touch.id),
        touch,
      ])
      hasTouches = true
      await reveal($, path)
      void $.ui
        .scroll({ in: PANE, to: { key: rowKey(path) } })
        .catch(() => undefined)

      const ran = await next(e)

      await update($, touches, list =>
        list.map(one => (one.id === touch.id ? { ...one, isRunning: false } : one)),
      )
      const isSaved =
        kind === 'edit' && ran.deny === undefined && ran.isError !== true
      if (isSaved) {
        await update($, saved, list =>
          list.includes(path) ? list : [...list, path],
        )
        await refresh($)
      }

      return ran
    },
  ).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = elements
    const Image = 'Image' in elements ? elements.Image : undefined
    const list = await read($, rows)
    const active = await read($, touches)
    const done = new Set(await read($, saved))
    const open = new Set(await read($, expanded))
    const shown = await read($, preview)
    const showSource = await read($, isSource)
    const lit = await read($, isLit)
    const root = await cwdOf($)
    const columns = e.props.bodyColumns
    const isSplit = shown !== null && columns >= SPLIT_COLUMNS
    const treeWidth = Math.min(44, Math.max(28, Math.floor(columns * 0.36)))

    // An edit outranks a read of the same file.
    const kinds = new Map<string, Touch['kind']>()
    for (const touch of active) {
      if (kinds.get(touch.path) !== 'edit') kinds.set(touch.path, touch.kind)
    }
    // A folder wears what happens inside it, so a closed one still shows it.
    const folderKinds = new Map<string, Touch['kind']>()
    for (const [path, kind] of kinds) {
      for (const dir of ancestors(path)) {
        if (folderKinds.get(dir) !== 'edit') folderKinds.set(dir, kind)
      }
    }
    const folderDone = new Set(
      [...done].flatMap(path => ancestors(path)),
    )
    const visible = list.filter(row =>
      ancestors(row.path).every(dir => open.has(dir)),
    )
    const fileCount = list.filter(row => !row.isDir).length
    const folder = root.split('/').pop() ?? root

    const renderRow = (row: TreeRow) => {
      const kind = row.isDir ? folderKinds.get(row.path) : kinds.get(row.path)
      const isDone = row.isDir ? folderDone.has(row.path) : done.has(row.path)
      const isSelected = !row.isDir && shown?.path === row.path
      const color =
        kind === 'edit'
          ? 'warning'
          : kind === 'read'
            ? 'suggestion'
            : isDone
              ? 'success'
              : undefined
      const badge =
        kind === 'edit' ? '改' : kind === 'read' ? '读' : isDone ? (row.isDir ? '•' : '✓') : ''
      const icon = iconOf(row.name)

      return (
        <Box key={rowKey(row.path)} backgroundColor={isSelected ? 'subtle' : undefined}>
          <Button
            plain
            key={pressKey(row.path)}
            onPress={() =>
              void (row.isDir ? toggle($, row.path) : select($, row.path))
            }
          >
            <Text dimColor>{'│ '.repeat(row.depth)}</Text>
            {row.isDir ? (
              <Text dimColor>{open.has(row.path) ? '▾ ' : '▸ '}</Text>
            ) : (
              <Text color={icon.color}>{`  ${pad(icon.glyph)} `}</Text>
            )}
            <Text
              color={color}
              inverse={kind !== undefined && lit}
              weight={isSelected ? 'bold' : undefined}
              wrap="truncate-end"
            >
              {row.name}
            </Text>
          </Button>
          <Box flexGrow={1} />
          {badge !== '' && <Text color={color}> {badge}</Text>}
        </Box>
      )
    }

    const tree = (
      <Box flexDirection="column" width={isSplit ? treeWidth : undefined} flexShrink={0}>
        <Box>
          <Text dimColor weight="bold">
            资源管理器
          </Text>
          <Box flexGrow={1} />
          <Button plain dimColor key="collapse" onPress={() => void update($, expanded, () => [])}>
            全部折叠
          </Button>
        </Box>
        <Text weight="bold" wrap="truncate-end">
          ▾ {folder}
        </Text>
        <Text dimColor wrap="truncate-end">
          {fileCount} 个文件 · {done.size} 个已保存
        </Text>
        {list.length === 0 && <Text dimColor>（空文件夹）</Text>}
        {visible.map(renderRow)}
      </Box>
    )

    if (shown === null) return tree

    const icon = iconOf(shown.path.split('/').pop() ?? shown.path)
    const name = shown.path.split('/').pop() ?? shown.path
    const where = ancestors(shown.path).pop() ?? folder
    const room = Math.max(8, (isSplit ? columns - treeWidth - 1 : columns) - 4)
    const imageColumns = Math.min(room, 80, 255)
    const imageRows =
      shown.width > 0
        ? Math.max(1, Math.min(40, Math.round((imageColumns * shown.height) / shown.width / 2)))
        : 1

    const body =
      shown.kind === 'code' || (shown.kind === 'markdown' && showSource) ? (
        <Code source={shown.text} path={shown.path} startLine={1} />
      ) : shown.kind === 'markdown' ? (
        <Markdown text={shown.text} />
      ) : shown.kind === 'image' && Image !== undefined ? (
        <Image
          source={{ file: `${root}/${shown.path}`, format: 'png', generation: shown.mtimeMs }}
          columns={imageColumns}
          rows={imageRows}
          alt={name}
        />
      ) : shown.kind === 'image' ? (
        <Text dimColor>图片只能在终端里预览</Text>
      ) : shown.kind === 'binary' ? (
        <Text dimColor>这种文件没法在这里预览（{sizeOf(shown.size)}）</Text>
      ) : (
        <Text dimColor>{shown.text}</Text>
      )

    const details =
      shown.kind === 'image'
        ? `${shown.width}×${shown.height} · ${sizeOf(shown.size)}`
        : shown.kind === 'code' || shown.kind === 'markdown'
          ? `${shown.lines} 行 · ${sizeOf(shown.size)}`
          : sizeOf(shown.size)

    const previewBox = (
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderDimColor
        paddingX={1}
      >
        <Box>
          {!isSplit && (
            <Button plain key="back" onPress={() => void closePreview($)}>
              ‹ 文件树
            </Button>
          )}
          {!isSplit && <Text> </Text>}
          <Text color={icon.color}>{pad(icon.glyph)} </Text>
          <Text weight="bold" wrap="truncate-end">
            {name}
          </Text>
          <Box flexGrow={1} />
          {shown.kind === 'markdown' && (
            <Button
              plain
              dimColor
              key="source"
              onPress={() => void update($, isSource, is => !is)}
            >
              {showSource ? '看排版' : '看源码'}
            </Button>
          )}
          {isSplit && <Text> </Text>}
          {isSplit && (
            <Button plain dimColor key="close" onPress={() => void closePreview($)}>
              ✕
            </Button>
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          {where} · {details}
        </Text>
        <Text> </Text>
        {body}
        {shown.hiddenLines > 0 && (
          <Text dimColor>…后面还有 {shown.hiddenLines} 行没显示</Text>
        )}
      </Box>
    )

    if (!isSplit) return previewBox

    return (
      <Box flexDirection="row">
        {tree}
        <Box width={1} flexShrink={0} />
        {previewBox}
      </Box>
    )
  })
}

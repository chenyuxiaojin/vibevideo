import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  ModelCompleteResult,
  Register,
} from 'claude-code'

import type { Flow, Question } from '../types'

const PANE = 'polish'
const OPEN = {
  id: PANE,
  title: 'Polish',
  focus: true,
  closeOnEscape: true,
  holdToasts: true,
  rows: 30,
  columns: 100,
} as const

const IDLE: Flow = { phase: 'idle' }
// 改 Flow 的字段时换这个标签：热重载后旧版本存的值会被丢弃。
const flow = atom({ plugin: 'polish', key: 'flow' } as const, IDLE, {
  shape: 'flow-2',
})

const GENERIC_QUESTIONS: Question[] = [
  { text: '这件事做完，你想看到什么结果？', hint: '一份能直接用的成品' },
  { text: '有什么不能碰、不能改的地方？', hint: '原文件不要动' },
  { text: '你会怎么判断它做好了？', hint: '我能一眼找到要的东西' },
]

const ASK_SYSTEM = `用户要让 Claude Code（能读写本机文件、运行命令的 AI 助手）办一件事，只写了一句话。你只负责提问，不要办这件事。
想出 3 个问题，它们的答案最能改变这件事的做法。
- 紧扣这句话和文件清单，不问通用套话，不问文件清单已经能看出来的事。
- 提问对象可能不懂技术：用大白话，每题不超过 25 个字，语言跟随用户原话。
- hint 是一个具体的示例答案，不超过 15 个字。
只输出 JSON，不要别的内容：{"questions":[{"q":"问题","hint":"示例答案"},{"q":"问题","hint":"示例答案"},{"q":"问题","hint":"示例答案"}]}`

const WRITE_SYSTEM = `用户要让 Claude Code（能读写本机文件、运行命令的 AI 助手）办一件事，只写了一句话，又回答了 3 个澄清问题。你不办这件事，只把这些内容写成一份可以直接发给 Claude Code 执行的详细提示词。
- 语言跟随用户原话，直接对 Claude Code 下指令。
- 依次写：目标、现状（用得上才写）、具体要求、不要做的事、完成标准（能检查的结果）。每段用「目标：」这样的纯文字小标题开头，要求分条写成 1. 2. 3.。
- 只用用户说过的内容和给出的文件清单，不编造文件、数字或偏好。
- 用户跳过的问题不要替他拍板，也不要提「跳过」「没回答」，直接写成「X 由你按常理决定，完成时告诉我你怎么定的」。
- 如果这件事可能删除或覆盖文件，加一条：动手前先列清单，等我确认。
- 不用 Markdown 符号（#、**、代码块）。总长不超过 400 字。
只输出提示词本身，不要前言和解释。`

// 面板关掉或重开时，用它掐断还在路上的模型调用。
let inflight: AbortController | undefined
// 面板上次画出来时放不放得下左右两栏。侧边栏宽度是用户自己拖的，mod 改不了。
let paneFits = true

// 输入框和按钮的处理函数等模型超过 10 秒，引擎就报超预算（实测）。
// 写提示词常常更久，「直接运行」也可能要等当前任务结束，所以都放后台跑。
const inBackground = ($: EngineInterface, work: Promise<void>) => {
  void work.catch((error: unknown) => $.ui.log(`polish 出错：${String(error)}`))
}

// 移动焦点只是图方便，没成功（比如键盘被切走了）也不该卡住流程。
const focusOn = ($: EngineInterface, key: string) =>
  $.ui.focus({ requestId: PANE, key }).catch(() => undefined)

function parseQuestions(text: string): Question[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const list = JSON.parse(text.slice(start, end + 1))?.questions
    if (!Array.isArray(list) || list.length < 3) return null
    const questions = list.slice(0, 3).map(one => ({
      text: String(one?.q ?? '').trim(),
      hint: String(one?.hint ?? '').trim(),
    }))

    return questions.every(one => one.text !== '') ? questions : null
  } catch {
    return null
  }
}

function failureOf(result: ModelCompleteResult & { isAnswered: false }): string {
  if (result.reason === 'api-error') {
    return `接口报错（${result.status ?? '没连上'}，${result.error}）`
  }
  if (result.reason === 'aborted') return '等太久超时了'

  return '模型没有返回内容'
}

async function listFolder($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const entries = await $.fs.list().catch(() => [])
  const names = entries
    .filter(one => !one.name.startsWith('.'))
    .slice(0, 60)
    .map(one => (one.kind === 'dir' ? `${one.name}/` : one.name))

  return `当前文件夹：${cwd}\n第一层内容：${names.join('、') || '（空）'}`
}

async function askQuestions(
  $: EngineInterface,
  run: string,
  raw: string,
): Promise<void> {
  const stop = new AbortController()
  inflight = stop
  const listing = await listFolder($)
  const result = await $.model
    .complete(
      {
        model: 'haiku',
        system: ASK_SYSTEM,
        prompt: `${listing}\n\n用户原话：${raw}`,
        maxTokens: 500,
        timeoutMs: 20_000,
      },
      { signal: stop.signal },
    )
    .catch(() => null)
  if (stop.signal.aborted) return
  const questions = result?.isAnswered ? parseQuestions(result.text) : null

  await update($, flow, (now): Flow =>
    now.phase === 'loading' && now.run === run
      ? {
          phase: 'asking',
          run,
          raw,
          listing,
          questions: questions ?? GENERIC_QUESTIONS,
          answers: [],
          isGeneric: questions === null,
        }
      : now,
  )
  await focusOn($, 'q0')
}

async function writePrompt(
  $: EngineInterface,
  run: string,
  raw: string,
  listing: string,
  questions: Question[],
  answers: string[],
): Promise<void> {
  const stop = new AbortController()
  inflight = stop
  const qa = questions
    .map((one, i) => {
      const answer = answers[i]?.trim()

      return `问：${one.text}\n答：${answer || '（用户跳过）'}`
    })
    .join('\n')
  const result = await $.model
    .complete(
      {
        model: 'sonnet',
        system: WRITE_SYSTEM,
        prompt: `${listing}\n\n用户原话：${raw}\n\n${qa}`,
        maxTokens: 2000,
        timeoutMs: 90_000,
      },
      { signal: stop.signal },
    )
    .catch((error: unknown) => String(error))
  if (stop.signal.aborted) return

  const prompt =
    typeof result !== 'string' && result.isAnswered ? result.text.trim() : ''
  let reason = '模型没有返回内容'
  if (typeof result === 'string') reason = result
  else if (!result.isAnswered) reason = failureOf(result)

  await update($, flow, (now): Flow => {
    if (now.phase !== 'writing' || now.run !== run) return now
    if (prompt === '') {
      return { phase: 'failed', run, raw, listing, questions, answers, reason }
    }

    return {
      phase: 'done',
      run,
      raw,
      prompt,
      site: paneFits ? 'pane' : 'band',
      page: 0,
      note: '',
      isSending: false,
    }
  })
  if (prompt === '') return
  // 焦点落在「复制」上，手滑多按一次回车也不会把提示词跑起来。
  if (paneFits) await focusOn($, 'copy')
  else await $.ui.close({ id: PANE })
}

async function answer(
  $: EngineInterface,
  index: number,
  value: string,
): Promise<void> {
  const now = await read($, flow)
  if (now.phase !== 'asking' || now.answers.length !== index) return
  const answers = [...now.answers, value]

  if (answers.length < now.questions.length) {
    await update($, flow, (): Flow => ({ ...now, answers }))
    await focusOn($, `q${index + 1}`)

    return
  }
  const { run, raw, listing, questions } = now
  await update($, flow, (): Flow => ({
    phase: 'writing',
    run,
    raw,
    listing,
    questions,
    answers,
  }))
  inBackground($, writePrompt($, run, raw, listing, questions, answers))
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
}

/** 按终端格数折行：中文占两格。翻页要预先知道每一行在哪。 */
function wrapLines(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let used = 0
    for (const char of paragraph) {
      const cells = isWide(char.codePointAt(0) ?? 0) ? 2 : 1
      if (used + cells > width) {
        lines.push(line)
        line = ''
        used = 0
      }
      line += char
      used += cells
    }
    lines.push(line)
  }

  return lines
}

async function runPrompt($: EngineInterface, text: string): Promise<void> {
  await update($, flow, (one): Flow =>
    one.phase === 'done'
      ? { ...one, isSending: true, note: '正在发送…' }
      : one,
  )
  const sent = await $.prompt.submit({ text, asUser: true })
  if (sent.drop === undefined) {
    await update($, flow, () => IDLE)
    await $.ui.close({ id: PANE })

    return
  }
  await update($, flow, (one): Flow =>
    one.phase === 'done'
      ? { ...one, isSending: false, note: `没发出去：${sent.drop}` }
      : one,
  )
}

/** 结果页：左右两栏高度受限，超出的部分翻页看，按钮永远留在最下面。 */
function drawResult(
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>,
  $: EngineInterface,
  now: Flow & { phase: 'done' },
  width: number,
  rows: number,
) {
  const { Box, Text, Button } = ui
  const isBand = now.site === 'band'
  const isStacked = width < 44
  const leftOuter = isStacked
    ? width
    : Math.min(30, Math.max(14, Math.floor(width * 0.3)))
  const rightOuter = isStacked ? width : width - leftOuter - 1
  const border = 4 // 左右边框各 1 格，内边距各 1 格
  const leftLines = wrapLines(now.raw, Math.max(4, leftOuter - border))
  const rightLines = wrapLines(now.prompt, Math.max(4, rightOuter - border))
  // 底部留 1 行按钮、1 行提示；每栏另有上下边框 2 行和标题 1 行。
  const chrome = 2 + 3 + (isStacked ? 3 + Math.min(leftLines.length, 3) : 0)
  const pageRows = Math.max(3, rows - chrome)
  const pages = Math.max(1, Math.ceil(rightLines.length / pageRows))
  const page = Math.min(now.page, pages - 1)
  const shown = rightLines.slice(page * pageRows, (page + 1) * pageRows)
  const goTo = (target: number) =>
    update($, flow, (one): Flow =>
      one.phase === 'done' ? { ...one, page: target } : one,
    )
  const hint = isBand ? '鼠标点按钮；或按 ctrl+x tab，再按数字键' : 'Esc 关闭'

  return (
    <Box flexDirection="column">
      <Box flexDirection={isStacked ? 'column' : 'row'} columnGap={1}>
        <Box
          flexDirection="column"
          width={leftOuter}
          flexShrink={0}
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          <Text bold dimColor>
            我的原话
          </Text>
          {(isStacked ? leftLines.slice(0, 3) : leftLines).map(line => (
            <Text>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
        <Box
          flexDirection="column"
          width={rightOuter}
          flexShrink={0}
          borderStyle="round"
          borderColor="claude"
          paddingX={1}
        >
          <Text bold color="claude">
            详细提示词
            {pages > 1 ? `（第 ${page + 1}/${pages} 页）` : ''}
          </Text>
          {shown.map(line => (
            <Text>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      </Box>
      <Box flexDirection="row" columnGap={1}>
        <Button
          key="copy"
          label="复制"
          hotkey="1"
          onPress={async press => {
            const copied = await $.ui.copy({
              text: now.prompt,
              surface: press.surface,
            })
            const note = copied.isCopied
              ? '已复制 ✓'
              : `复制失败：${copied.reason}`
            await update($, flow, (one): Flow =>
              one.phase === 'done' ? { ...one, note } : one,
            )
          }}
        />
        {!now.isSending && (
          <Button
            key="run"
            label="直接运行"
            hotkey="2"
            variant="primary"
            onPress={() => inBackground($, runPrompt($, now.prompt))}
          />
        )}
        {page > 0 && (
          <Button
            key="prev"
            label="上一页"
            hotkey="k"
            onPress={() => goTo(page - 1)}
          />
        )}
        {page < pages - 1 && (
          <Button
            key="next"
            label="下一页"
            hotkey="j"
            onPress={() => goTo(page + 1)}
          />
        )}
        {isBand && (
          <Button
            key="dismiss"
            label="关闭"
            hotkey="3"
            onPress={() => update($, flow, () => IDLE)}
          />
        )}
      </Box>
      <Text dimColor>{now.note === '' ? hint : now.note}</Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'polish',
      description: '把一句简单需求打磨成详细提示词（先问你 3 个问题）',
      argumentHint: '一句简单的需求',
    })

    return next(e)
  })

  on('command.run', { command: 'polish' }, async ($, e) => {
    const raw = e.args.trim()
    if (raw === '') {
      return { text: '用法：/polish 一句简单的需求，比如 /polish 帮我整理这个文件夹' }
    }
    inflight?.abort()
    const run = crypto.randomUUID()
    await update($, flow, (): Flow => ({ phase: 'loading', run, raw, listing: '' }))
    await $.ui.open(OPEN)
    void askQuestions($, run, raw)

    return { text: `正在打磨这句需求：${raw}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // 结果搬去宽区域时面板也会关，那次不算取消。
    const now = await read($, flow)
    if (now.phase !== 'done' || now.site !== 'band') {
      inflight?.abort()
      await update($, flow, () => IDLE)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, flow)
    const width = e.props.bodyColumns
    // 只有终端和桌面端有输入框上方那块区域，别的端只能留在面板里。
    const hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    paneFits = width >= 60 || e.props.placement === 'inline' || !hasBand

    if (now.phase === 'idle') {
      return <Text dimColor>用 /polish 加一句需求开始。</Text>
    }

    if (now.phase === 'loading') {
      return (
        <Box flexDirection="column">
          <Text dimColor>你的需求：{now.raw}</Text>
          <Text>正在想该问你什么…</Text>
        </Box>
      )
    }

    if (now.phase === 'asking') {
      if (e.surface === 'mobile') {
        return <Text>手机端不能打字答题，请到电脑上用 /polish。</Text>
      }
      const { Input } = $.ui.resolve(e)
      const index = now.answers.length
      const question = now.questions[index]
      if (question === undefined) return <Text dimColor>问题读取失败。</Text>
      const isLast = index === now.questions.length - 1

      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>你的需求：{now.raw}</Text>
          <Box flexDirection="column">
            <Text bold>
              问题 {index + 1}/{now.questions.length}：{question.text}
            </Text>
            {question.hint !== '' && (
              <Text dimColor>比如：{question.hint}</Text>
            )}
            <Input
              key={`q${index}`}
              autoFocus
              placeholder="在这里回答"
              submitLabel={isLast ? '开始写' : '下一题'}
              onSubmit={value => answer($, index, value)}
            />
          </Box>
          {now.isGeneric && (
            <Text dimColor>模型没给出问题，这里先用通用问题。</Text>
          )}
          <Text dimColor>不想答就直接回车 · Esc 关闭</Text>
        </Box>
      )
    }

    if (now.phase === 'writing') {
      return (
        <Box flexDirection="column">
          <Text dimColor>你的需求：{now.raw}</Text>
          <Text>正在写详细提示词…</Text>
        </Box>
      )
    }

    const { Button } = $.ui.resolve(e)

    if (now.phase === 'failed') {
      const { run, raw, listing, questions, answers } = now

      return (
        <Box flexDirection="column" rowGap={1}>
          <Text color="error">没写成：{now.reason}</Text>
          <Box>
            <Button
              key="retry"
              label="重试"
              hotkey="1"
              variant="primary"
              onPress={async () => {
                await update($, flow, (): Flow => ({
                  phase: 'writing',
                  run,
                  raw,
                  listing,
                  questions,
                  answers,
                }))
                inBackground(
                  $,
                  writePrompt($, run, raw, listing, questions, answers),
                )
              }}
            />
          </Box>
        </Box>
      )
    }

    return drawResult($.ui.resolve(e), $, now, width, e.props.scroll.bodyRows)
  })

  // 面板太窄时，结果画在这里：宽度是整个对话栏。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, flow)
    if (e.props.hasSurvey || now.phase !== 'done' || now.site !== 'band') {
      return next(e)
    }

    return drawResult(
      $.ui.resolve(e),
      $,
      now,
      e.props.bodyColumns,
      e.props.maxRows,
    )
  })

  // 用户不看结果、接着打字了：宽区域不再占着位置。
  on('prompt.submit', async ($, e, next) => {
    const now = await read($, flow)
    if (e.command === undefined && now.phase === 'done' && now.site === 'band') {
      await update($, flow, () => IDLE)
    }

    return next(e)
  })
}

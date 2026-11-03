import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionMessage } from 'claude-code'

import type { Handoff, Recap } from '../types'
import { RULES, TAKE, ago, cleanLine, isHandoffPath, linePrompt, mark, pickPending, promptOf, recapOf, remember, takeContext, takePrompt, titleOf } from './handoff'

const COMMAND = 'handoff'
const KEY = 'handoffs'
const LINE_MODEL = 'haiku'
const LINE_TIMEOUT_MS = 15_000
const CLEAR_SETTLE_MS = 300

const shown = atom({ plugin: 'handoff', key: 'shown' } as const, null)
const recap = atom({ plugin: 'handoff', key: 'recap' } as const, null)

let isInteractive = false

const load = async ($: EngineInterface): Promise<Handoff[]> => {
  const value = await $.store.get(KEY)

  return Array.isArray(value) ? (value as Handoff[]) : []
}

const setStatus = async ($: EngineInterface, path: string, status: Handoff['status']) => {
  await $.store.set(KEY, mark(await load($), path, status))
  await update($, shown, () => null)
}

const refreshShown = async ($: EngineInterface) => {
  const pending = pickPending(await load($), await $.session.cwd(), await $.session.id(), await $.clock.now())
  await update($, shown, () => pending ?? null)
}

const take = async ($: EngineInterface, handoff: Handoff) => {
  await setStatus($, handoff.path, 'taken')
  await $.prompt.submit({ text: takePrompt(handoff.path), asUser: true })
}

// mod 自己发的话带不了隐藏上下文，所以按钮这条路把卡片写在正文里
const takeRecap = async ($: EngineInterface, carried: Recap) => {
  await update($, recap, () => null)
  await $.prompt.submit({ text: `接上刚才的活。\n\n${carried.card}`, asUser: true })
}

const recordWrite = async ($: EngineInterface, path: string, text: string) => {
  const handoff: Handoff = {
    path,
    title: titleOf(path, text),
    cwd: await $.session.cwd(),
    sessionId: await $.session.id(),
    at: await $.clock.now(),
    status: 'pending',
  }
  await $.store.set(KEY, remember(await load($), handoff))
}

// 先放一句小陈的原话，模型那句回来再换上；模型失败就留着原话
const summarize = async ($: EngineInterface, carried: Recap, messages: readonly SessionMessage[]) => {
  const reply = await $.model.complete({ model: LINE_MODEL, prompt: linePrompt(messages), timeoutMs: LINE_TIMEOUT_MS })
  if (!reply.isAnswered) return
  const line = cleanLine(reply.text)
  if (line === '') return
  await update($, recap, current => (current?.sessionId === carried.sessionId ? { ...current, line } : current))
}

// 交接稿优先：刚写过稿就提示稿，没写才提示「刚才在做」
const afterClear = async ($: EngineInterface, carried: Recap | null, messages: readonly SessionMessage[]) => {
  await $.clock.sleep(CLEAR_SETTLE_MS)
  await refreshShown($)
  if (carried === null || (await read($, shown)) !== null) return
  await update($, recap, () => carried)
  await summarize($, carried, messages)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    if (!isInteractive) return next(e)

    await $.command.register({ name: COMMAND, description: '写交接稿进项目文件夹，新对话一键接手', argumentHint: '[补充说明]' })
    void refreshShown($).catch(() => undefined)

    return next(e)
  })

  // /clear 之后算新对话：刚写的交接稿这时就能接；没写稿也自动记下刚才在做什么
  on('session.end', async ($, e, next) => {
    if (!isInteractive || e.reason !== 'clear') return next(e)

    const messages = await $.session.messages().catch(() => [] as SessionMessage[])
    const carried = recapOf(messages, e.sessionId, await $.clock.now())
    const ended = await next(e)
    void afterClear($, carried, messages).catch((error: unknown) => $.ui.log(`handoff afterClear 失败：${String(error)}`, { to: 'debug' }))

    return ended
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    // 不等它：插件发的话要等这条命令跑完、对话空闲才进去
    void $.prompt.submit({ text: promptOf(e.args), asUser: true }).catch(() => undefined)

    return { text: '交接稿规则已交给 Claude。', context: [RULES] }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (isInteractive && ran.deny === undefined && ran.isError !== true && isHandoffPath(e.file_path)) {
      await recordWrite($, e.file_path, e.content).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // 新对话里 Claude 自己读了这份稿（比如小陈直接贴了路径），就算接手了
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    const current = await read($, shown).catch(() => null)
    if (current !== null && current.path === e.file_path) await setStatus($, current.path, 'taken').catch(() => undefined)

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)

    const current = await read($, shown)
    const carried = await read($, recap)
    if (current === null && carried === null) return next(e)

    const isTake = TAKE.test(e.text.trim())

    if (current !== null && isTake) {
      await setStatus($, current.path, 'taken')

      return next({ ...e, context: [...(e.context ?? []), takeContext(current.path)] })
    }

    await update($, recap, () => null)

    if (carried !== null && isTake) return next({ ...e, context: [...(e.context ?? []), carried.card] })

    // 说了别的就先收起来，交接稿留到下次新对话再提示；「刚才在做」不留，开了新话题就算了
    await update($, shown, () => null)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, shown)
    const carried = await read($, recap)
    if ((current === null && carried === null) || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (current === null && carried !== null) {
      return (
        <Box>
          <Box flexShrink={0}><Text color="claude">{'刚才在做 '}</Text></Box>
          <Text wrap="truncate-end">{`${carried.line}  `}</Text>
          <Box flexShrink={0}><Button key="take" label="接上" onPress={() => takeRecap($, carried)} /></Box>
          <Text> </Text>
          <Box flexShrink={0}><Button key="skip" label="不用" onPress={() => update($, recap, () => null)} /></Box>
          <Box flexShrink={0}><Text dimColor>{'  回「接」也行'}</Text></Box>
        </Box>
      )
    }

    if (current === null) return next(e)

    const since = ago((await $.clock.now()) - current.at)

    return (
      <Box>
        <Text color="claude">{'交接稿 '}</Text>
        <Text wrap="truncate-end">{`（${since}）${current.title}  `}</Text>
        <Button key="take" label="接手" onPress={() => take($, current)} />
        <Text> </Text>
        <Button key="skip" label="不用" onPress={() => setStatus($, current.path, 'dismissed')} />
        <Text dimColor>{'  也可以直接回「接」'}</Text>
      </Box>
    )
  })
}

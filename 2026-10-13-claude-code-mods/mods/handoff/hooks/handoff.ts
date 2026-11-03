import type { SessionMessage } from 'claude-code'

import type { Handoff, Recap } from '../types'

export const FRESH_MS = 24 * 3_600_000
const KEEP = 20

const NOISE = /<(system-reminder|command-name|command-message|command-args|local-command-[a-z]+)[^>]*>[\s\S]*?<\/\1>/g
const CARD_TURNS = 8
const USER_CLIP = 600
const ASSISTANT_CLIP = 1200
const LINE_CLIP = 40
const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const MAX_FILES = 12

type Turn = { role: SessionMessage['role']; text: string }

const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size)}…` : text)

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export const turnsOf = (messages: readonly SessionMessage[]): Turn[] =>
  messages.map(m => ({ role: m.role, text: m.text.replace(NOISE, '').trim() })).filter(t => t.text !== '')

export const filesOf = (messages: readonly SessionMessage[]): string[] => {
  const paths = messages.flatMap(m =>
    m.toolUses.filter(use => FILE_TOOLS.has(use.tool) && typeof use.input['file_path'] === 'string').map(use => use.input['file_path'] as string),
  )

  return [...new Set(paths.reverse())].slice(0, MAX_FILES)
}

// 「好」「接」这种短回复说明不了在做什么，往前找一句够长的
export const fallbackLine = (turns: readonly Turn[]) => {
  const asks = turns.filter(t => t.role === 'user')
  const ask = [...asks].reverse().find(t => oneLine(t.text).length >= 6) ?? asks.at(-1)

  return ask === undefined ? '' : clip(oneLine(ask.text), LINE_CLIP)
}

const transcriptOf = (turns: readonly Turn[]) =>
  turns
    .slice(-CARD_TURNS)
    .map(t => `${t.role === 'user' ? '小陈' : 'Claude'}：${clip(t.text, t.role === 'user' ? USER_CLIP : ASSISTANT_CLIP)}`)
    .join('\n\n')

export const recapCard = (turns: readonly Turn[], files: readonly string[], sessionId: string) =>
  [
    '[接上刚才 · mod 自动附上] 小陈刚 /clear 完，回了「接」，要接着清空前的活继续做。下面是清空前最后几轮原话：',
    transcriptOf(turns),
    ...(files.length === 0 ? [] : [`清空前改过的文件：\n${files.map(p => `- ${p}`).join('\n')}`]),
    `不够用时读 ~/.claude/projects/ 底下文件名是 ${sessionId}.jsonl 的完整记录。先用一两句话说清你理解的进度和下一步，再接着做。`,
  ].join('\n\n')

// 这一轮什么都没聊就 /clear 的，没东西可接
export const recapOf = (messages: readonly SessionMessage[], sessionId: string, at: number): Recap | null => {
  const turns = turnsOf(messages)
  if (!turns.some(t => t.role === 'user')) return null

  return { line: fallbackLine(turns), card: recapCard(turns, filesOf(messages), sessionId), sessionId, at }
}

export const linePrompt = (messages: readonly SessionMessage[]) =>
  `下面是小陈和 Claude 对话的最后几轮。用一句中文说清手上在做的那件事，不超过 25 个字，直接从动作说起（如「改 Mods 文案里的 upgrade 段」），不要出现「用户」「小陈」「Claude」，只输出这一句，结尾不加标点。\n\n${transcriptOf(turnsOf(messages))}`

export const cleanLine = (text: string) => clip(oneLine(text).replace(/[。.]$/, ''), LINE_CLIP)

// 文件名带「交接」的 .md 都算交接稿（交接稿.md、幕后页-交接.md、交接稿-S6.md…）
export const isHandoffPath = (path: string) => {
  const name = path.split('/').pop() ?? ''

  return name.endsWith('.md') && name.includes('交接')
}

export const titleOf = (path: string, text: string) => {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
  const name = (path.split('/').pop() ?? path).replace(/\.md$/, '')

  return (heading ?? name).slice(0, 40)
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

// 新对话开在哪都行：同一个目录、或交接稿就在这个目录底下、或这个目录在交接稿旁边
export const isNear = (handoff: Handoff, cwd: string) =>
  handoff.cwd === cwd || handoff.path.startsWith(`${cwd}/`) || cwd.startsWith(dirOf(handoff.path))

export const pickPending = (list: readonly Handoff[], cwd: string, sessionId: string, now: number) =>
  list
    .filter(h => h.status === 'pending' && h.sessionId !== sessionId && now - h.at < FRESH_MS && isNear(h, cwd))
    .sort((a, b) => b.at - a.at)[0]

export const remember = (list: readonly Handoff[], handoff: Handoff): Handoff[] =>
  [handoff, ...list.filter(h => h.path !== handoff.path)].slice(0, KEEP)

export const mark = (list: readonly Handoff[], path: string, status: Handoff['status']): Handoff[] =>
  list.map(h => (h.path === path ? { ...h, status } : h))

export const TAKE = /^(接|接手|接吧|接着做|接上|接着干)[。.!！]?$/

export const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟前`

  return `${Math.round(minutes / 60)} 小时前`
}

export const takePrompt = (path: string) => `读交接稿 ${path}，按里面的「接手后第一步」接着做`

export const takeContext = (path: string) =>
  `[交接接力 · mod 自动附上] 用户要接手这份交接稿：${path}。先完整读它，按里面的「接手后第一步」开始。`

export const RULES = `/handoff 交接稿规则：
- 写成一个 .md 文件，文件名带「交接」二字（如 交接稿-智商倒挂-S6.md），放在这件事所属的项目文件夹里。
- 新对话的 Claude 没有任何上下文，只靠这份稿接着干。写清：① 一句话目标 ② 已经定下的（带小陈原话、版本号 / 端口 / 帧号）③ 还没做的，按顺序 ④ 别碰的、踩过的坑 ⑤ 开工前先读哪些文件（绝对路径）⑥ 最后一行「接手后第一步：……」。
- 写完在对话里只回一句文件路径，不要把全文贴出来。`

export const promptOf = (args: string) => `写交接稿${args.trim() === '' ? '' : `：${args.trim()}`}`

export type Handoff = {
  path: string
  title: string
  cwd: string
  sessionId: string
  at: number
  status: 'pending' | 'taken' | 'dismissed'
}

// /clear 时自动记下的「刚才在做什么」，不用先写交接稿
export type Recap = {
  line: string
  card: string
  sessionId: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { shown: Handoff | null; recap: Recap | null }
  }
}

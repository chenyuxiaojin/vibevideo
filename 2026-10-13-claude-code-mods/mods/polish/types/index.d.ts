export type Question = { text: string; hint: string }

/** 面板当前走到哪一步。run 用来认出已经过期的模型回答。 */
export type Flow =
  | { phase: 'idle' }
  | { phase: 'loading'; run: string; raw: string; listing: string }
  | {
      phase: 'asking'
      run: string
      raw: string
      listing: string
      questions: Question[]
      answers: string[]
      isGeneric: boolean
    }
  | {
      phase: 'writing'
      run: string
      raw: string
      listing: string
      questions: Question[]
      answers: string[]
    }
  | {
      phase: 'failed'
      run: string
      raw: string
      listing: string
      questions: Question[]
      answers: string[]
      reason: string
    }
  | {
      phase: 'done'
      run: string
      raw: string
      prompt: string
      /** 结果画在哪：面板够宽就留在面板，否则去输入框上方的宽区域。 */
      site: 'pane' | 'band'
      page: number
      note: string
      isSending: boolean
    }

declare module 'claude-code' {
  interface PluginState {
    polish: { flow: Shaped<Flow> }
  }
}

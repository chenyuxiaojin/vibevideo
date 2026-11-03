export type TreeRow = { path: string; name: string; depth: number; isDir: boolean }

export type Touch = {
  id: string
  path: string
  kind: 'read' | 'edit'
  until: number
  isRunning: boolean
}

export type Preview = {
  path: string
  kind: 'code' | 'markdown' | 'image' | 'binary' | 'missing'
  text: string
  lines: number
  hiddenLines: number
  size: number
  mtimeMs: number
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      rows: Shaped<TreeRow[]>
      touches: Shaped<Touch[]>
      saved: Shaped<string[]>
      expanded: Shaped<string[]>
      preview: Shaped<Preview | null>
      isSource: boolean
      isLit: boolean
    }
  }
}

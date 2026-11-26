export type Category = 'running' | 'waiting' | 'idle'

export type SessionCard = {
  sid: string
  name: string
  title: string
  prompt: string
  model: string
  category: Category
  detail: string
  context: number
  window: number
  rate: number
  turnOut: number
  turnRate: number
  agoSec: number
  isThis: boolean
  /** output tokens per 50 s, oldest first, last 10 minutes */
  spark: number[]
}

export type Snapshot = { cards: SessionCard[]; error: string }

declare module 'claude-code' {
  interface PluginState {
    'session-dashboard': {
      snapshot: Shaped<Snapshot>
      hidden: Shaped<string[]>
      picking: Shaped<boolean>
    }
  }
}

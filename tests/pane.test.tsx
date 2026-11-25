import { expect, test } from 'claude-code/testing'

import type { SessionCard } from '../types'

const PANE = {
  plugin: 'session-dashboard',
  component: 'Pane',
  requestId: 'session-dashboard',
  props: {
    title: 'Claude sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const base: SessionCard = {
  sid: 'a', name: 'Project A', title: 'Build the login page', prompt: 'add a password field', model: 'opus-5-5',
  category: 'running', detail: 'running Bash', context: 150_000, window: 200_000, rate: 312.4,
  turnOut: 26_000, turnRate: 300, agoSec: 2, isThis: true,
}
const cards: SessionCard[] = [
  base,
  { ...base, sid: 'b', name: 'Project B', category: 'waiting', detail: 'approve the plan', isThis: false },
  { ...base, sid: 'c', name: 'Project C', category: 'idle', detail: '', agoSec: 3600, isThis: false },
]

const seed = (on: any, hidden: string[] = [], picking = false) => {
  on('state.get', (_: unknown, e: any) => {
    const key = e.key
    const value = key === 'snapshot' ? { shape: 'snapshot-1', value: { cards, error: '' } }
      : key === 'hidden' ? { shape: 'hidden-1', value: hidden }
      : { shape: 'picking-1', value: picking }
    return { value: { value, version: 1 } }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`sessions are grouped into three sections on ${surface}`, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /RUNNING \/ IN PROGRESS \(1\)/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /WAITING FOR INPUT \(1\)/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /IDLE \(1\)/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /approve the plan/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /312\.4 tok\/s/ }))).toBeTruthy()
    expect((await ui.find({ key: 'choose' }))).toBeTruthy()
    await ui.unmount()
  })

  test(`a hidden session leaves the dashboard on ${surface}`, async ($, on) => {
    seed(on, ['b'])
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /WAITING FOR INPUT \(0\)/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1 hidden/ }))).toBeTruthy()
    await ui.unmount()
  })

  test(`the picker lists each session with a toggle on ${surface}`, async ($, on) => {
    seed(on, ['b'], true)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'pick-a' }))).toBeTruthy()
    expect((await ui.find({ key: 'pick-b' }))).toBeTruthy()
    expect((await ui.find({ key: 'done' }))).toBeTruthy()
    await ui.unmount()
  })
}

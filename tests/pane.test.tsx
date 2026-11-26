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
  spark: [0, 0, 120, 400, 380, 900, 1200, 800, 0, 300, 650, 1100],
}
const cards: SessionCard[] = [
  base,
  { ...base, sid: 'b', name: 'Project B', category: 'waiting', detail: 'approve the plan', isThis: false },
  { ...base, sid: 'c', name: 'Project C', category: 'idle', detail: '', agoSec: 3600, isThis: false },
]

const seed = (on: any, hidden: string[] = [], picking = false) => {
  on('state.get', (_: unknown, e: any) => {
    const key = e.key
    const value = key === 'snapshot' ? { shape: 'snapshot-2', value: { cards, error: '' } }
      : key === 'hidden' ? { shape: 'hidden-1', value: hidden }
      : { shape: 'picking-1', value: picking }
    return { value: { value, version: 1 } }
  })
}

const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

for (const surface of ['terminal', 'desktop'] as const) {
  test(`sessions are grouped by status on ${surface}`, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, /^Running 1$/)).toBeTruthy()
    expect(await text(ui, /^Waiting for you 1$/)).toBeTruthy()
    expect(await text(ui, /^Idle 1$/)).toBeTruthy()
    expect(await text(ui, /Approve the plan/)).toBeTruthy()
    expect(await text(ui, /312 tok\/s/)).toBeTruthy()
    expect(await ui.find({ key: 'choose' })).toBeTruthy()
    await ui.unmount()
  })

  test(`a hidden session leaves the dashboard and its empty section goes on ${surface}`, async ($, on) => {
    seed(on, ['b'])
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, /^Waiting for you/)).toBeUndefined()
    expect(await text(ui, /1 hidden/)).toBeTruthy()
    await ui.unmount()
  })

  test(`the picker offers Hide or Show for each session on ${surface}`, async ($, on) => {
    seed(on, ['b'], true)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'pick-a' })).toBeTruthy()
    expect(await ui.find({ key: 'pick-b' })).toBeTruthy()
    expect(await ui.find({ key: 'show-all' })).toBeTruthy()
    expect(await ui.find({ key: 'done' })).toBeTruthy()
    await ui.unmount()
  })
}

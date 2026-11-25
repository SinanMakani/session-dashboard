import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Category, SessionCard, Snapshot } from '../types'

// A pane listing every Claude session on this machine, read from the
// transcripts in ~/.claude/projects: Running / Waiting for input / Idle,
// with context used and token rate. Port of claude-wallpaper-dashboard.

const PANE = 'session-dashboard'
const TITLE = 'Claude sessions'

const REFRESH_MS = 3000
const SHOW_HOURS = 12
const BUSY_STALE_S = 600 // mid-turn, no messages this long -> "check the session"
const ABANDON_S = 1800 // mid-turn, no messages this long -> idle (closed / interrupted)
const APPROVAL_GUESS_S = 45 // a tool call with no result this long -> likely an approval prompt
const RATE_WINDOW_S = 60
const TAIL_BYTES = 4_000_000 // one $.fs.read may answer at most 4 MiB
const DEFAULT_WINDOW = 200_000
const LONG_TOOLS = new Set(['Agent', 'Task', 'Monitor', 'ScheduleWakeup', 'WebSearch', 'WebFetch'])

const snapshot = atom({ plugin: 'session-dashboard', key: 'snapshot' } as const,
  { cards: [], error: '' }, { shape: 'snapshot-1' })
const hidden = atom({ plugin: 'session-dashboard', key: 'hidden' } as const, [], { shape: 'hidden-1' })
const picking = atom({ plugin: 'session-dashboard', key: 'picking' } as const, false, { shape: 'picking-1' })

// ------------------------------------------------------------ transcript parsing

type Pending = { name: string; ts: number; ask: string }

type Parsed = {
  sid: string
  project: string
  offset: number
  title: string
  prompt: string
  model: string
  context: number
  maxSeen: number
  busy: boolean
  turnStart: number
  turnOut: number
  lastActivity: number
  outputs: Array<[number, number]>
  pending: Map<string, Pending>
  turnAsk: string
  lastText: string
  endedAsking: string
}

const parsed = new Map<string, Parsed>() // by file path; starts over on a reload

const utf8Len = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }
    else n += 3
  }
  return n
}

const ts = (s: unknown): number => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t / 1000 : 0
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const p of content) if (p && p.type === 'text') return String(p.text ?? '')
  }
  return ''
}

const isRealPrompt = (d: any): boolean => {
  if (d.isMeta || d.isSidechain) return false
  const c = d.message?.content
  if (Array.isArray(c) && c.some((p: any) => p?.type === 'tool_result')) return false
  const t = textOf(c).trim()
  return t !== '' && !t.startsWith('<')
}

const endTurn = (s: Parsed) => {
  s.busy = false
  s.pending.clear()
  const lines = s.lastText.trim().split('\n')
  const last = (lines[lines.length - 1] ?? '').trim()
  if (s.turnAsk) s.endedAsking = s.turnAsk
  else if (/\?[*_`) ]*$/.test(last)) s.endedAsking = last.replace(/^[*_` ]+|[*_` ]+$/g, '')
}

const ingest = (s: Parsed, d: any) => {
  const t = d.type
  if ((t === 'user' || t === 'assistant' || t === 'system') && !d.isSidechain) {
    s.lastActivity = Math.max(s.lastActivity, ts(d.timestamp))
  }
  if (t === 'custom-title' && d.customTitle) s.title = d.customTitle
  else if (t === 'last-prompt' && d.lastPrompt) s.prompt = d.lastPrompt
  else if (t === 'user' && !d.isSidechain) {
    if (isRealPrompt(d)) {
      s.prompt = textOf(d.message.content).trim()
      s.turnStart = ts(d.timestamp)
      s.turnOut = 0
      s.turnAsk = s.lastText = s.endedAsking = ''
      s.pending.clear()
    }
    const c = d.message?.content
    if (Array.isArray(c)) for (const p of c) if (p?.type === 'tool_result') s.pending.delete(p.tool_use_id)
    if (!d.isMeta) s.endedAsking = ''
    s.busy = true
  } else if (t === 'assistant' && !d.isSidechain) {
    const m = d.message ?? {}
    const u = m.usage ?? {}
    const at = ts(d.timestamp)
    if (m.model && !String(m.model).startsWith('<')) s.model = m.model
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
    if (ctx) { s.context = ctx; s.maxSeen = Math.max(s.maxSeen, ctx) }
    if (u.output_tokens) { s.outputs.push([at, u.output_tokens]); s.turnOut += u.output_tokens }
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (p?.type === 'text' && String(p.text ?? '').trim()) s.lastText = String(p.text).trim()
      else if (p?.type === 'tool_use') {
        const name = String(p.name ?? '')
        const inp = p.input ?? {}
        let ask = ''
        if (name.endsWith('wrap_up') && inp.ask) ask = String(inp.ask)
        else if (name === 'AskUserQuestion') ask = String(inp.questions?.[0]?.question ?? 'answer Claude\'s question')
        if (ask) s.turnAsk = ask
        s.pending.set(p.id, { name, ts: at, ask })
      }
    }
    if (['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(m.stop_reason)) endTurn(s)
    else s.busy = true
  } else if (t === 'system' && (d.subtype === 'turn_duration' || d.subtype === 'stop_hook_summary')) {
    if (s.busy) endTurn(s)
  }
}

const statusOf = (s: Parsed, now: number): [Category, string] => {
  const quiet = now - s.lastActivity
  if (s.busy) {
    if (quiet > ABANDON_S) return ['idle', 'stopped mid-turn']
    const first = [...s.pending.values()].sort((a, b) => a.ts - b.ts)[0]
    if (first) {
      const short = first.name.split('__').pop() ?? first.name
      if (first.name === 'AskUserQuestion') return ['waiting', first.ask || 'answer Claude\'s question']
      if (first.name === 'ExitPlanMode') return ['waiting', 'approve the plan']
      if (!LONG_TOOLS.has(first.name) && quiet > APPROVAL_GUESS_S) return ['waiting', `approve ${short}? (or it's a long run)`]
      return ['running', `running ${short}`]
    }
    if (quiet > BUSY_STALE_S) return ['waiting', 'no activity — check the session']
    return ['running', 'thinking']
  }
  if (s.endedAsking) return ['waiting', s.endedAsking]
  return ['idle', '']
}

const projectName = (folder: string, home: string): string => {
  const prefix = home.replace(/[:\\/]/g, '-').toLowerCase() + '-'
  const p = folder.toLowerCase().startsWith(prefix) ? folder.slice(prefix.length) : folder
  return p.replace(/-/g, ' ') || '~'
}

// ------------------------------------------------------------ the refresh

const refresh = async ($: any, projectsDir: string, home: string, thisSid: string) => {
  const now = (await $.clock.now()) / 1000
  const horizon = now - SHOW_HOURS * 3600
  const cards: SessionCard[] = []
  const folders = await $.fs.list(projectsDir)
  for (const folder of folders) {
    if (folder.kind !== 'directory') continue
    const dir = `${projectsDir}/${folder.name}`
    let files: Array<{ name: string; kind: string; size: number; mtimeMs: number }> = []
    try { files = await $.fs.list(dir) } catch { continue }
    for (const f of files) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs / 1000 < horizon) continue
      const path = `${dir}/${f.name}`
      let s = parsed.get(path)
      if (!s) {
        s = {
          sid: f.name.replace(/\.jsonl$/, ''), project: folder.name, offset: -1, title: '', prompt: '',
          model: '', context: 0, maxSeen: 0, busy: false, turnStart: 0, turnOut: 0, lastActivity: 0,
          outputs: [], pending: new Map(), turnAsk: '', lastText: '', endedAsking: '',
        }
        parsed.set(path, s)
      }
      if (f.size < s.offset) s.offset = -1 // rewritten
      if (f.size !== s.offset) {
        const start = s.offset < 0 ? Math.max(0, f.size - TAIL_BYTES) : s.offset
        const text: string = await $.fs.read(path, { offset: start, length: f.size - start })
        const cut = text.lastIndexOf('\n')
        if (cut >= 0) {
          for (const line of text.slice(0, cut).split('\n')) {
            if (!line.trim()) continue
            try { ingest(s, JSON.parse(line)) } catch { /* partial first line after a tail seek */ }
          }
          // count from the end: the cut-off start of a tail read may hold a replaced character
          s.offset = f.size - utf8Len(text.slice(cut + 1))
        } else if (s.offset < 0) s.offset = start
        s.outputs = s.outputs.filter(([at]) => at >= now - 600)
      }
      const last = s.lastActivity || f.mtimeMs / 1000
      if (last < horizon || (!s.context && !s.prompt)) continue
      const [category, detail] = statusOf(s, now)
      const window = s.model.includes('[1m]') || s.maxSeen > DEFAULT_WINDOW ? 1_000_000 : DEFAULT_WINDOW
      const recent = s.outputs.filter(([at]) => at >= now - RATE_WINDOW_S).reduce((n, [, o]) => n + o, 0)
      cards.push({
        sid: s.sid,
        name: projectName(s.project, home),
        title: s.title,
        prompt: s.prompt.replace(/\s+/g, ' ').trim(),
        model: s.model.replace(/^claude-/, ''),
        category,
        detail,
        context: s.context,
        window,
        rate: recent / RATE_WINDOW_S,
        turnOut: s.turnOut,
        turnRate: s.turnStart && s.turnOut ? s.turnOut / Math.max(1, now - s.turnStart) : 0,
        agoSec: Math.max(0, now - last),
        isThis: s.sid === thisSid,
      })
    }
  }
  cards.sort((a, b) => a.agoSec - b.agoSec)
  return cards
}

// ------------------------------------------------------------ formatting

const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`
const ago = (sec: number) => sec < 60 ? `${Math.round(sec)}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m ago`
const clip = (t: string, n: number) => t.length <= n ? t : `${t.slice(0, n - 1)}…`

const SECTIONS: Array<[Category, string, string]> = [
  ['running', 'RUNNING / IN PROGRESS', 'success'],
  ['waiting', 'WAITING FOR INPUT', 'warning'],
  ['idle', 'IDLE', 'subtle'],
]

// ------------------------------------------------------------ hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'sessions', description: 'Show all your Claude sessions in a pane' })

    const saved = await $.store.get('hidden')
    if (Array.isArray(saved)) await update($, hidden, () => saved.map(String))

    const info = await $.session.info()
    const tp = (info.transcriptPath ?? '').replace(/\\/g, '/')
    const thisSid = tp.split('/').pop()?.replace(/\.jsonl$/, '') ?? ''
    // <home>/.claude/projects/<project>/<session>.jsonl
    const projectsDir = tp.split('/').slice(0, -2).join('/')
    const home = projectsDir.replace(/\/\.claude\/projects$/, '')

    const tick = async () => {
      try {
        const cards = projectsDir ? await refresh($, projectsDir, home, thisSid) : []
        await update($, snapshot, () => ({ cards, error: projectsDir ? '' : 'This session keeps no transcript on this machine.' }))
      } catch (err) {
        await update($, snapshot, s => ({ ...s, error: String(err) }))
      }
    }
    await tick()
    $.clock.every(REFRESH_MS, () => { void tick() })
    void $.ui.open({ id: PANE, title: TITLE })

    return result
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Session dashboard opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const hide = new Set(await read($, hidden))
    const isPicking = await read($, picking)

    const setHidden = async (sid: string, isHidden: boolean) => {
      const list = await update($, hidden, l => isHidden ? [...new Set([...l, sid])] : l.filter(x => x !== sid))
      await $.store.set('hidden', list)
    }

    if (isPicking) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Choose which sessions to show</Text>
          {snap.cards.map(c => (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Button key={`pick-${c.sid}`} label={hide.has(c.sid) ? 'Hidden' : 'Shown'}
                variant={hide.has(c.sid) ? 'secondary' : 'primary'}
                onPress={() => setHidden(c.sid, !hide.has(c.sid))} />
              <Text wrap="truncate-end" dimColor={hide.has(c.sid)}>
                {c.name}{c.isThis ? ' (this session)' : ''} — {c.title || c.prompt}
              </Text>
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            <Button key="done" label="Done" variant="primary" onPress={() => update($, picking, () => false)} />
            <Button key="show-all" label="Show all" onPress={async () => {
              await update($, hidden, () => [])
              await $.store.set('hidden', [])
            }} />
          </Box>
        </Box>
      )
    }

    const shown = snap.cards.filter(c => !hide.has(c.sid))
    const groups = { running: [] as SessionCard[], waiting: [] as SessionCard[], idle: [] as SessionCard[] }
    for (const c of shown) groups[c.category].push(c)
    const total = shown.reduce((n, c) => n + c.rate, 0)

    const card = (c: SessionCard, color: string) => {
      const frac = c.window ? Math.min(1, c.context / c.window) : 0
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text bold>{c.name}</Text>
              <Text dimColor>  {c.model}{c.isThis ? ' · this session' : ''}</Text>
            </Text>
            <Text color={color} bold size="caption">
              {c.category === 'running' ? c.detail.toUpperCase() : `WAITING · ${ago(c.agoSec)}`}
            </Text>
          </Box>
          {(c.title || c.prompt) && <Text dimColor wrap="truncate-end">{c.title || c.prompt}</Text>}
          {c.category === 'waiting'
            ? <Text color="warning" bold wrap="truncate-end">⏵ {c.detail}</Text>
            : c.title && c.prompt && c.prompt !== c.title && <Text dimColor italic wrap="truncate-end">› {c.prompt}</Text>}
          <Progress label="Context" value={frac} max={1}
            valueText={`${k(c.context)} / ${k(c.window)} (${Math.round(frac * 100)}%)`}
            color={frac < 0.6 ? 'success' : frac < 0.85 ? 'warning' : 'error'} />
          <Text dimColor mono tabular>
            {c.rate.toFixed(1)} tok/s · this turn {k(c.turnOut)} at {c.turnRate.toFixed(1)}/s
          </Text>
        </Box>
      )
    }

    const row = (c: SessionCard) => {
      const pct = c.window ? Math.round(Math.min(1, c.context / c.window) * 100) : 0
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text wrap="truncate-end">
            <Text bold>{c.name}</Text>
            <Text dimColor>  {clip(c.title || c.prompt, 40)}{c.isThis ? ' · this session' : ''}</Text>
          </Text>
          <Text dimColor mono tabular>ctx {pct}% · {ago(c.agoSec)}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text color="success" bold>{groups.running.length} running</Text>
          <Text color="warning" bold>{groups.waiting.length} waiting</Text>
          <Text dimColor bold>{groups.idle.length} idle</Text>
          <Text bold>{Math.round(total)} tok/s</Text>
        </Box>
        {snap.error && <Text color="error">{snap.error}</Text>}
        {SECTIONS.map(([key, label, color]) => (
          <Box flexDirection="column">
            <Text color={color} bold size="caption">{label} ({groups[key].length})</Text>
            {groups[key].length === 0 && <Text dimColor>— none</Text>}
            {groups[key].map(c => key === 'idle' ? row(c) : card(c, color))}
          </Box>
        ))}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text dimColor size="caption">{snap.cards.length - shown.length} hidden · last {SHOW_HOURS}h</Text>
          <Button key="choose" label="Choose sessions" onPress={() => update($, picking, () => true)} />
        </Box>
      </Box>
    )
  })
}

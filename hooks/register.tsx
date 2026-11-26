import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
const TAIL_BYTES = 4_000_000 // how much of a long transcript to read the first time
const CHUNK_BYTES = 1_000_000 // one $.fs.read answers at most 4 MiB (base64 adds a third)
const DEFAULT_WINDOW = 200_000
const LONG_TOOLS = new Set(['Agent', 'Task', 'Monitor', 'ScheduleWakeup', 'WebSearch', 'WebFetch'])

const snapshot = atom({ plugin: 'session-dashboard', key: 'snapshot' } as const,
  { cards: [], error: '' }, { shape: 'snapshot-2' })
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

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]))

const fromBase64 = (s: string): Uint8Array => {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = B64_INDEX.get(clean[i]!) ?? 0
    const b = B64_INDEX.get(clean[i + 1]!) ?? 0
    const c = B64_INDEX.get(clean[i + 2] ?? 'A') ?? 0
    const d = B64_INDEX.get(clean[i + 3] ?? 'A') ?? 0
    const n = (a << 18) | (b << 12) | (c << 6) | d
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length && i + 2 < clean.length) out[o++] = (n >> 8) & 255
    if (o < out.length && i + 3 < clean.length) out[o++] = n & 255
  }
  return out.subarray(0, o)
}

// Reads bytes [start, end) in pieces small enough for one $.fs.read each.
const readBytes = async ($: EngineInterface, path: string, start: number, end: number): Promise<Uint8Array> => {
  const out = new Uint8Array(end - start)
  let at = start
  while (at < end) {
    const length = Math.min(CHUNK_BYTES, end - at)
    const { base64 } = await $.fs.read(path, { as: 'bytes', offset: at, length })
    const piece = fromBase64(base64)
    if (piece.length === 0) break
    out.set(piece.subarray(0, end - at), at - start)
    at += piece.length
  }
  return out.subarray(0, at - start)
}

const decoder = new TextDecoder('utf-8')

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

const refresh = async ($: EngineInterface, projectsDir: string, home: string, thisSid: string) => {
  const now = (await $.clock.now()) / 1000
  const horizon = now - SHOW_HOURS * 3600
  const cards: SessionCard[] = []
  const errors: string[] = []
  const folders = await $.fs.list(projectsDir)
  for (const folder of folders) {
    if (folder.kind !== 'dir') continue
    const dir = `${projectsDir}/${folder.name}`
    let files: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
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
        try {
          const bytes = await readBytes($, path, start, f.size)
          const cut = bytes.lastIndexOf(10) // the last complete line ends here
          if (cut >= 0) {
            const text = decoder.decode(bytes.subarray(0, cut))
            for (const line of text.split('\n')) {
              if (!line.trim()) continue
              try { ingest(s, JSON.parse(line)) } catch { /* partial first line after a tail seek */ }
            }
            s.offset = start + cut + 1
          } else if (s.offset < 0) s.offset = start
        } catch (err) {
          errors.push(`${projectName(folder.name, home)}: ${String(err).slice(0, 120)}`)
          continue // one unreadable transcript never stops the others
        }
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
        spark: Array.from({ length: 12 }, (_, i) => {
          const from = now - (12 - i) * 50
          return s!.outputs.filter(([at]) => at >= from && at < from + 50).reduce((n, [, o]) => n + o, 0)
        }),
      })
    }
  }
  cards.sort((a, b) => a.agoSec - b.agoSec)
  return { cards, errors }
}

// ------------------------------------------------------------ formatting

const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`
const ago = (sec: number) => sec < 60 ? 'just now' : sec < 3600 ? `${Math.floor(sec / 60)} min ago` : sec < 86400 ? `${Math.floor(sec / 3600)} h ago` : `${Math.floor(sec / 86400)} d ago`
const rate = (r: number) => r >= 10 ? `${Math.round(r)}` : r > 0 ? r.toFixed(1) : '0'
const sentence = (t: string) => t ? t[0]!.toUpperCase() + t.slice(1) : t

// Status is shape + word + colour, never colour alone (dataviz: status palette).
const STATUS: Record<Category, { label: string; glyph: string; color: string }> = {
  running: { label: 'Running', glyph: '●', color: 'success' },
  waiting: { label: 'Waiting for you', glyph: '▲', color: 'warning' },
  idle: { label: 'Idle', glyph: '○', color: 'subtle' },
}
const ORDER: Category[] = ['running', 'waiting', 'idle']

// Context meter: the fill carries severity, accent -> warning -> error.
const meterColor = (frac: number) => frac < 0.6 ? 'claude' : frac < 0.85 ? 'warning' : 'error'

// A 12-point trend line in the accent, drawn as an image (theme keys can't reach it).
const ACCENT = '#d97757'
const sparkSvg = (points: number[], w = 96, h = 20): string => {
  const peak = Math.max(...points, 1)
  const pad = 3 // room for the round caps and the end dot
  const step = (w - 2 * pad) / Math.max(1, points.length - 1)
  const xy = points.map((v, i) => [pad + i * step, h - pad - (v / peak) * (h - 2 * pad)] as const)
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const [lx, ly] = xy[xy.length - 1] ?? [w, h - 2]
  const isFlat = points.every(v => v === 0)
  const stroke = isFlat ? '#8a8a86' : ACCENT
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<polyline points="${line}" fill="none" stroke="${stroke}" stroke-opacity="${isFlat ? 0.5 : 1}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    + (isFlat ? '' : `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5" fill="${ACCENT}"/>`)
    + '</svg>'
}
const sparkText = (points: number[]): string => {
  const bars = '▁▂▃▄▅▆▇█'
  const peak = Math.max(...points, 1)
  return points.map(v => v === 0 ? '▁' : bars[Math.min(7, Math.round((v / peak) * 7))]).join('')
}

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
        if (!projectsDir) {
          await update($, snapshot, () => ({ cards: [], error: 'This session keeps no transcript on this machine.' }))
          return
        }
        const { cards, errors } = await refresh($, projectsDir, home, thisSid)
        await update($, snapshot, () => ({ cards, error: errors.length ? `Couldn't read ${errors.join('; ')}` : '' }))
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
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Progress } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const snap = await read($, snapshot)
    const hide = new Set(await read($, hidden))
    const isPicking = await read($, picking)

    const setHidden = async (sid: string, isHidden: boolean) => {
      const list = await update($, hidden, l => isHidden ? [...new Set([...l, sid])] : l.filter(x => x !== sid))
      await $.store.set('hidden', list)
    }

    // ---------------------------------------------------- the picker
    if (isPicking) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="semibold">Choose sessions</Text>
            <Text dimColor size="footnote">Hidden sessions stay hidden in every session until you show them.</Text>
          </Box>
          <Box flexDirection="column" gap={1}>
            {snap.cards.map(c => {
              const isHidden = hide.has(c.sid)
              const st = STATUS[c.category]
              return (
                <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
                  <Box flexDirection="column" flexShrink={1}>
                    <Text wrap="truncate-end" dimColor={isHidden}>
                      <Text color={st.color}>{st.glyph}</Text> <Text weight="semibold">{c.name}</Text>
                      {c.isThis && <Text dimColor> · this session</Text>}
                    </Text>
                    <Text dimColor wrap="truncate-end" size="footnote">{c.title || c.prompt}</Text>
                  </Box>
                  <Button key={`pick-${c.sid}`} label={isHidden ? 'Show' : 'Hide'}
                    variant="secondary" onPress={() => setHidden(c.sid, !isHidden)} />
                </Box>
              )
            })}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="done" label="Done" variant="primary" onPress={() => update($, picking, () => false)} />
            {hide.size > 0 && (
              <Button key="show-all" label="Show all sessions" variant="secondary" onPress={async () => {
                await update($, hidden, () => [])
                await $.store.set('hidden', [])
              }} />
            )}
          </Box>
        </Box>
      )
    }

    // ---------------------------------------------------- the dashboard
    const shown = snap.cards.filter(c => !hide.has(c.sid))
    const groups: Record<Category, SessionCard[]> = { running: [], waiting: [], idle: [] }
    for (const c of shown) groups[c.category].push(c)
    const total = shown.reduce((n, c) => n + c.rate, 0)
    const hiddenCount = snap.cards.length - shown.length

    const tile = (label: string, value: string, cat?: Category) => (
      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor size="footnote" wrap="truncate-end">
          {cat && <Text color={STATUS[cat].color}>{STATUS[cat].glyph} </Text>}{label}
        </Text>
        <Text size="heading" weight="semibold">{value}</Text>
      </Box>
    )

    const card = (c: SessionCard) => {
      const st = STATUS[c.category]
      const frac = c.window ? Math.min(1, c.context / c.window) : 0
      const sub = c.title && c.prompt && c.prompt !== c.title ? c.prompt : ''
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1} gap={0}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text wrap="truncate-end">
              <Text color={st.color}>{st.glyph}</Text> <Text weight="semibold">{c.name}</Text>
              {c.isThis && <Text dimColor> · this session</Text>}
            </Text>
            <Text dimColor size="footnote">{c.model}</Text>
          </Box>
          {(c.title || c.prompt) && <Text wrap="truncate-end">{c.title || c.prompt}</Text>}
          {sub && <Text dimColor size="footnote" wrap="truncate-end">“{sub}”</Text>}
          {c.category === 'waiting'
            ? <Text wrap="truncate-end"><Text color="warning">▲</Text> {sentence(c.detail)}</Text>
            : <Text dimColor size="footnote" wrap="truncate-end">{sentence(c.detail)}</Text>}
          <Box marginTop={1}>
            <Progress label="Context" value={frac} max={1}
              valueText={`${k(c.context)} of ${k(c.window)}`} color={meterColor(frac)} />
          </Box>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text>
              <Text weight="semibold">{rate(c.rate)}</Text>
              <Text dimColor size="footnote"> tok/s · {k(c.turnOut)} this turn</Text>
            </Text>
            {Svg
              ? <Svg source={sparkSvg(c.spark)} alt={`Output over the last 10 minutes, now ${rate(c.rate)} tokens a second`} width={96} height={20} />
              : <Text color="claude">{sparkText(c.spark)}</Text>}
          </Box>
        </Box>
      )
    }

    const row = (c: SessionCard) => {
      const pct = c.window ? Math.round(Math.min(1, c.context / c.window) * 100) : 0
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexDirection="column" flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={STATUS.idle.color}>{STATUS.idle.glyph}</Text> <Text weight="medium">{c.name}</Text>
              {c.isThis && <Text dimColor> · this session</Text>}
            </Text>
            {(c.title || c.prompt) && <Text dimColor size="footnote" wrap="truncate-end">{c.title || c.prompt}</Text>}
          </Box>
          <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
            <Text dimColor size="footnote" tabular>{ago(c.agoSec)}</Text>
            <Text dimColor size="footnote" tabular>{pct}% context</Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {tile('Running', String(groups.running.length), 'running')}
          {tile('Waiting', String(groups.waiting.length), 'waiting')}
          {tile('Idle', String(groups.idle.length), 'idle')}
          {tile('Output', `${Math.round(total)} tok/s`)}
        </Box>

        {snap.error && <Text color="error" wrap="wrap">{snap.error}</Text>}
        {shown.length === 0 && !snap.error && (
          <Text dimColor>No Claude sessions in the last {SHOW_HOURS} hours.</Text>
        )}

        {ORDER.filter(cat => groups[cat].length > 0).map(cat => (
          <Box flexDirection="column" gap={cat === 'idle' ? 1 : 0}>
            <Text weight="semibold" size="footnote">
              {STATUS[cat].label} <Text dimColor>{groups[cat].length}</Text>
            </Text>
            {cat === 'idle'
              ? groups.idle.map(row)
              : <Box flexDirection="column" gap={1}>{groups[cat].map(card)}</Box>}
          </Box>
        ))}

        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text dimColor size="footnote">
            {hiddenCount > 0 ? `${hiddenCount} hidden · ` : ''}Last {SHOW_HOURS} hours
          </Text>
          <Button key="choose" label="Choose sessions" variant="secondary" onPress={() => update($, picking, () => true)} />
        </Box>
      </Box>
    )
  })
}

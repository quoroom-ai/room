import { useState, useMemo, useCallback, useRef } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useSwarmEvents, type SwarmEventKind } from '../hooks/useSwarmEvents'
import { api } from '../lib/client'
import { storageGet, storageSet } from '../lib/storage'
import type { Room, Worker, Station, RevenueSummary, OnChainBalance } from '@shared/types'

interface ReferredRoom {
  roomId: string; visibility: 'public' | 'private'; name?: string; goal?: string
  workerCount?: number; taskCount?: number; earnings?: string; queenModel?: string | null
  workers?: Array<{ name: string; state: string }>; stations?: Array<{ name: string; status: string; tier: string }>
  online?: boolean; registeredAt?: string
}

interface SwarmPanelProps {
  rooms: Room[]
  queenRunning: Record<number, boolean>
  onNavigateToRoom: (roomId: number) => void
}

interface InviteCard {
  imagePath: string
  previewText: string
  label: string
}

// ─── Hexagon math (flat-top orientation) ───────────────────

const ROOM_R = 140
const REFERRED_R = 80
const SAT_R = 16
const H = Math.sqrt(3)
const HALF_SQRT3 = H / 2 // cos(30°) ≈ 0.866

function hexPoints(cx: number, cy: number, r: number): string {
  const h = H * r / 2
  return [
    [cx + r, cy],
    [cx + r / 2, cy + h],
    [cx - r / 2, cy + h],
    [cx - r, cy],
    [cx - r / 2, cy - h],
    [cx + r / 2, cy - h],
  ].map(([x, y]) => `${x},${y}`).join(' ')
}

// Distance from hex center to border at a given angle (flat-top hex)
function hexBorderDist(angleDeg: number): number {
  // Normalize angle to 0-360
  const a = ((angleDeg % 360) + 360) % 360
  // Each 60° sector: find offset from sector midpoint
  const sectorAngle = (a % 60) - 30
  const sectorRad = (sectorAngle * Math.PI) / 180
  return ROOM_R * HALF_SQRT3 / Math.cos(sectorRad)
}

function satellitePositions(cx: number, cy: number, count: number, startAngle = -90): Array<[number, number]> {
  if (count === 0) return []
  const angleStep = Math.max(360 / count, 30)
  return Array.from({ length: count }, (_, i) => {
    const angleDeg = startAngle + i * angleStep
    const angleRad = (angleDeg * Math.PI) / 180
    // Place satellite so its flat edge touches the room hex border (2px gap)
    // hexBorderDist = room border, SAT_R * HALF_SQRT3 = satellite flat-edge inset
    const dist = hexBorderDist(angleDeg) + SAT_R * HALF_SQRT3 + 2
    return [cx + dist * Math.cos(angleRad), cy + dist * Math.sin(angleRad)]
  })
}

// ─── Text wrapping helper ──────────────────────────────────

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && (current + ' ' + word).length > maxCharsPerLine) {
      lines.push(current)
      current = word
    } else {
      current = current ? current + ' ' + word : word
    }
  }
  if (current) lines.push(current)
  return lines
}

// ─── Formatting ────────────────────────────────────────────

function fmtMoney(n: number): string {
  if (n === 0) return '$0'
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) >= 1) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function fmtModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)/, ' $1.$2')
}

// ─── Status → color maps ───────────────────────────────────

function roomColors(room: Room, running: boolean): { fill: string; stroke: string } {
  if (running) return { fill: 'var(--status-success-bg)', stroke: 'var(--status-success)' }
  if (room.status === 'paused') return { fill: 'var(--status-warning-bg)', stroke: 'var(--status-warning)' }
  if (room.status === 'stopped') return { fill: 'var(--surface-tertiary)', stroke: 'var(--border-primary)' }
  return { fill: 'var(--surface-tertiary)', stroke: 'var(--border-secondary)' }
}

function workerColor(state: string): string {
  switch (state) {
    case 'thinking': return 'var(--status-info-bg)'
    case 'acting': return 'var(--status-success-bg)'
    case 'voting': return 'var(--status-warning-bg)'
    case 'rate_limited': return 'var(--brand-100)'
    case 'blocked': return 'var(--status-error-bg)'
    default: return 'var(--surface-tertiary)'
  }
}

function stationColor(status: string): string {
  switch (status) {
    case 'active': return 'var(--status-success-bg)'
    case 'pending': return 'var(--status-warning-bg)'
    case 'error': return 'var(--status-error-bg)'
    default: return 'var(--surface-tertiary)'
  }
}

// ─── Event bubble visuals ─────────────────────────────────

function eventIcon(kind: SwarmEventKind): React.JSX.Element {
  const s = 14 // icon viewBox size
  const common = { width: s, height: s, viewBox: `0 0 ${s} ${s}`, xmlns: 'http://www.w3.org/2000/svg' }
  switch (kind) {
    case 'worker_thinking':
      return <svg {...common}><path d="M7 2C4.2 2 2 4 2 6.4c0 1.4.7 2.6 1.8 3.4L3.5 12l2-1.2c.5.1 1 .2 1.5.2 2.8 0 5-2 5-4.4S9.8 2 7 2z" fill="var(--status-info)" fillOpacity="0.7"/></svg>
    case 'worker_acting':
      return <svg {...common}><path d="M8.5 1L4 7.5h3.5L6 13l5.5-7H8L8.5 1z" fill="var(--status-success)" fillOpacity="0.7"/></svg>
    case 'worker_voting':
      return <svg {...common}><rect x="2" y="1.5" width="10" height="11" rx="1.5" fill="none" stroke="var(--interactive)" strokeWidth="1.2"/><path d="M5 7l1.5 1.5L9 5.5" stroke="var(--interactive)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'worker_rate_limited':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="var(--status-warning)" strokeWidth="1.2"/><path d="M7 4v3.5l2.5 1.5" stroke="var(--status-warning)" strokeWidth="1.2" strokeLinecap="round"/></svg>
    case 'worker_blocked':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="var(--status-error)" strokeWidth="1.2"/><path d="M5 5l4 4M9 5l-4 4" stroke="var(--status-error)" strokeWidth="1.2" strokeLinecap="round"/></svg>
    case 'vote_cast':
      return <svg {...common}><rect x="2" y="1.5" width="10" height="11" rx="1.5" fill="none" stroke="var(--interactive)" strokeWidth="1.2"/><path d="M5 7l1.5 1.5L9 5.5" stroke="var(--interactive)" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'decision_approved':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="var(--status-success)" fillOpacity="0.2" stroke="var(--status-success)" strokeWidth="1.2"/><path d="M4.5 7l2 2 3.5-4" stroke="var(--status-success)" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'decision_rejected':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="var(--status-error)" fillOpacity="0.2" stroke="var(--status-error)" strokeWidth="1.2"/><path d="M5 5l4 4M9 5l-4 4" stroke="var(--status-error)" strokeWidth="1.3" strokeLinecap="round"/></svg>
    case 'goal_progress':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="none" stroke="var(--status-info)" strokeWidth="1.2"/><circle cx="7" cy="7" r="2" fill="var(--status-info)" fillOpacity="0.6"/></svg>
    case 'goal_completed':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="var(--status-success)" fillOpacity="0.2" stroke="var(--status-success)" strokeWidth="1.2"/><circle cx="7" cy="7" r="2" fill="var(--status-success)"/></svg>
    case 'task_started':
      return <svg {...common}><path d="M4.5 2.5v9l7-4.5z" fill="var(--status-info)" fillOpacity="0.7"/></svg>
    case 'task_completed':
      return <svg {...common}><path d="M7 1l1.5 3.5H12l-3 2.5 1 3.5L7 8.5 3.5 10.5l1-3.5-3-2.5h3.5z" fill="var(--status-success)" fillOpacity="0.6"/></svg>
    case 'task_failed':
      return <svg {...common}><path d="M7 1.5L1.5 12h11L7 1.5z" fill="none" stroke="var(--status-error)" strokeWidth="1.2" strokeLinejoin="round"/><path d="M7 5v3M7 9.5v1" stroke="var(--status-error)" strokeWidth="1.2" strokeLinecap="round"/></svg>
    case 'money_received':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="var(--status-success)" fillOpacity="0.15" stroke="var(--status-success)" strokeWidth="1.2"/><path d="M7 4v6M5 7l2 3 2-3" stroke="var(--status-success)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'money_sent':
      return <svg {...common}><circle cx="7" cy="7" r="5" fill="var(--status-error)" fillOpacity="0.15" stroke="var(--status-error)" strokeWidth="1.2"/><path d="M7 10V4M5 7l2-3 2 3" stroke="var(--status-error)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
    case 'escalation':
      return <svg {...common}><path d="M7 1.5L1.5 12h11L7 1.5z" fill="var(--status-warning)" fillOpacity="0.2" stroke="var(--status-warning)" strokeWidth="1.2" strokeLinejoin="round"/><path d="M7 5v3M7 9.5v1" stroke="var(--status-warning)" strokeWidth="1.2" strokeLinecap="round"/></svg>
    case 'skill_created':
      return <svg {...common}><path d="M7 1C4.5 1 2.5 3 2.5 5.5c0 1.5.7 2.8 1.8 3.6V11.5h5.4V9.1c1.1-.8 1.8-2.1 1.8-3.6C11.5 3 9.5 1 7 1z" fill="var(--interactive)" fillOpacity="0.2" stroke="var(--interactive)" strokeWidth="1"/><path d="M5 12.5h4" stroke="var(--interactive)" strokeWidth="1" strokeLinecap="round"/></svg>
    case 'station_created':
    case 'station_started':
      return <svg {...common}><rect x="2" y="3" width="10" height="8" rx="1.5" fill="var(--status-success)" fillOpacity="0.15" stroke="var(--status-success)" strokeWidth="1.2"/><circle cx="5" cy="7" r="1" fill="var(--status-success)"/><path d="M8 5.5h2M8 7h2M8 8.5h2" stroke="var(--status-success)" strokeWidth="0.8" strokeLinecap="round"/></svg>
    case 'station_stopped':
      return <svg {...common}><rect x="2" y="3" width="10" height="8" rx="1.5" fill="var(--status-warning)" fillOpacity="0.15" stroke="var(--status-warning)" strokeWidth="1.2"/><path d="M5.5 5.5v3M8.5 5.5v3" stroke="var(--status-warning)" strokeWidth="1.3" strokeLinecap="round"/></svg>
    case 'self_mod':
      return <svg {...common}><path d="M4 2v10M10 2v10" stroke="var(--interactive)" strokeWidth="1.2" strokeLinecap="round"/><path d="M4 4c2 0 2 2 6 2M4 8c2 0 2-2 6-2" stroke="var(--interactive)" strokeWidth="1.2" fill="none" strokeLinecap="round"/></svg>
    default:
      return <svg {...common}><circle cx="7" cy="7" r="4" fill="var(--text-muted)" fillOpacity="0.3"/></svg>
  }
}

function eventBgColor(kind: SwarmEventKind): string {
  switch (kind) {
    case 'worker_thinking': case 'goal_progress': case 'task_started': case 'station_created':
      return 'var(--status-info-bg)'
    case 'worker_acting': case 'decision_approved': case 'goal_completed': case 'task_completed': case 'money_received': case 'station_started':
      return 'var(--status-success-bg)'
    case 'worker_voting': case 'vote_cast': case 'skill_created': case 'self_mod':
      return 'var(--interactive-bg)'
    case 'worker_rate_limited': case 'escalation': case 'station_stopped':
      return 'var(--status-warning-bg)'
    case 'worker_blocked': case 'decision_rejected': case 'task_failed': case 'money_sent':
      return 'var(--status-error-bg)'
    default:
      return 'var(--surface-tertiary)'
  }
}

// ─── Share as image ────────────────────────────────────────

const VAR_RE = /var\(--([^)]+)\)/g

/** Resolve all CSS var(--...) references to computed hex values */
function resolveVars(svgClone: SVGSVGElement): void {
  const style = getComputedStyle(document.documentElement)
  const cache: Record<string, string> = {}
  function resolve(val: string): string {
    return val.replace(VAR_RE, (_, name) => {
      if (!cache[name]) cache[name] = style.getPropertyValue(`--${name}`).trim() || val
      return cache[name]
    })
  }
  const COLOR_ATTRS = ['fill', 'stroke', 'color', 'stop-color', 'flood-color']
  svgClone.querySelectorAll('*').forEach(el => {
    for (const attr of COLOR_ATTRS) {
      const v = el.getAttribute(attr)
      if (v && v.includes('var(')) el.setAttribute(attr, resolve(v))
    }
  })
}

/** QUOROOM wordmark: Q,O,O,O are hexagons; U,R,M are geometric strokes */
function addBrandFooter(svgClone: SVGSVGElement): void {
  const w = Number(svgClone.getAttribute('width') || 400)
  const h = Number(svgClone.getAttribute('height') || 400)
  const footerH = 70
  svgClone.setAttribute('height', String(h + footerH))

  const NS = 'http://www.w3.org/2000/svg'
  const g = document.createElementNS(NS, 'g')
  const COLOR = '#f59542'
  const muted = '#6B7280'
  const FONT = "'Segoe UI', -apple-system, system-ui, sans-serif"

  // Matched to landing: font-size drives cap height → hex radius
  const fs = 28
  const capH = fs * 0.72 // approximate cap height for weight 200
  const hexR = capH / Math.sqrt(3)
  const hexW = hexR * 2
  const SP = fs * 0.06
  const OO_SP = fs * 0.18 // extra gap between the two O's (index 4→5)
  const lw = Math.max(2, capH * 0.08)

  const cy = h + footerH / 2

  // Hex path centered at (cx, cy)
  function makeHex(cx: number, cy: number): SVGPolygonElement {
    const pts: string[] = []
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i
      pts.push(`${cx + hexR * Math.cos(a)},${cy + hexR * Math.sin(a)}`)
    }
    const poly = document.createElementNS(NS, 'polygon')
    poly.setAttribute('points', pts.join(' '))
    poly.setAttribute('fill', 'none')
    poly.setAttribute('stroke', COLOR)
    poly.setAttribute('stroke-width', String(lw))
    return poly
  }

  // Q = hex + diagonal tail from lower-right outward (matches landing exactly)
  function makeQ(cx: number, cy: number): SVGGElement {
    const qg = document.createElementNS(NS, 'g')
    qg.appendChild(makeHex(cx, cy))
    const tail = document.createElementNS(NS, 'line')
    const tx = cx + hexR * 0.3
    const ty = cy + hexR * 0.3
    const tx2 = cx + hexR * 1.05
    const ty2 = cy + hexR * 1.05
    tail.setAttribute('x1', String(tx))
    tail.setAttribute('y1', String(ty))
    tail.setAttribute('x2', String(tx2))
    tail.setAttribute('y2', String(ty2))
    tail.setAttribute('stroke', COLOR)
    tail.setAttribute('stroke-width', String(lw))
    qg.appendChild(tail)
    return qg
  }

  // Text letter (U, R, M)
  function makeLetter(ch: string, x: number, baseline: number): SVGTextElement {
    const t = document.createElementNS(NS, 'text')
    t.setAttribute('x', String(x))
    t.setAttribute('y', String(baseline))
    t.setAttribute('fill', COLOR)
    t.setAttribute('font-size', String(fs))
    t.setAttribute('font-weight', '200')
    t.setAttribute('font-family', FONT)
    t.textContent = ch
    return t
  }

  // Word layout: Q U O R O O M
  // Approximate text widths for weight-200 at this size
  const uW = fs * 0.52
  const rW = fs * 0.42
  const mW = fs * 0.62
  const word = ['Q', 'U', 'O', 'R', 'O', 'O', 'M'] as const
  const types = word.map(c => (c === 'Q' ? 'hexQ' : c === 'O' ? 'hex' : 'letter'))
  const widths = word.map((c, i) =>
    types[i] === 'hex' || types[i] === 'hexQ' ? hexW : c === 'U' ? uW : c === 'R' ? rW : mW,
  )
  function gapAt(i: number) { return i === 4 ? OO_SP : SP }

  let totalW = 0
  word.forEach((_, i) => {
    totalW += widths[i]
    if (i < word.length - 1) totalW += gapAt(i)
  })

  const baseline = cy + capH / 2
  let x = 20 // left padding

  word.forEach((ch, i) => {
    if (types[i] === 'hexQ') {
      g.appendChild(makeQ(x + hexW / 2, cy))
      x += hexW
    } else if (types[i] === 'hex') {
      g.appendChild(makeHex(x + hexW / 2, cy))
      x += hexW
    } else {
      g.appendChild(makeLetter(ch, x, baseline))
      x += widths[i]
    }
    if (i < word.length - 1) x += gapAt(i)
  })

  // "RESEARCH" to the right of the wordmark
  const sub = document.createElementNS(NS, 'text')
  sub.setAttribute('x', String(x + 10))
  sub.setAttribute('y', String(cy + 4))
  sub.setAttribute('fill', muted)
  sub.setAttribute('font-size', '10')
  sub.setAttribute('font-family', FONT)
  sub.setAttribute('letter-spacing', '3')
  sub.textContent = 'RESEARCH'
  g.appendChild(sub)

  // "quoroom.ai" domain on right
  const domain = document.createElementNS(NS, 'text')
  domain.setAttribute('x', String(w - 20))
  domain.setAttribute('y', String(cy + 4))
  domain.setAttribute('text-anchor', 'end')
  domain.setAttribute('fill', muted)
  domain.setAttribute('font-size', '13')
  domain.setAttribute('font-family', FONT)
  domain.textContent = 'quoroom.ai'
  g.appendChild(domain)

  svgClone.appendChild(g)
}

async function svgToBlob(svgEl: SVGSVGElement, hideMoney: boolean, scale = 2): Promise<Blob> {
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  if (hideMoney) {
    clone.querySelectorAll('[data-money]').forEach(el => el.remove())
  }

  // Resolve CSS variables → actual colors (canvas can't read CSS vars)
  resolveVars(clone)

  // Dark background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', '100%')
  bg.setAttribute('height', '200%') // oversized to cover footer too
  bg.setAttribute('fill', '#0F1117')
  clone.insertBefore(bg, clone.firstChild)

  // Brand footer
  addBrandFooter(clone)

  const data = new XMLSerializer().serializeToString(clone)
  const svgBlob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; img.src = url })
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth * scale
  canvas.height = img.naturalHeight * scale
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  URL.revokeObjectURL(url)
  return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob!), 'image/png') })
}

async function downloadImage(svgEl: SVGSVGElement, hideMoney: boolean): Promise<void> {
  const blob = await svgToBlob(svgEl, hideMoney)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'quoroom-swarm.png'
  a.click()
  URL.revokeObjectURL(url)
}

async function shareToTwitter(svgEl: SVGSVGElement, hideMoney: boolean): Promise<void> {
  await downloadImage(svgEl, hideMoney)
  const text = encodeURIComponent('My agent swarm on Quoroom \ud83d\udc1d\n\nhttps://quoroom.ai')
  window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank')
}

async function shareToInstagram(svgEl: SVGSVGElement, hideMoney: boolean): Promise<void> {
  const blob = await svgToBlob(svgEl, hideMoney)
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) } catch { await downloadImage(svgEl, hideMoney) }
}

async function shareToTikTok(svgEl: SVGSVGElement, hideMoney: boolean): Promise<void> {
  await downloadImage(svgEl, hideMoney)
}

const INVITE_URL = 'https://quoroom.ai'

const INVITE_CARDS: InviteCard[] = [
  {
    imagePath: '/social-variants/social-01.png',
    label: 'AUTONOMOUS INCOME SYSTEMS',
    previewText: 'Is it a game, a money machine, or your new AI team?',
  },
  {
    imagePath: '/social-variants/social-02.png',
    label: 'AUTONOMOUS INCOME SYSTEMS',
    previewText: 'Is this your next competitive game, or your first autonomous business?',
  },
  {
    imagePath: '/social-variants/social-03.png',
    label: 'AUTONOMOUS INCOME SYSTEMS',
    previewText: 'Autonomous AI agents earning for their keeper, day and night',
  },
  {
    imagePath: '/social-variants/social-04.png',
    label: 'LIVE RESEARCH EXPERIMENT',
    previewText: 'Can AI agents turn consistent action into income?',
  },
  {
    imagePath: '/social-variants/social-06.png',
    label: 'LIVE RESEARCH EXPERIMENT',
    previewText: 'Built like research, shared like a social experiment, focused on making money with AI',
  },
  {
    imagePath: '/social-variants/social-07.png',
    label: 'SELF-EVOLVING WORKFLOWS',
    previewText: 'Persistent AI that learns, adapts, and keeps earning',
  },
  {
    imagePath: '/social-variants/social-09.png',
    label: 'SELF-EVOLVING WORKFLOWS',
    previewText: 'Persistent by design, self-evolving by default, focused on real income for their keeper',
  },
  {
    imagePath: '/social-variants-upgraded/social-v1-research.png',
    label: 'LIVE RESEARCH EXPERIMENT',
    previewText: 'Research in public: testing how AI can help ordinary people make money online',
  },
  {
    imagePath: '/social-variants-upgraded/social-v2-money.png',
    label: 'AUTONOMOUS INCOME SYSTEMS',
    previewText: 'Autonomous AI agents that make money for their keeper',
  },
  {
    imagePath: '/social-variants-upgraded/social-v3-persist.png',
    label: 'SELF-EVOLVING WORKFLOWS',
    previewText: 'Persistent by design, self-evolving by default, focused on real income for their keeper',
  },
]

function pickDifferentIndex(current: number, total: number): number {
  if (total <= 1) return 0
  let next = current
  while (next === current) {
    next = Math.floor(Math.random() * total)
  }
  return next
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ─── Component ─────────────────────────────────────────────

export function SwarmPanel({ rooms, queenRunning, onNavigateToRoom }: SwarmPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const [hoveredRoomId, setHoveredRoomId] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [shareOpen, setShareOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const [showMoney, setShowMoney] = useState<boolean>(() => storageGet('quoroom_swarm_money') !== 'false')
  const [inviteCardIndex, setInviteCardIndex] = useState<number>(() => Math.floor(Math.random() * INVITE_CARDS.length))
  const svgRef = useRef<SVGSVGElement>(null)

  const { data: allWorkers } = usePolling<Worker[]>(() => api.workers.list(), 15000)

  const { data: stationMap } = usePolling<Record<number, Station[]>>(
    async () => {
      if (rooms.length === 0) return {}
      const entries = await Promise.all(
        rooms.map(async r => {
          const stations = await api.stations.list(r.id).catch(() => [] as Station[])
          return [r.id, stations] as const
        })
      )
      return Object.fromEntries(entries)
    },
    20000
  )

  const { data: revenueMap } = usePolling<Record<number, RevenueSummary>>(
    async () => {
      if (rooms.length === 0) return {}
      const entries = await Promise.all(
        rooms.map(async r => {
          const summary = await api.wallet.summary(r.id).catch(() => null)
          return [r.id, summary] as const
        })
      )
      return Object.fromEntries(entries.filter(([, v]) => v !== null)) as Record<number, RevenueSummary>
    },
    30000
  )

  const { data: balanceMap } = usePolling<Record<number, OnChainBalance>>(
    async () => {
      if (rooms.length === 0) return {}
      const wallets = await Promise.all(
        rooms.map(r => api.wallet.get(r.id).catch(() => null))
      )
      const roomsWithWallets = rooms.filter((_, i) => wallets[i] !== null)
      if (roomsWithWallets.length === 0) return {}
      const entries = await Promise.all(
        roomsWithWallets.map(async r => {
          const bal = await api.wallet.balance(r.id).catch(() => null)
          return [r.id, bal] as const
        })
      )
      return Object.fromEntries(entries.filter(([, v]) => v !== null)) as Record<number, OnChainBalance>
    },
    30000
  )

  const { data: referredMap } = usePolling<Record<number, ReferredRoom[]>>(
    async () => {
      if (rooms.length === 0) return {}
      const entries = await Promise.all(
        rooms.map(async r => {
          const referred = await api.rooms.network(r.id).catch(() => [] as ReferredRoom[])
          return [r.id, referred] as const
        })
      )
      return Object.fromEntries(entries)
    },
    60000
  )

  const totalReferred = useMemo(
    () => Object.values(referredMap ?? {}).reduce((s, arr) => s + arr.length, 0),
    [referredMap]
  )

  const workersPerRoom = useMemo(() => {
    const map: Record<number, Worker[]> = {}
    for (const w of allWorkers ?? []) {
      if (w.roomId !== null) {
        ;(map[w.roomId] ??= []).push(w)
      }
    }
    return map
  }, [allWorkers])

  const totalIncome = useMemo(() => Object.values(revenueMap ?? {}).reduce((s, r) => s + r.totalIncome, 0), [revenueMap])
  const totalExpenses = useMemo(() => Object.values(revenueMap ?? {}).reduce((s, r) => s + r.totalExpenses, 0), [revenueMap])
  const totalOnChainBalance = useMemo(() => Object.values(balanceMap ?? {}).reduce((s, b) => s + b.totalBalance, 0), [balanceMap])

  const { events: swarmEvents, ripples: swarmRipples } = useSwarmEvents(rooms, allWorkers)

  const showSatellites = containerWidth >= 400

  // Honeycomb grid — satellites now hug the hex border
  const satOutreach = SAT_R * 2 + 6 // how far satellites stick out past hex border
  const cellW = (ROOM_R + satOutreach) * 2 + 8
  const colSpacing = cellW * 0.75
  const rowSpacing = H * (ROOM_R + satOutreach + 4)
  const margin = ROOM_R + satOutreach + 20
  const usableWidth = Math.max(containerWidth - margin * 2, colSpacing + ROOM_R)
  const cols = Math.max(1, Math.floor(usableWidth / colSpacing) + 1)

  const positions = useMemo(() => {
    return rooms.map((room, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const cx = margin + col * colSpacing
      const cy = margin + row * rowSpacing + (col % 2 === 1 ? rowSpacing * 0.5 : 0)
      return { room, cx, cy }
    })
  }, [rooms, cols, margin, colSpacing, rowSpacing])

  // Ring positions for referred rooms around each user room
  const referredPositions = useMemo(() => {
    const result: Array<{
      ref: ReferredRoom
      parentRoomId: number
      cx: number
      cy: number
    }> = []
    for (const { room, cx, cy } of positions) {
      const refs = (referredMap ?? {})[room.id] ?? []
      if (refs.length === 0) continue
      const ringDist = ROOM_R + 24 + REFERRED_R
      const maxPerRing = Math.max(6, Math.floor((2 * Math.PI * ringDist) / (REFERRED_R * 2.2)))
      refs.forEach((ref, i) => {
        const ring = Math.floor(i / maxPerRing)
        const idxInRing = i % maxPerRing
        const countInRing = Math.min(refs.length - ring * maxPerRing, maxPerRing)
        const dist = ringDist + ring * (REFERRED_R * 2.2)
        const angleStep = (2 * Math.PI) / countInRing
        const angle = -Math.PI / 2 + idxInRing * angleStep
        result.push({
          ref,
          parentRoomId: room.id,
          cx: cx + dist * Math.cos(angle),
          cy: cy + dist * Math.sin(angle),
        })
      })
    }
    return result
  }, [positions, referredMap])

  const svgWidth = useMemo(() => {
    if (positions.length === 0) return 300
    const allX = [...positions.map(p => p.cx), ...referredPositions.map(p => p.cx + REFERRED_R)]
    return Math.max(...allX) + margin
  }, [positions, referredPositions, margin])

  const svgHeight = useMemo(() => {
    if (positions.length === 0) return 200
    const allY = [...positions.map(p => p.cy), ...referredPositions.map(p => p.cy + REFERRED_R)]
    return Math.max(...allY) + margin + 30
  }, [positions, referredPositions, margin])

  // Event bubble positioning
  const roomPositionMap = useMemo(() => {
    const map = new Map<number, { cx: number; cy: number }>()
    for (const p of positions) map.set(p.room.id, { cx: p.cx, cy: p.cy })
    return map
  }, [positions])

  const eventsByRoom = useMemo(() => {
    const map = new Map<number, typeof swarmEvents>()
    for (const e of swarmEvents) {
      const list = map.get(e.roomId) ?? []
      list.push(e)
      map.set(e.roomId, list)
    }
    return map
  }, [swarmEvents])

  const hoveredRoom = rooms.find(r => r.id === hoveredRoomId) ?? null

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltipPos({ x: e.clientX - rect.left + 14, y: e.clientY - rect.top - 10 })
  }, [])

  const toggleMoney = useCallback(() => {
    setShowMoney(prev => { const next = !prev; storageSet('quoroom_swarm_money', String(next)); return next })
  }, [])

  const handleRegenerateInvite = useCallback(() => {
    setInviteCardIndex(prev => pickDifferentIndex(prev, INVITE_CARDS.length))
  }, [])

  const handleInviteShare = useCallback(async (platform: 'twitter' | 'instagram' | 'facebook' | 'sms' | 'telegram') => {
    const card = INVITE_CARDS[inviteCardIndex]
    const imageUrl = `${window.location.origin}${card.imagePath}`
    const shareText = `${card.previewText}\n\n${INVITE_URL}`
    switch (platform) {
      case 'twitter': {
        // X/Twitter web intent cannot upload a local file, so we attach the selected
        // hosted image URL and keep quoroom.ai in the tweet body.
        const text = encodeURIComponent(`${card.previewText}\n${INVITE_URL}`)
        const url = encodeURIComponent(imageUrl)
        window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank')
        setShareStatus('Opened Twitter')
        break
      }
      case 'facebook': {
        const quote = encodeURIComponent(card.previewText)
        const url = encodeURIComponent(INVITE_URL)
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}&quote=${quote}`, '_blank')
        setShareStatus('Opened Facebook')
        break
      }
      case 'telegram': {
        const text = encodeURIComponent(card.previewText)
        const url = encodeURIComponent(INVITE_URL)
        window.open(`https://t.me/share/url?url=${url}&text=${text}`, '_blank')
        setShareStatus('Opened Telegram')
        break
      }
      case 'sms': {
        const body = encodeURIComponent(shareText)
        window.open(`sms:?&body=${body}`, '_self')
        setShareStatus('Opened SMS')
        break
      }
      case 'instagram': {
        const copied = await copyText(`${card.previewText}\n${INVITE_URL}`)
        window.open(imageUrl, '_blank')
        window.open('https://www.instagram.com/', '_blank')
        setShareStatus(copied ? 'Caption copied. Upload image in Instagram.' : 'Opened Instagram and image.')
        break
      }
    }
    setTimeout(() => setShareStatus(null), 3500)
  }, [inviteCardIndex])

  const handleShare = useCallback(async (platform: 'download' | 'twitter' | 'instagram' | 'tiktok') => {
    if (!svgRef.current) return
    setShareStatus('Generating image...')
    const hideMoney = !showMoney
    try {
      switch (platform) {
        case 'download': await downloadImage(svgRef.current, hideMoney); setShareStatus('Downloaded!'); break
        case 'twitter': await shareToTwitter(svgRef.current, hideMoney); setShareStatus('Image saved, opening Twitter...'); break
        case 'instagram': await shareToInstagram(svgRef.current, hideMoney); setShareStatus('Copied to clipboard! Paste in Instagram.'); break
        case 'tiktok': await shareToTikTok(svgRef.current, hideMoney); setShareStatus('Image saved! Upload it to TikTok.'); break
      }
    } catch { setShareStatus('Failed to generate image') }
    setTimeout(() => setShareStatus(null), 3000)
    setShareOpen(false)
  }, [showMoney])

  // ─── Empty state ─────────────────────────────────────────

  if (rooms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12">
        <svg width="72" height="72" viewBox="0 0 72 72" className="mb-3">
          <polygon points={hexPoints(36, 36, 30)} fill="none" stroke="var(--border-primary)" strokeWidth="2" />
        </svg>
        <p className="text-sm text-text-muted">No rooms in the swarm yet.</p>
        <p className="text-xs text-text-muted mt-1">Create a room to see it here.</p>
      </div>
    )
  }

  // ─── Render ──────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2.5 border-b border-border-primary shrink-0">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" className="text-interactive shrink-0">
            <polygon points={hexPoints(8, 8, 7)} fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          <h2 className="text-base font-semibold text-text-primary">Swarm</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-text-muted">{rooms.length} room{rooms.length !== 1 ? 's' : ''}</span>
          <span className="text-xs text-text-muted">{(allWorkers ?? []).filter(w => w.roomId !== null).length} workers</span>
          <span className="text-xs text-text-muted">{Object.values(stationMap ?? {}).flat().length} stations</span>
          {totalReferred > 0 && (
            <span className="text-xs text-text-muted">{totalReferred} network</span>
          )}

          {showMoney && revenueMap && (
            <>
              {totalOnChainBalance > 0 && (
                <span className="text-xs text-interactive">{fmtMoney(totalOnChainBalance)} bal</span>
              )}
              <span className="text-xs text-status-success">{fmtMoney(totalIncome)} in</span>
              <span className="text-xs text-status-error">{fmtMoney(totalExpenses)} out</span>
            </>
          )}

          <button
            onClick={toggleMoney}
            className={`px-2 py-1 text-xs rounded-lg transition-colors ${
              showMoney
                ? 'bg-interactive text-text-invert hover:bg-interactive-hover'
                : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
            }`}
            title={showMoney ? 'Hide financials' : 'Show financials'}
          >$</button>

          <button
            onClick={() => {
              setInviteOpen(true)
              setShareOpen(false)
            }}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-surface-secondary text-text-secondary border border-border-primary hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
              <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            </svg>
            Invite
          </button>

          <div className="relative">
            <button
              onClick={() => {
                setShareOpen(!shareOpen)
                setInviteOpen(false)
              }}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
                <path d="M4 8h8M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Share
            </button>
            {shareOpen && (
              <div className="absolute right-0 top-full mt-1 bg-surface-primary border border-border-primary rounded-lg shadow-lg py-1 z-20 w-40">
                <button onClick={() => void handleShare('twitter')} className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-2">
                  <span className="w-4 text-center text-sm">{'\ud835\udd4f'}</span> Twitter / X
                </button>
                <button onClick={() => void handleShare('instagram')} className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0">
                    <rect x="2" y="2" width="12" height="12" rx="3"/><circle cx="8" cy="8" r="3"/><circle cx="12" cy="4" r="0.8" fill="currentColor"/>
                  </svg>
                  Instagram
                </button>
                <button onClick={() => void handleShare('tiktok')} className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0">
                    <path d="M10 2v8a3 3 0 1 1-2-2.8"/><path d="M10 2c1.5 0 3 1 3.5 2.5"/>
                  </svg>
                  TikTok
                </button>
                <div className="border-t border-border-primary mt-0.5 pt-0.5">
                  <button onClick={() => void handleShare('download')} className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface-hover flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0">
                      <path d="M8 2v9M5 8l3 3 3-3M3 13h10" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Save as PNG
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {shareStatus && (
        <div className="px-4 py-2 bg-surface-secondary border-b border-border-primary text-xs text-text-muted shrink-0">{shareStatus}</div>
      )}

      {inviteOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setInviteOpen(false)}
        >
          <div
            className="w-full max-w-[760px] bg-surface-primary border border-border-primary rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Invite Preview</h3>
                <p className="text-xs text-text-muted">Preview text + image before sharing</p>
              </div>
              <button
                onClick={() => setInviteOpen(false)}
                className="px-2 py-1 text-xs rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-hover"
              >
                Close
              </button>
            </div>

            <div className="grid gap-4 p-4 md:grid-cols-[1.4fr_1fr]">
              <div className="rounded-lg border border-border-primary bg-surface-secondary p-2">
                <img
                  src={INVITE_CARDS[inviteCardIndex].imagePath}
                  alt={`Invite preview: ${INVITE_CARDS[inviteCardIndex].previewText}`}
                  className="w-full h-auto rounded-md"
                />
              </div>

              <div className="flex flex-col gap-3">
                <div className="rounded-lg border border-border-primary bg-surface-secondary px-3 py-2">
                  <div className="text-[11px] tracking-[0.16em] uppercase text-text-muted mb-2">{INVITE_CARDS[inviteCardIndex].label}</div>
                  <p className="text-sm text-text-secondary leading-relaxed">{INVITE_CARDS[inviteCardIndex].previewText}</p>
                  <p className="text-xs text-interactive mt-2">{INVITE_URL}</p>
                </div>

                <button
                  onClick={handleRegenerateInvite}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border-primary bg-surface-secondary text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  Regenerate
                </button>

                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => void handleInviteShare('twitter')} className="px-3 py-2 text-sm rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors">Twitter</button>
                  <button onClick={() => void handleInviteShare('instagram')} className="px-3 py-2 text-sm rounded-lg bg-surface-secondary border border-border-primary text-text-secondary hover:bg-surface-hover transition-colors">IG</button>
                  <button onClick={() => void handleInviteShare('telegram')} className="px-3 py-2 text-sm rounded-lg bg-surface-secondary border border-border-primary text-text-secondary hover:bg-surface-hover transition-colors">TG</button>
                  <button onClick={() => void handleInviteShare('facebook')} className="px-3 py-2 text-sm rounded-lg bg-surface-secondary border border-border-primary text-text-secondary hover:bg-surface-hover transition-colors">FB</button>
                  <button onClick={() => void handleInviteShare('sms')} className="px-3 py-2 text-sm rounded-lg bg-surface-secondary border border-border-primary text-text-secondary hover:bg-surface-hover transition-colors">SMS</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Honeycomb */}
      <div className="flex-1 overflow-auto relative" onMouseMove={handleMouseMove}>
        <svg
          ref={svgRef}
          width={svgWidth}
          height={svgHeight}
          className="block"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
          {positions.map(({ room, cx, cy }) => {
            const running = room.status === 'active' && queenRunning[room.id]
            const { fill, stroke } = roomColors(room, running)
            const workers = workersPerRoom[room.id] ?? []
            const stations = (stationMap ?? {})[room.id] ?? []
            const revenue = (revenueMap ?? {})[room.id]
            const isHovered = hoveredRoomId === room.id
            const totalSats = workers.length + stations.length
            const satPositions = showSatellites ? satellitePositions(cx, cy, totalSats) : []

            // Queen model
            const queenWorker = workers.find(w => w.id === room.queenWorkerId)
            const queenModel = queenWorker?.model || room.workerModel

            // Goal text wrapped into lines
            const goalText = room.goal || 'No objective set'
            const goalLines = wrapText(goalText, 28).slice(0, 6) // max 6 lines

            // Life indicators
            const busyWorkers = workers.filter(w => w.agentState === 'thinking' || w.agentState === 'acting').length
            const activeStations = stations.filter(s => s.status === 'active').length

            // Layout: goal lines at top, then gap, then life bar, then model, then money
            const lineH = 16
            const goalBlockH = goalLines.length * lineH
            const lifeLineY = 1 // relative offset after goal block
            const modelLineY = lifeLineY + lineH + 1
            const moneyLineY = modelLineY + lineH

            // Total content height — always reserve money line when toggle is on
            const contentH = goalBlockH + lineH + lineH + 1 + (showMoney ? lineH : 0)
            const startY = cy - contentH / 2

            return (
              <g
                key={room.id}
                className="cursor-pointer"
                onClick={() => onNavigateToRoom(room.id)}
                onMouseEnter={() => setHoveredRoomId(room.id)}
                onMouseLeave={() => setHoveredRoomId(null)}
              >
                {/* Room hexagon */}
                <polygon
                  points={hexPoints(cx, cy, ROOM_R)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={isHovered ? 3 : 1.5}
                  className={running ? 'hex-pulse' : ''}
                  style={{ transition: 'stroke-width 150ms' }}
                />

                {/* Goal text (multi-line) */}
                {goalLines.map((line, li) => (
                  <text
                    key={li}
                    x={cx}
                    y={startY + li * lineH + 8}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={li === 0 ? '14' : '13'}
                    fontWeight={li === 0 ? '600' : '400'}
                    fill={room.goal ? 'var(--text-primary)' : 'var(--text-muted)'}
                    style={{ pointerEvents: 'none' }}
                  >
                    {line}
                  </text>
                ))}

                {/* Life bar: workers + stations status */}
                <text
                  x={cx}
                  y={startY + goalBlockH + lifeLineY + 8}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="12"
                  fill="var(--text-secondary)"
                  style={{ pointerEvents: 'none' }}
                >
                  {workers.length}w{busyWorkers > 0 ? ` (${busyWorkers} active)` : ''}
                  {stations.length > 0 ? ` \u00b7 ${stations.length}s${activeStations > 0 ? ` (${activeStations} up)` : ''}` : ''}
                </text>

                {/* Queen model */}
                <text
                  x={cx}
                  y={startY + goalBlockH + modelLineY + 8}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="13"
                  fontWeight="500"
                  fill="var(--interactive)"
                  style={{ pointerEvents: 'none' }}
                >
                  {fmtModel(queenModel)}
                </text>

                {/* Money line — always shown when $ toggle is on */}
                {showMoney && (
                  <text
                    x={cx}
                    y={startY + goalBlockH + moneyLineY + 8}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="13"
                    fontWeight="500"
                    fill="var(--text-muted)"
                    style={{ pointerEvents: 'none' }}
                    data-money="true"
                  >
                    <tspan fill="var(--status-success)">{fmtMoney(revenue?.totalIncome ?? 0)} in</tspan>
                    <tspan fill="var(--text-muted)">{' / '}</tspan>
                    <tspan fill="var(--status-error)">{fmtMoney(revenue?.totalExpenses ?? 0)} out</tspan>
                    {(revenue?.stationCosts ?? 0) > 0 && (
                      <tspan fill="var(--text-muted)">{' \u00b7 '}</tspan>
                    )}
                    {(revenue?.stationCosts ?? 0) > 0 && (
                      <tspan fill="var(--status-warning)">{fmtMoney(revenue!.stationCosts)} srv</tspan>
                    )}
                  </text>
                )}

                {/* Queen running indicator */}
                {running && (
                  <circle cx={cx + ROOM_R - 20} cy={cy - ROOM_R * 0.42} r={6} fill="var(--status-success)" className="hex-pulse" />
                )}

                {/* Status dot (paused) */}
                {room.status === 'paused' && (
                  <circle cx={cx + ROOM_R - 20} cy={cy - ROOM_R * 0.42} r={6} fill="var(--status-warning)" />
                )}

                {/* Worker satellites */}
                {showSatellites && workers.map((w, wi) => {
                  const pos = satPositions[wi]
                  if (!pos) return null
                  return (
                    <polygon
                      key={`w-${w.id}`}
                      points={hexPoints(pos[0], pos[1], SAT_R)}
                      fill={workerColor(w.agentState)}
                      stroke="var(--border-primary)"
                      strokeWidth={0.8}
                      style={{ transition: 'fill 300ms' }}
                    />
                  )
                })}

                {/* Station satellites */}
                {showSatellites && stations.map((s, si) => {
                  const pos = satPositions[workers.length + si]
                  if (!pos) return null
                  return (
                    <g key={`s-${s.id}`}>
                      <polygon
                        points={hexPoints(pos[0], pos[1], SAT_R)}
                        fill={stationColor(s.status)}
                        stroke="var(--border-primary)"
                        strokeWidth={0.8}
                      />
                      <rect
                        x={pos[0] - 5}
                        y={pos[1] - 3.5}
                        width={10}
                        height={6}
                        rx={1.5}
                        fill="none"
                        stroke="var(--text-muted)"
                        strokeWidth={0.8}
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}

          {/* ─── Referred room connector lines ─── */}
          {referredPositions.map((rp) => {
            const parent = roomPositionMap.get(rp.parentRoomId)
            if (!parent) return null
            return (
              <line
                key={`conn-${rp.parentRoomId}-${rp.ref.roomId}`}
                x1={parent.cx} y1={parent.cy}
                x2={rp.cx} y2={rp.cy}
                stroke="var(--border-primary)"
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.4}
              />
            )
          })}

          {/* ─── Referred room hexes ─── */}
          {referredPositions.map((rp) => {
            const isPublic = rp.ref.visibility === 'public'
            const refName = isPublic ? (rp.ref.name || rp.ref.roomId.slice(0, 12)) : 'Private'
            const nameLines = wrapText(refName, 14).slice(0, 2)
            const wCount = rp.ref.workerCount ?? 0
            const sCount = rp.ref.stations?.length ?? 0
            return (
              <g key={`ref-${rp.parentRoomId}-${rp.ref.roomId}`}>
                <polygon
                  points={hexPoints(rp.cx, rp.cy, REFERRED_R)}
                  fill={isPublic ? 'var(--surface-tertiary)' : 'var(--surface-secondary)'}
                  fillOpacity={isPublic ? 0.6 : 0.3}
                  stroke="var(--border-secondary)"
                  strokeWidth={1}
                  strokeDasharray="6 3"
                />
                {nameLines.map((line, li) => (
                  <text
                    key={li}
                    x={rp.cx} y={rp.cy - 10 + li * 14}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={li === 0 ? '12' : '11'}
                    fontWeight={li === 0 ? '600' : '400'}
                    fill={isPublic ? 'var(--text-secondary)' : 'var(--text-muted)'}
                    style={{ pointerEvents: 'none' }}
                  >
                    {line}
                  </text>
                ))}
                {isPublic && (wCount > 0 || sCount > 0) && (
                  <text
                    x={rp.cx} y={rp.cy + nameLines.length * 7 + 6}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize="10" fill="var(--text-muted)"
                    style={{ pointerEvents: 'none' }}
                  >
                    {wCount > 0 ? `${wCount}w` : ''}{wCount > 0 && sCount > 0 ? ' · ' : ''}{sCount > 0 ? `${sCount}s` : ''}
                  </text>
                )}
                {rp.ref.online && (
                  <circle cx={rp.cx + REFERRED_R - 12} cy={rp.cy - REFERRED_R * 0.42} r={4} fill="var(--status-success)" />
                )}
              </g>
            )
          })}

          {/* ─── Ripple effects ─── */}
          {swarmRipples.map(r => {
            const pos = roomPositionMap.get(r.roomId)
            if (!pos) return null
            return (
              <circle
                key={r.id}
                cx={pos.cx}
                cy={pos.cy}
                r={80}
                fill="none"
                stroke={r.color}
                className="hex-ripple"
              />
            )
          })}

          {/* ─── Event bubbles ─── */}
          {swarmEvents.map(event => {
            const pos = roomPositionMap.get(event.roomId)
            if (!pos) return null
            const siblings = eventsByRoom.get(event.roomId) ?? []
            const stackIdx = siblings.indexOf(event)
            const BUBBLE_W = 130
            const BUBBLE_H = 24
            const STACK_GAP = 30
            const bx = pos.cx - BUBBLE_W / 2
            const by = pos.cy - ROOM_R - 28 - stackIdx * STACK_GAP
            return (
              <g key={event.id} className="event-bubble">
                <rect
                  x={bx} y={by}
                  width={BUBBLE_W} height={BUBBLE_H}
                  rx={BUBBLE_H / 2}
                  fill={eventBgColor(event.kind)}
                  fillOpacity={0.7}
                />
                <foreignObject x={bx + 6} y={by + (BUBBLE_H - 14) / 2} width={14} height={14}>
                  {eventIcon(event.kind)}
                </foreignObject>
                <text
                  x={bx + 24}
                  y={by + BUBBLE_H / 2 + 1}
                  dominantBaseline="middle"
                  fontSize="11"
                  fontWeight="400"
                  fill="var(--text-secondary)"
                  style={{ pointerEvents: 'none' }}
                >
                  {event.label}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Legend */}
        <div className="px-6 pb-6 pt-2 space-y-3 text-xs text-text-muted max-w-xl mx-auto">
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-status-success" /> Active (queen running)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-status-warning" /> Paused</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-surface-tertiary" /> Idle / stopped</span>
          </div>
          <p>Each large hexagon is a <strong className="text-text-secondary">room</strong> — an autonomous agent collective with a queen, workers, and optional stations. Small hexagons on the border are <strong className="text-text-secondary">workers</strong> (agents) and <strong className="text-text-secondary">stations</strong> (cloud compute). Smaller hexagons with dashed borders are rooms in your <strong className="text-text-secondary">network</strong> — created via your invite links. Click a room to open it.</p>
          <p>Toggle the <strong className="text-text-secondary">$</strong> button to show or hide financial info. Use <strong className="text-text-secondary">Share</strong> to export your swarm as an image.</p>
        </div>

        {/* Tooltip — shows name + details on hover */}
        {hoveredRoom && (
          <div
            className="absolute z-10 bg-surface-primary border border-border-primary rounded-lg shadow-lg p-3 pointer-events-none max-w-72"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
          >
            <div className="text-sm font-semibold text-text-primary">{hoveredRoom.name}</div>
            {hoveredRoom.goal && (
              <div className="text-xs text-text-muted mt-0.5">{hoveredRoom.goal}</div>
            )}
            <div className="text-sm text-text-secondary mt-2 space-y-0.5">
              {(workersPerRoom[hoveredRoom.id] ?? []).length > 0 && (
                <div>
                  <span className="text-text-muted">Workers: </span>
                  {(workersPerRoom[hoveredRoom.id] ?? []).map(w => w.name).join(', ')}
                </div>
              )}
              {((stationMap ?? {})[hoveredRoom.id] ?? []).length > 0 && (
                <div>
                  <span className="text-text-muted">Stations: </span>
                  {((stationMap ?? {})[hoveredRoom.id] ?? []).map(s => `${s.name} (${s.tier})`).join(', ')}
                </div>
              )}
              {showMoney && (revenueMap ?? {})[hoveredRoom.id] && (() => {
                const rev = (revenueMap ?? {})[hoveredRoom.id]!
                const bal = (balanceMap ?? {})[hoveredRoom.id]
                return (
                  <div className="pt-1 border-t border-border-primary mt-1">
                    {bal && bal.totalBalance > 0 && (
                      <div>
                        <span className="text-interactive font-medium">{fmtMoney(bal.totalBalance)} balance</span>
                      </div>
                    )}
                    <span className="text-status-success">{fmtMoney(rev.totalIncome)} income</span>
                    <span className="text-text-muted mx-1">/</span>
                    <span className="text-status-error">{fmtMoney(rev.totalExpenses)} expenses</span>
                    <span className="text-text-muted mx-1">/</span>
                    <span className={rev.netProfit >= 0 ? 'text-status-success font-medium' : 'text-status-error font-medium'}>
                      {rev.netProfit >= 0 ? '+' : ''}{fmtMoney(rev.netProfit)} net
                    </span>
                  </div>
                )
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

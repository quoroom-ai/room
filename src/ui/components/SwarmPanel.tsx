import { useState, useMemo, useCallback, useRef } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import type { Room, Worker, Station, RevenueSummary } from '@shared/types'

interface SwarmPanelProps {
  rooms: Room[]
  queenRunning: Record<number, boolean>
  onNavigateToRoom: (roomId: number) => void
}

// ─── Hexagon math (flat-top orientation) ───────────────────

const ROOM_R = 140
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

// ─── Status → color maps ───────────────────────────────────

function roomColors(room: Room, running: boolean): { fill: string; stroke: string } {
  if (running) return { fill: '#dcfce7', stroke: '#22c55e' }
  if (room.status === 'paused') return { fill: '#fef3c7', stroke: '#f59e0b' }
  if (room.status === 'stopped') return { fill: '#f3f4f6', stroke: '#d1d5db' }
  return { fill: '#f3f4f6', stroke: '#9ca3af' }
}

function workerColor(state: string): string {
  switch (state) {
    case 'thinking': return '#bfdbfe'
    case 'acting': return '#bbf7d0'
    case 'voting': return '#fde68a'
    case 'rate_limited': return '#fed7aa'
    case 'blocked': return '#fecaca'
    default: return '#e5e7eb'
  }
}

function stationColor(status: string): string {
  switch (status) {
    case 'active': return '#bbf7d0'
    case 'pending': return '#fde68a'
    case 'error': return '#fecaca'
    default: return '#e5e7eb'
  }
}

// ─── Share as image ────────────────────────────────────────

async function svgToBlob(svgEl: SVGSVGElement, hideMoney: boolean, scale = 2): Promise<Blob> {
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  if (hideMoney) {
    clone.querySelectorAll('[data-money]').forEach(el => el.remove())
  }
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', '100%')
  bg.setAttribute('height', '100%')
  bg.setAttribute('fill', '#ffffff')
  clone.insertBefore(bg, clone.firstChild)
  const wm = document.createElementNS('http://www.w3.org/2000/svg', 'text')
  wm.setAttribute('x', '20')
  wm.setAttribute('y', String(Number(clone.getAttribute('height') || '400') - 16))
  wm.setAttribute('fill', '#d1d5db')
  wm.setAttribute('font-size', '14')
  wm.setAttribute('font-family', 'system-ui, sans-serif')
  wm.textContent = 'quoroom.ai'
  clone.appendChild(wm)

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

// ─── Component ─────────────────────────────────────────────

export function SwarmPanel({ rooms, queenRunning, onNavigateToRoom }: SwarmPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const [hoveredRoomId, setHoveredRoomId] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [shareOpen, setShareOpen] = useState(false)
  const [shareStatus, setShareStatus] = useState<string | null>(null)
  const [showMoney, setShowMoney] = useState<boolean>(() => localStorage.getItem('quoroom_swarm_money') !== 'false')
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

  const svgWidth = useMemo(() => {
    if (positions.length === 0) return 300
    return Math.max(...positions.map(p => p.cx)) + margin
  }, [positions, margin])

  const svgHeight = useMemo(() => {
    if (positions.length === 0) return 200
    return Math.max(...positions.map(p => p.cy)) + margin + 30
  }, [positions, margin])

  const hoveredRoom = rooms.find(r => r.id === hoveredRoomId) ?? null

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltipPos({ x: e.clientX - rect.left + 14, y: e.clientY - rect.top - 10 })
  }, [])

  const toggleMoney = useCallback(() => {
    setShowMoney(prev => { const next = !prev; localStorage.setItem('quoroom_swarm_money', String(next)); return next })
  }, [])

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
          <polygon points={hexPoints(36, 36, 30)} fill="none" stroke="#e5e7eb" strokeWidth="2" />
        </svg>
        <p className="text-sm text-gray-400">No rooms in the swarm yet.</p>
        <p className="text-xs text-gray-300 mt-1">Create a room to see it here.</p>
      </div>
    )
  }

  // ─── Render ──────────────────────────────────────────────

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" className="text-amber-500 shrink-0">
            <polygon points={hexPoints(8, 8, 7)} fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          <span className="text-xs font-semibold text-gray-700">Swarm</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-gray-400">{rooms.length} room{rooms.length !== 1 ? 's' : ''}</span>
          <span className="text-[10px] text-gray-400">{(allWorkers ?? []).filter(w => w.roomId !== null).length} workers</span>
          <span className="text-[10px] text-gray-400">{Object.values(stationMap ?? {}).flat().length} stations</span>

          {showMoney && revenueMap && (
            <>
              <span className="text-[10px] text-green-500">{fmtMoney(totalIncome)} in</span>
              <span className="text-[10px] text-red-400">{fmtMoney(totalExpenses)} out</span>
            </>
          )}

          <button
            onClick={toggleMoney}
            className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
              showMoney ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
            }`}
            title={showMoney ? 'Hide financials' : 'Show financials'}
          >$</button>

          <div className="relative">
            <button
              onClick={() => setShareOpen(!shareOpen)}
              className="px-2 py-1 text-[10px] rounded border border-gray-200 text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
                <path d="M4 8h8M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Share
            </button>
            {shareOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-20 w-40">
                <button onClick={() => void handleShare('twitter')} className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-2">
                  <span className="w-4 text-center text-sm">{'\ud835\udd4f'}</span> Twitter / X
                </button>
                <button onClick={() => void handleShare('instagram')} className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0">
                    <rect x="2" y="2" width="12" height="12" rx="3"/><circle cx="8" cy="8" r="3"/><circle cx="12" cy="4" r="0.8" fill="currentColor"/>
                  </svg>
                  Instagram
                </button>
                <button onClick={() => void handleShare('tiktok')} className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="shrink-0">
                    <path d="M10 2v8a3 3 0 1 1-2-2.8"/><path d="M10 2c1.5 0 3 1 3.5 2.5"/>
                  </svg>
                  TikTok
                </button>
                <div className="border-t border-gray-100 mt-0.5 pt-0.5">
                  <button onClick={() => void handleShare('download')} className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-2">
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
        <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100 text-[10px] text-gray-500 shrink-0">{shareStatus}</div>
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

            // Goal text wrapped into lines
            const goalText = room.goal || 'No objective set'
            const goalLines = wrapText(goalText, 22).slice(0, 4) // max 4 lines

            // Life indicators
            const busyWorkers = workers.filter(w => w.agentState === 'thinking' || w.agentState === 'acting').length
            const activeStations = stations.filter(s => s.status === 'active').length

            // Layout: goal lines at top, then gap, then life bar, then money
            const lineH = 16
            const goalBlockH = goalLines.length * lineH
            const lifeLineY = 1 // relative offset after goal block
            const moneyLineY = lifeLineY + lineH + 2

            // Total content height — always reserve money line when toggle is on
            const contentH = goalBlockH + lineH + (showMoney ? lineH + 2 : 0)
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
                    fill={room.goal ? '#374151' : '#b0b0b0'}
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
                  fill="#6b7280"
                  style={{ pointerEvents: 'none' }}
                >
                  {workers.length}w{busyWorkers > 0 ? ` (${busyWorkers} active)` : ''}
                  {stations.length > 0 ? ` \u00b7 ${stations.length}s${activeStations > 0 ? ` (${activeStations} up)` : ''}` : ''}
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
                    fill="#9ca3af"
                    style={{ pointerEvents: 'none' }}
                    data-money="true"
                  >
                    <tspan fill="#16a34a">{fmtMoney(revenue?.totalIncome ?? 0)} in</tspan>
                    <tspan fill="#9ca3af">{' / '}</tspan>
                    <tspan fill="#dc2626">{fmtMoney(revenue?.totalExpenses ?? 0)} out</tspan>
                    {(revenue?.stationCosts ?? 0) > 0 && (
                      <tspan fill="#9ca3af">{' \u00b7 '}</tspan>
                    )}
                    {(revenue?.stationCosts ?? 0) > 0 && (
                      <tspan fill="#f59e0b">{fmtMoney(revenue!.stationCosts)} srv</tspan>
                    )}
                  </text>
                )}

                {/* Queen running indicator */}
                {running && (
                  <circle cx={cx + ROOM_R - 20} cy={cy - ROOM_R * 0.42} r={6} fill="#22c55e" className="hex-pulse" />
                )}

                {/* Status dot (paused) */}
                {room.status === 'paused' && (
                  <circle cx={cx + ROOM_R - 20} cy={cy - ROOM_R * 0.42} r={6} fill="#f59e0b" />
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
                      stroke="#d1d5db"
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
                        stroke="#d1d5db"
                        strokeWidth={0.8}
                      />
                      <rect
                        x={pos[0] - 5}
                        y={pos[1] - 3.5}
                        width={10}
                        height={6}
                        rx={1.5}
                        fill="none"
                        stroke="#9ca3af"
                        strokeWidth={0.8}
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>

        {/* Tooltip — shows name + details on hover */}
        {hoveredRoom && (
          <div
            className="absolute z-10 bg-white border border-gray-200 rounded-lg shadow-sm p-3 pointer-events-none max-w-72"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
          >
            <div className="text-sm font-semibold text-gray-700">{hoveredRoom.name}</div>
            {hoveredRoom.goal && (
              <div className="text-xs text-gray-400 mt-0.5">{hoveredRoom.goal}</div>
            )}
            <div className="text-xs text-gray-500 mt-2 space-y-0.5">
              {(workersPerRoom[hoveredRoom.id] ?? []).length > 0 && (
                <div>
                  <span className="text-gray-400">Workers: </span>
                  {(workersPerRoom[hoveredRoom.id] ?? []).map(w => w.name).join(', ')}
                </div>
              )}
              {((stationMap ?? {})[hoveredRoom.id] ?? []).length > 0 && (
                <div>
                  <span className="text-gray-400">Stations: </span>
                  {((stationMap ?? {})[hoveredRoom.id] ?? []).map(s => `${s.name} (${s.tier})`).join(', ')}
                </div>
              )}
              {showMoney && (revenueMap ?? {})[hoveredRoom.id] && (() => {
                const rev = (revenueMap ?? {})[hoveredRoom.id]!
                return (
                  <div className="pt-1 border-t border-gray-100 mt-1">
                    <span className="text-green-600">{fmtMoney(rev.totalIncome)} income</span>
                    <span className="text-gray-300 mx-1">/</span>
                    <span className="text-red-500">{fmtMoney(rev.totalExpenses)} expenses</span>
                    <span className="text-gray-300 mx-1">/</span>
                    <span className={rev.netProfit >= 0 ? 'text-green-600 font-medium' : 'text-red-500 font-medium'}>
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

export type Tab = 'swarm' | 'status' | 'chat' | 'memory' | 'workers' | 'tasks' | 'watches' | 'results' | 'goals' | 'votes' | 'messages' | 'skills' | 'credentials' | 'transactions' | 'stations' | 'room-settings' | 'settings' | 'help'

export const mainTabs: { id: Tab; label: string; advanced?: boolean }[] = [
  { id: 'status', label: 'Overview' },
  { id: 'chat', label: 'Queen' },
  { id: 'goals', label: 'Goals', advanced: true },
  { id: 'votes', label: 'Votes' },
  { id: 'messages', label: 'Messages' },
  { id: 'workers', label: 'Workers', advanced: true },
  { id: 'tasks', label: 'Tasks', advanced: true },
  { id: 'skills', label: 'Skills', advanced: true },
  { id: 'credentials', label: 'Credentials', advanced: true },
  { id: 'transactions', label: 'Transactions', advanced: true },
  { id: 'stations', label: 'Stations' },
  { id: 'memory', label: 'Memory', advanced: true },
  { id: 'watches', label: 'Watches', advanced: true },
  { id: 'results', label: 'Results', advanced: true },
  { id: 'room-settings', label: 'Settings' },
]

const bottomTabs: { id: Tab; label: string }[] = [
  { id: 'settings', label: 'Global Settings' },
  { id: 'help', label: 'Help' },
]

const S = 14 // icon size
const sw = '1.5' // stroke width

/** Minimal SVG icons for each tab — all 14×14 with stroke-based design */
export const tabIcons: Record<Tab, React.JSX.Element> = {
  status: ( // grid/dashboard
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  chat: ( // message bubble
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h10a1 1 0 011 1v6a1 1 0 01-1 1H6l-3 3V4a1 1 0 011-1z" />
    </svg>
  ),
  goals: ( // target
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r="0.5" fill="currentColor" />
    </svg>
  ),
  votes: ( // ballot/check
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8l3 3 5-6" /><rect x="2" y="2" width="12" height="12" rx="2" />
    </svg>
  ),
  messages: ( // envelope
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 4l6 5 6-5" />
    </svg>
  ),
  workers: ( // people
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2" /><path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" /><circle cx="11" cy="5" r="1.5" /><path d="M11 9c1.7 0 3 1.3 3 3" />
    </svg>
  ),
  tasks: ( // checklist
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4l1.5 1.5L7 3" /><path d="M9 4h5" /><path d="M3 8l1.5 1.5L7 7" /><path d="M9 8h5" /><path d="M3 12l1.5 1.5L7 11" /><path d="M9 12h5" />
    </svg>
  ),
  skills: ( // lightning bolt
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1L4 9h4l-1 6 5-8H8l1-6z" />
    </svg>
  ),
  credentials: ( // key
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5.5" cy="8" r="3" /><path d="M8 8h6" /><path d="M12 6v4" /><path d="M14 6v4" />
    </svg>
  ),
  transactions: ( // arrows up-down
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3v10M5 3L2 6M5 3l3 3" /><path d="M11 13V3M11 13l-3-3M11 13l3-3" />
    </svg>
  ),
  stations: ( // server
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="4" rx="1" /><rect x="2" y="10" width="12" height="4" rx="1" /><path d="M8 6v4" /><circle cx="5" cy="4" r="0.5" fill="currentColor" /><circle cx="5" cy="12" r="0.5" fill="currentColor" />
    </svg>
  ),
  memory: ( // brain/database
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4" /><path d="M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8" />
    </svg>
  ),
  watches: ( // eye
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" />
    </svg>
  ),
  results: ( // terminal
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 6l2 2-2 2" /><path d="M9 10h3" />
    </svg>
  ),
  'room-settings': ( // gear
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  ),
  settings: ( // sliders
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h3M9 4h5" /><circle cx="7" cy="4" r="2" /><path d="M2 12h5M11 12h3" /><circle cx="9" cy="12" r="2" /><path d="M2 8h7M13 8h1" /><circle cx="11" cy="8" r="2" />
    </svg>
  ),
  help: ( // question circle
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" /><path d="M6 6.5a2 2 0 013.5 1.5c0 1-1.5 1.5-1.5 1.5" /><circle cx="8" cy="12" r="0.5" fill="currentColor" />
    </svg>
  ),
  swarm: ( // hexagon/hive
    <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1l5 3v6l-5 3-5-3V4z" /><path d="M8 5v6" /><path d="M3 4l5 3 5-3" />
    </svg>
  ),
}

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
  onInvite?: () => void
}

export function TabBar({ active, onChange, onInvite }: TabBarProps): React.JSX.Element {
  const btnClass = (id: Tab) =>
    `flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors text-left rounded-lg ${
      active === id
        ? 'bg-surface-tertiary text-text-primary'
        : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
    }`

  return (
    <div className="flex flex-col gap-0.5 border-t border-border-primary pt-2 mt-2">
      {onInvite && (
        <button
          onClick={onInvite}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-[#1a2038] border border-[#313a5a] text-[#c6cce0] hover:bg-[#20284a] transition-colors text-left"
        >
          <svg width={S} height={S} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v12M2 8h12" />
          </svg>
          Invite
        </button>
      )}
      {bottomTabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} className={btnClass(tab.id)}>
          {tabIcons[tab.id]}
          {tab.label}
        </button>
      ))}
    </div>
  )
}

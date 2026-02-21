export type Tab = 'swarm' | 'status' | 'memory' | 'workers' | 'tasks' | 'watches' | 'results' | 'goals' | 'votes' | 'messages' | 'skills' | 'credentials' | 'transactions' | 'stations' | 'room-settings' | 'settings' | 'help'

export const mainTabs: { id: Tab; label: string; advanced?: boolean }[] = [
  { id: 'status', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'votes', label: 'Votes' },
  { id: 'messages', label: 'Messages', advanced: true },
  { id: 'workers', label: 'Workers', advanced: true },
  { id: 'tasks', label: 'Tasks', advanced: true },
  { id: 'skills', label: 'Skills', advanced: true },
  { id: 'credentials', label: 'Credentials' },
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

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

export function TabBar({ active, onChange }: TabBarProps): React.JSX.Element {
  const btnClass = (id: Tab) =>
    `px-3 py-2 text-sm font-medium transition-colors text-left rounded-lg ${
      active === id
        ? 'bg-surface-tertiary text-text-primary'
        : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
    }`

  return (
    <div className="flex flex-col gap-0.5 border-t border-border-primary pt-2 mt-2">
      {bottomTabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} className={btnClass(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  )
}

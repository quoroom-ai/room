export type Tab = 'status' | 'memory' | 'workers' | 'tasks' | 'watches' | 'results' | 'goals' | 'votes' | 'messages' | 'skills' | 'credentials' | 'transactions' | 'stations' | 'settings' | 'help'

export const mainTabs: { id: Tab; label: string; advanced?: boolean }[] = [
  { id: 'status', label: 'Activity' },
  { id: 'goals', label: 'Goals' },
  { id: 'votes', label: 'Votes' },
  { id: 'messages', label: 'Messages' },
  { id: 'workers', label: 'Workers' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'skills', label: 'Skills' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'stations', label: 'Stations' },
  { id: 'memory', label: 'Memory', advanced: true },
  { id: 'watches', label: 'Watches', advanced: true },
  { id: 'results', label: 'Results', advanced: true },
]

const bottomTabs: { id: Tab; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
]

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

export function TabBar({ active, onChange }: TabBarProps): React.JSX.Element {
  const btnClass = (id: Tab) =>
    `px-3 py-1.5 text-xs font-medium transition-colors text-left rounded ${
      active === id
        ? 'bg-gray-200 text-gray-900'
        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
    }`

  return (
    <div className="flex flex-col gap-0.5 border-t border-gray-200 pt-1.5 mt-1.5">
      {bottomTabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} className={btnClass(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  )
}

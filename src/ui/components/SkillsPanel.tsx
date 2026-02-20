import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { Skill } from '@shared/types'

interface SkillsPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function SkillsPanel({ roomId, autonomyMode }: SkillsPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'

  const { data: skills, refresh } = usePolling<Skill[]>(
    () => api.skills.list(roomId ?? undefined),
    5000
  )

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const isWide = containerWidth > 500

  // Create form state (always declared — React hooks rule)
  const [createName, setCreateName] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createContexts, setCreateContexts] = useState('')
  const [createAutoActivate, setCreateAutoActivate] = useState(false)

  async function handleCreate(): Promise<void> {
    if (!createName.trim() || !createContent.trim()) return
    const contexts = createContexts.trim()
      ? createContexts.split(',').map(s => s.trim()).filter(Boolean)
      : null
    await api.skills.create({
      name: createName.trim(),
      content: createContent.trim(),
      activationContext: contexts,
      autoActivate: createAutoActivate,
      roomId: roomId ?? undefined,
    })
    setCreateName('')
    setCreateContent('')
    setCreateContexts('')
    setCreateAutoActivate(false)
    setShowCreate(false)
    refresh()
  }

  async function handleToggleAutoActivate(skill: Skill): Promise<void> {
    await api.skills.update(skill.id, { autoActivate: !skill.autoActivate })
    refresh()
  }

  async function handleDelete(skillId: number): Promise<void> {
    if (confirmDeleteId !== skillId) {
      setConfirmDeleteId(skillId)
      return
    }
    await api.skills.delete(skillId)
    if (expandedId === skillId) setExpandedId(null)
    setConfirmDeleteId(null)
    refresh()
  }

  return (
    <div className="flex flex-col h-full" ref={containerRef}>
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {skills ? `${skills.length} skill(s)` : 'Loading...'}
          </span>
        </div>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Skill'}
          </button>
        )}
      </div>

      {semi && showCreate && (
        <div className="p-3 border-b-2 border-blue-300 bg-blue-50/50 space-y-2">
          <input
            placeholder="Skill name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
          />
          <textarea
            placeholder="Skill content (instructions, code, etc.)"
            value={createContent}
            onChange={(e) => setCreateContent(e.target.value)}
            rows={4}
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white resize-y font-mono"
          />
          <input
            placeholder="Activation contexts (comma-separated, optional)"
            value={createContexts}
            onChange={(e) => setCreateContexts(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
          />
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={createAutoActivate}
                onChange={(e) => setCreateAutoActivate(e.target.checked)}
                className="rounded border-gray-300"
              />
              Auto-activate
            </label>
            <button
              onClick={handleCreate}
              disabled={!createName.trim() || !createContent.trim()}
              className="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {(skills ?? []).length === 0 && skills ? (
          <div className="p-4 text-xs text-gray-400">
            {semi ? 'No skills yet. Create one to get started.' : 'No skills yet. Skills are created by agents.'}
          </div>
        ) : isWide ? (
          <div className="grid grid-cols-2 gap-2 p-2">
            {(skills ?? []).map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                expanded={expandedId === skill.id}
                semi={semi}
                confirmDelete={confirmDeleteId === skill.id}
                onToggle={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
                onToggleAutoActivate={() => handleToggleAutoActivate(skill)}
                onDelete={() => handleDelete(skill.id)}
                onBlurDelete={() => setConfirmDeleteId(null)}
              />
            ))}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {(skills ?? []).map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                expanded={expandedId === skill.id}
                semi={semi}
                confirmDelete={confirmDeleteId === skill.id}
                onToggle={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
                onToggleAutoActivate={() => handleToggleAutoActivate(skill)}
                onDelete={() => handleDelete(skill.id)}
                onBlurDelete={() => setConfirmDeleteId(null)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface SkillCardProps {
  skill: Skill
  expanded: boolean
  semi: boolean
  confirmDelete: boolean
  onToggle: () => void
  onToggleAutoActivate: () => void
  onDelete: () => void
  onBlurDelete: () => void
}

function SkillCard({ skill, expanded, semi, confirmDelete, onToggle, onToggleAutoActivate, onDelete, onBlurDelete }: SkillCardProps): React.JSX.Element {
  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-gray-800">{skill.name}</span>
            {skill.agentCreated && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-600">agent</span>
            )}
            {skill.autoActivate && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-600">auto</span>
            )}
            <span className="text-[10px] text-gray-300">v{skill.version}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-gray-400 truncate max-w-[200px]">
              {skill.content.slice(0, 80)}{skill.content.length > 80 ? '...' : ''}
            </span>
          </div>
          {skill.activationContext && skill.activationContext.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {skill.activationContext.map((ctx, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-500 border border-blue-100">
                  {ctx}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="text-xs text-gray-300">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 bg-gray-50 space-y-2">
          <pre className="text-[11px] text-gray-600 bg-white border border-gray-200 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
            {skill.content}
          </pre>
          <div className="flex items-center gap-2">
            {semi ? (
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skill.autoActivate}
                  onChange={onToggleAutoActivate}
                  className="rounded border-gray-300"
                />
                Auto-activate
              </label>
            ) : (
              <span className="text-[10px] text-gray-400">
                {skill.autoActivate ? 'Auto-activate enabled' : 'Manual activation'}
              </span>
            )}
            <div className="flex-1" />
            <span className="text-[10px] text-gray-400">{formatRelativeTime(skill.updatedAt)}</span>
            {semi && (
              <button
                onClick={onDelete}
                onBlur={onBlurDelete}
                className="text-[10px] px-2 py-0.5 rounded border border-red-200 text-red-400 hover:text-red-600"
              >
                {confirmDelete ? 'Confirm?' : 'Delete'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

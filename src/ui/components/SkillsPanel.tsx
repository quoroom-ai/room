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
      <div className="px-4 py-2 border-b border-border-primary flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">
            {skills ? `${skills.length} skill(s)` : 'Loading...'}
          </span>
        </div>
        {semi && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-sm text-interactive hover:text-interactive-hover font-medium"
          >
            {showCreate ? 'Cancel' : '+ New Skill'}
          </button>
        )}
      </div>

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <input
            placeholder="Skill name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
          />
          <textarea
            placeholder="Skill content (instructions, code, etc.)"
            value={createContent}
            onChange={(e) => setCreateContent(e.target.value)}
            rows={4}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted resize-y font-mono"
          />
          <input
            placeholder="Activation contexts (comma-separated, optional)"
            value={createContexts}
            onChange={(e) => setCreateContexts(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
          />
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={createAutoActivate}
                onChange={(e) => setCreateAutoActivate(e.target.checked)}
                className="rounded-lg border-border-primary"
              />
              Auto-activate
            </label>
            <button
              onClick={handleCreate}
              disabled={!createName.trim() || !createContent.trim()}
              className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {(skills ?? []).length === 0 && skills ? (
          <div className="p-4 text-sm text-text-muted">
            {semi ? 'No skills yet. Create one to get started.' : 'No skills yet. Skills are created by agents.'}
          </div>
        ) : isWide ? (
          <div className="grid grid-cols-2 gap-2 p-3">
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
          <div className="divide-y divide-border-primary">
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
        className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{skill.name}</span>
            {skill.agentCreated && (
              <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-info-bg text-status-info">agent</span>
            )}
            {skill.autoActivate && (
              <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-success-bg text-status-success">auto</span>
            )}
            <span className="text-xs text-text-muted">v{skill.version}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-text-muted truncate max-w-[200px]">
              {skill.content.slice(0, 80)}{skill.content.length > 80 ? '...' : ''}
            </span>
          </div>
          {skill.activationContext && skill.activationContext.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {skill.activationContext.map((ctx, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded-lg text-xs bg-interactive-bg text-interactive border border-interactive-bg">
                  {ctx}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="text-sm text-text-muted">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 bg-surface-secondary space-y-2">
          <pre className="text-xs text-text-secondary bg-surface-primary border border-border-primary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
            {skill.content}
          </pre>
          <div className="flex items-center gap-2">
            {semi ? (
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={skill.autoActivate}
                  onChange={onToggleAutoActivate}
                  className="rounded-lg border-border-primary"
                />
                Auto-activate
              </label>
            ) : (
              <span className="text-xs text-text-muted">
                {skill.autoActivate ? 'Auto-activate enabled' : 'Manual activation'}
              </span>
            )}
            <div className="flex-1" />
            <span className="text-xs text-text-muted">{formatRelativeTime(skill.updatedAt)}</span>
            {semi && (
              <button
                onClick={onDelete}
                onBlur={onBlurDelete}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-status-error hover:text-red-600"
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

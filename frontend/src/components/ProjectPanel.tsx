import { useState, useEffect, useRef } from 'react'
import { ProjectMeta, ProjectDetail, Scene } from '../types'

interface Props {
  currentProjectId: string | null
  projectName: string
  onProjectLoad: (project: ProjectDetail) => void
  onProjectCreated: (id: string, name: string) => void
  onProjectNameChange: (name: string) => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ProjectPanel({
  currentProjectId,
  projectName,
  onProjectLoad,
  onProjectCreated,
  onProjectNameChange,
}: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)

  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) return
      const data: ProjectMeta[] = await res.json()
      setProjects(data)
    } catch {}
  }

  useEffect(() => {
    fetchProjects()
  }, [])

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const handleCreate = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未命名作品' }),
      })
      if (!res.ok) return
      const proj = await res.json()
      onProjectCreated(proj.id, proj.name)
      await fetchProjects()
    } catch {} finally {
      setLoading(false)
    }
  }

  const handleLoad = async (id: string) => {
    if (id === currentProjectId) return
    try {
      const res = await fetch(`/api/projects/${id}`)
      if (!res.ok) return
      const proj: ProjectDetail = await res.json()
      onProjectLoad(proj)
      await fetchProjects()
    } catch {}
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (confirmDeleteId !== id) {
      // First click: arm confirmation; auto-dismiss after 4 s
      setConfirmDeleteId(id)
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 4000)
      return
    }
    // Second click: execute delete
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDeleteId(null)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      if (id === currentProjectId) {
        onProjectCreated('', '')
      }
      await fetchProjects()
    } catch {}
  }

  const startEdit = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation()
    setEditingId(id)
    setEditName(name)
  }

  const handleDuplicate = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (duplicatingId) return
    setDuplicatingId(id)
    try {
      const res = await fetch(`/api/projects/${id}/duplicate`, { method: 'POST' })
      if (!res.ok) return
      await fetchProjects()
    } catch {} finally {
      setDuplicatingId(null)
    }
  }

  const commitEdit = async (id: string) => {
    const trimmed = editName.trim()
    if (!trimmed) { setEditingId(null); return }
    try {
      await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (id === currentProjectId) onProjectNameChange(trimmed)
      await fetchProjects()
    } catch {} finally {
      setEditingId(null)
    }
  }

  const filteredProjects = searchQuery.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : projects

  return (
    <div className="project-panel">
      <div className="project-panel-header">
        <span className="project-panel-title">我的作品</span>
        <button
          className="btn-new-project"
          onClick={handleCreate}
          disabled={loading}
          title="建立新作品"
        >＋ 新作品</button>
      </div>

      {projects.length >= 4 && (
        <div className="project-search-wrap">
          <input
            className="project-search-input"
            type="text"
            placeholder="搜尋作品…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="project-search-clear" onClick={() => setSearchQuery('')} title="清除搜尋">✕</button>
          )}
        </div>
      )}

      <div className="project-list">
        {projects.length === 0 && (
          <div className="project-empty">尚無已儲存作品</div>
        )}
        {projects.length > 0 && filteredProjects.length === 0 && (
          <div className="project-empty">找不到符合的作品</div>
        )}
        {filteredProjects.map(p => (
          <div
            key={p.id}
            className={`project-item${p.id === currentProjectId ? ' active' : ''}`}
            onClick={() => handleLoad(p.id)}
            title={p.name}
          >
            <div className="project-cover-thumb">
              {p.cover_image
                ? <img src={p.cover_image} alt={p.name} className="project-cover-img" />
                : <span className="project-cover-placeholder">📖</span>
              }
            </div>
            <div className="project-item-body">
              {editingId === p.id ? (
                <input
                  ref={editInputRef}
                  className="project-name-input"
                  value={editName}
                  onChange={e => setEditName(e.target.value.slice(0, 100))}
                  onBlur={() => commitEdit(p.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitEdit(p.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span
                  className="project-name"
                  onDoubleClick={e => startEdit(e, p.id, p.name)}
                  title="雙擊重新命名"
                >{p.name}</span>
              )}
              <span className="project-meta">
                {p.scene_count} 幕・{formatDate(p.updated_at)}
              </span>
            </div>
            <button
              className="btn-duplicate-project"
              onClick={e => handleDuplicate(e, p.id)}
              disabled={!!duplicatingId}
              title="複製此作品"
            >{duplicatingId === p.id ? <span className="spinner-sm" /> : '📋'}</button>
            <button
              className={`btn-delete-project${confirmDeleteId === p.id ? ' confirm' : ''}`}
              onClick={e => handleDelete(e, p.id)}
              title={confirmDeleteId === p.id ? '再次點擊確認刪除' : '刪除作品'}
            >{confirmDeleteId === p.id ? '⚠️' : '✕'}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

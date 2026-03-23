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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

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
    if (!confirm('確定刪除此作品？此動作無法復原。')) return
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

      <div className="project-list">
        {projects.length === 0 && (
          <div className="project-empty">尚無已儲存作品</div>
        )}
        {projects.map(p => (
          <div
            key={p.id}
            className={`project-item${p.id === currentProjectId ? ' active' : ''}`}
            onClick={() => handleLoad(p.id)}
            title={p.name}
          >
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
              className="btn-delete-project"
              onClick={e => handleDelete(e, p.id)}
              title="刪除作品"
            >✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

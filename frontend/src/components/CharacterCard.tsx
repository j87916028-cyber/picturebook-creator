import { useRef, useState, useEffect } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Character } from '../types'

interface Props {
  character: Character
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  isDragging?: boolean
  lineCount?: number   // total dialogue lines this character has across all scenes
}

export default function CharacterCard({ character, onDelete, onEdit, onDuplicate, onMoveUp, onMoveDown, isDragging = false, lineCount }: Props) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: character.id,
    data: { character },
  })

  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up timer on unmount
  useEffect(() => () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current) }, [])

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirmDelete) {
      setConfirmDelete(true)
      confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 4000)
      return
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    setConfirmDelete(false)
    onDelete(character.id)
  }

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, borderColor: character.color }}
      className="character-card"
      {...attributes}
    >
      <div className="card-drag-handle" {...listeners}>
        <span className="card-emoji">{character.emoji}</span>
        <div className="card-info">
          <div className="card-name-row">
            <span className="card-name" style={{ color: character.color }}>{character.name}</span>
            {lineCount !== undefined && lineCount > 0 && (
              <span className="card-line-badge" style={{ borderColor: character.color, color: character.color }}>
                💬 {lineCount}
              </span>
            )}
          </div>
          <div className="card-personality">{character.personality}</div>
          {character.visual_description && (
            <div className="card-visual-desc" title="外形描述">👗 {character.visual_description}</div>
          )}
        </div>
      </div>
      <div className="card-actions">
        {onMoveUp && (
          <button
            className="card-move card-move-up"
            onClick={e => { e.stopPropagation(); onMoveUp() }}
            title="上移角色"
          >▲</button>
        )}
        {onMoveDown && (
          <button
            className="card-move card-move-down"
            onClick={e => { e.stopPropagation(); onMoveDown() }}
            title="下移角色"
          >▼</button>
        )}
        <button
          className="card-edit"
          onClick={() => onEdit(character.id)}
          title="編輯角色"
        >✏️</button>
        <button
          className="card-duplicate"
          onClick={e => { e.stopPropagation(); onDuplicate(character.id) }}
          title="複製角色"
        >📋</button>
        <button
          className={`card-delete${confirmDelete ? ' confirm' : ''}`}
          onClick={handleDeleteClick}
          title={confirmDelete ? '再次點擊確認刪除' : '刪除角色'}
        >{confirmDelete ? '⚠️' : '×'}</button>
      </div>
    </div>
  )
}

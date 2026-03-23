import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Character } from '../types'

interface Props {
  character: Character
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  isDragging?: boolean
}

export default function CharacterCard({ character, onDelete, onEdit, isDragging = false }: Props) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: character.id,
    data: { character },
  })

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
          <div className="card-name" style={{ color: character.color }}>{character.name}</div>
          <div className="card-personality">{character.personality}</div>
        </div>
      </div>
      <div className="card-actions">
        <button
          className="card-edit"
          onClick={() => onEdit(character.id)}
          title="編輯角色"
        >✏️</button>
        <button
          className="card-delete"
          onClick={() => onDelete(character.id)}
          title="刪除角色"
        >×</button>
      </div>
    </div>
  )
}

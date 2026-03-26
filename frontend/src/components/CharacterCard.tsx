import { useRef, useState, useEffect, useCallback } from 'react'
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
  lineCount?: number      // total dialogue lines this character has across all scenes
  sceneIndices?: number[] // scene numbers (1-based) where this character appears
  voiceLabel?: string     // display name of the assigned voice
  isInScene?: boolean     // whether this character is already in the scene drop zone
  onAddToScene?: () => void  // click-to-add fallback (mobile / accessibility)
}

export default function CharacterCard({ character, onDelete, onEdit, onDuplicate, onMoveUp, onMoveDown, isDragging = false, lineCount, sceneIndices, voiceLabel, isInScene, onAddToScene }: Props) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: character.id,
    data: { character },
  })

  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewLoadingRef = useRef(false)

  // Clean up timer and audio on unmount
  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    previewAudioRef.current?.pause()
  }, [])

  // Use the dedicated cached preview endpoint (GET /api/voices/{id}/preview)
  // to avoid consuming the /api/generate-voice rate-limit quota.
  const handlePreview = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
      setPreviewing(false)
      return
    }
    if (previewLoadingRef.current) return
    previewLoadingRef.current = true
    setPreviewing(true)
    try {
      const res = await fetch(`/api/voices/${character.voice_id}/preview`)
      if (!res.ok) { setPreviewing(false); return }
      const data = await res.json()
      const fmt = data.format || 'mp3'
      const audio = new Audio(`data:audio/${fmt};base64,${data.audio_base64}`)
      previewAudioRef.current = audio
      audio.onended = () => { setPreviewing(false); previewAudioRef.current = null }
      audio.onerror = () => { setPreviewing(false); previewAudioRef.current = null }
      audio.play().catch(() => { setPreviewing(false); previewAudioRef.current = null })
    } catch {
      setPreviewing(false)
    } finally {
      previewLoadingRef.current = false
    }
  }, [character.voice_id])

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
            {sceneIndices && sceneIndices.length > 0 && (
              <span
                className="card-scene-badge"
                style={{ borderColor: character.color, color: character.color }}
                title={`出現在第 ${sceneIndices.join('、') } 幕`}
              >
                🎬 {sceneIndices.join('·')}
              </span>
            )}
          </div>
          <div className="card-personality">{character.personality}</div>
          {character.visual_description && (
            <div className="card-visual-desc" title="外形描述">👗 {character.visual_description}</div>
          )}
          {voiceLabel && (
            <div className="card-voice-label" title="配音聲音">🎙 {voiceLabel}</div>
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
          className={`card-preview${previewing ? ' playing' : ''}`}
          onClick={handlePreview}
          title={previewing ? '停止試聽' : '試聽角色聲音'}
        >{previewing ? '⏹' : '🔊'}</button>
        {onAddToScene && (
          <button
            className={`card-add-scene${isInScene ? ' in-scene' : ''}`}
            onClick={e => { e.stopPropagation(); if (!isInScene) onAddToScene() }}
            title={isInScene ? '已在場景中' : '點擊加入場景'}
          >{isInScene ? '✓' : '➕'}</button>
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

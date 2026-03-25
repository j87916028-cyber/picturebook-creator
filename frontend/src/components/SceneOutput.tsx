import { useRef, useState, useCallback, useEffect } from 'react'
import {
  DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, horizontalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Scene, Character } from '../types'
import PlaybackModal from './PlaybackModal'

// Resolve image src: use data URI if base64 blob, else bare URL
function resolveImgSrc(image: string): string {
  if (!image) return ''
  if (image.startsWith('data:') || image.startsWith('http') || image.startsWith('/')) return image
  return `data:image/jpeg;base64,${image}`
}

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

const EMOTION_LABELS: Record<string, string> = {
  happy:     '😄 開心',
  sad:       '😢 難過',
  angry:     '😠 生氣',
  surprised: '😲 驚訝',
  fearful:   '😨 害怕',
  disgusted: '🤢 厭惡',
  neutral:   '😐 平靜',
}

// Sortable nav chip — each chip in the scene navigation strip
function SortableNavChip({
  scene,
  index,
  onClick,
}: {
  scene: Scene
  index: number
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: scene.id })

  // Compute completion status for the two dots (image · audio)
  const imageStatus: 'ok' | 'err' | 'pending' =
    scene.image === 'error' ? 'err' :
    scene.image             ? 'ok'  : 'pending'

  const linesWithAudio = scene.lines.filter(l => l.audio_base64).length
  const totalLines     = scene.lines.length
  const audioStatus: 'ok' | 'partial' | 'pending' =
    totalLines === 0              ? 'pending'  :
    linesWithAudio === totalLines ? 'ok'       :
    linesWithAudio > 0            ? 'partial'  : 'pending'

  const imageTip  = imageStatus === 'ok' ? '插圖完成' : imageStatus === 'err' ? '插圖失敗' : '插圖生成中'
  const audioTip  = audioStatus === 'ok' ? '配音完整' : audioStatus === 'partial' ? `配音 ${linesWithAudio}/${totalLines}` : '配音生成中'

  return (
    <div
      ref={setNodeRef}
      className={`scene-nav-chip${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
    >
      <span className="scene-nav-drag-handle" {...listeners} title="拖曳排序">⠿</span>
      <button className="scene-nav-click-btn" onClick={onClick} title={scene.description}>
        {scene.image && scene.image !== 'error' ? (
          <img className="scene-nav-thumb" src={resolveImgSrc(scene.image)} alt={`第${index + 1}幕`} />
        ) : (
          <span className="scene-nav-placeholder">🎭</span>
        )}
        <span className="scene-nav-num">第 {index + 1} 幕</span>
        <span className="scene-nav-desc">{scene.description}</span>
        {/* Completion dots: left = image, right = audio */}
        <div className="scene-nav-status">
          <span className={`nav-status-dot img-dot dot-${imageStatus}`} title={imageTip} />
          <span className={`nav-status-dot aud-dot dot-${audioStatus}`} title={audioTip} />
        </div>
      </button>
    </div>
  )
}

interface Props {
  scenes: Scene[]
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onSceneMove: (sceneId: string, direction: 'up' | 'down') => void
  onScenesReorder: (orderedIds: string[]) => void
  onSceneDuplicate: (sceneId: string) => void
  onLineMove: (sceneId: string, lineIndex: number, direction: 'up' | 'down') => void
  onLineEditConfirm: (sceneId: string, lineIndex: number, newText: string) => Promise<void>
  onLineDelete: (sceneId: string, lineIndex: number) => void
  onLineAdd: (sceneId: string, characterId: string, text: string) => Promise<void>
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onLineEmotionChange: (sceneId: string, lineIndex: number, newEmotion: string) => Promise<void>
  onLineCharacterChange: (sceneId: string, lineIndex: number, newCharacterId: string) => Promise<void>
  onImageRegen: (sceneId: string, customPrompt?: string) => Promise<void>
  onSceneRegen: (sceneId: string, newDescription: string, style: string, lineLength?: string) => Promise<void>
  onBatchRegenVoice: () => void
  batchRegenStatus: { done: number; total: number } | null
  onBatchRegenImages: () => void
  batchImageStatus: { done: number; total: number } | null
}

interface SceneCardProps {
  scene: Scene
  sceneIndex: number
  totalScenes: number
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onSceneMove: (sceneId: string, direction: 'up' | 'down') => void
  onSceneDuplicate: (sceneId: string) => void
  onLineMove: (sceneId: string, lineIndex: number, direction: 'up' | 'down') => void
  onLineEditConfirm: (sceneId: string, lineIndex: number, newText: string) => Promise<void>
  onLineDelete: (sceneId: string, lineIndex: number) => void
  onLineAdd: (sceneId: string, characterId: string, text: string) => Promise<void>
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onLineEmotionChange: (sceneId: string, lineIndex: number, newEmotion: string) => Promise<void>
  onLineCharacterChange: (sceneId: string, lineIndex: number, newCharacterId: string) => Promise<void>
  onImageRegen: (sceneId: string, customPrompt?: string) => Promise<void>
  onSceneRegen: (sceneId: string, newDescription: string, style: string, lineLength?: string) => Promise<void>
  onPlayFromScene: (sceneIndex: number) => void
}

function SceneCard({
  scene,
  sceneIndex,
  totalScenes,
  characters,
  onSceneDelete,
  onSceneMove,
  onSceneDuplicate,
  onLineMove,
  onLineEditConfirm,
  onLineDelete,
  onLineAdd,
  onLineVoiceRegen,
  onLineEmotionChange,
  onLineCharacterChange,
  onImageRegen,
  onSceneRegen,
  onPlayFromScene,
}: SceneCardProps) {
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [playProgress, setPlayProgress] = useState(0)  // 0–100 percent
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

  // Attach timeupdate listener whenever the active line changes
  useEffect(() => {
    if (playingIndex === null) { setPlayProgress(0); return }
    const audio = audioRefs.current[playingIndex]
    if (!audio) return
    const onTime = () => {
      if (audio.duration) setPlayProgress((audio.currentTime / audio.duration) * 100)
    }
    audio.addEventListener('timeupdate', onTime)
    return () => audio.removeEventListener('timeupdate', onTime)
  }, [playingIndex])

  // Edit state
  const [editingLineIndex, setEditingLineIndex] = useState<number | null>(null)
  const [editLineText, setEditLineText] = useState('')
  const [regenVoiceIndex, setRegenVoiceIndex] = useState<number | null>(null)
  const [emotionRegenIndex, setEmotionRegenIndex] = useState<number | null>(null)
  const [charChangeIndex, setCharChangeIndex] = useState<number | null>(null)
  const [regenImage, setRegenImage] = useState(false)
  const [showPromptEdit, setShowPromptEdit] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState(scene.script.scene_prompt || '')
  const [showRegenForm, setShowRegenForm] = useState(false)
  const [showAddLine, setShowAddLine] = useState(false)
  const [addCharId, setAddCharId] = useState('')
  const [addLineText, setAddLineText] = useState('')
  const [addLineLoading, setAddLineLoading] = useState(false)

  // Inline delete confirmation — avoids blocking window.confirm
  const [confirmDeleteScene, setConfirmDeleteScene] = useState(false)
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current) }, [])

  // Keep editedPrompt in sync when scene_prompt changes (e.g. after full scene regen)
  useEffect(() => {
    setEditedPrompt(scene.script.scene_prompt || '')
  }, [scene.script.scene_prompt])
  const [regenDesc, setRegenDesc] = useState(scene.description)
  const [regenStyle, setRegenStyle] = useState(scene.style)
  const [regenLineLength, setRegenLineLength] = useState<'short' | 'standard' | 'long'>(
    (scene.line_length as 'short' | 'standard' | 'long') || 'standard'
  )
  const [regenLoading, setRegenLoading] = useState(false)
  const [regenError, setRegenError] = useState<string | null>(null)
  const [expandedImage, setExpandedImage] = useState(false)

  const getCharacter = (id: string) => characters.find(c => c.id === id)

  // Close lightbox on Escape
  useEffect(() => {
    if (!expandedImage) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedImage(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expandedImage])

  const playLine = useCallback((index: number) => {
    audioRefs.current.forEach((a, i) => {
      if (a && i !== index) { a.pause(); a.currentTime = 0 }
    })
    const audio = audioRefs.current[index]
    if (!audio) return

    setPlayingIndex(prev => {
      if (prev === index) {
        audio.pause()
        return null
      }
      audio.play()
      audio.onended = () => {
        setPlayingIndex(null)
        if (index + 1 < scene.lines.length) {
          setTimeout(() => playLine(index + 1), 300)
        }
      }
      return index
    })
  }, [scene.lines])

  const playAll = () => {
    if (scene.lines.length > 0) playLine(0)
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>, index: number) => {
    const audio = audioRefs.current[index]
    if (!audio || !audio.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = pct * audio.duration
    setPlayProgress(pct * 100)
  }

  const handleDownloadImage = () => {
    if (!scene.image) return
    const filename = `第${sceneIndex + 1}幕插圖`
    if (scene.image.startsWith('data:')) {
      // data: URI — browser can download directly
      const ext = scene.image.match(/^data:image\/(\w+)/)?.[1] ?? 'png'
      const a = document.createElement('a')
      a.href = scene.image
      a.download = `${filename}.${ext}`
      a.click()
    } else {
      // External URL — fetch then blob-download to force save-as instead of navigating
      fetch(scene.image)
        .then(r => r.blob())
        .then(blob => {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `${filename}.jpg`
          a.click()
          URL.revokeObjectURL(url)
        })
        .catch(() => {})
    }
  }

  const isGenerating = scene.lines.length === 0

  const handleDeleteScene = () => {
    if (!confirmDeleteScene) {
      // First click: arm the confirmation; auto-dismiss after 4 s
      setConfirmDeleteScene(true)
      if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current)
      deleteConfirmTimerRef.current = setTimeout(() => setConfirmDeleteScene(false), 4000)
      return
    }
    // Second click within 4 s: execute
    if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current)
    setConfirmDeleteScene(false)
    onSceneDelete(scene.id)
  }

  const handleStartEditLine = (index: number, text: string) => {
    setEditingLineIndex(index)
    setEditLineText(text)
  }

  const handleConfirmEditLine = async (index: number) => {
    const newText = editLineText.trim()
    if (!newText) return
    // Close edit form immediately, then show voice-loading while regen runs
    setEditingLineIndex(null)
    setRegenVoiceIndex(index)
    try {
      await onLineEditConfirm(scene.id, index, newText)
    } finally {
      setRegenVoiceIndex(null)
    }
  }

  const handleCancelEditLine = () => {
    setEditingLineIndex(null)
    setEditLineText('')
  }

  const handleVoiceRegen = async (index: number) => {
    setRegenVoiceIndex(index)
    try {
      await onLineVoiceRegen(scene.id, index)
    } finally {
      setRegenVoiceIndex(null)
    }
  }

  const handleEmotionChange = async (index: number, newEmotion: string) => {
    setEmotionRegenIndex(index)
    try {
      await onLineEmotionChange(scene.id, index, newEmotion)
    } finally {
      setEmotionRegenIndex(null)
    }
  }

  const handleCharacterChange = async (index: number, newCharId: string) => {
    setCharChangeIndex(index)
    try {
      await onLineCharacterChange(scene.id, index, newCharId)
    } finally {
      setCharChangeIndex(null)
    }
  }

  const handleImageRegen = async (customPrompt?: string) => {
    setRegenImage(true)
    try {
      await onImageRegen(scene.id, customPrompt)
      if (customPrompt) setShowPromptEdit(false)
    } finally {
      setRegenImage(false)
    }
  }

  const handleSceneRegenSubmit = async () => {
    if (!regenDesc.trim()) return
    setRegenLoading(true)
    setRegenError(null)
    try {
      await onSceneRegen(scene.id, regenDesc.trim(), regenStyle, regenLineLength)
      setShowRegenForm(false)
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : '重新生成失敗，請稍後重試')
    } finally {
      setRegenLoading(false)
    }
  }

  const hasAudio = scene.lines.some(l => l.audio_base64)
  // A line whose audio is missing while other lines in the same scene have
  // audio means this specific line's voice generation silently failed.
  const isAudioFailed = (line: { audio_base64?: string }) =>
    hasAudio && !line.audio_base64

  return (
    <div className="scene-card">
      <div className="scene-card-header">
        <span className="scene-card-title">第 {sceneIndex + 1} 幕</span>
        <span className="scene-card-desc">{scene.description}</span>
        <div className="scene-header-right">
          {hasAudio && (
            <button
              className="btn-play-from-scene"
              onClick={() => onPlayFromScene(sceneIndex)}
              title="從此幕開始播放"
            >
              ▶ 從此幕
            </button>
          )}
          <div className="scene-move-btns">
            <button
              className="btn-scene-move"
              onClick={() => onSceneMove(scene.id, 'up')}
              disabled={sceneIndex === 0}
              title="上移"
            >↑</button>
            <button
              className="btn-scene-move"
              onClick={() => onSceneMove(scene.id, 'down')}
              disabled={sceneIndex === totalScenes - 1}
              title="下移"
            >↓</button>
          </div>
        </div>
      </div>

      {/* Action buttons row */}
      <div className="scene-card-actions">
        {scene.image && (
          <button
            className="btn-scene-action btn-download-image"
            onClick={handleDownloadImage}
            title="下載插圖"
          >
            💾 下載插圖
          </button>
        )}
        {scene.script.scene_prompt && (
          <>
            <button
              className="btn-scene-action"
              onClick={() => handleImageRegen()}
              disabled={regenImage || isGenerating}
              title="用原始提示詞重新生成插圖"
            >
              {regenImage && !showPromptEdit ? <><span className="spinner-sm" /> 生成中...</> : '🔄 重新生成插圖'}
            </button>
            <button
              className={`btn-scene-action${showPromptEdit ? ' active' : ''}`}
              onClick={() => setShowPromptEdit(v => !v)}
              disabled={regenImage || isGenerating}
              title="檢視並編輯插圖提示詞"
            >
              ✏️ 編輯提示詞
            </button>
          </>
        )}
        <button
          className="btn-scene-action"
          onClick={() => {
            setRegenDesc(scene.description)
            setRegenStyle(scene.style)
            setShowRegenForm(v => !v)
          }}
          disabled={regenLoading || isGenerating}
          title="重新生成此幕"
        >
          ✏️ 重新生成此幕
        </button>
        <button
          className="btn-scene-action btn-scene-duplicate"
          onClick={() => onSceneDuplicate(scene.id)}
          disabled={isGenerating || regenLoading}
          title="複製此幕（保留劇本、配音、插圖）"
        >
          📋 複製此幕
        </button>
        {confirmDeleteScene ? (
          <>
            <button
              className="btn-scene-action btn-scene-delete btn-scene-delete-confirm"
              onClick={handleDeleteScene}
              title="再次點擊以確認刪除"
            >
              ⚠️ 確認刪除？
            </button>
            <button
              className="btn-ghost"
              onClick={() => { setConfirmDeleteScene(false); if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current) }}
              style={{ fontSize: '0.78rem', padding: '4px 10px' }}
            >
              取消
            </button>
          </>
        ) : (
          <button
            className="btn-scene-action btn-scene-delete"
            onClick={handleDeleteScene}
            disabled={regenLoading}
            title="刪除此幕"
          >
            🗑️ 刪除此幕
          </button>
        )}
      </div>

      {/* Image prompt editor */}
      {showPromptEdit && (
        <div className="prompt-edit-panel">
          <div className="prompt-edit-header">
            <span className="prompt-edit-title">🎨 插圖提示詞</span>
            <span className="prompt-edit-hint">可加入風格描述，如「水彩畫風」、「宮崎駿風格」、「黑白線稿」</span>
          </div>
          <textarea
            className="prompt-edit-textarea"
            value={editedPrompt}
            onChange={e => setEditedPrompt(e.target.value.slice(0, 1000))}
            rows={4}
            maxLength={1000}
            placeholder="描述插圖內容與風格..."
          />
          <div className="prompt-edit-actions">
            <button
              className="btn-scene-action"
              onClick={() => handleImageRegen(editedPrompt.trim() || undefined)}
              disabled={regenImage || !editedPrompt.trim()}
            >
              {regenImage ? <><span className="spinner-sm" /> 生成中...</> : '🎨 用此提示詞生成'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => { setShowPromptEdit(false); setEditedPrompt(scene.script.scene_prompt || '') }}
              style={{ fontSize: '0.8rem', padding: '5px 12px' }}
            >
              取消
            </button>
            <span className="prompt-char-count">{editedPrompt.length} / 1000</span>
          </div>
        </div>
      )}

      {/* Re-generate scene form */}
      {showRegenForm && (
        <div className="regen-scene-form">
          <label className="regen-scene-label">場景描述</label>
          <textarea
            className="line-edit-textarea"
            value={regenDesc}
            onChange={e => setRegenDesc(e.target.value.slice(0, 500))}
            rows={3}
            maxLength={500}
            placeholder="描述新場景內容..."
          />
          <div className="style-row" style={{ marginTop: '8px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>故事風格</label>
            <div className="style-buttons">
              {STYLES.map(s => (
                <button
                  key={s}
                  className={`style-btn ${regenStyle === s ? 'active' : ''}`}
                  onClick={() => setRegenStyle(s)}
                  type="button"
                >{s}</button>
              ))}
            </div>
          </div>
          <div className="style-row" style={{ marginTop: '6px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>台詞長度</label>
            <div className="style-buttons">
              {([
                { value: 'short',    label: '幼兒（≤12字）' },
                { value: 'standard', label: '標準（≤20字）' },
                { value: 'long',     label: '進階（≤35字）' },
              ] as { value: 'short' | 'standard' | 'long'; label: string }[]).map(opt => (
                <button
                  key={opt.value}
                  className={`style-btn ${regenLineLength === opt.value ? 'active' : ''}`}
                  onClick={() => setRegenLineLength(opt.value)}
                  type="button"
                >{opt.label}</button>
              ))}
            </div>
          </div>
          {regenError && (
            <div className="error-box regen-error-box">⚠️ {regenError}</div>
          )}
          <div className="line-edit-btns" style={{ marginTop: '10px' }}>
            <button
              className="btn-scene-action"
              onClick={handleSceneRegenSubmit}
              disabled={regenLoading || !regenDesc.trim()}
            >
              {regenLoading ? <><span className="spinner-sm" /> 生成中...</> : '✓ 確認重新生成'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => { setShowRegenForm(false); setRegenError(null) }}
              disabled={regenLoading}
              style={{ fontSize: '0.8rem', padding: '5px 12px' }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 場景插圖 */}
      <div className="scene-card-image-wrap">
        {scene.image === 'error' ? (
          <div className="image-error">
            <span className="image-error-icon">🖼️</span>
            <span className="image-error-text">插圖生成失敗</span>
            <button
              className="btn-scene-action"
              onClick={() => handleImageRegen()}
              disabled={regenImage}
              style={{ marginTop: '8px', fontSize: '0.8rem' }}
            >
              🔄 重新生成插圖
            </button>
          </div>
        ) : scene.image ? (
          <>
            <img
              src={scene.image}
              alt={`第${sceneIndex + 1}幕插圖`}
              className="scene-image scene-image-zoomable"
              onClick={() => setExpandedImage(true)}
              title="點擊放大"
            />
            <span className="image-zoom-hint">🔍</span>
          </>
        ) : (
          <div className="image-loading">
            {isGenerating ? '劇本生成中...' : regenImage ? '重新生成插圖中...' : '插圖生成中...'}
          </div>
        )}
      </div>

      {/* Lightbox overlay */}
      {expandedImage && scene.image && scene.image !== 'error' && (
        <div className="image-lightbox-overlay" onClick={() => setExpandedImage(false)}>
          <button className="lightbox-close" onClick={() => setExpandedImage(false)} title="關閉 (Esc)">✕</button>
          <button
            className="lightbox-download"
            onClick={e => { e.stopPropagation(); handleDownloadImage() }}
            title="下載插圖"
          >💾</button>
          <img
            src={scene.image}
            alt={`第${sceneIndex + 1}幕插圖（放大）`}
            className="lightbox-img"
            onClick={e => e.stopPropagation()}
          />
          <p className="lightbox-caption">第 {sceneIndex + 1} 幕 · {scene.description}</p>
        </div>
      )}

      {scene.script.sfx_description && (
        <p className="sfx-note">🎵 {scene.script.sfx_description}</p>
      )}

      {/* 對話劇本 */}
      {scene.lines.length > 0 && (
        <div className="scene-card-dialogue">
          <div className="output-header">
            <h4>對話劇本</h4>
            <button className="btn-play-all" onClick={playAll}>▶ 全部播放</button>
          </div>

          <div className="dialogue-list">
            {scene.lines.map((line, i) => {
              const char = getCharacter(line.character_id)
              const color = char?.color || '#888'
              const isPlaying = playingIndex === i
              const isEditingThis = editingLineIndex === i
              const isRegenVoice = regenVoiceIndex === i

              return (
                <div
                  key={i}
                  className={`dialogue-line ${isPlaying ? 'playing' : ''}`}
                  style={{ borderLeftColor: color }}
                >
                  <div className="dialogue-speaker">
                    <span className="speaker-emoji">{char?.emoji || '🎭'}</span>
                    <span className="speaker-name" style={{ color }}>{line.character_name}</span>
                    {emotionRegenIndex === i ? (
                      <span className="emotion-badge emotion-regen-badge">
                        <span className="spinner-sm" /> 換情緒中...
                      </span>
                    ) : (
                      <select
                        className="emotion-select"
                        value={line.emotion || 'neutral'}
                        onChange={e => handleEmotionChange(i, e.target.value)}
                        disabled={isRegenVoice || emotionRegenIndex !== null || charChangeIndex !== null}
                        title="更換情緒，自動重新配音"
                      >
                        {Object.entries(EMOTION_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    )}
                    {characters.length > 1 && (
                      charChangeIndex === i ? (
                        <span className="emotion-badge emotion-regen-badge">
                          <span className="spinner-sm" /> 換角色中...
                        </span>
                      ) : (
                        <select
                          className="char-change-select"
                          value={line.character_id}
                          onChange={e => { if (e.target.value !== line.character_id) handleCharacterChange(i, e.target.value) }}
                          disabled={isRegenVoice || emotionRegenIndex !== null || charChangeIndex !== null}
                          title="更換說話角色，自動重新配音"
                        >
                          {characters.map(c => (
                            <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>
                          ))}
                        </select>
                      )
                    )}
                  </div>
                  <div className="dialogue-content">
                    {isEditingThis ? (
                      <div className="line-edit-area">
                        <textarea
                          className="line-edit-textarea"
                          value={editLineText}
                          onChange={e => setEditLineText(e.target.value)}
                          rows={2}
                          autoFocus
                        />
                        <div className="line-edit-btns">
                          <button
                            className="btn-scene-action"
                            onClick={() => handleConfirmEditLine(i)}
                            disabled={!editLineText.trim()}
                          >
                            ✓ 確認
                          </button>
                          <button
                            className="btn-ghost"
                            onClick={handleCancelEditLine}
                            style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                          >
                            ✗ 取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="dialogue-text-row">
                        <p className="dialogue-text">{line.text}</p>
                        <div className="line-move-btns">
                          <button
                            className="btn-move-line"
                            onClick={() => onLineMove(scene.id, i, 'up')}
                            disabled={i === 0}
                            title="上移此行"
                          >▲</button>
                          <button
                            className="btn-move-line"
                            onClick={() => onLineMove(scene.id, i, 'down')}
                            disabled={i === scene.lines.length - 1}
                            title="下移此行"
                          >▼</button>
                        </div>
                        <button
                          className="btn-edit-line"
                          onClick={() => handleStartEditLine(i, line.text)}
                          title="編輯台詞"
                        >
                          ✏️
                        </button>
                        <button
                          className="btn-delete-line"
                          onClick={() => {
                            if (scene.lines.length <= 1) return   // keep at least one line
                            onLineDelete(scene.id, i)
                          }}
                          disabled={scene.lines.length <= 1}
                          title={scene.lines.length <= 1 ? '至少保留一行台詞' : '刪除此行台詞'}
                        >
                          🗑️
                        </button>
                      </div>
                    )}
                    <div className="dialogue-controls">
                      {line.audio_base64 ? (
                        <>
                          <audio
                            ref={(el: HTMLAudioElement | null) => { audioRefs.current[i] = el }}
                            src={`data:audio/${line.audio_format || 'wav'};base64,${line.audio_base64}`}
                          />
                          <button
                            className={`btn-play-line ${isPlaying ? 'playing' : ''}`}
                            onClick={() => playLine(i)}
                            style={{ borderColor: color, color: isPlaying ? '#fff' : color, background: isPlaying ? color : 'transparent' }}
                          >
                            {isPlaying ? '⏸' : '▶'} {isPlaying ? '播放中' : '播放'}
                          </button>
                          {isPlaying && (
                            <div
                              className="audio-progress-track"
                              onClick={e => handleSeek(e, i)}
                              title="點擊跳轉播放位置"
                            >
                              <div
                                className="audio-progress-fill"
                                style={{ width: `${playProgress}%` }}
                              />
                            </div>
                          )}
                        </>
                      ) : isRegenVoice ? (
                        <span className="audio-loading">配音生成中...</span>
                      ) : isAudioFailed(line) ? (
                        <button
                          className="btn-regen-voice btn-regen-voice-failed"
                          onClick={() => handleVoiceRegen(i)}
                          disabled={isEditingThis}
                          title="配音生成失敗，點擊重試"
                        >
                          ⚠️ 配音失敗，點擊重試
                        </button>
                      ) : (
                        <span className="audio-loading">音訊生成中...</span>
                      )}
                      {line.text && !isAudioFailed(line) && (
                        <button
                          className="btn-regen-voice"
                          onClick={() => handleVoiceRegen(i)}
                          disabled={isRegenVoice || isEditingThis}
                          title="重新配音"
                        >
                          {isRegenVoice
                            ? <><span className="spinner-sm" /> 配音中...</>
                            : '🎤 重新配音'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Add new line */}
          {showAddLine ? (
            <div className="add-line-form">
              <select
                className="add-line-char-select"
                value={addCharId}
                onChange={e => setAddCharId(e.target.value)}
                disabled={addLineLoading}
              >
                <option value="">選擇角色...</option>
                {characters.map(c => (
                  <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>
                ))}
              </select>
              <textarea
                className="line-edit-textarea"
                value={addLineText}
                onChange={e => setAddLineText(e.target.value.slice(0, 100))}
                placeholder="輸入台詞（最多100字）"
                rows={2}
                disabled={addLineLoading}
                autoFocus
              />
              <div className="line-edit-btns">
                <button
                  className="btn-scene-action"
                  disabled={!addCharId || !addLineText.trim() || addLineLoading}
                  onClick={async () => {
                    setAddLineLoading(true)
                    try {
                      await onLineAdd(scene.id, addCharId, addLineText)
                      setShowAddLine(false)
                      setAddCharId('')
                      setAddLineText('')
                    } finally {
                      setAddLineLoading(false)
                    }
                  }}
                >
                  {addLineLoading ? <><span className="spinner-sm" /> 配音生成中...</> : '✓ 新增台詞'}
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => { setShowAddLine(false); setAddCharId(''); setAddLineText('') }}
                  disabled={addLineLoading}
                  style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn-add-line"
              onClick={() => {
                setAddCharId(scene.lines[0]?.character_id || '')
                setShowAddLine(true)
              }}
              disabled={isGenerating}
              title="在此幕末尾新增一行台詞"
            >
              ＋ 加入台詞
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function SceneOutput({
  scenes,
  characters,
  onSceneDelete,
  onSceneMove,
  onScenesReorder,
  onSceneDuplicate,
  onLineMove,
  onLineEditConfirm,
  onLineDelete,
  onLineAdd,
  onLineVoiceRegen,
  onLineEmotionChange,
  onLineCharacterChange,
  onImageRegen,
  onSceneRegen,
  onBatchRegenVoice,
  batchRegenStatus,
  onBatchRegenImages,
  batchImageStatus,
}: Props) {
  const [showPlayback, setShowPlayback] = useState(false)
  const [playbackStartScene, setPlaybackStartScene] = useState(0)
  const sceneRefs = useRef<(HTMLDivElement | null)[]>([])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Auto-scroll to newly added scene (length increase only, not on initial load)
  const prevSceneCountRef = useRef(scenes.length)
  useEffect(() => {
    if (scenes.length > prevSceneCountRef.current) {
      const lastIdx = scenes.length - 1
      setTimeout(() => {
        sceneRefs.current[lastIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 80)
    }
    prevSceneCountRef.current = scenes.length
  }, [scenes.length])

  if (scenes.length === 0) return null

  const hasAudio = scenes.some(s => s.lines.some(l => l.audio_base64))
  const missingAudioCount = scenes.reduce(
    (n, s) => n + s.lines.filter(l => l.text && !l.audio_base64).length, 0
  )
  const missingImageCount = scenes.filter(s => !s.image || s.image === 'error').length

  const scrollToScene = (index: number) => {
    sceneRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handlePlayFromScene = (sceneIndex: number) => {
    setPlaybackStartScene(sceneIndex)
    setShowPlayback(true)
  }

  return (
    <div className="scene-output-panel">
      {(hasAudio || missingAudioCount > 0 || missingImageCount > 0) && (
        <div className="playbook-bar">
          {hasAudio && (
            <button className="btn-playbook" onClick={() => { setPlaybackStartScene(0); setShowPlayback(true) }}>
              🎬 播放全書
            </button>
          )}
          {missingAudioCount > 0 && (
            <button
              className="btn-batch-regen"
              onClick={onBatchRegenVoice}
              disabled={batchRegenStatus !== null || batchImageStatus !== null}
              title={`補齊 ${missingAudioCount} 條缺失配音`}
            >
              {batchRegenStatus
                ? `🎤 配音中 ${batchRegenStatus.done}/${batchRegenStatus.total}…`
                : `🎤 補齊配音（${missingAudioCount}）`}
            </button>
          )}
          {missingImageCount > 0 && (
            <button
              className="btn-batch-regen btn-batch-image"
              onClick={onBatchRegenImages}
              disabled={batchImageStatus !== null || batchRegenStatus !== null}
              title={`補齊 ${missingImageCount} 幕缺失插圖`}
            >
              {batchImageStatus
                ? `🖼️ 插圖中 ${batchImageStatus.done}/${batchImageStatus.total}…`
                : `🖼️ 補齊插圖（${missingImageCount}）`}
            </button>
          )}
          <span className="playbook-hint">
            {batchRegenStatus
              ? `正在生成配音 ${batchRegenStatus.done}/${batchRegenStatus.total}`
              : batchImageStatus
              ? `正在生成插圖 ${batchImageStatus.done}/${batchImageStatus.total}`
              : '全螢幕朗讀模式・各幕可單獨播放 ▶'}
          </span>
        </div>
      )}

      {/* Scene navigation strip — sortable, only shown when there are 2+ scenes */}
      {scenes.length > 1 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event: DragEndEvent) => {
            const { active, over } = event
            if (over && active.id !== over.id) {
              const ids = scenes.map(s => s.id)
              const oldIndex = ids.indexOf(active.id as string)
              const newIndex = ids.indexOf(over.id as string)
              onScenesReorder(arrayMove(ids, oldIndex, newIndex))
            }
          }}
        >
          <SortableContext items={scenes.map(s => s.id)} strategy={horizontalListSortingStrategy}>
            <div className="scene-nav-strip">
              {scenes.map((scene, i) => (
                <SortableNavChip
                  key={scene.id}
                  scene={scene}
                  index={i}
                  onClick={() => scrollToScene(i)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {showPlayback && (
        <PlaybackModal
          scenes={scenes}
          characters={characters}
          onClose={() => setShowPlayback(false)}
          initialSceneIdx={playbackStartScene}
        />
      )}

      {scenes.map((scene, i) => (
        <div key={scene.id} ref={el => { sceneRefs.current[i] = el }}>
          <SceneCard
            scene={scene}
            sceneIndex={i}
            totalScenes={scenes.length}
            characters={characters}
            onSceneDelete={onSceneDelete}
            onSceneMove={onSceneMove}
            onSceneDuplicate={onSceneDuplicate}
            onLineMove={onLineMove}
            onLineEditConfirm={onLineEditConfirm}
            onLineDelete={onLineDelete}
            onLineAdd={onLineAdd}
            onLineVoiceRegen={onLineVoiceRegen}
            onLineEmotionChange={onLineEmotionChange}
            onLineCharacterChange={onLineCharacterChange}
            onImageRegen={onImageRegen}
            onSceneRegen={onSceneRegen}
            onPlayFromScene={handlePlayFromScene}
          />
        </div>
      ))}
    </div>
  )
}

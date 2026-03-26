import { useRef, useState, useCallback, useEffect, useMemo, Fragment } from 'react'
import {
  DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Scene, Character, ScriptLine } from '../types'
import PlaybackModal from './PlaybackModal'
import BookPreviewModal from './BookPreviewModal'

// Resolve image src: use data URI if base64 blob, else bare URL
function resolveImgSrc(image: string): string {
  if (!image) return ''
  if (image.startsWith('data:') || image.startsWith('http') || image.startsWith('/')) return image
  return `data:image/jpeg;base64,${image}`
}

// Wrap all occurrences of `query` in `text` with <mark className="search-hit">
function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text
  const q = query.toLowerCase()
  const lower = text.toLowerCase()
  const nodes: React.ReactNode[] = []
  let pos = 0
  let idx = lower.indexOf(q)
  while (idx !== -1) {
    if (idx > pos) nodes.push(text.slice(pos, idx))
    nodes.push(<mark key={idx} className="search-hit">{text.slice(idx, idx + q.length)}</mark>)
    pos = idx + q.length
    idx = lower.indexOf(q, pos)
  }
  if (pos < text.length) nodes.push(text.slice(pos))
  return nodes.length === 0 ? text : <>{nodes}</>
}

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']
const IMAGE_STYLES = ['水彩繪本', '粉彩卡通', '鉛筆素描', '宮崎駿風', '3D 卡通']

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
  isActive,
  onClick,
}: {
  scene: Scene
  index: number
  isActive: boolean
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: scene.id })

  // Keep a separate ref so we can scroll into view; combine with useSortable's setNodeRef
  const chipElRef = useRef<HTMLDivElement | null>(null)
  const combinedRef = (el: HTMLDivElement | null) => {
    setNodeRef(el)
    chipElRef.current = el
  }
  useEffect(() => {
    if (isActive) chipElRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [isActive])

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
      ref={combinedRef}
      className={`scene-nav-chip${isDragging ? ' dragging' : ''}${isActive ? ' active' : ''}`}
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
        <span className="scene-nav-num">
          第 {index + 1} 幕
          {scene.title && <span className="scene-nav-title">{scene.title}</span>}
        </span>
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

// ── Storyboard card — compact read-only scene overview ───────────
function StoryboardCard({
  scene,
  index,
  characters,
  onClick,
}: {
  scene: Scene
  index: number
  characters: Character[]
  onClick: () => void
}) {
  const imageStatus: 'ok' | 'err' | 'pending' =
    scene.image === 'error' ? 'err' : scene.image ? 'ok' : 'pending'
  const linesWithAudio = scene.lines.filter(l => l.audio_base64).length
  const totalLines     = scene.lines.length
  const audioStatus: 'ok' | 'partial' | 'pending' =
    totalLines === 0              ? 'pending'  :
    linesWithAudio === totalLines ? 'ok'       :
    linesWithAudio > 0            ? 'partial'  : 'pending'
  const previewLines = scene.lines.slice(0, 3)
  const sceneSecs = Math.round(scene.lines.reduce((m, l) => m + l.text.length, 0) / 4)

  return (
    <div className="storyboard-card" onClick={onClick} title="點擊進入編輯此幕">
      <div className="storyboard-thumb-wrap">
        {scene.image && scene.image !== 'error' ? (
          <img src={resolveImgSrc(scene.image)} className="storyboard-thumb" alt={`第${index + 1}幕`} />
        ) : (
          <div className="storyboard-thumb-placeholder">🎭</div>
        )}
        <span className="storyboard-num">第 {index + 1} 幕</span>
        <div className="storyboard-status">
          <span className={`nav-status-dot img-dot dot-${imageStatus}`} title={imageStatus === 'ok' ? '插圖完成' : imageStatus === 'err' ? '插圖失敗' : '插圖生成中'} />
          <span className={`nav-status-dot aud-dot dot-${audioStatus}`} title={audioStatus === 'ok' ? '配音完整' : audioStatus === 'partial' ? `配音 ${linesWithAudio}/${totalLines}` : '配音生成中'} />
        </div>
      </div>
      <div className="storyboard-info">
        {scene.title && <h4 className="storyboard-title">《{scene.title}》</h4>}
        <div className="storyboard-desc-row">
          <p className="storyboard-desc">{scene.description}</p>
          {sceneSecs >= 5 && (
            <span className="storyboard-duration" title="依台詞字數估算播放時長">
              ⏱ {Math.floor(sceneSecs / 60)}:{String(sceneSecs % 60).padStart(2, '0')}
            </span>
          )}
        </div>
        {previewLines.length > 0 && (
          <div className="storyboard-lines">
            {previewLines.map((line, i) => {
              const char = characters.find(c => c.id === line.character_id)
              return (
                <div key={i} className="storyboard-line" style={{ borderLeftColor: char?.color || '#ccc' }}>
                  <span className="storyboard-char">{char?.emoji || '🎭'}</span>
                  <span className="storyboard-text">{line.text}</span>
                </div>
              )
            })}
            {scene.lines.length > 3 && (
              <div className="storyboard-more">還有 {scene.lines.length - 3} 句...</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sortable dialogue line — drag-to-reorder wrapper ─────────────
function SortableLine({
  id,
  disabled,
  children,
}: {
  id: string
  disabled: boolean
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      className={`dialogue-sortable${isDragging ? ' dragging-line' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {!disabled && (
        <span className="line-drag-handle" {...attributes} {...listeners} title="拖曳調整台詞順序">⠿</span>
      )}
      <div className="dialogue-sortable-content">{children}</div>
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
  onLineDuplicate: (sceneId: string, lineIndex: number) => Promise<void>
  onLineAdd: (sceneId: string, characterId: string, text: string, insertAfterIndex?: number) => Promise<void>
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onLineEmotionChange: (sceneId: string, lineIndex: number, newEmotion: string) => Promise<void>
  onLineCharacterChange: (sceneId: string, lineIndex: number, newCharacterId: string) => Promise<void>
  onImageRegen: (sceneId: string, customPrompt?: string) => Promise<void>
  onImageUpload: (sceneId: string, dataUrl: string) => void
  onSceneDescriptionUpdate: (sceneId: string, newDescription: string) => void
  onSceneTitleUpdate: (sceneId: string, newTitle: string) => void
  onSceneRegen: (sceneId: string, newDescription: string, style: string, lineLength?: string, imageStyle?: string, mood?: string) => Promise<void>
  onBatchRegenVoice: () => void
  onSceneRegenAllVoices: (sceneId: string) => Promise<void>
  batchRegenStatus: { done: number; total: number } | null
  onBatchRegenImages: () => void
  onBatchRegenAllImages: () => void
  batchImageStatus: { done: number; total: number } | null
  onLinesReorder: (sceneId: string, newLines: ScriptLine[]) => void
  onScrollToEditor?: () => void
}

interface SceneCardProps {
  scene: Scene
  sceneIndex: number
  totalScenes: number
  characters: Character[]
  isCollapsed: boolean
  onToggleCollapse: (sceneId: string) => void
  onSceneDelete: (sceneId: string) => void
  onSceneMove: (sceneId: string, direction: 'up' | 'down') => void
  onSceneDuplicate: (sceneId: string) => void
  onLineMove: (sceneId: string, lineIndex: number, direction: 'up' | 'down') => void
  onLineEditConfirm: (sceneId: string, lineIndex: number, newText: string) => Promise<void>
  onLineDelete: (sceneId: string, lineIndex: number) => void
  onLineDuplicate: (sceneId: string, lineIndex: number) => Promise<void>
  onLineAdd: (sceneId: string, characterId: string, text: string, insertAfterIndex?: number) => Promise<void>
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onLineEmotionChange: (sceneId: string, lineIndex: number, newEmotion: string) => Promise<void>
  onLineCharacterChange: (sceneId: string, lineIndex: number, newCharacterId: string) => Promise<void>
  onImageRegen: (sceneId: string, customPrompt?: string) => Promise<void>
  onImageUpload: (sceneId: string, dataUrl: string) => void
  onSceneDescriptionUpdate: (sceneId: string, newDescription: string) => void
  onSceneTitleUpdate: (sceneId: string, newTitle: string) => void
  onSceneRegen: (sceneId: string, newDescription: string, style: string, lineLength?: string, imageStyle?: string, mood?: string) => Promise<void>
  onSceneRegenAllVoices: (sceneId: string) => Promise<void>
  onFocusScene: () => void
  isFocused: boolean
  onPlayFromScene: (sceneIndex: number) => void
  onReadFromScene: (sceneIndex: number) => void
  onLinesReorder: (sceneId: string, newLines: ScriptLine[]) => void
  searchQuery?: string
}

function SceneCard({
  scene,
  sceneIndex,
  totalScenes,
  characters,
  isCollapsed,
  onToggleCollapse,
  onSceneDelete,
  onSceneMove,
  onSceneDuplicate,
  onLineMove,
  onLineEditConfirm,
  onLineDelete,
  onLineDuplicate,
  onLineAdd,
  onLineVoiceRegen,
  onLineEmotionChange,
  onLineCharacterChange,
  onImageRegen,
  onImageUpload,
  onSceneDescriptionUpdate,
  onSceneTitleUpdate,
  onSceneRegen,
  onSceneRegenAllVoices,
  onFocusScene,
  isFocused,
  onPlayFromScene,
  onReadFromScene,
  onLinesReorder,
  searchQuery = '',
}: SceneCardProps) {
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [playProgress, setPlayProgress] = useState(0)  // 0–100 percent
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])
  const lineItemRefs = useRef<(HTMLDivElement | null)[]>([])
  const linesLengthRef = useRef(scene.lines.length)
  const playLineRef = useRef<((i: number) => void) | null>(null)
  const [playSpeed, setPlaySpeed] = useState(1.0)
  const playSpeedRef = useRef(playSpeed)

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

  // Auto-scroll the playing line into view so users can follow along
  useEffect(() => {
    if (playingIndex === null) return
    lineItemRefs.current[playingIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [playingIndex])

  // Edit state
  const [editingLineIndex, setEditingLineIndex] = useState<number | null>(null)
  const [editLineText, setEditLineText] = useState('')
  const [regenVoiceIndex, setRegenVoiceIndex] = useState<number | null>(null)
  const [emotionRegenIndex, setEmotionRegenIndex] = useState<number | null>(null)
  const [charChangeIndex, setCharChangeIndex] = useState<number | null>(null)
  const [rephraseLoading, setRephraseLoading] = useState(false)
  const [rephraseSuggestions, setRephraseSuggestions] = useState<string[]>([])
  const [rephraseRateLimit, setRephraseRateLimit] = useState(0)
  const rephraseRateLimitRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [regenImage, setRegenImage] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imageUploadError, setImageUploadError] = useState<string | null>(null)
  const imageUploadRef = useRef<HTMLInputElement>(null)
  const [showPromptEdit, setShowPromptEdit] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState(scene.script.scene_prompt || '')
  const [showRegenForm, setShowRegenForm] = useState(false)
  const [showAddLine, setShowAddLine] = useState(false)
  const [addCharId, setAddCharId] = useState('')
  const [addLineText, setAddLineText] = useState('')
  const [addLineLoading, setAddLineLoading] = useState(false)
  const [lineSuggestLoading, setLineSuggestLoading] = useState(false)
  const [lineSuggestions, setLineSuggestions] = useState<string[]>([])
  const [lineSuggestRateLimit, setLineSuggestRateLimit] = useState(0)
  const lineSuggestRateLimitRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // null = append to end; number = insert after that line index
  const [insertAfterIndex, setInsertAfterIndex] = useState<number | null>(null)

  // Inline delete confirmation — avoids blocking window.confirm
  const [confirmDeleteScene, setConfirmDeleteScene] = useState(false)
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current) }, [])
  useEffect(() => () => { if (rephraseRateLimitRef.current) clearInterval(rephraseRateLimitRef.current) }, [])
  useEffect(() => () => { if (lineSuggestRateLimitRef.current) clearInterval(lineSuggestRateLimitRef.current) }, [])

  // Keep editedPrompt in sync when scene_prompt changes (e.g. after full scene regen)
  useEffect(() => {
    setEditedPrompt(scene.script.scene_prompt || '')
  }, [scene.script.scene_prompt])
  // Inline scene title edit (short user label, e.g. "開場", "高潮", "結局")
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleText, setEditTitleText] = useState(scene.title ?? '')
  useEffect(() => {
    if (!editingTitle) setEditTitleText(scene.title ?? '')
  }, [scene.title, editingTitle])

  const commitTitle = () => {
    const v = editTitleText.trim()
    onSceneTitleUpdate(scene.id, v)
    setEditingTitle(false)
  }

  // Inline description edit
  const [editingDesc, setEditingDesc] = useState(false)
  const [editDescText, setEditDescText] = useState(scene.description)
  // Keep local text in sync if description changes externally (e.g. after full regen)
  useEffect(() => {
    if (!editingDesc) setEditDescText(scene.description)
  }, [scene.description, editingDesc])

  const [regenDesc, setRegenDesc] = useState(scene.description)
  // Keep regen form pre-fill in sync when description is edited inline (while form is closed)
  useEffect(() => {
    if (!showRegenForm) setRegenDesc(scene.description)
  }, [scene.description, showRegenForm])
  const [regenStyle, setRegenStyle] = useState(scene.style)
  const [regenLineLength, setRegenLineLength] = useState<'short' | 'standard' | 'long'>(
    (scene.line_length as 'short' | 'standard' | 'long') || 'standard'
  )
  const [regenImageStyle, setRegenImageStyle] = useState<string>(
    () => localStorage.getItem('scene_image_style') || '水彩繪本'
  )
  const [regenMood, setRegenMood] = useState<string>(
    () => localStorage.getItem('scene_mood') ?? ''
  )
  const [regenLoading, setRegenLoading] = useState(false)
  const [regenError, setRegenError] = useState<string | null>(null)
  const [regenAllVoicesLoading, setRegenAllVoicesLoading] = useState(false)
  const [expandedImage, setExpandedImage] = useState(false)

  const getCharacter = (id: string) => characters.find(c => c.id === id)

  // Close lightbox on Escape
  useEffect(() => {
    if (!expandedImage) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedImage(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expandedImage])

  // Keep linesLengthRef current so onended always sees the latest count
  useEffect(() => { linesLengthRef.current = scene.lines.length }, [scene.lines.length])

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
      audio.playbackRate = playSpeedRef.current
      audio.onended = () => {
        setPlayingIndex(null)
        if (index + 1 < linesLengthRef.current) {
          setTimeout(() => playLineRef.current?.(index + 1), 300)
        }
      }
      return index
    })
  }, [])

  // Always point the refs at the latest values so closures inside onended stay fresh
  playLineRef.current = playLine
  playSpeedRef.current = playSpeed

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

  const [copied, setCopied] = useState(false)
  const handleCopyScript = () => {
    const lines = scene.lines
      .filter(l => l.text)
      .map(l => {
        const char = getCharacter(l.character_id)
        const emoji = char?.emoji || '🎭'
        return `${emoji}${l.character_name}：「${l.text}」`
      })
      .join('\n')
    const text = `第${sceneIndex + 1}幕：${scene.description}\n${lines}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  const isGenerating = scene.lines.length === 0

  // Drag-to-reorder for dialogue lines
  const lineSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const isDragDisabled = isGenerating || regenLoading || editingLineIndex !== null || showAddLine ||
    regenVoiceIndex !== null || emotionRegenIndex !== null || charChangeIndex !== null
  const handleLineDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    // Stop any in-progress audio before reordering so playingIndex stays consistent
    audioRefs.current.forEach(a => { if (a) { a.pause(); a.currentTime = 0 } })
    setPlayingIndex(null)
    const oldIndex = parseInt(String(active.id))
    const newIndex = parseInt(String(over.id))
    onLinesReorder(scene.id, arrayMove(scene.lines, oldIndex, newIndex))
  }

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
    setEditLineText(text.slice(0, 200))
  }

  const handleConfirmEditLine = async (index: number) => {
    const newText = editLineText.trim().slice(0, 200)
    if (!newText) return
    // Close edit form immediately, then show voice-loading while regen runs
    setEditingLineIndex(null)
    setRephraseSuggestions([])
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
    setRephraseSuggestions([])
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

  const handleImageFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (imageUploadRef.current) imageUploadRef.current.value = ''
    if (!file) return
    setImageUploadError(null)
    if (file.size > 4 * 1024 * 1024) {
      setImageUploadError('圖片檔案請勿超過 4 MB')
      return
    }
    setUploadingImage(true)
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      if (dataUrl) onImageUpload(scene.id, dataUrl)
      setUploadingImage(false)
    }
    reader.onerror = () => setUploadingImage(false)
    reader.readAsDataURL(file)
  }

  const handleSceneRegenSubmit = async () => {
    if (!regenDesc.trim()) return
    setRegenLoading(true)
    setRegenError(null)
    try {
      await onSceneRegen(scene.id, regenDesc.trim(), regenStyle, regenLineLength, regenImageStyle, regenMood || undefined)
      setShowRegenForm(false)
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : '重新生成失敗，請稍後重試')
    } finally {
      setRegenLoading(false)
    }
  }

  const hasAudio = scene.lines.some(l => l.audio_base64)
  // A line counts as failed if it has no audio AND generation has already
  // been attempted for this scene.  Without `voices_attempted`, if ALL lines
  // fail (e.g. TTS provider is down), hasAudio would be false and every line
  // would show "音訊生成中…" forever instead of the retry button.
  const isAudioFailed = (line: { audio_base64?: string }) =>
    (hasAudio || !!scene.voices_attempted) && !line.audio_base64

  // Estimated duration for this scene (~4 Chinese chars per second)
  const sceneSecs = useMemo(
    () => Math.round(scene.lines.reduce((m, l) => m + l.text.length, 0) / 4),
    [scene.lines]
  )

  return (
    <div className={`scene-card${isCollapsed ? ' scene-card-collapsed' : ''}`}>
      <div className="scene-card-header">
        <span className="scene-card-title">
          第 {sceneIndex + 1} 幕
          {/* User-defined short scene title */}
          {editingTitle ? (
            <input
              className="scene-title-edit-input"
              value={editTitleText}
              placeholder="幕次標題（選填）"
              maxLength={100}
              autoFocus
              onChange={e => setEditTitleText(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') { setEditingTitle(false); setEditTitleText(scene.title ?? '') }
              }}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              className={`scene-title-label${scene.title ? ' has-title' : ''}`}
              onDoubleClick={e => { e.stopPropagation(); setEditingTitle(true) }}
              title={scene.title ? '雙擊編輯標題' : '雙擊新增幕次標題'}
            >
              {scene.title || <span className="scene-title-placeholder">雙擊加標題</span>}
            </span>
          )}
          {sceneSecs >= 5 && (
            <span
              className="scene-duration-badge"
              title="依台詞字數估算播放時長（約 4 字/秒）"
            >
              約 {Math.floor(sceneSecs / 60)}:{String(sceneSecs % 60).padStart(2, '0')}
            </span>
          )}
          {scene.line_length === 'short' && (
            <span className="scene-length-badge scene-length-short" title="幼兒模式（≤12字/句）">👶 幼兒</span>
          )}
          {scene.line_length === 'long' && (
            <span className="scene-length-badge scene-length-long" title="進階模式（≤35字/句）">🧒 進階</span>
          )}
        </span>
        {/* Thumbnail preview — only shown in collapsed state, lets users identify scenes without expanding */}
        {isCollapsed && scene.image && scene.image !== 'error' && (
          <img
            className="scene-header-thumb"
            src={resolveImgSrc(scene.image)}
            alt={`第${sceneIndex + 1}幕縮圖`}
            onClick={() => onToggleCollapse(scene.id)}
            title="點擊展開此幕"
          />
        )}
        {editingDesc ? (
          <input
            className="scene-desc-edit-input"
            value={editDescText}
            maxLength={500}
            autoFocus
            onChange={e => setEditDescText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = editDescText.trim()
                if (v) onSceneDescriptionUpdate(scene.id, v)
                setEditingDesc(false)
              }
              if (e.key === 'Escape') {
                setEditingDesc(false)
                setEditDescText(scene.description)
              }
            }}
            onBlur={() => {
              const v = editDescText.trim()
              if (v && v !== scene.description) onSceneDescriptionUpdate(scene.id, v)
              setEditingDesc(false)
            }}
          />
        ) : (
          <div className="scene-desc-wrap">
            <span className="scene-card-desc">{highlightText(scene.description, searchQuery)}</span>
            <button
              className="btn-edit-desc"
              onClick={() => { setEditDescText(scene.description); setEditingDesc(true) }}
              title="編輯場景描述（不重新生成）"
            >✏️</button>
          </div>
        )}
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
          <button
            className="btn-play-from-scene btn-read-scene"
            onClick={() => onReadFromScene(sceneIndex)}
            title="從此幕開始閱讀（全螢幕閱讀模式）"
          >
            📖
          </button>
          {totalScenes > 1 && (
            <button
              className={`btn-focus-scene${isFocused ? ' active' : ''}`}
              onClick={onFocusScene}
              title={isFocused ? '取消聚焦，展開所有場景' : '聚焦此幕（收合其他場景）'}
            >🎯</button>
          )}
          <button
            className="btn-scene-collapse"
            onClick={() => onToggleCollapse(scene.id)}
            title={isCollapsed ? '展開此幕' : '收合此幕'}
          >{isCollapsed ? '▼ 展開' : '▲ 收合'}</button>
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

      {isCollapsed ? null : (<>

      {/* Action buttons row */}
      <div className="scene-card-actions">
        <input
          ref={imageUploadRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={handleImageFileUpload}
        />
        <button
          className="btn-scene-action btn-upload-image"
          onClick={() => imageUploadRef.current?.click()}
          disabled={uploadingImage || regenImage}
          title="上傳自訂插圖（取代 AI 生成圖，最大 4 MB）"
        >
          {uploadingImage ? <><span className="spinner-sm" /> 載入中...</> : '📁 上傳插圖'}
        </button>
        {imageUploadError && (
          <span className="image-upload-error">{imageUploadError}</span>
        )}
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
          className="btn-scene-action btn-regen-all-voices"
          onClick={async () => {
            setRegenAllVoicesLoading(true)
            try { await onSceneRegenAllVoices(scene.id) }
            finally { setRegenAllVoicesLoading(false) }
          }}
          disabled={regenAllVoicesLoading || isGenerating || regenLoading}
          title="清除並重新生成此幕所有配音（更換角色聲音後使用）"
        >
          {regenAllVoicesLoading ? <><span className="spinner-sm" /> 配音中...</> : '🎤 重新生成全部配音'}
        </button>
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
          <div className="style-row" style={{ marginTop: '6px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>情感基調</label>
            <div className="style-buttons">
              <button
                className={`style-btn ${regenMood === '' ? 'active' : ''}`}
                onClick={() => setRegenMood('')}
                type="button"
                title="由 AI 根據場景描述自動決定情感基調"
              >🤖 自動</button>
              {([
                { value: '輕鬆愉快', emoji: '😄' },
                { value: '溫馨感動', emoji: '🥰' },
                { value: '緊張刺激', emoji: '😱' },
                { value: '搞笑幽默', emoji: '😂' },
                { value: '神奇夢幻', emoji: '✨' },
              ]).map(opt => (
                <button
                  key={opt.value}
                  className={`style-btn ${regenMood === opt.value ? 'active' : ''}`}
                  onClick={() => setRegenMood(opt.value)}
                  type="button"
                  title={opt.value}
                >{opt.emoji} {opt.value}</button>
              ))}
            </div>
          </div>
          <div className="style-row" style={{ marginTop: '6px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>插圖風格</label>
            <div className="style-buttons">
              {IMAGE_STYLES.map(s => (
                <button
                  key={s}
                  className={`style-btn ${regenImageStyle === s ? 'active' : ''}`}
                  onClick={() => setRegenImageStyle(s)}
                  type="button"
                >{s}</button>
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
            <div className="output-header-actions">
              <button
                className={`btn-copy-script${copied ? ' copied' : ''}`}
                onClick={handleCopyScript}
                title="複製此幕劇本文字"
              >{copied ? '✓ 已複製' : '📄 複製'}</button>
              <div className="scene-speed-btns">
                {([0.75, 1.0, 1.5] as const).map(s => (
                  <button
                    key={s}
                    className={`scene-speed-btn${playSpeed === s ? ' active' : ''}`}
                    onClick={() => {
                      setPlaySpeed(s)
                      if (playingIndex !== null) {
                        const a = audioRefs.current[playingIndex]
                        if (a) a.playbackRate = s
                      }
                    }}
                    title={`播放速度 ${s}×`}
                  >{s === 1 ? '1×' : `${s}×`}</button>
                ))}
              </div>
              <button className="btn-play-all" onClick={playAll}>▶ 全部播放</button>
            </div>
          </div>

          <DndContext sensors={lineSensors} collisionDetection={closestCenter} onDragEnd={handleLineDragEnd}>
            <SortableContext items={scene.lines.map((_, j) => String(j))} strategy={verticalListSortingStrategy}>
              <div className="dialogue-list">
                {scene.lines.map((line, i) => {
                  const char = getCharacter(line.character_id)
                  const color = char?.color || '#888'
                  const isPlaying = playingIndex === i
                  const isEditingThis = editingLineIndex === i
                  const isRegenVoice = regenVoiceIndex === i

                  return (
                    <Fragment key={i}>
                    <SortableLine id={String(i)} disabled={isDragDisabled}>
                    <div
                      ref={el => { lineItemRefs.current[i] = el }}
                      className={`dialogue-line ${isPlaying ? 'playing' : ''}`}
                      style={{ borderLeftColor: color }}
                >
                  <div className="dialogue-speaker">
                    <span className="speaker-emoji">{char?.emoji || '🎭'}</span>
                    <span className="speaker-name" style={{ color }}>{highlightText(line.character_name, searchQuery)}</span>
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
                          onChange={e => { setEditLineText(e.target.value.slice(0, 200)); setRephraseSuggestions([]) }}
                          onKeyDown={e => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                              e.preventDefault()
                              if (editLineText.trim()) handleConfirmEditLine(i)
                            } else if (e.key === 'Escape') {
                              handleCancelEditLine()
                            }
                          }}
                          maxLength={200}
                          rows={2}
                          autoFocus
                        />
                        <p className="line-char-count" style={{ color: editLineText.length >= 180 ? '#e53e3e' : editLineText.length >= 150 ? '#e07b00' : '#bbb' }}>
                          {editLineText.length} / 200
                          <span className="line-edit-hint">Ctrl+Enter 確認・Esc 取消</span>
                        </p>
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
                          <button
                            className="btn-rephrase"
                            disabled={rephraseLoading || !editLineText.trim() || rephraseRateLimit > 0}
                            title={rephraseRateLimit > 0 ? `${rephraseRateLimit} 秒後可重試` : 'AI 改寫建議'}
                            onClick={async () => {
                              setRephraseLoading(true)
                              setRephraseSuggestions([])
                              try {
                                const res = await fetch('/api/rephrase-line', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    text: editLineText.trim(),
                                    character_name: line.character_name,
                                    personality: char?.personality ?? '',
                                    style: scene.style || '溫馨童趣',
                                  }),
                                })
                                if (res.status === 429) {
                                  const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
                                  setRephraseRateLimit(wait)
                                  if (rephraseRateLimitRef.current) clearInterval(rephraseRateLimitRef.current)
                                  rephraseRateLimitRef.current = setInterval(() => {
                                    setRephraseRateLimit(prev => {
                                      if (prev <= 1) { clearInterval(rephraseRateLimitRef.current!); rephraseRateLimitRef.current = null; return 0 }
                                      return prev - 1
                                    })
                                  }, 1000)
                                } else if (res.ok) {
                                  const data = await res.json()
                                  setRephraseSuggestions(data.suggestions ?? [])
                                }
                              } catch {}
                              finally { setRephraseLoading(false) }
                            }}
                          >
                            {rephraseLoading ? <><span className="spinner-sm" /> 生成中...</> : '✨ AI 潤色'}
                          </button>
                        </div>
                        {rephraseRateLimit > 0 && (
                          <div className="suggest-ratelimit-msg">
                            請求過於頻繁，請等 <strong>{rephraseRateLimit}</strong> 秒後再試
                          </div>
                        )}
                        {rephraseSuggestions.length > 0 && (
                          <div className="rephrase-suggestions">
                            <span className="rephrase-suggestions-label">選一個版本填入：</span>
                            {rephraseSuggestions.map((s, si) => (
                              <button
                                key={si}
                                className="rephrase-chip"
                                onClick={() => { setEditLineText(s.slice(0, 200)); setRephraseSuggestions([]) }}
                                title="點擊套用此版本"
                              >{s}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="dialogue-text-row">
                        <p className="dialogue-text">{highlightText(line.text, searchQuery)}</p>
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
                          className="btn-duplicate-line"
                          onClick={() => onLineDuplicate(scene.id, i)}
                          title="複製此行台詞（插入下方）"
                        >
                          📋
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
                          <button
                            className="btn-download-audio"
                            onClick={() => {
                              const fmt = line.audio_format || 'wav'
                              const byteString = atob(line.audio_base64!)
                              const ab = new ArrayBuffer(byteString.length)
                              const ia = new Uint8Array(ab)
                              for (let j = 0; j < byteString.length; j++) ia[j] = byteString.charCodeAt(j)
                              const blob = new Blob([ab], { type: `audio/${fmt}` })
                              const url = URL.createObjectURL(blob)
                              const a = document.createElement('a')
                              a.href = url
                              a.download = `第${sceneIndex + 1}幕_第${i + 1}句_${line.character_name}.${fmt}`
                              a.click()
                              URL.revokeObjectURL(url)
                            }}
                            title={`下載 ${line.character_name} 的配音音檔 (.${line.audio_format || 'wav'})`}
                          >
                            💾
                          </button>
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
                    </SortableLine>
                    {/* Insert-between button: shown between consecutive lines */}
                    {i < scene.lines.length - 1 && !showAddLine && (
                      <div className="insert-line-divider">
                        <button
                          className="btn-insert-between"
                          onClick={() => {
                            setInsertAfterIndex(i)
                            setAddCharId(line.character_id)
                            setAddLineText('')
                            setShowAddLine(true)
                          }}
                          title={`在第 ${i + 1} 句之後插入新台詞`}
                        >＋ 插入</button>
                      </div>
                    )}
                    </Fragment>
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>

          {/* Add new line */}
          {showAddLine ? (
            <div className="add-line-form">
              {insertAfterIndex !== null && (
                <div className="add-line-position-label">
                  插入位置：第 {insertAfterIndex + 1} 句之後
                </div>
              )}
              <select
                className="add-line-char-select"
                value={addCharId}
                onChange={e => { setAddCharId(e.target.value); setLineSuggestions([]) }}
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
                onChange={e => { setAddLineText(e.target.value.slice(0, 200)); setLineSuggestions([]) }}
                onKeyDown={async e => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    if (!addCharId || !addLineText.trim() || addLineLoading) return
                    setAddLineLoading(true)
                    try {
                      await onLineAdd(scene.id, addCharId, addLineText, insertAfterIndex ?? undefined)
                      setShowAddLine(false)
                      setAddCharId('')
                      setAddLineText('')
                      setInsertAfterIndex(null)
                      setLineSuggestions([])
                    } finally {
                      setAddLineLoading(false)
                    }
                  } else if (e.key === 'Escape') {
                    setShowAddLine(false)
                    setAddCharId('')
                    setAddLineText('')
                    setInsertAfterIndex(null)
                    setLineSuggestions([])
                  }
                }}
                placeholder="輸入台詞（最多200字）"
                rows={2}
                disabled={addLineLoading}
                autoFocus
              />
              <p className="line-char-count" style={{ color: addLineText.length >= 180 ? '#e53e3e' : addLineText.length >= 150 ? '#e07b00' : '#bbb' }}>
                {addLineText.length} / 200
                <span className="line-edit-hint">Ctrl+Enter 新增・Esc 取消</span>
              </p>
              <div className="line-edit-btns">
                <button
                  className="btn-scene-action"
                  disabled={!addCharId || !addLineText.trim() || addLineLoading}
                  onClick={async () => {
                    setAddLineLoading(true)
                    try {
                      await onLineAdd(scene.id, addCharId, addLineText, insertAfterIndex ?? undefined)
                      setShowAddLine(false)
                      setAddCharId('')
                      setAddLineText('')
                      setInsertAfterIndex(null)
                      setLineSuggestions([])
                    } finally {
                      setAddLineLoading(false)
                    }
                  }}
                >
                  {addLineLoading ? <><span className="spinner-sm" /> 配音生成中...</> : '✓ 新增台詞'}
                </button>
                <button
                  className="btn-rephrase"
                  disabled={!addCharId || lineSuggestLoading || addLineLoading || lineSuggestRateLimit > 0}
                  title={lineSuggestRateLimit > 0 ? `${lineSuggestRateLimit} 秒後可重試` : '根據場景與角色個性，AI 建議下一句台詞'}
                  onClick={async () => {
                    const char = getCharacter(addCharId)
                    if (!char) return
                    setLineSuggestLoading(true)
                    setLineSuggestions([])
                    try {
                      const contextLines = insertAfterIndex !== null
                        ? scene.lines.slice(0, insertAfterIndex + 1)
                        : scene.lines
                      const res = await fetch('/api/suggest-line', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          character_name: char.name,
                          personality: char.personality || '',
                          scene_description: scene.description,
                          style: scene.style || '溫馨童趣',
                          previous_lines: contextLines.map(l => ({
                            character_name: l.character_name,
                            text: l.text,
                          })),
                          line_length: scene.line_length || 'standard',
                        }),
                      })
                      if (res.status === 429) {
                        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
                        setLineSuggestRateLimit(wait)
                        if (lineSuggestRateLimitRef.current) clearInterval(lineSuggestRateLimitRef.current)
                        lineSuggestRateLimitRef.current = setInterval(() => {
                          setLineSuggestRateLimit(prev => {
                            if (prev <= 1) { clearInterval(lineSuggestRateLimitRef.current!); lineSuggestRateLimitRef.current = null; return 0 }
                            return prev - 1
                          })
                        }, 1000)
                      } else if (res.ok) {
                        const data = await res.json()
                        setLineSuggestions(data.suggestions ?? [])
                      }
                    } catch {}
                    finally { setLineSuggestLoading(false) }
                  }}
                >
                  {lineSuggestLoading ? <><span className="spinner-sm" /> 生成中...</> : '✨ AI 建議台詞'}
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => { setShowAddLine(false); setAddCharId(''); setAddLineText(''); setInsertAfterIndex(null); setLineSuggestions([]) }}
                  disabled={addLineLoading}
                  style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                >
                  取消
                </button>
              </div>
              {lineSuggestRateLimit > 0 && (
                <div className="suggest-ratelimit-msg">
                  請求過於頻繁，請等 <strong>{lineSuggestRateLimit}</strong> 秒後再試
                </div>
              )}
              {lineSuggestions.length > 0 && (
                <div className="rephrase-suggestions">
                  <span className="rephrase-suggestions-label">選一條台詞填入：</span>
                  {lineSuggestions.map((s, si) => (
                    <button
                      key={si}
                      className="rephrase-chip"
                      onClick={() => { setAddLineText(s); setLineSuggestions([]) }}
                      title="點擊套用此台詞"
                    >{s}</button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              className="btn-add-line"
              onClick={() => {
                setInsertAfterIndex(null)
                setAddCharId(scene.lines[0]?.character_id || '')
                setAddLineText('')
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

      </>)}
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
  onLineDuplicate,
  onLineAdd,
  onLineVoiceRegen,
  onLineEmotionChange,
  onLineCharacterChange,
  onImageRegen,
  onImageUpload,
  onSceneDescriptionUpdate,
  onSceneTitleUpdate,
  onSceneRegen,
  onBatchRegenVoice,
  onSceneRegenAllVoices,
  batchRegenStatus,
  onBatchRegenImages,
  onBatchRegenAllImages,
  batchImageStatus,
  onLinesReorder,
  onScrollToEditor,
}: Props) {
  const [showPlayback, setShowPlayback] = useState(false)
  const [playbackStartScene, setPlaybackStartScene] = useState(0)
  const [showBookPreview, setShowBookPreview] = useState(false)
  const [bookPreviewStart, setBookPreviewStart] = useState(0)
  const [viewMode, setViewMode] = useState<'detail' | 'storyboard'>('detail')
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  const toggleCollapse = (sceneId: string) =>
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(sceneId) ? next.delete(sceneId) : next.add(sceneId)
      return next
    })

  const allCollapsed = scenes.length > 0 && scenes.every(s => collapsedIds.has(s.id))
  const collapseAll = () => setCollapsedIds(new Set(scenes.map(s => s.id)))
  const expandAll  = () => setCollapsedIds(new Set())

  // Collapse every scene except the given one. If already focused, expand all.
  const focusScene = (sceneId: string) => {
    const alreadyFocused = scenes.filter(s => s.id !== sceneId).every(s => collapsedIds.has(s.id))
    setCollapsedIds(alreadyFocused
      ? new Set()
      : new Set(scenes.filter(s => s.id !== sceneId).map(s => s.id))
    )
  }
  const sceneRefs = useRef<(HTMLDivElement | null)[]>([])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Track which scene card is currently in view to highlight the nav chip
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)
  const intersectingIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (scenes.length < 2) { setActiveSceneId(null); return }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => {
        const id = (e.target as HTMLElement).dataset.sceneId
        if (!id) return
        if (e.isIntersecting) intersectingIdsRef.current.add(id)
        else intersectingIdsRef.current.delete(id)
      })
      // Highlight the topmost visible scene (first in scenes array order)
      const activeId = scenes.find(s => intersectingIdsRef.current.has(s.id))?.id ?? null
      setActiveSceneId(activeId)
    }, { rootMargin: '-80px 0px -75% 0px', threshold: 0 })

    intersectingIdsRef.current.clear()
    sceneRefs.current.forEach((ref, i) => {
      if (ref && scenes[i]) {
        ref.dataset.sceneId = scenes[i].id
        observer.observe(ref)
      }
    })
    return () => { observer.disconnect(); intersectingIdsRef.current.clear() }
  }, [scenes])

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

  // ── Memoized derived state ──────────────────────────────────
  // activeSceneId changes on every scroll (IntersectionObserver), which
  // re-renders this component. Memoizing here prevents these O(scenes×lines)
  // iterations from running on each scroll event.
  const hasAudio = useMemo(
    () => scenes.some(s => s.lines.some(l => l.audio_base64)),
    [scenes]
  )
  const missingAudioCount = useMemo(
    () => scenes.reduce((n, s) => n + s.lines.filter(l => l.text && !l.audio_base64).length, 0),
    [scenes]
  )
  const missingImageCount = useMemo(
    () => scenes.filter(s => !s.image || s.image === 'error').length,
    [scenes]
  )
  const hasImages = useMemo(
    () => scenes.some(s => s.image && s.image !== 'error'),
    [scenes]
  )
  const totalLines = useMemo(
    () => scenes.reduce((n, s) => n + s.lines.length, 0),
    [scenes]
  )
  // charStats is O(characters × scenes × lines) — most expensive of the group
  const charStats = useMemo(
    () => characters
      .map(c => ({
        id: c.id, name: c.name, emoji: c.emoji, color: c.color,
        count: scenes.reduce((n, s) => n + s.lines.filter(l => l.character_id === c.id).length, 0),
      }))
      .filter(c => c.count > 0),
    [scenes, characters]
  )
  // Estimated total playback duration based on Chinese speech rate (~4 chars/sec at 1×)
  const estimatedSecs = useMemo(
    () => Math.round(
      scenes.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.text.length, 0), 0) / 4
    ),
    [scenes]
  )

  // ── Cross-scene search ────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  // Separate counts: how many scenes match by description, how many lines match by text/character
  const { descMatchCount, lineMatchCount } = useMemo(() => {
    if (!searchQuery.trim()) return { descMatchCount: 0, lineMatchCount: 0 }
    const q = searchQuery.toLowerCase()
    let desc = 0, lines = 0
    scenes.forEach(s => {
      if (s.description.toLowerCase().includes(q)) desc++
      lines += s.lines.filter(l =>
        l.text.toLowerCase().includes(q) || l.character_name.toLowerCase().includes(q)
      ).length
    })
    return { descMatchCount: desc, lineMatchCount: lines }
  }, [searchQuery, scenes])
  const matchCount = descMatchCount + lineMatchCount

  // Auto-expand scenes that contain matching lines or description when the query changes
  useEffect(() => {
    if (!searchQuery.trim()) return
    const q = searchQuery.toLowerCase()
    setCollapsedIds(prev => {
      const next = new Set(prev)
      scenes.forEach(s => {
        const hasMatch =
          s.description.toLowerCase().includes(q) ||
          s.lines.some(l =>
            l.text.toLowerCase().includes(q) || l.character_name.toLowerCase().includes(q)
          )
        if (hasMatch) next.delete(s.id)
      })
      return next
    })
  }, [searchQuery, scenes])

  if (scenes.length === 0) return null

  const scrollToScene = (index: number) => {
    const targetId = scenes[index]?.id
    if (targetId && collapsedIds.has(targetId)) {
      // Expand the scene first; wait one animation frame for React to commit the
      // expanded DOM before scrolling, so scrollIntoView targets the full height.
      setCollapsedIds(prev => { const next = new Set(prev); next.delete(targetId); return next })
      requestAnimationFrame(() =>
        sceneRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      )
    } else {
      sceneRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const handlePlayFromScene = (sceneIndex: number) => {
    setPlaybackStartScene(sceneIndex)
    setShowPlayback(true)
  }

  const handleReadFromScene = (sceneIndex: number) => {
    setBookPreviewStart(sceneIndex)
    setShowBookPreview(true)
  }

  return (
    <div className="scene-output-panel">
      <div className="scene-sticky-bar">
        {(hasAudio || missingAudioCount > 0 || missingImageCount > 0 || hasImages) && (
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
            {hasImages && missingImageCount === 0 && (
              <button
                className="btn-batch-regen btn-batch-image"
                onClick={onBatchRegenAllImages}
                disabled={batchImageStatus !== null || batchRegenStatus !== null}
                title="用目前 AI 重新生成所有場景插圖（更換畫風或角色設定後使用）"
              >
                {batchImageStatus
                  ? `🖼️ 重生中 ${batchImageStatus.done}/${batchImageStatus.total}…`
                  : '🖼️ 全部重新生圖'}
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

        {/* Scene navigation strip — sortable, hidden in storyboard mode */}
        {scenes.length > 1 && viewMode === 'detail' && (
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
                    isActive={scene.id === activeSceneId}
                    onClick={() => scrollToScene(i)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {/* Story stats bar: always show when 2+ scenes so the view-mode toggle is accessible */}
        {(charStats.length > 0 || scenes.length >= 2) && (
          <div className="story-stats-bar">
            <span className="stats-summary">
              {scenes.length} 幕 · {totalLines} 句
              {estimatedSecs >= 5 && (
                <span
                  className="stats-duration"
                  title="依台詞總字數估算（約 4 字/秒），實際時長依語速而異"
                >
                  · 約 {Math.floor(estimatedSecs / 60)}:{String(estimatedSecs % 60).padStart(2, '0')}
                </span>
              )}
            </span>
            {charStats.length > 0 && (
              <div className="stats-chars">
                {charStats.map(c => (
                  <span key={c.id} className="stats-char-badge" style={{ borderColor: c.color, color: c.color }} title={`${c.name} 共 ${c.count} 句`}>
                    {c.emoji} {c.name} <strong>{c.count}</strong>
                  </span>
                ))}
              </div>
            )}
            {scenes.length >= 2 && viewMode === 'detail' && (
              <button
                className="btn-view-toggle"
                onClick={allCollapsed ? expandAll : collapseAll}
                title={allCollapsed ? '展開所有場景' : '收合所有場景'}
              >
                {allCollapsed ? '▼ 全部展開' : '▲ 全部收合'}
              </button>
            )}
            {scenes.length >= 2 && (
              <button
                className={`btn-view-toggle${viewMode === 'storyboard' ? ' active' : ''}`}
                onClick={() => setViewMode(v => v === 'detail' ? 'storyboard' : 'detail')}
                title={viewMode === 'storyboard' ? '返回詳細編輯視圖' : '切換為故事板概覽（只讀）'}
              >
                {viewMode === 'storyboard' ? '📝 編輯模式' : '🗺️ 故事板'}
              </button>
            )}
            <button
              className="btn-view-toggle btn-book-preview"
              onClick={() => { setBookPreviewStart(0); setShowBookPreview(true) }}
              title="全螢幕閱讀模式：逐幕翻頁瀏覽故事（← → 翻頁，適合念給孩子聽）"
            >
              📖 閱讀模式
            </button>
          </div>
        )}

        {/* Cross-scene search bar */}
        {viewMode === 'detail' && (
          <div className="scene-search-bar">
            <span className="scene-search-icon">🔍</span>
            <input
              type="text"
              className="scene-search-input"
              placeholder="搜尋場景描述、台詞或角色..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSearchQuery('') }}
            />
            {searchQuery ? (
              <>
                <span className={`scene-search-count${matchCount === 0 ? ' no-results' : ''}`}>
                  {matchCount === 0 ? '無結果' : [
                    descMatchCount > 0 ? `${descMatchCount} 幕` : '',
                    lineMatchCount > 0 ? `${lineMatchCount} 句` : '',
                  ].filter(Boolean).join('・')}
                </span>
                <button className="scene-search-clear" onClick={() => setSearchQuery('')} title="清除搜尋 (Esc)">×</button>
              </>
            ) : (
              <span className="scene-search-hint">可搜尋場景描述、台詞或角色姓名</span>
            )}
          </div>
        )}
      </div>

      {showPlayback && (
        <PlaybackModal
          scenes={scenes}
          characters={characters}
          onClose={() => setShowPlayback(false)}
          initialSceneIdx={playbackStartScene}
        />
      )}

      {showBookPreview && (
        <BookPreviewModal
          scenes={scenes}
          characters={characters}
          initialScene={bookPreviewStart}
          onClose={() => setShowBookPreview(false)}
        />
      )}

      {viewMode === 'storyboard' ? (
        <div className="storyboard-grid">
          {scenes.map((scene, i) => (
            <StoryboardCard
              key={scene.id}
              scene={scene}
              index={i}
              characters={characters}
              onClick={() => {
                setViewMode('detail')
                setTimeout(() => scrollToScene(i), 60)
              }}
            />
          ))}
        </div>
      ) : (
        scenes.map((scene, i) => (
          <div key={scene.id} ref={el => { sceneRefs.current[i] = el }}>
            <SceneCard
              scene={scene}
              sceneIndex={i}
              totalScenes={scenes.length}
              characters={characters}
              isCollapsed={collapsedIds.has(scene.id)}
              onToggleCollapse={toggleCollapse}
              onSceneDelete={onSceneDelete}
              onSceneMove={onSceneMove}
              onSceneDuplicate={onSceneDuplicate}
              onLineMove={onLineMove}
              onLineEditConfirm={onLineEditConfirm}
              onLineDelete={onLineDelete}
              onLineDuplicate={onLineDuplicate}
              onLineAdd={onLineAdd}
              onLineVoiceRegen={onLineVoiceRegen}
              onLineEmotionChange={onLineEmotionChange}
              onLineCharacterChange={onLineCharacterChange}
              onImageRegen={onImageRegen}
              onImageUpload={onImageUpload}
              onSceneDescriptionUpdate={onSceneDescriptionUpdate}
              onSceneTitleUpdate={onSceneTitleUpdate}
              onSceneRegen={onSceneRegen}
              onSceneRegenAllVoices={onSceneRegenAllVoices}
              onFocusScene={() => focusScene(scene.id)}
              isFocused={scenes.filter(s => s.id !== scene.id).every(s => collapsedIds.has(s.id))}
              onPlayFromScene={handlePlayFromScene}
              onReadFromScene={handleReadFromScene}
              onLinesReorder={onLinesReorder}
              searchQuery={searchQuery}
            />
          </div>
        ))
      )}

      {scenes.length > 0 && onScrollToEditor && viewMode === 'detail' && (
        <div className="continue-story-bar">
          <button className="btn-continue-story" onClick={onScrollToEditor}>
            ✏️ 繼續創作下一幕
          </button>
        </div>
      )}
    </div>
  )
}

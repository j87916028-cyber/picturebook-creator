import { useRef, useState, useCallback, useEffect, useMemo, Fragment } from 'react'
import {
  DndContext, DragEndEvent, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Scene, Character, ScriptLine, EMOTION_LABELS, STORY_STYLES, IMAGE_STYLES, lsSet } from '../types'

const STYLES = STORY_STYLES

// Resolve image src
function resolveImgSrc(image: string): string {
  if (!image) return ''
  if (image.startsWith('data:') || image.startsWith('http') || image.startsWith('/')) return image
  return `data:image/jpeg;base64,${image}`
}

// Highlight search matches
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
  onLineEditTextOnly: (sceneId: string, lineIndex: number, newText: string) => void
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
  onSceneNotesUpdate: (sceneId: string, newNotes: string) => void
  onSceneSfxUpdate: (sceneId: string, newSfx: string) => void
  onSceneRegen: (sceneId: string, newDescription: string, style: string, lineLength?: string, imageStyle?: string, mood?: string, lineCount?: string, ageGroup?: string) => Promise<void>
  onSceneLockToggle: (sceneId: string) => void
  onSceneRegenAllVoices: (sceneId: string) => Promise<void>
  onFocusScene: () => void
  isFocused: boolean
  onPlayFromScene: (sceneIndex: number) => void
  onReadFromScene: (sceneIndex: number) => void
  onLinesReorder: (sceneId: string, newLines: ScriptLine[]) => void
  searchQuery?: string
}


export default function SceneCard({
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
  onLineEditTextOnly,
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
  onSceneNotesUpdate,
  onSceneSfxUpdate,
  onSceneRegen,
  onSceneLockToggle,
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
  const [rephraseError, setRephraseError] = useState(false)
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
  const [lineSuggestError, setLineSuggestError] = useState(false)
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

  // AI scene-title suggestion
  const [titleSuggesting, setTitleSuggesting] = useState(false)
  const [titleSuggestion, setTitleSuggestion] = useState<string | null>(null)
  const suggestSceneTitle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const sceneChars = characters.filter(c => scene.lines.some(l => l.character_id === c.id))
    if (sceneChars.length === 0 || titleSuggesting) return
    setTitleSuggesting(true)
    setTitleSuggestion(null)
    try {
      const res = await fetch('/api/generate-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characters: sceneChars,
          scene_description: scene.description,
          first_lines: scene.lines.slice(0, 5).map(l => l.text),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.title) setTitleSuggestion(data.title)
      }
    } catch { /* silent */ } finally {
      setTitleSuggesting(false)
    }
  }

  // Private director/author notes
  const [showNotes, setShowNotes] = useState(false)
  const [notesText, setNotesText] = useState(scene.notes ?? '')
  useEffect(() => { setNotesText(scene.notes ?? '') }, [scene.notes])
  const commitNotes = () => onSceneNotesUpdate(scene.id, notesText)

  // Inline sfx (background music/sound effect) description edit
  const [editingSfx, setEditingSfx] = useState(false)
  const [sfxText, setSfxText] = useState(scene.script.sfx_description ?? '')
  const [sfxSuggesting, setSfxSuggesting] = useState(false)
  useEffect(() => { if (!editingSfx) setSfxText(scene.script.sfx_description ?? '') }, [scene.script.sfx_description, editingSfx])
  const commitSfx = () => {
    setEditingSfx(false)
    if (sfxText.trim() !== (scene.script.sfx_description ?? '').trim()) {
      onSceneSfxUpdate(scene.id, sfxText.trim())
    }
  }
  const handleSuggestSfx = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (sfxSuggesting) return
    setSfxSuggesting(true)
    try {
      const res = await fetch('/api/suggest-sfx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: scene.description,
          style: scene.style,
          lines: scene.lines.slice(0, 6).map(l => l.text).filter(Boolean),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.sfx) {
          setSfxText(data.sfx)
          onSceneSfxUpdate(scene.id, data.sfx)
        }
      }
    } catch { /* silent */ } finally {
      setSfxSuggesting(false)
    }
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
    () => scene.image_style || localStorage.getItem('scene_image_style') || IMAGE_STYLES[0].value
  )
  // Pre-fill mood from the persisted per-scene value; fall back to localStorage
  // (the global setting) only when the scene has no stored mood (e.g. old projects).
  const [regenMood, setRegenMood] = useState<string>(
    () => scene.mood || localStorage.getItem('scene_mood') || ''
  )
  // Same for age_group: per-scene value takes precedence over the global setting.
  const [regenAgeGroup, setRegenAgeGroup] = useState<'toddler' | 'child' | 'preteen'>(() => {
    const perScene = scene.age_group as 'toddler' | 'child' | 'preteen' | undefined
    if (perScene && ['toddler', 'child', 'preteen'].includes(perScene)) return perScene
    const saved = localStorage.getItem('scene_age_group') as 'toddler' | 'child' | 'preteen' | null
    return saved && ['toddler', 'child', 'preteen'].includes(saved) ? saved : 'child'
  })
  const [regenLineCount, setRegenLineCount] = useState<'few' | 'standard' | 'many'>(() => {
    const saved = localStorage.getItem('scene_line_count')
    return (saved === 'few' || saved === 'many') ? saved : 'standard'
  })
  // Persist regen-form selections so they survive page refresh and stay in sync
  // with SceneEditor (which reads these same keys on init).
  useEffect(() => { lsSet('scene_age_group',   regenAgeGroup)   }, [regenAgeGroup])
  useEffect(() => { lsSet('scene_image_style', regenImageStyle) }, [regenImageStyle])
  useEffect(() => {
    if (regenMood) lsSet('scene_mood', regenMood)
    else localStorage.removeItem('scene_mood')
  }, [regenMood])
  useEffect(() => { lsSet('scene_line_count', regenLineCount) }, [regenLineCount])
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
    const titleSuffix = scene.title ? `_${scene.title}` : ''
    const filename = `第${sceneIndex + 1}幕${titleSuffix}插圖`
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
  const [copiedLineIdx, setCopiedLineIdx] = useState<number | null>(null)
  const handleCopyLine = useCallback((idx: number, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedLineIdx(idx)
      setTimeout(() => setCopiedLineIdx(null), 1500)
    }).catch(() => {})
  }, [])
  const handleCopyScript = () => {
    const lines = scene.lines
      .filter(l => l.text)
      .map(l => {
        const char = getCharacter(l.character_id)
        const emoji = char?.emoji || '🎭'
        return `${emoji}${l.character_name}：「${l.text}」`
      })
      .join('\n')
    const titlePart = scene.title ? `《${scene.title}》` : ''
    const text = `第${sceneIndex + 1}幕${titlePart}：${scene.description}\n${lines}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  const isGenerating = scene.lines.length === 0

  // Drag-to-reorder for dialogue lines
  const lineSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
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

  // Update text only — clears audio but does NOT auto-regenerate voice.
  // Useful for bulk typo fixes where the user wants to defer regen to a batch pass.
  const handleTextOnlyEdit = (index: number) => {
    const newText = editLineText.trim().slice(0, 200)
    if (!newText) return
    setEditingLineIndex(null)
    setRephraseSuggestions([])
    onLineEditTextOnly(scene.id, index, newText)
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
      await onSceneRegen(scene.id, regenDesc.trim(), regenStyle, regenLineLength, regenImageStyle, regenMood || undefined, regenLineCount, regenAgeGroup)
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

  // Audio completion stats for the badge
  const textLineCount = scene.lines.filter(l => l.text).length
  const voicedCount   = scene.lines.filter(l => l.audio_base64).length

  // Unique characters in this scene (ordered by first appearance), for collapsed header chips
  const sceneChars = useMemo(() => {
    const seen = new Set<string>()
    const result: { id: string; emoji: string; name: string; color: string; portrait_url?: string }[] = []
    for (const line of scene.lines) {
      if (line.character_id && !seen.has(line.character_id)) {
        seen.add(line.character_id)
        const char = characters.find(c => c.id === line.character_id)
        if (char) result.push({ id: char.id, emoji: char.emoji, name: char.name, color: char.color, portrait_url: char.portrait_url })
      }
    }
    return result
  }, [scene.lines, characters])

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
            <>
              <span
                className={`scene-title-label${scene.title ? ' has-title' : ''}`}
                onDoubleClick={e => { e.stopPropagation(); setEditingTitle(true) }}
                title={scene.title ? '雙擊編輯標題' : '雙擊新增幕次標題'}
              >
                {scene.title ? highlightText(scene.title, searchQuery) : <span className="scene-title-placeholder">雙擊加標題</span>}
              </span>
              <button
                className={`btn-suggest-scene-title${titleSuggesting ? ' loading' : ''}`}
                onClick={suggestSceneTitle}
                disabled={titleSuggesting}
                title="AI 自動建議幕次標題"
              >
                {titleSuggesting ? <span className="spinner-sm" /> : '✨'}
              </button>
              {titleSuggestion && (
                <button
                  className="btn-apply-title-suggestion"
                  onClick={e => { e.stopPropagation(); onSceneTitleUpdate(scene.id, titleSuggestion); setTitleSuggestion(null) }}
                  title={`點擊套用 AI 建議標題「${titleSuggestion}」`}
                >
                  《{titleSuggestion}》✓
                </button>
              )}
            </>
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
          {/* Audio completion badge: only show after voice generation has been attempted */}
          {scene.voices_attempted && textLineCount > 0 && (
            <span
              className={`scene-audio-badge${
                voicedCount === textLineCount ? ' all' :
                voicedCount === 0 ? ' none' : ' partial'
              }`}
              title={
                voicedCount === textLineCount
                  ? `全部 ${textLineCount} 句已配音`
                  : voicedCount === 0
                    ? `0/${textLineCount} 句已配音，可點「重新生成配音」`
                    : `${voicedCount}/${textLineCount} 句已配音，部分台詞尚未配音`
              }
            >
              🔊 {voicedCount}/{textLineCount}
            </span>
          )}
          {/* Character emoji chips — only shown when collapsed, so user can see who's in this scene */}
          {isCollapsed && sceneChars.length > 0 && (
            <span className="scene-char-chips">
              {sceneChars.slice(0, 5).map(ch => (
                <span
                  key={ch.id}
                  className={`scene-char-chip${ch.portrait_url ? ' scene-char-chip-portrait' : ''}`}
                  style={{ borderColor: ch.color, background: ch.portrait_url ? 'transparent' : `${ch.color}22` }}
                  title={ch.name}
                >
                  {ch.portrait_url
                    ? <img src={ch.portrait_url} alt={ch.name} className="scene-char-chip-img" />
                    : ch.emoji}
                </span>
              ))}
              {sceneChars.length > 5 && (
                <span className="scene-char-chip-more" title={`還有 ${sceneChars.length - 5} 位角色`}>
                  +{sceneChars.length - 5}
                </span>
              )}
            </span>
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
        {/* First dialogue line preview — shown only when collapsed, helps identify scenes without expanding */}
        {isCollapsed && scene.lines.length > 0 && scene.lines[0].text && (
          <div className="scene-collapsed-line-preview" title="點擊展開檢視完整台詞" onClick={() => onToggleCollapse(scene.id)}>
            <span className="collapsed-char">{characters.find(c => c.id === scene.lines[0].character_id)?.emoji || '🎭'}</span>
            <span className="collapsed-text">「{scene.lines[0].text.slice(0, 40)}{scene.lines[0].text.length > 40 ? '…' : ''}」</span>
          </div>
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
        {/* Private notes toggle */}
        <button
          className={`btn-scene-notes-toggle${showNotes ? ' active' : ''}${notesText ? ' has-notes' : ''}`}
          onClick={() => setShowNotes(v => !v)}
          title={notesText ? '導演備註（有內容）' : '新增導演備註（僅自用，不會匯出）'}
        >
          {notesText ? '📝' : '📋'} 備註{notesText ? ' ●' : ''}
        </button>
        {showNotes && (
          <div className="scene-notes-area">
            <textarea
              className="scene-notes-textarea"
              value={notesText}
              placeholder="導演備註：記錄創作思路、修改方向、靈感……此欄位不會出現在任何匯出內容中"
              maxLength={2000}
              rows={3}
              onChange={e => setNotesText(e.target.value)}
              onBlur={commitNotes}
            />
            <span className="scene-notes-hint">{notesText.length}/2000 · 僅自用，不匯出</span>
          </div>
        )}
        {/* Scene lock toggle — protects this scene from batch / accidental regeneration */}
        <button
          className={`btn-scene-lock${scene.is_locked ? ' locked' : ''}`}
          onClick={() => onSceneLockToggle(scene.id)}
          title={scene.is_locked ? '解鎖此幕（允許重新生成）' : '鎖定此幕（防止意外覆寫）'}
        >
          {scene.is_locked ? '🔒' : '🔓'}
        </button>
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
          <button
            className="btn-scene-action"
            onClick={() => handleImageRegen()}
            disabled={regenImage || isGenerating}
            title="用原始提示詞重新生成插圖"
          >
            {regenImage && !showPromptEdit ? <><span className="spinner-sm" /> 生成中...</> : '🔄 重新生成插圖'}
          </button>
        )}
        <button
          className={`btn-scene-action${showPromptEdit ? ' active' : ''}`}
          onClick={() => setShowPromptEdit(v => !v)}
          disabled={regenImage || isGenerating}
          title={scene.script.scene_prompt ? '檢視並編輯插圖提示詞' : '自訂插圖提示詞（手動輸入英文描述後生成插圖）'}
        >
          ✏️ {scene.script.scene_prompt ? '編輯提示詞' : '自訂插圖'}
        </button>
        <button
          className="btn-scene-action btn-regen-all-voices"
          onClick={async () => {
            setRegenAllVoicesLoading(true)
            try { await onSceneRegenAllVoices(scene.id) }
            finally { setRegenAllVoicesLoading(false) }
          }}
          disabled={regenAllVoicesLoading || isGenerating || regenLoading || !!scene.is_locked}
          title={scene.is_locked ? '場景已鎖定，請先解鎖才能重新生成配音' : '清除並重新生成此幕所有配音（更換角色聲音後使用）'}
        >
          {regenAllVoicesLoading ? <><span className="spinner-sm" /> 配音中...</> : '🎤 重新生成全部配音'}
        </button>
        <button
          className="btn-scene-action"
          onClick={() => {
            if (scene.is_locked) return
            setRegenDesc(scene.description)
            setRegenStyle(scene.style)
            setShowRegenForm(v => !v)
          }}
          disabled={regenLoading || isGenerating || !!scene.is_locked}
          title={scene.is_locked ? '場景已鎖定，請先點 🔓 解鎖才能重新生成' : '重新生成此幕'}
        >
          {scene.is_locked ? '🔒 已鎖定' : '✏️ 重新生成此幕'}
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
            placeholder={scene.script.scene_prompt ? '描述插圖內容與風格...' : '用英文輸入插圖描述，例如：A white rabbit in a forest, watercolor children\'s book illustration style, warm colors'}
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
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>台詞數量</label>
            <div className="style-buttons">
              {([
                { value: 'few',      label: '精簡（3-5句）' },
                { value: 'standard', label: '標準（6-9句）' },
                { value: 'many',     label: '豐富（10-14句）' },
              ] as { value: 'few' | 'standard' | 'many'; label: string }[]).map(opt => (
                <button
                  key={opt.value}
                  className={`style-btn ${regenLineCount === opt.value ? 'active' : ''}`}
                  onClick={() => setRegenLineCount(opt.value)}
                  type="button"
                  title={
                    opt.value === 'few'      ? '適合輕快節奏或簡短幕次' :
                    opt.value === 'standard' ? '標準節奏（預設）' :
                                               '適合高潮或情感濃烈的幕次'
                  }
                >{opt.label}</button>
              ))}
            </div>
          </div>
          <div className="style-row" style={{ marginTop: '6px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>年齡層</label>
            <div className="style-buttons">
              {([
                { value: 'toddler', label: '🐣 幼兒', title: '3-6歲，極簡用語' },
                { value: 'child',   label: '🧒 兒童', title: '7-10歲，標準（預設）' },
                { value: 'preteen', label: '📚 少年', title: '11-14歲，豐富詞彙' },
              ] as { value: 'toddler' | 'child' | 'preteen'; label: string; title: string }[]).map(opt => (
                <button
                  key={opt.value}
                  className={`style-btn ${regenAgeGroup === opt.value ? 'active' : ''}`}
                  onClick={() => setRegenAgeGroup(opt.value)}
                  type="button"
                  title={opt.title}
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
                  key={s.value}
                  className={`style-btn ${regenImageStyle === s.value ? 'active' : ''}`}
                  onClick={() => setRegenImageStyle(s.value)}
                  type="button"
                >{s.label}</button>
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

      {scene.lines.length > 0 && (
        <div className="sfx-note-row">
          <div
            className={`sfx-note${editingSfx ? ' sfx-editing' : ''}`}
            onClick={() => { if (!editingSfx) setEditingSfx(true) }}
            title={editingSfx ? undefined : '點擊編輯音效建議'}
          >
            🎵
            {editingSfx ? (
              <input
                className="sfx-note-input"
                value={sfxText}
                onChange={e => setSfxText(e.target.value.slice(0, 100))}
                onBlur={commitSfx}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitSfx() }
                  else if (e.key === 'Escape') { setEditingSfx(false); setSfxText(scene.script.sfx_description ?? '') }
                }}
                autoFocus
                maxLength={100}
                placeholder="音效描述（如：森林鳥鳴、輕柔鋼琴）"
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="sfx-note-text">
                {sfxText || <em style={{ opacity: 0.55 }}>點擊新增音效建議</em>}
              </span>
            )}
          </div>
          <button
            className={`btn-suggest-sfx${sfxSuggesting ? ' loading' : ''}`}
            onClick={handleSuggestSfx}
            disabled={sfxSuggesting}
            title={sfxSuggesting ? 'AI 建議中…' : 'AI 自動建議音效描述'}
          >
            {sfxSuggesting ? <span className="spinner-sm" /> : '✨'}
          </button>
        </div>
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
                    {char?.portrait_url
                      ? <img src={char.portrait_url} alt={char.name} className="dialogue-speaker-portrait" />
                      : <span className="speaker-emoji">{char?.emoji || '🎭'}</span>}
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
                            } else if (e.key === 'Tab') {
                              // Tab / Shift+Tab: save text-only and jump to next / previous line
                              e.preventDefault()
                              const newText = editLineText.trim().slice(0, 200)
                              if (newText && newText !== scene.lines[i].text) {
                                onLineEditTextOnly(scene.id, i, newText)
                              }
                              const nextIdx = e.shiftKey ? i - 1 : i + 1
                              setRephraseSuggestions([])
                              if (nextIdx >= 0 && nextIdx < scene.lines.length) {
                                setEditingLineIndex(nextIdx)
                                setEditLineText(scene.lines[nextIdx].text.slice(0, 200))
                              } else {
                                setEditingLineIndex(null)
                                setEditLineText('')
                              }
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
                          <span className="line-edit-hint">Ctrl+Enter 確認・Tab 跳下句・Esc 取消</span>
                        </p>
                        <div className="line-edit-btns">
                          <button
                            className="btn-scene-action"
                            onClick={() => handleConfirmEditLine(i)}
                            disabled={!editLineText.trim()}
                            title="更新文字並重新生成配音"
                          >
                            ✓ 確認＋配音
                          </button>
                          <button
                            className="btn-text-only-edit"
                            onClick={() => handleTextOnlyEdit(i)}
                            disabled={!editLineText.trim()}
                            title="只更新文字，保留現有配音（適合修改錯字）"
                          >
                            ✎ 僅改文字
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
                              setRephraseError(false)
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
                                } else {
                                  setRephraseError(true)
                                }
                              } catch { setRephraseError(true) }
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
                        {rephraseError && !rephraseLoading && (
                          <div className="suggest-error">潤色建議生成失敗，請稍後再試</div>
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
                          className={`btn-copy-line${copiedLineIdx === i ? ' copied' : ''}`}
                          onClick={() => handleCopyLine(i, line.text)}
                          title="複製台詞文字到剪貼簿"
                        >
                          {copiedLineIdx === i ? '✓' : '⎘'}
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
                              const sceneLabel = scene.title ? `第${sceneIndex + 1}幕_${scene.title}` : `第${sceneIndex + 1}幕`
                              a.download = `${sceneLabel}_第${i + 1}句_${line.character_name}.${fmt}`
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
                    setLineSuggestError(false)
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
                      } else {
                        setLineSuggestError(true)
                      }
                    } catch { setLineSuggestError(true) }
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
              {lineSuggestError && !lineSuggestLoading && (
                <div className="suggest-error">台詞建議生成失敗，請稍後再試</div>
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


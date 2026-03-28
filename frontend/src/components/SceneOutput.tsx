import { useRef, useState, useCallback, useEffect, useMemo, Fragment } from 'react'
import {
  DndContext, DragEndEvent, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, sortableKeyboardCoordinates, horizontalListSortingStrategy, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Scene, Character, ScriptLine, EMOTION_META, EMOTION_LABELS, EMOTION_COLORS, STORY_STYLES, IMAGE_STYLES, lsSet } from '../types'
import PlaybackModal from './PlaybackModal'
import BookPreviewModal from './BookPreviewModal'
import SceneCard from './SceneCard'

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

const STYLES = STORY_STYLES

// EMOTION_LABELS and EMOTION_COLORS imported from '../types'

/** Return the most-frequent non-neutral emotion across a scene's lines, or 'neutral'. */
function dominantEmotion(lines: { emotion?: string }[]): string {
  const counts: Record<string, number> = {}
  for (const l of lines) {
    if (l.emotion && l.emotion !== 'neutral') counts[l.emotion] = (counts[l.emotion] ?? 0) + 1
  }
  const top = Object.entries(counts).sort(([, a], [, b]) => b - a)[0]
  return top ? top[0] : 'neutral'
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
          {scene.is_locked && <span className="nav-lock-dot" title="場景已鎖定">🔒</span>}
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
  const domEmotion = scene.lines.length > 0 ? dominantEmotion(scene.lines) : null

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
          {scene.is_locked && <span className="nav-lock-dot" title="場景已鎖定">🔒</span>}
          <span className={`nav-status-dot img-dot dot-${imageStatus}`} title={imageStatus === 'ok' ? '插圖完成' : imageStatus === 'err' ? '插圖失敗' : '插圖生成中'} />
          <span className={`nav-status-dot aud-dot dot-${audioStatus}`} title={audioStatus === 'ok' ? '配音完整' : audioStatus === 'partial' ? `配音 ${linesWithAudio}/${totalLines}` : '配音生成中'} />
        </div>
      </div>
      <div className="storyboard-info">
        <div className="storyboard-title-row">
          {scene.title && <h4 className="storyboard-title">《{scene.title}》</h4>}
          {domEmotion && (
            <span
              className="storyboard-emotion-badge"
              style={{ background: EMOTION_COLORS[domEmotion] ?? '#bdbdbd' }}
              title={`主要情緒：${EMOTION_LABELS[domEmotion] ?? domEmotion}`}
            >
              {EMOTION_LABELS[domEmotion]?.split(' ')[0] ?? '😐'}
            </span>
          )}
        </div>
        <div className="storyboard-desc-row">
          <p className="storyboard-desc">{scene.description}</p>
          {sceneSecs >= 5 && (
            <span className="storyboard-duration" title="依台詞字數估算播放時長">
              ⏱ {Math.floor(sceneSecs / 60)}:{String(sceneSecs % 60).padStart(2, '0')}
            </span>
          )}
        </div>
        {/* Emotion sparkline: one coloured dot per line, capped at 10 */}
        {scene.lines.length > 0 && scene.lines.some(l => l.emotion && l.emotion !== 'neutral') && (() => {
          const dots = scene.lines.slice(0, 10)
          const tipText = dots.map((l, i) => {
            const em = l.emotion || 'neutral'
            const label = EMOTION_LABELS[em]?.split(' ').slice(1).join(' ') || em
            return `第${i + 1}句：${label}`
          }).join(' · ')
          return (
            <div className="storyboard-emotion-sparkline" title={tipText}>
              {dots.map((l, i) => {
                const em = l.emotion || 'neutral'
                return (
                  <span
                    key={i}
                    className="sparkline-dot"
                    style={{ background: EMOTION_COLORS[em] ?? '#bdbdbd' }}
                  />
                )
              })}
              {scene.lines.length > 10 && (
                <span className="sparkline-more">+{scene.lines.length - 10}</span>
              )}
            </div>
          )
        })()}
        {previewLines.length > 0 && (
          <div className="storyboard-lines">
            {previewLines.map((line, i) => {
              const char = characters.find(c => c.id === line.character_id)
              return (
                <div key={i} className="storyboard-line" style={{ borderLeftColor: char?.color || '#ccc' }}>
                  {char?.portrait_url
                    ? <img src={char.portrait_url} alt={char.name} className="storyboard-char-portrait" />
                    : <span className="storyboard-char">{char?.emoji || '🎭'}</span>}
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
interface Props {
  scenes: Scene[]
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onSceneMove: (sceneId: string, direction: 'up' | 'down') => void
  onScenesReorder: (orderedIds: string[]) => void
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
  onBatchRegenVoice: () => void
  onSceneRegenAllVoices: (sceneId: string) => Promise<void>
  batchRegenStatus: { done: number; total: number; failed?: number } | null
  onBatchRegenImages: () => void
  onBatchRegenAllImages: () => void
  batchImageStatus: { done: number; total: number } | null
  onBatchGenerateTitles: () => void
  batchTitleStatus: { done: number; total: number } | null
  onLinesReorder: (sceneId: string, newLines: ScriptLine[]) => void
  onScrollToEditor?: () => void
  onBatchReplaceAll: (changes: {
    lines:  { sceneId: string; lineIndex: number; newText: string }[]
    titles: { sceneId: string; newTitle: string }[]
    descs:  { sceneId: string; newDesc: string }[]
    notes:  { sceneId: string; newNotes: string }[]
  }) => void
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
  onBatchRegenVoice,
  onSceneRegenAllVoices,
  batchRegenStatus,
  onBatchRegenImages,
  onBatchRegenAllImages,
  batchImageStatus,
  onBatchGenerateTitles,
  batchTitleStatus,
  onLinesReorder,
  onScrollToEditor,
  onBatchReplaceAll,
}: Props) {
  const [showPlayback, setShowPlayback] = useState(false)
  const [playbackStartScene, setPlaybackStartScene] = useState(0)
  const [showBookPreview, setShowBookPreview] = useState(false)
  const [bookPreviewStart, setBookPreviewStart] = useState(0)
  const [viewMode, setViewMode] = useState<'detail' | 'storyboard'>('detail')
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  // Quick jump-to-scene dialog state (triggered by pressing G)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpInput, setJumpInput] = useState('')
  const jumpInputRef = useRef<HTMLInputElement>(null)

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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

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

  // Auto-scroll to newly added scene and collapse all previous scenes (length increase only)
  const prevSceneCountRef = useRef(scenes.length)
  useEffect(() => {
    if (scenes.length > prevSceneCountRef.current) {
      const lastIdx = scenes.length - 1
      // Collapse all prior scenes so the new scene gets full attention
      setCollapsedIds(prev => {
        const next = new Set(prev)
        scenes.slice(0, lastIdx).forEach(s => next.add(s.id))
        return next
      })
      setTimeout(() => {
        sceneRefs.current[lastIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 80)
    }
    prevSceneCountRef.current = scenes.length
  }, [scenes.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Memoized derived state ──────────────────────────────────
  // activeSceneId changes on every scroll (IntersectionObserver), which
  // re-renders this component. Memoizing here prevents these O(scenes×lines)
  // iterations from running on each scroll event.
  const hasAudio = useMemo(
    () => scenes.some(s => s.lines.some(l => l.audio_base64)),
    [scenes]
  )

  // Global keyboard shortcuts: P = PlaybackModal, B = BookPreviewModal
  // Only fire when no text field is focused and no modal is currently open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'p' && e.key !== 'P' && e.key !== 'b' && e.key !== 'B') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (e.key === 'p' || e.key === 'P') {
        if (!hasAudio) return
        e.preventDefault()
        setShowPlayback(v => {
          if (!v) setPlaybackStartScene(0)
          return !v
        })
      } else {
        if (scenes.length === 0) return
        e.preventDefault()
        setShowBookPreview(v => {
          if (!v) setBookPreviewStart(0)
          return !v
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hasAudio, scenes.length])  

  const missingAudioCount = useMemo(
    () => scenes.reduce((n, s) => n + s.lines.filter(l => l.text && !l.audio_base64).length, 0),
    [scenes]
  )
  const missingImageCount = useMemo(
    () => scenes.filter(s => !s.image || s.image === 'error').length,
    [scenes]
  )
  const missingTitleCount = useMemo(
    () => scenes.filter(s => !s.is_locked && s.lines.length > 0 && !s.title?.trim()).length,
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
      .map(c => {
        let count = 0
        let textChars = 0
        for (const s of scenes) {
          for (const l of s.lines) {
            if (l.character_id === c.id) {
              count++
              textChars += l.text.length
            }
          }
        }
        return { id: c.id, name: c.name, emoji: c.emoji, color: c.color, count, textChars }
      })
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

  // ── Copy all scripts to clipboard ────────────────────────────
  const [copiedAll, setCopiedAll] = useState(false)
  const handleCopyAllScripts = () => {
    const body = scenes.map((s, i) => {
      const titlePart = s.title ? `《${s.title}》` : ''
      const header = `第${i + 1}幕${titlePart}：${s.description}`
      const lines = s.lines
        .filter(l => l.text)
        .map(l => {
          const char = characters.find(c => c.id === l.character_id)
          return `${char?.emoji || '🎭'}${l.character_name}：「${l.text}」`
        })
        .join('\n')
      return `${header}\n${lines}`
    }).join('\n\n')
    const allLines = scenes.reduce((n, s) => n + s.lines.filter(l => l.text).length, 0)
    const allChars = scenes.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.text.length, 0), 0)
    const footer = `\n\n——\n共 ${scenes.length} 幕 · ${allLines} 句台詞 · ${allChars} 字`
    const text = body + footer
    navigator.clipboard.writeText(text).then(() => {
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 2000)
    }).catch(() => {})
  }

  // ── Cross-scene search & replace ─────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null)
  const replaceMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => { if (replaceMsgTimerRef.current) clearTimeout(replaceMsgTimerRef.current) }, [])

  // Ctrl+F / Cmd+F — intercept browser's native find and focus our search bar instead
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (viewMode !== 'detail' || showPlayback || showBookPreview) return
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [viewMode, showPlayback, showBookPreview])

  const handleReplaceAll = () => {
    const q = searchQuery.trim()
    if (!q) return
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // Collect ALL changes first — do NOT call individual setScenes callbacks in a
    // loop, because React 18 automatic batching means only the last call wins and
    // all earlier changes are silently dropped.
    const lineChanges:  { sceneId: string; lineIndex: number; newText: string }[] = []
    const titleChanges: { sceneId: string; newTitle: string }[] = []
    const descChanges:  { sceneId: string; newDesc: string }[] = []
    const notesChanges: { sceneId: string; newNotes: string }[] = []

    scenes.forEach(scene => {
      const re = () => new RegExp(escaped, 'gi')
      if (scene.title) {
        const newTitle = scene.title.replace(re(), replaceText)
        if (newTitle !== scene.title) titleChanges.push({ sceneId: scene.id, newTitle })
      }
      const newDesc = scene.description.replace(re(), replaceText)
      if (newDesc !== scene.description) descChanges.push({ sceneId: scene.id, newDesc })
      if (scene.notes) {
        const newNotes = scene.notes.replace(re(), replaceText)
        if (newNotes !== scene.notes) notesChanges.push({ sceneId: scene.id, newNotes })
      }
      scene.lines.forEach((line, i) => {
        const newText = line.text.replace(re(), replaceText)
        if (newText !== line.text) lineChanges.push({ sceneId: scene.id, lineIndex: i, newText })
      })
    })

    const lineCount = lineChanges.length
    const metaCount = titleChanges.length + descChanges.length + notesChanges.length
    const total = lineCount + metaCount

    if (total > 0) {
      // Single atomic state update — all scenes/lines updated together
      onBatchReplaceAll({ lines: lineChanges, titles: titleChanges, descs: descChanges, notes: notesChanges })
      if (replaceText) setSearchQuery(replaceText)
    }

    const msg = total > 0
      ? lineCount > 0
        ? `已取代 ${total} 處（含 ${lineCount} 句台詞），台詞配音已清除`
        : `已取代 ${total} 處`
      : '找不到可取代的文字'
    setReplaceMsg(msg)
    if (replaceMsgTimerRef.current) clearTimeout(replaceMsgTimerRef.current)
    replaceMsgTimerRef.current = setTimeout(() => setReplaceMsg(null), 5000)
  }
  // Separate counts: how many scenes match by title, description, lines, or notes
  const { titleMatchCount, descMatchCount, lineMatchCount, notesMatchCount } = useMemo(() => {
    if (!searchQuery.trim()) return { titleMatchCount: 0, descMatchCount: 0, lineMatchCount: 0, notesMatchCount: 0 }
    const q = searchQuery.toLowerCase()
    let titles = 0, desc = 0, lines = 0, notes = 0
    scenes.forEach(s => {
      if (s.title?.toLowerCase().includes(q)) titles++
      if (s.description.toLowerCase().includes(q)) desc++
      if (s.notes?.toLowerCase().includes(q)) notes++
      lines += s.lines.filter(l =>
        l.text.toLowerCase().includes(q) || l.character_name.toLowerCase().includes(q)
      ).length
    })
    return { titleMatchCount: titles, descMatchCount: desc, lineMatchCount: lines, notesMatchCount: notes }
  }, [searchQuery, scenes])
  const matchCount = titleMatchCount + descMatchCount + lineMatchCount + notesMatchCount

  // Auto-expand scenes that contain matching title, description, lines, or notes when the query changes
  useEffect(() => {
    if (!searchQuery.trim()) return
    const q = searchQuery.toLowerCase()
    setCollapsedIds(prev => {
      const next = new Set(prev)
      scenes.forEach(s => {
        const hasMatch =
          s.title?.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.notes?.toLowerCase().includes(q) ||
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

  // ← / → to navigate between scenes in detail view.
  // Use a ref so the listener is registered once (empty deps) but always reads
  // current state — avoids re-registering on every render.
  const _arrowNavRef = useRef<{
    scenes: Scene[]
    viewMode: 'detail' | 'storyboard'
    activeSceneId: string | null
    showPlayback: boolean
    showBookPreview: boolean
    scrollToScene: (i: number) => void
  } | null>(null)
  _arrowNavRef.current = { scenes, viewMode, activeSceneId, showPlayback, showBookPreview, scrollToScene }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const nav = _arrowNavRef.current
      if (!nav) return
      const { scenes, viewMode, activeSceneId, showPlayback, showBookPreview, scrollToScene } = nav
      if (viewMode !== 'detail' || scenes.length < 2) return
      if (showPlayback || showBookPreview) return
      const tag = (e.target as HTMLElement)?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.target as HTMLElement).isContentEditable) return
      const activeIdx = activeSceneId ? scenes.findIndex(s => s.id === activeSceneId) : 0
      const targetIdx = e.key === 'ArrowLeft'
        ? Math.max(0, activeIdx - 1)
        : Math.min(scenes.length - 1, activeIdx + 1)
      if (targetIdx === (activeIdx < 0 ? 0 : activeIdx)) return  // boundary — let browser scroll naturally
      e.preventDefault()
      scrollToScene(targetIdx)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])  

  // G key: open quick jump-to-scene dialog.
  // Uses the same ref pattern as arrow-nav so the handler is registered once.
  const _jumpNavRef = useRef<{
    scenes: Scene[]
    viewMode: 'detail' | 'storyboard'
    showPlayback: boolean
    showBookPreview: boolean
    jumpOpen: boolean
  } | null>(null)
  _jumpNavRef.current = { scenes, viewMode, showPlayback, showBookPreview, jumpOpen }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'g' && e.key !== 'G') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const nav = _jumpNavRef.current
      if (!nav || nav.jumpOpen || nav.showPlayback || nav.showBookPreview) return
      if (nav.viewMode !== 'detail' || nav.scenes.length < 2) return
      const tag = (e.target as HTMLElement)?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.target as HTMLElement).isContentEditable) return
      e.preventDefault()
      setJumpInput('')
      setJumpOpen(true)
      // Focus the number input after React has rendered it
      requestAnimationFrame(() => jumpInputRef.current?.focus())
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])  

  const handleJumpConfirm = () => {
    const n = parseInt(jumpInput.trim(), 10)
    if (!isNaN(n) && n >= 1 && n <= scenes.length) {
      scrollToScene(n - 1)
    }
    setJumpOpen(false)
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
        {(scenes.length > 0 || hasAudio || missingAudioCount > 0 || missingImageCount > 0 || hasImages) && (
          <div className="playbook-bar">
            <button
              className="btn-playbook btn-readbook"
              onClick={() => { setBookPreviewStart(0); setShowBookPreview(true) }}
              title="翻頁繪本閱讀模式（從第1幕開始）"
            >
              📖 閱讀全書
            </button>
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
                  ? batchRegenStatus.failed
                    ? `⚠️ 配音完成 ${batchRegenStatus.done}/${batchRegenStatus.total}（${batchRegenStatus.failed} 條失敗）`
                    : `🎤 配音中 ${batchRegenStatus.done}/${batchRegenStatus.total}…`
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
            {missingTitleCount > 0 && (
              <button
                className="btn-batch-regen btn-batch-title"
                onClick={onBatchGenerateTitles}
                disabled={batchTitleStatus !== null || batchRegenStatus !== null || batchImageStatus !== null}
                title={`AI 自動為 ${missingTitleCount} 幕尚無標題的場景命名`}
              >
                {batchTitleStatus
                  ? `✨ 命名中 ${batchTitleStatus.done}/${batchTitleStatus.total}…`
                  : `✨ 補齊幕名（${missingTitleCount}）`}
              </button>
            )}
            <button
              className="btn-batch-regen btn-copy-all"
              onClick={handleCopyAllScripts}
              disabled={totalLines === 0}
              title="複製全書劇本文字到剪貼簿（方便分享或貼到文件）"
            >
              {copiedAll ? '✅ 已複製' : '📋 複製劇本'}
            </button>
            <span className="playbook-hint">
              {batchRegenStatus
                ? batchRegenStatus.failed
                  ? `配音結果：${batchRegenStatus.done}/${batchRegenStatus.total} 成功，${batchRegenStatus.failed} 條失敗，可再試`
                  : `正在生成配音 ${batchRegenStatus.done}/${batchRegenStatus.total}`
                : batchImageStatus
                ? `正在生成插圖 ${batchImageStatus.done}/${batchImageStatus.total}`
                : batchTitleStatus
                ? `正在命名場景 ${batchTitleStatus.done}/${batchTitleStatus.total}`
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
            {/* Emotional arc bar — one segment per scene, coloured by dominant emotion */}
            {scenes.length >= 2 && scenes.some(s => s.lines.some(l => l.emotion && l.emotion !== 'neutral')) && (
              <div
                className="story-arc-bar"
                title="故事情感弧線：每一格代表一幕的主要情緒，點擊可跳至該幕"
              >
                {scenes.map((scene, i) => {
                  const dom = dominantEmotion(scene.lines)
                  const color = EMOTION_COLORS[dom] ?? '#bdbdbd'
                  const label = EMOTION_LABELS[dom] ?? '😐 平靜'
                  return (
                    <div
                      key={scene.id}
                      className="arc-segment"
                      style={{ background: color, flex: 1 }}
                      title={`第${i + 1}幕${scene.title ? `《${scene.title}》` : ''}：${label}`}
                      onClick={() => scrollToScene(i)}
                    />
                  )
                })}
              </div>
            )}
            {charStats.length > 0 && (
              <div className="stats-chars">
                {charStats.map(c => {
                  const secs = Math.round(c.textChars / 4)
                  const timeStr = secs >= 60
                    ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
                    : secs >= 5 ? `${secs}s` : null
                  return (
                    <span
                      key={c.id}
                      className="stats-char-badge"
                      style={{ borderColor: c.color, color: c.color }}
                      title={`${c.name}：${c.count} 句 · ${c.textChars} 字${secs >= 5 ? ` · 約 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`}` : ''}`}
                    >
                      {c.emoji} {c.name} <strong>{c.count}</strong>
                      {timeStr && <span className="stats-char-time">⏱{timeStr}</span>}
                    </span>
                  )
                })}
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

        {/* Cross-scene search & replace bar */}
        {viewMode === 'detail' && (
          <div className="scene-search-wrap">
            <div className="scene-search-bar">
              <span className="scene-search-icon">🔍</span>
              <input
                ref={searchInputRef}
                type="text"
                className="scene-search-input"
                placeholder="搜尋幕次標題、場景描述、台詞、角色或備註...（Ctrl+F）"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setSearchQuery(''); setShowReplace(false) }
                  else if (e.key === 'Enter' && showReplace) handleReplaceAll()
                }}
              />
              {searchQuery ? (
                <>
                  <span className={`scene-search-count${matchCount === 0 ? ' no-results' : ''}`}>
                    {matchCount === 0 ? '無結果' : [
                      titleMatchCount > 0 ? `${titleMatchCount} 標題` : '',
                      descMatchCount > 0 ? `${descMatchCount} 幕` : '',
                      lineMatchCount > 0 ? `${lineMatchCount} 句` : '',
                      notesMatchCount > 0 ? `${notesMatchCount} 備註` : '',
                    ].filter(Boolean).join('・')}
                  </span>
                  <button className="scene-search-clear" onClick={() => { setSearchQuery(''); setShowReplace(false) }} title="清除搜尋 (Esc)">×</button>
                </>
              ) : (
                <span className="scene-search-hint">可搜尋幕次標題、場景描述、台詞、角色姓名或導演備註</span>
              )}
              <button
                className={`scene-replace-toggle${showReplace ? ' active' : ''}`}
                onClick={() => setShowReplace(v => !v)}
                title={showReplace ? '隱藏取代功能' : '開啟全文取代（台詞・描述・標題・備註）'}
              >⇄</button>
            </div>
            {showReplace && (
              <div className="scene-replace-bar">
                <span className="scene-search-icon" style={{ marginLeft: 2 }}>→</span>
                <input
                  type="text"
                  className="scene-search-input"
                  placeholder="取代為..."
                  value={replaceText}
                  onChange={e => setReplaceText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleReplaceAll() }}
                  autoFocus
                />
                <button
                  className="scene-replace-btn"
                  onClick={handleReplaceAll}
                  disabled={!searchQuery.trim()}
                  title="取代全書所有符合的文字（台詞・場景描述・幕次標題）"
                >
                  全部取代
                </button>
                {replaceMsg && (
                  <span className={`scene-replace-msg${replaceMsg.startsWith('找') ? ' no-result' : ''}`}>
                    {replaceMsg}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick jump-to-scene dialog (triggered by G key) */}
      {jumpOpen && (
        <div
          className="jump-scene-overlay"
          onMouseDown={() => setJumpOpen(false)}
        >
          <div className="jump-scene-dialog" onMouseDown={e => e.stopPropagation()}>
            <span className="jump-scene-label">跳至第</span>
            <input
              ref={jumpInputRef}
              className="jump-scene-input"
              type="number"
              min={1}
              max={scenes.length}
              value={jumpInput}
              onChange={e => setJumpInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleJumpConfirm()
                if (e.key === 'Escape') setJumpOpen(false)
              }}
              placeholder={`1–${scenes.length}`}
            />
            <span className="jump-scene-label">幕</span>
            <button className="jump-scene-btn" onClick={handleJumpConfirm}>確認</button>
          </div>
        </div>
      )}

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
              onLineEditTextOnly={onLineEditTextOnly}
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
              onSceneNotesUpdate={onSceneNotesUpdate}
              onSceneSfxUpdate={onSceneSfxUpdate}
              onSceneRegen={onSceneRegen}
              onSceneLockToggle={onSceneLockToggle}
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

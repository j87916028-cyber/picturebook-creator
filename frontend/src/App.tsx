import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { DndContext, DragEndEvent } from '@dnd-kit/core'
import { Character, ScriptLine, ScriptResponse, Scene, ProjectDetail } from './types'
import CharacterPanel from './components/CharacterPanel'
import SceneEditor from './components/SceneEditor'
import SceneOutput from './components/SceneOutput'
import ProjectPanel from './components/ProjectPanel'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal'

/**
 * Derive a stable seed from the project's character set and image style.
 * Using the same seed for every scene in the same project makes FLUX generate
 * visually consistent character appearances and lighting across all illustrations.
 * djb2 variant — result in [1, 2_147_483_647].
 */
function stableImageSeed(characters: Character[], imageStyle: string): number {
  const key = [...characters]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(c => c.id)
    .join('|') + '|' + imageStyle
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  }
  return (Math.abs(h) % 2147483647) + 1
}

/**
 * Cheap fingerprint of a scene's media blobs (image + all audio).
 * Uses only the tail of each base64 string — enough to detect any change
 * without spending time hashing megabytes of data.
 * Returns a stable string that only changes when image or audio changes.
 */
function blobChecksum(s: { image?: string; lines?: Array<{ audio_base64?: string }> }): string {
  const img = s.image ? s.image.slice(-24) : ''
  const audio = (s.lines ?? []).map(l => l.audio_base64 ? l.audio_base64.slice(-12) : '-').join('')
  return `${img}|${audio}`
}

/**
 * Build a compact story context from all scenes up to (but not including) endIndex.
 * Each scene contributes: scene number, title (if set), description, and first + last dialogue line.
 * This keeps every scene in context for long stories while staying under the
 * backend's 5000-char limit (~200 chars × 25 scenes = ~5000 chars worst case).
 */
function buildStoryContext(scenes: Scene[], endIndex?: number): string | undefined {
  const relevant = endIndex !== undefined ? scenes.slice(0, endIndex) : scenes
  if (relevant.length === 0) return undefined

  // All `story_context` backend fields are capped at 5000 chars (Pydantic max_length).
  // For long stories, including every scene can exceed this limit and cause 422 errors.
  // Strategy: always include scene 1 (story setup — world, characters, tone) + the last
  // MAX_SCENES-1 scenes (continuity).  Sending only the tail loses the opening context
  // that anchors the AI's understanding of the story; scene 1 costs only one slot.
  const MAX_SCENES = 8

  let selected: Array<{ scene: Scene; num: number }>
  if (relevant.length <= MAX_SCENES) {
    selected = relevant.map((s, i) => ({ scene: s, num: i + 1 }))
  } else {
    const tailStart = relevant.length - (MAX_SCENES - 1)
    selected = [
      { scene: relevant[0], num: 1 },
      ...relevant.slice(tailStart).map((s, i) => ({ scene: s, num: tailStart + i + 1 })),
    ]
  }

  const context = selected.map(({ scene: s, num }) => {
    const lines = s.lines.filter(l => l.text)
    const first = lines[0]
    const last  = lines.length > 1 ? lines[lines.length - 1] : null
    const snippets = [first, last]
      .filter((l): l is NonNullable<typeof l> => l != null)
      .map(l => `${l.character_name}：「${l.text}」`)
      .join('…')
    const titlePart = s.title ? `《${s.title}》` : ''
    return `第${num}幕${titlePart}（${s.description}）：${snippets || '（生成中）'}`
  }).join('\n')

  // Hard safety cap: description / line text can be long; truncate rather than 422.
  return context.length > 4800 ? context.slice(0, 4800) : context
}

/**
 * Run `tasks` with at most `concurrency` running simultaneously.
 * Calls `onProgress(done, total)` after each task completes.
 */
async function throttled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let nextIdx = 0
  let done = 0
  const total = tasks.length
  const run = async () => {
    while (nextIdx < total) {
      const i = nextIdx++
      await tasks[i]()
      done++
      onProgress?.(done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, run))
}

/** Generate a short stable ID for a ScriptLine (7 random base-36 chars). */
const _lid = () => Math.random().toString(36).slice(2, 9)

export default function App() {
  const [characters, setCharacters] = useState<Character[]>([])
  const [droppedCharacters, setDroppedCharacters] = useState<Character[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [genStatus, setGenStatus] = useState<{ step: string; done: number; total: number } | null>(null)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [error, setError] = useState('')
  const [planWarning, setPlanWarning] = useState<'voice' | 'image' | null>(null)
  const voiceDoneRef = useRef(0)
  const [generateRateLimitSecs, setGenerateRateLimitSecs] = useState(0)
  const generateRateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [batchRegenStatus, setBatchRegenStatus] = useState<{ done: number; total: number; failed?: number } | null>(null)
  const [batchImageStatus, setBatchImageStatus] = useState<{ done: number; total: number } | null>(null)
  const [batchTitleStatus, setBatchTitleStatus] = useState<{ done: number; total: number } | null>(null)

  // Project state
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [titleSparkle, setTitleSparkle] = useState(false)
  const [savedStatus, setSavedStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [projectPanelOpen, setProjectPanelOpen] = useState(true)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ projectId: string; scenes: Scene[]; characters: Character[] } | null>(null)
  // Stores the blobChecksum for each scene index at the time of the last successful save.
  // When the checksum hasn't changed the frontend skips re-uploading image/audio data,
  // telling the backend to preserve the existing DB blobs instead.
  const lastSavedBlobsRef = useRef<Map<number, string>>(new Map())
  // Always-current snapshot used by the Ctrl+S handler so it reads fresh state
  // without re-registering the event listener on every render.
  const ctrlSSaveRef = useRef<{ projectId: string | null; scenes: Scene[]; characters: Character[] }>({
    projectId: null, scenes: [], characters: [],
  })

  // Undo-delete state: remembers the last deleted line for 5 seconds
  type UndoState = { sceneId: string; lineIndex: number; line: ScriptLine }
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Undo-delete state for scenes: remembers the last deleted scene for 5 seconds
  type UndoSceneState = { scene: Scene; index: number }
  const [undoSceneState, setUndoSceneState] = useState<UndoSceneState | null>(null)
  const undoSceneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Undo-delete state for characters: remembers the last deleted character for 5 seconds
  type UndoCharState = { char: Character; index: number }
  const [undoCharState, setUndoCharState] = useState<UndoCharState | null>(null)
  const undoCharTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Voice-regen hint: shown when a character voice change cleared existing audio lines
  const [voiceRegenCount, setVoiceRegenCount] = useState(0)
  const voiceRegenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Story summary state
  const [storySummary, setStorySummary] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)

  // Service warning: shown when critical API keys are missing (from /api/health)
  const [serviceWarning, setServiceWarning] = useState<string | null>(null)

  // Export state
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const [copiedFeedback, setCopiedFeedback] = useState(false)

  // JSON import state
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  // AI title-suggest state
  const [titleSuggestOpen, setTitleSuggestOpen] = useState(false)
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([])
  const [titleSuggestLoading, setTitleSuggestLoading] = useState(false)
  const titleSuggestRef = useRef<HTMLDivElement>(null)

  // Keyboard shortcuts help modal
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false)

  // Inline title-editing state
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const editTitleInputRef = useRef<HTMLInputElement>(null)
  const sceneEditorRef = useRef<HTMLDivElement>(null)
  const [editorFocusTrigger, setEditorFocusTrigger] = useState(0)

  // Close any open dropdown on outside click or Escape
  useEffect(() => {
    if (!exportOpen && !titleSuggestOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (exportOpen && exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportOpen(false)
      }
      if (titleSuggestOpen && titleSuggestRef.current && !titleSuggestRef.current.contains(e.target as Node)) {
        setTitleSuggestOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExportOpen(false)
        setTitleSuggestOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [exportOpen, titleSuggestOpen])

  const abortControllerRef = useRef<AbortController | null>(null)
  const batchAbortRef = useRef<AbortController | null>(null)

  // ── Sync browser tab title to current project name ─────────────
  useEffect(() => {
    const base = '繪本有聲書創作工坊'
    document.title = projectName && projectName !== '未命名作品'
      ? `${projectName} ✦ ${base}`
      : base
  }, [projectName])

  // Reset blob checksums whenever the active project changes so the first save
  // after loading a project always uploads the full current state.
  useEffect(() => {
    lastSavedBlobsRef.current = new Map()
  }, [currentProjectId])

  // ── Service-availability check: warn if critical API keys are missing ──
  useEffect(() => {
    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.services) return
        const s = data.services
        if (!s.llm) {
          setServiceWarning(
            '未設定 AI 語言模型金鑰（MINIMAX_API_KEY 或 GROQ_API_KEY），劇本生成功能無法使用。請在 backend/.env 中設定後重啟服務。'
          )
        } else if (!s.database) {
          setServiceWarning('資料庫未連線，專案儲存功能暫時無法使用。')
        }
      })
      .catch(() => {/* ignore network errors */})
  }, [])

  // Clear rate-limit countdown timer on unmount to prevent setState on dead component
  useEffect(() => () => {
    if (generateRateLimitTimerRef.current) clearInterval(generateRateLimitTimerRef.current)
  }, [])

  // ── Warn before unload when there is unsaved data ──────────────
  // Guards against accidental tab close / refresh when autosave failed
  // or when a save is still pending in the debounce queue.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const hasPending  = pendingSaveRef.current !== null
      const hasFailed   = savedStatus === 'failed'
      if (hasPending || hasFailed) {
        e.preventDefault()
        // Modern browsers ignore the custom string, but setting returnValue
        // still triggers the native "Leave site?" dialog.
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [savedStatus])

  // ── Auto-init: fetch projects on mount, auto-load most recent ──
  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch('/api/projects')
        if (!res.ok) return
        const list = await res.json()
        if (list.length > 0) {
          const res2 = await fetch(`/api/projects/${list[0].id}`)
          if (!res2.ok) return
          const proj: ProjectDetail = await res2.json()
          loadProjectData(proj)
        }
      } catch {}
    }
    init()
  }, [])

  const loadProjectData = (proj: ProjectDetail) => {
    // Cancel any in-flight or debounced saves from the previous project before
    // switching.  Without this:
    // 1. A pending _flushSave fires after the switch → setSavedStatus('saved'/'failed')
    //    shows the wrong status on the newly-loaded project.
    // 2. lastSavedBlobsRef gets updated with the old project's blob checksums,
    //    causing incorrect preserve_blobs=true decisions on the next save for the
    //    new project (blobs that should be re-uploaded are silently skipped).
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null }
    if (charSaveTimerRef.current) { clearTimeout(charSaveTimerRef.current); charSaveTimerRef.current = null }
    if (savedTimerRef.current)    { clearTimeout(savedTimerRef.current);    savedTimerRef.current    = null }
    pendingSaveRef.current = null
    lastSavedBlobsRef.current = new Map()
    setSavedStatus('idle')

    setCurrentProjectId(proj.id)
    setProjectName(proj.name)
    const loaded: Scene[] = proj.scenes.map(s => ({
      id: s.id,
      title: s.title ?? '',
      description: s.description,
      style: s.style,
      line_length: s.line_length ?? 'standard',
      notes: s.notes ?? '',
      script: s.script,
      lines: s.lines.map((l: ScriptLine) => l.id ? l : { ...l, id: _lid() }),
      image: s.image,
      voices_attempted: true,  // scenes from DB are fully generated
      is_locked: s.is_locked ?? false,
    }))
    setScenes(loaded)
    // Always replace characters with the loaded project's list — including empty [].
    // The previous guard (length > 0) caused cross-project leakage: switching to a
    // new/empty project left the previous project's characters visible.
    const loadedChars = proj.characters ?? []
    setCharacters(loadedChars)

    // Restore drop zone: use the characters that appeared in the last scene so the
    // user can immediately continue generating without having to re-drag.
    // Falls back to empty when the project has no scenes (cross-project contamination fix).
    const lastScene = loaded.length > 0 ? loaded[loaded.length - 1] : null
    if (lastScene && loadedChars.length > 0) {
      const lastCharIds = new Set(lastScene.lines.map((l: ScriptLine) => l.character_id).filter(Boolean))
      const restored = loadedChars.filter(c => lastCharIds.has(c.id))
      setDroppedCharacters(restored)
    } else {
      setDroppedCharacters([])
    }

    setError('')
    setPlanWarning(null)
  }

  // ── Save characters immediately (lightweight, no scene data) ──
  const charSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveCharacters = useCallback((projectId: string, chars: Character[]) => {
    if (!projectId) return
    if (charSaveTimerRef.current) clearTimeout(charSaveTimerRef.current)
    charSaveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/projects/${projectId}/characters`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ characters: chars }),
        })
      } catch {}
    }, 400)
  }, [])

  // ── Auto-save scenes + characters — debounced 1.5 s ──────────
  // Rapid edits (e.g. typing, batch voice, quick deletes) are coalesced:
  // only the *last* write within any 1.5 s window fires an API call.
  const _flushSave = useCallback(async () => {
    const data = pendingSaveRef.current
    if (!data) return
    pendingSaveRef.current = null
    setSavedStatus('saving')
    try {
      // For each scene, compute a cheap fingerprint of its image + audio blobs.
      // Scenes whose fingerprint matches the last successful save get preserve_blobs=true,
      // which tells the backend to keep existing DB blobs instead of re-uploading them.
      // This turns a ~7 MB payload on every keystroke into ~10 KB for pure text edits.
      const prevChecksums = lastSavedBlobsRef.current
      const nextChecksums = new Map<number, string>()

      const body = {
        scenes: data.scenes.map((s, idx) => {
          const checksum = blobChecksum(s)
          nextChecksums.set(idx, checksum)
          const preserveBlobs = prevChecksums.get(idx) === checksum
          return {
            idx,
            title: s.title ?? '',
            description: s.description,
            style: s.style,
            line_length: s.line_length ?? 'standard',
            notes: s.notes ?? '',
            is_locked: s.is_locked ?? false,
            script: s.script,
            // Strip audio_base64 / audio_format from lines when blobs are unchanged;
            // JSON.stringify omits undefined values automatically.
            lines: preserveBlobs
              ? s.lines.map(({ audio_base64: _a, audio_format: _f, ...rest }) => rest)
              : s.lines,
            // Omit image when unchanged (undefined → omitted from JSON → backend uses "")
            image: preserveBlobs ? undefined : s.image,
            preserve_blobs: preserveBlobs,
          }
        }),
        characters: data.characters,
      }
      const res = await fetch(`/api/projects/${data.projectId}/scenes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Only update stored checksums after a confirmed successful save.
      lastSavedBlobsRef.current = nextChecksums
      setSavedStatus('saved')
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSavedStatus('idle'), 2500)
    } catch {
      setSavedStatus('failed')
    }
  }, [])

  const autoSave = useCallback((projectId: string, currentScenes: Scene[], currentCharacters?: Character[]) => {
    if (!projectId) return
    pendingSaveRef.current = { projectId, scenes: currentScenes, characters: currentCharacters ?? [] }
    // Clear any 'failed' state so the user sees a fresh 'saving…' indicator on retry
    setSavedStatus(s => (s === 'failed' ? 'idle' : s))
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(_flushSave, 1500)
  }, [_flushSave])

  // Manual retry: re-queue a save with the latest in-memory state, fire immediately
  const handleRetrySave = useCallback(() => {
    if (!currentProjectId) return
    pendingSaveRef.current = { projectId: currentProjectId, scenes, characters }
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    setSavedStatus('idle')
    autoSaveTimerRef.current = setTimeout(_flushSave, 0)
  }, [currentProjectId, scenes, characters, _flushSave])

  // Ctrl+S / ⌘S: immediately flush any pending debounced save.
  // Uses a ref so the handler is registered once and always reads fresh state.
  ctrlSSaveRef.current = { projectId: currentProjectId, scenes, characters }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return
      e.preventDefault()
      const { projectId, scenes: s, characters: c } = ctrlSSaveRef.current
      if (!projectId) return
      if (!pendingSaveRef.current) {
        pendingSaveRef.current = { projectId, scenes: s, characters: c }
      }
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      setSavedStatus(prev => prev === 'failed' ? 'idle' : prev)
      autoSaveTimerRef.current = setTimeout(_flushSave, 0)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [_flushSave]) // stable — ref always provides fresh state without re-registering

  // `?` key: open keyboard shortcuts help (skip when focus is in a text input/textarea)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      setShowKeyboardHelp(v => !v)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleDragEnd = (event: DragEndEvent) => {
    const { over, active } = event
    if (over?.id === 'scene-drop-zone') {
      const char = active.data.current?.character as Character
      if (char && !droppedCharacters.find(c => c.id === char.id)) {
        setDroppedCharacters(prev => [...prev, char])
      }
    }
  }

  const removeDropped = (id: string) => {
    setDroppedCharacters(prev => prev.filter(c => c.id !== id))
  }

  const handleReset = () => {
    if (abortControllerRef.current) abortControllerRef.current.abort()
    batchAbortRef.current?.abort()
    setScenes([])
    setDroppedCharacters([])
    setError('')
    setPlanWarning(null)
  }

  // Cancel the in-progress generation only; preserves all existing scenes
  const handleCancelGeneration = () => {
    abortControllerRef.current?.abort()
  }

  // Reorder dropped characters in the scene editor (affects dialogue generation order)
  const handleReorderDropped = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= droppedCharacters.length) return
    setDroppedCharacters(prev => {
      const arr = [...prev]
      const [moved] = arr.splice(fromIdx, 1)
      arr.splice(toIdx, 0, moved)
      return arr
    })
  }

  // Duplicate a scene: clone with new ID, insert immediately after the original
  const handleSceneDuplicate = (sceneId: string) => {
    const idx = scenes.findIndex(s => s.id === sceneId)
    if (idx < 0) return
    const original = scenes[idx]
    const copy: Scene = {
      ...original,
      id: `scene-${Date.now()}`,
      is_locked: false,   // duplicates start unlocked regardless of original
    }
    const next = [...scenes.slice(0, idx + 1), copy, ...scenes.slice(idx + 1)]
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  const handleGenerate = async (description: string, style: string, lineLength: 'short' | 'standard' | 'long' = 'standard', isEnding?: boolean, imageStyle?: string, mood?: string, lineCount?: 'few' | 'standard' | 'many', ageGroup?: 'toddler' | 'child' | 'preteen') => {
    if (!description.trim() || droppedCharacters.length === 0) return

    // Ensure a project exists before generating
    let projId = currentProjectId
    if (!projId) {
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '未命名作品' }),
        })
        if (res.ok) {
          const proj = await res.json()
          projId = proj.id
          setCurrentProjectId(proj.id)
          setProjectName(proj.name)
          // Immediately persist characters that were created before the project existed
          if (characters.length > 0) saveCharacters(proj.id, characters)
        }
      } catch {}
    }

    if (abortControllerRef.current) abortControllerRef.current.abort()
    batchAbortRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const { signal } = controller

    // Build story context from ALL previous scenes (compact summary per scene)
    const storyContext = buildStoryContext(scenes)

    const newSceneId = `scene-${Date.now()}`
    const placeholderScene: Scene = {
      id: newSceneId,
      description,
      style,
      line_length: lineLength,
      script: { lines: [], scene_prompt: '', sfx_description: '' },
      lines: [],
      image: '',
    }

    setScenes(prev => [...prev, placeholderScene])
    setIsLoading(true)
    setError('')
    setPlanWarning(null)
    setGenStatus({ step: 'script', done: 0, total: 0 })
    voiceDoneRef.current = 0

    const updateScene = (updater: (s: Scene) => Scene) => {
      setScenes(prev => prev.map(s => s.id === newSceneId ? updater(s) : s))
    }

    let scriptOk = false
    try {
      // Step 1: 生成劇本
      const scriptRes = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_description: description,
          characters: droppedCharacters,
          style,
          story_context: storyContext,
          line_length: lineLength,
          line_count: lineCount ?? 'standard',
          is_ending: isEnding ?? false,
          image_style: imageStyle,
          mood: mood || undefined,
          age_group: ageGroup ?? 'child',
        }),
        signal,
      })
      if (!scriptRes.ok) {
        if (scriptRes.status === 429) {
          const wait = parseInt(scriptRes.headers.get('Retry-After') ?? '10', 10)
          setGenerateRateLimitSecs(wait)
          if (generateRateLimitTimerRef.current) clearInterval(generateRateLimitTimerRef.current)
          generateRateLimitTimerRef.current = setInterval(() => {
            setGenerateRateLimitSecs(prev => {
              if (prev <= 1) { clearInterval(generateRateLimitTimerRef.current!); generateRateLimitTimerRef.current = null; return 0 }
              return prev - 1
            })
          }, 1000)
        }
        const body = await scriptRes.json().catch(() => ({}))
        throw new Error(body.detail ?? `劇本生成失敗（${scriptRes.status}）`)
      }
      const script: ScriptResponse = await scriptRes.json()
      scriptOk = true
      const llmTitle = (script.scene_title || '').trim().slice(0, 30)
      updateScene(s => ({
        ...s,
        script,
        lines: script.lines.map(l => ({ ...l, id: _lid() })),
        // Apply LLM-suggested title only if user hasn't set one (preserves manual edits)
        title: s.title || llmTitle,
      }))

      // Step 2: 並行生成圖片 + 各台詞語音
      const totalLines = script.lines.length
      voiceDoneRef.current = 0
      setGenStatus({ step: 'media', done: 0, total: totalLines })

      const imagePromise = fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: script.scene_prompt,
          seed: stableImageSeed(droppedCharacters, imageStyle ?? localStorage.getItem('scene_image_style') ?? ''),
        }),
        signal,
      }).then(async r => {
        if (r.status === 402) { setPlanWarning('image'); return }
        if (!r.ok) { updateScene(s => ({ ...s, image: 'error' })); return }
        const d = await r.json()
        updateScene(s => ({ ...s, image: d.url }))
      }).catch(() => { updateScene(s => ({ ...s, image: 'error' })) })

      let voiceFailCount = 0
      const voiceTasks = script.lines.map((line, index) => async () => {
        try {
          const res = await fetch('/api/generate-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion }),
            signal,
          })
          if (res.status === 402) { setPlanWarning('voice'); return }
          if (!res.ok) { voiceFailCount++; return }
          const data = await res.json()
          updateScene(s => {
            const updated = [...s.lines] as ScriptLine[]
            updated[index] = { ...updated[index], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
            return { ...s, lines: updated }
          })
          voiceDoneRef.current += 1
          setGenStatus({ step: 'media', done: voiceDoneRef.current, total: totalLines })
        } catch (err) {
          // AbortError = user cancelled — stay silent
          if (err instanceof DOMException && err.name === 'AbortError') return
          voiceFailCount++
          console.warn(`[voice] line ${index} failed:`, err)
        }
      })

      await Promise.all([
        imagePromise,
        throttled(voiceTasks, 4),
      ])
      // Mark voices as attempted so SceneOutput can distinguish "still loading"
      // from "generation finished but audio failed" (e.g. TTS provider was down).
      updateScene(s => ({ ...s, voices_attempted: true }))
      // Notify user if any voices failed — each failed line already shows a retry button
      if (voiceFailCount > 0 && !signal.aborted) {
        setError(`${voiceFailCount} 句配音生成失敗，可點擊各句的「⚠️ 配音失敗」按鈕重試`)
        setTimeout(() => setError(e => e.startsWith(String(voiceFailCount)) ? '' : e), 8000)
      }
      setGenStatus({ step: 'done', done: totalLines, total: totalLines })

      // Auto-save after all generation completes (read latest state via setter, then save outside)
      if (projId) {
        setScenes(prev => {
          // schedule save outside the pure updater
          setTimeout(() => autoSave(projId!, prev, characters), 0)
          return prev
        })
      }

      // Auto-generate book title on the very first scene if still unnamed
      if (projId && scenes.length === 0 && projectName === '未命名作品' && !signal.aborted) {
        try {
          const tr = await fetch('/api/generate-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              characters: droppedCharacters,
              scene_description: description,
              first_lines: script.lines.map(l => l.text),
            }),
            signal,
          })
          if (tr.ok) {
            const { title } = await tr.json()
            setProjectName(title)
            setTitleSparkle(true)
            setTimeout(() => setTitleSparkle(false), 2500)
            await fetch(`/api/projects/${projId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: title }),
              signal,
            })
          }
        } catch (err) {
          // Re-throw AbortError so the outer handler can clean up the partial scene
          if (err instanceof DOMException && err.name === 'AbortError') throw err
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setScenes(prev => prev.filter(s => s.id !== newSceneId))
        return
      }
      if (!scriptOk) setScenes(prev => prev.filter(s => s.id !== newSceneId))
      setError(e instanceof Error ? e.message : '發生錯誤，請重試')
    } finally {
      setIsLoading(false)
      setTimeout(() => setGenStatus(null), 1200)  // keep 'done' visible briefly
    }
  }

  // ── Edit callbacks ────────────────────────────────────────────

  // Edit scene description label without re-generating
  const handleSceneDescriptionUpdate = (sceneId: string, newDescription: string) => {
    const next = scenes.map(s => s.id === sceneId ? { ...s, description: newDescription } : s)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Edit scene title (short user-defined label, e.g. "開場", "大結局")
  const handleSceneTitleUpdate = (sceneId: string, newTitle: string) => {
    const next = scenes.map(s => s.id === sceneId ? { ...s, title: newTitle } : s)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Batch AI title generation — fills in titles for all untitled scenes (up to 3 concurrent)
  const handleBatchGenerateTitles = async () => {
    const untitled = scenes.filter(s => !s.is_locked && !s.title?.trim())
    if (untitled.length === 0 || !currentProjectId) return
    setBatchTitleStatus({ done: 0, total: untitled.length })

    const titleResults = new Map<string, string>()

    const tasks = untitled.map(scene => async () => {
      const sceneChars = characters.filter(c => scene.lines.some(l => l.character_id === c.id))
      if (sceneChars.length > 0) {
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
            if (data.title) titleResults.set(scene.id, data.title)
          }
        } catch { /* silent */ }
      }
    })

    await throttled(tasks, 3, (done, total) => {
      setBatchTitleStatus({ done, total })
      setScenes(prev => prev.map(s => {
        const t = titleResults.get(s.id)
        return t ? { ...s, title: t } : s
      }))
    })

    setBatchTitleStatus(null)
    // Use functional setScenes to get the latest state (not the stale closure
    // captured at call time) so voice/image data generated during the batch
    // are included in the save, not overwritten.
    setScenes(prev => {
      const finalScenes = prev.map(s => {
        const t = titleResults.get(s.id)
        return t ? { ...s, title: t } : s
      })
      setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, finalScenes, characters) }, 0)
      return finalScenes
    })
  }

  // Edit private director/author notes for a scene (never exported)
  const handleSceneNotesUpdate = (sceneId: string, newNotes: string) => {
    const next = scenes.map(s => s.id === sceneId ? { ...s, notes: newNotes } : s)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Edit the AI-generated background sound effect description for a scene
  const handleSceneSfxUpdate = (sceneId: string, newSfx: string) => {
    const next = scenes.map(s =>
      s.id === sceneId
        ? { ...s, script: { ...s.script, sfx_description: newSfx } }
        : s
    )
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Delete a scene (with 5-second undo window)
  const handleSceneDelete = (sceneId: string) => {
    const idx = scenes.findIndex(s => s.id === sceneId)
    if (idx < 0) return
    const deletedScene = scenes[idx]
    const next = scenes.filter(s => s.id !== sceneId)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
    // Arm undo toast — clears after 5 s
    setUndoSceneState({ scene: deletedScene, index: idx })
    if (undoSceneTimerRef.current) clearTimeout(undoSceneTimerRef.current)
    undoSceneTimerRef.current = setTimeout(() => setUndoSceneState(null), 5000)
  }

  const handleUndoSceneDelete = () => {
    if (!undoSceneState) return
    if (undoSceneTimerRef.current) clearTimeout(undoSceneTimerRef.current)
    const { scene, index } = undoSceneState
    setUndoSceneState(null)
    const next = [...scenes]
    next.splice(index, 0, scene)   // re-insert at original position
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  const handleUndoCharDelete = () => {
    if (!undoCharState) return
    if (undoCharTimerRef.current) clearTimeout(undoCharTimerRef.current)
    const { char, index } = undoCharState
    setUndoCharState(null)
    const next = [...characters]
    next.splice(index, 0, char)    // re-insert at original position
    setCharacters(next)
    if (currentProjectId) saveCharacters(currentProjectId, next)
  }

  // Reorder scenes by new ID order (from drag-and-drop)
  const handleScenesReorder = (orderedIds: string[]) => {
    const idToScene = new Map(scenes.map(s => [s.id, s]))
    const next = orderedIds.map(id => idToScene.get(id)!).filter(Boolean)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Move a scene up or down
  const handleSceneMove = (sceneId: string, direction: 'up' | 'down') => {
    const idx = scenes.findIndex(s => s.id === sceneId)
    if (idx < 0) return
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= scenes.length) return
    const next = [...scenes]
    ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Update a single line's text (inline edit)
  const handleLineTextChange = (sceneId: string, lineIndex: number, newText: string) => {
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines[lineIndex] = { ...lines[lineIndex], text: newText, audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Update line text only (no voice regen). Useful for typo fixes or bulk edits
  // where the user wants to defer voice regeneration to a later batch pass.
  const handleLineEditTextOnly = useCallback((sceneId: string, lineIndex: number, newText: string) => {
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines[lineIndex] = { ...lines[lineIndex], text: newText, audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }, [scenes, currentProjectId, characters, autoSave])

  // Confirm a line text edit: update text then auto-regenerate voice (mirrors
  // the emotion-change flow so the user never needs a separate "重新配音" click).
  const handleLineEditConfirm = useCallback(async (sceneId: string, lineIndex: number, newText: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const line = scene.lines[lineIndex]
    const { voice_id, emotion } = line
    const lineId = line.id

    // 1. Commit new text + clear stale audio immediately
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
      if (idx === -1) return s
      lines[idx] = { ...lines[idx], text: newText, audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)

    // 2. Auto-regenerate voice with the updated text
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newText, voice_id, emotion }),
      })
      if (!res.ok) return
      const data = await res.json()
      setScenes(prev => {
        const updated = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
          if (idx === -1) return s
          lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, updated, characters) }, 0)
        return updated
      })
    } catch {}
  }, [scenes, currentProjectId, characters, autoSave])

  // Delete a single dialogue line (with 5-second undo window)
  const handleLineMove = (sceneId: string, lineIndex: number, direction: 'up' | 'down') => {
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      const target = direction === 'up' ? lineIndex - 1 : lineIndex + 1
      if (target < 0 || target >= lines.length) return s
      ;[lines[lineIndex], lines[target]] = [lines[target], lines[lineIndex]]
      return { ...s, lines }
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  const handleLinesReorder = (sceneId: string, newLines: ScriptLine[]) => {
    const next = scenes.map(s => s.id === sceneId ? { ...s, lines: newLines } : s)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  const handleLineDelete = (sceneId: string, lineIndex: number) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const deletedLine = scene.lines[lineIndex]
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      return { ...s, lines: s.lines.filter((_, i) => i !== lineIndex) }
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
    // Arm the undo toast for 5 seconds
    setUndoState({ sceneId, lineIndex, line: deletedLine })
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setUndoState(null), 5000)
  }

  const handleUndoDelete = () => {
    if (!undoState) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    const { sceneId, lineIndex, line } = undoState
    setUndoState(null)
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines.splice(lineIndex, 0, line)   // re-insert at original position
      return { ...s, lines }
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Global Ctrl+Z / Cmd+Z: undo the most recent delete (line > scene > character priority)
  useEffect(() => {
    if (!undoState && !undoSceneState && !undoCharState) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'z') return
      const target = e.target as Element
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        (target as HTMLElement).isContentEditable
      ) return
      e.preventDefault()
      if (undoState) handleUndoDelete()
      else if (undoSceneState) handleUndoSceneDelete()
      else handleUndoCharDelete()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [undoState, undoSceneState, undoCharState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Append or insert a new dialogue line and generate its voice.
  // insertAfterIndex: undefined = append; number = insert after that line index.
  const handleLineAdd = async (sceneId: string, characterId: string, text: string, insertAfterIndex?: number) => {
    const character = characters.find(c => c.id === characterId)
    const scene = scenes.find(s => s.id === sceneId)
    if (!character || !scene || !text.trim()) return

    const insertAt = insertAfterIndex !== undefined ? insertAfterIndex + 1 : scene.lines.length
    const newLine = {
      id: _lid(),
      character_name: character.name,
      character_id: character.id,
      voice_id: character.voice_id,
      text: text.trim(),
      emotion: 'neutral' as const,
    }
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines.splice(insertAt, 0, newLine)
      return { ...s, lines }
    }))
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newLine.text, voice_id: newLine.voice_id, emotion: 'neutral' }),
      })
      if (!res.ok) return
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const idx = s.lines.findIndex(l => l.id === newLine.id)
          if (idx === -1) return s
          const lines = [...s.lines]
          lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
        return next
      })
    } catch {}
  }

  // Duplicate a dialogue line (clone text/character/emotion, insert after, auto-regen voice)
  const handleLineDuplicate = async (sceneId: string, lineIndex: number) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const src = scene.lines[lineIndex]
    const clone = {
      id: _lid(),  // new ID — clone is a distinct line, not the same as the source
      character_name: src.character_name,
      character_id: src.character_id,
      voice_id: src.voice_id,
      text: src.text,
      emotion: src.emotion,
    }
    const insertAt = lineIndex + 1
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines.splice(insertAt, 0, clone)
      return { ...s, lines }
    }))
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clone.text, voice_id: clone.voice_id, emotion: clone.emotion || 'neutral' }),
      })
      if (!res.ok) return
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const idx = s.lines.findIndex(l => l.id === clone.id)
          if (idx === -1) return s
          const lines = [...s.lines]
          lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
        return next
      })
    } catch {}
  }

  // Re-generate voice for a single line
  const handleLineVoiceRegen = async (sceneId: string, lineIndex: number) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const line = scene.lines[lineIndex]
    // Snapshot stable ID + old audio for restore-on-failure
    const lineId     = line.id
    const prevAudio  = line.audio_base64
    const prevFormat = line.audio_format
    // Mark as loading (clear audio) — use ID if available, fall back to index
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
      if (idx === -1) return s
      lines[idx] = { ...lines[idx], audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    }))
    const restoreOldAudio = () => {
      setScenes(prev => prev.map(s => {
        if (s.id !== sceneId) return s
        const lines = [...s.lines]
        const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
        if (idx === -1) return s
        lines[idx] = { ...lines[idx], audio_base64: prevAudio, audio_format: prevFormat }
        return { ...s, lines }
      }))
    }
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion }),
      })
      if (!res.ok) { restoreOldAudio(); return }
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
          if (idx === -1) return s
          lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
        return next
      })
    } catch { restoreOldAudio() }
  }

  // Change emotion for a single line and auto-regen voice
  const handleLineEmotionChange = async (sceneId: string, lineIndex: number, newEmotion: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const line = scene.lines[lineIndex]
    const lineId     = line.id
    const prevAudio  = line.audio_base64
    const prevFormat = line.audio_format
    // Update emotion + clear stale audio immediately
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
      if (idx === -1) return s
      lines[idx] = { ...lines[idx], emotion: newEmotion, audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    }))
    const restoreOldAudio = () => {
      setScenes(prev => prev.map(s => {
        if (s.id !== sceneId) return s
        const lines = [...s.lines]
        const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
        if (idx === -1) return s
        lines[idx] = { ...lines[idx], audio_base64: prevAudio, audio_format: prevFormat }
        return { ...s, lines }
      }))
    }
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: newEmotion }),
      })
      if (!res.ok) { restoreOldAudio(); return }
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
          if (idx === -1) return s
          lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
        return next
      })
    } catch { restoreOldAudio() }
  }

  // Change character for a single line and auto-regen voice with new voice_id
  const handleLineCharacterChange = async (sceneId: string, lineIndex: number, newCharacterId: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    const newChar = characters.find(c => c.id === newCharacterId)
    if (!scene || !newChar) return
    const line = scene.lines[lineIndex]
    const lineId = line.id
    // Snapshot old character state for rollback on failure
    const prevCharId   = line.character_id
    const prevCharName = line.character_name
    const prevVoiceId  = line.voice_id
    const prevAudio    = line.audio_base64
    const prevFormat   = line.audio_format
    // Apply new character + clear stale audio immediately
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
      if (idx === -1) return s
      lines[idx] = {
        ...lines[idx],
        character_id: newChar.id,
        character_name: newChar.name,
        voice_id: newChar.voice_id,
        audio_base64: undefined,
        audio_format: undefined,
      }
      return { ...s, lines }
    }))
    const restoreOldState = () => {
      setScenes(prev => prev.map(s => {
        if (s.id !== sceneId) return s
        const lines = [...s.lines]
        const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
        if (idx === -1) return s
        lines[idx] = {
          ...lines[idx],
          character_id: prevCharId,
          character_name: prevCharName,
          voice_id: prevVoiceId,
          audio_base64: prevAudio,
          audio_format: prevFormat,
        }
        return { ...s, lines }
      }))
    }
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line.text, voice_id: newChar.voice_id, emotion: line.emotion }),
      })
      if (!res.ok) { restoreOldState(); return }
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          const idx = lineId ? lines.findIndex(l => l.id === lineId) : lineIndex
          if (idx === -1) return s
          lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
        return next
      })
    } catch { restoreOldState() }
  }

  // Replace scene image with a user-uploaded file (client-side only, no API call)
  const handleImageUpload = (sceneId: string, dataUrl: string) => {
    const next = scenes.map(s => s.id === sceneId ? { ...s, image: dataUrl } : s)
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  // Re-generate scene image (optionally with a custom prompt)
  const handleImageRegen = async (sceneId: string, customPrompt?: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    const prompt = customPrompt ?? scene?.script.scene_prompt
    if (!scene || !prompt) return
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: '' } : s))
    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          seed: stableImageSeed(characters, localStorage.getItem('scene_image_style') ?? ''),
        }),
      })
      if (!res.ok) { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)); return }
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => s.id === sceneId
          ? { ...s, image: data.url, script: { ...s.script, scene_prompt: prompt } }
          : s)
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
        return next
      })
    } catch { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)) }
  }

  // Atomic batch replace-all — applies every line/title/desc change in ONE setScenes
  // call so that React 18 automatic batching cannot silently drop intermediate updates
  // (the bug that occurred when the old code called onLineEditTextOnly in a loop).
  const handleBatchReplaceAll = useCallback((changes: {
    lines:  { sceneId: string; lineIndex: number; newText: string }[]
    titles: { sceneId: string; newTitle: string }[]
    descs:  { sceneId: string; newDesc: string }[]
    notes:  { sceneId: string; newNotes: string }[]
  }) => {
    const next = scenes.map(s => {
      const titleUp = changes.titles.find(t => t.sceneId === s.id)
      const descUp  = changes.descs.find(d => d.sceneId === s.id)
      const notesUp = changes.notes.find(n => n.sceneId === s.id)
      const lineUps = changes.lines.filter(l => l.sceneId === s.id)
      if (!titleUp && !descUp && !notesUp && lineUps.length === 0) return s
      let updated = { ...s }
      if (titleUp) updated = { ...updated, title: titleUp.newTitle }
      if (descUp)  updated = { ...updated, description: descUp.newDesc }
      if (notesUp) updated = { ...updated, notes: notesUp.newNotes }
      if (lineUps.length > 0) {
        const lines = [...s.lines]
        for (const c of lineUps) {
          lines[c.lineIndex] = { ...lines[c.lineIndex], text: c.newText, audio_base64: undefined, audio_format: undefined }
        }
        updated = { ...updated, lines }
      }
      return updated
    })
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }, [scenes, currentProjectId, characters, autoSave])

  // Toggle the is_locked flag on a scene (protects it from batch regen)
  const handleSceneLockToggle = useCallback((sceneId: string) => {
    setScenes(prev => {
      const next = prev.map(s => s.id === sceneId ? { ...s, is_locked: !s.is_locked } : s)
      setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
      return next
    })
  }, [currentProjectId, characters, autoSave])

  // Batch-regenerate all lines that are missing audio (e.g. after a voice change)
  const handleBatchRegenVoice = async () => {
    // Collect every (sceneId, lineIndex, lineId) that has text but no audio.
    // lineId is snapshotted so the async callback can route audio to the correct
    // line by ID even if the user reorders lines while the batch is in flight.
    type Task = { sceneId: string; lineIndex: number; lineId?: string; text: string; voice_id: string; emotion: string }
    const tasks: Task[] = []
    for (const scene of scenes) {
      if (scene.is_locked) continue  // skip locked scenes
      scene.lines.forEach((line, i) => {
        if (line.text && !line.audio_base64) {
          tasks.push({ sceneId: scene.id, lineIndex: i, lineId: line.id, text: line.text, voice_id: line.voice_id, emotion: line.emotion || 'neutral' })
        }
      })
    }
    if (tasks.length === 0) return

    batchAbortRef.current?.abort()
    const batchController = new AbortController()
    batchAbortRef.current = batchController
    const { signal: batchSignal } = batchController

    setBatchRegenStatus({ done: 0, total: tasks.length })

    // Track API-level failures (non-abort errors + non-2xx responses).
    // Stored in a plain mutable object so the async task closures can share it
    // without a React state update per task.
    let failCount = 0

    const voiceTasks = tasks.map(task => async () => {
      if (batchSignal.aborted) return
      try {
        const res = await fetch('/api/generate-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: task.text, voice_id: task.voice_id, emotion: task.emotion }),
          signal: batchSignal,
        })
        if (!res.ok) { failCount++; return }
        const data = await res.json()
        setScenes(prev => {
          const next = prev.map(s => {
            if (s.id !== task.sceneId) return s
            const lines = [...s.lines]
            const idx = task.lineId ? lines.findIndex(l => l.id === task.lineId) : task.lineIndex
            if (idx === -1) return s  // line was deleted while task was in-flight
            lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
            return { ...s, lines }
          })
          // Incrementally persist each completed voice via the debounced auto-save
          // (1.5 s coalesce window) so partial progress survives a mid-batch tab close.
          setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
          return next
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        failCount++  // network error (not abort)
      }
    })
    try {
      await throttled(voiceTasks, 5, (done, total) => setBatchRegenStatus({ done, total }))
    } finally {
      if (batchSignal.aborted) {
        setBatchRegenStatus(null)
      } else if (failCount > 0) {
        // Show final result with failure count for 3 s so users know to retry
        setBatchRegenStatus({ done: tasks.length - failCount, total: tasks.length, failed: failCount })
        setTimeout(() => setBatchRegenStatus(null), 3000)
      } else {
        setTimeout(() => setBatchRegenStatus(null), 1500)
      }
    }
  }

  // Force-regenerate ALL voice lines in one specific scene.
  // Clears existing audio first so stale audio doesn't remain after a voice change.
  const handleSceneRegenAllVoices = async (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene || scene.lines.length === 0) return
    if (scene.is_locked) return  // locked scenes cannot have voices force-regenerated

    // Clear audio on all lines in the scene immediately so the UI shows loading state
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      return { ...s, lines: s.lines.map(l => ({ ...l, audio_base64: undefined, audio_format: undefined })) }
    }))

    const linesToRegen = scene.lines.map((line, i) => ({ line, i })).filter(({ line }) => !!line.text)
    batchAbortRef.current?.abort()
    const batchController = new AbortController()
    batchAbortRef.current = batchController
    const { signal: batchSignal } = batchController

    let sceneVoiceFailCount = 0
    const tasks = linesToRegen.map(({ line, i }) => async () => {
      const lineId = line.id   // snapshot stable ID before any async gap
      if (batchSignal.aborted) return
      try {
        const res = await fetch('/api/generate-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion || 'neutral' }),
          signal: batchSignal,
        })
        if (!res.ok) { sceneVoiceFailCount++; return }
        const data = await res.json()
        setScenes(prev => {
          const next = prev.map(s => {
            if (s.id !== sceneId) return s
            const lines = [...s.lines]
            const idx = lineId ? lines.findIndex(l => l.id === lineId) : i
            if (idx === -1) return s
            lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
            return { ...s, lines }
          })
          setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
          return next
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        sceneVoiceFailCount++
      }
    })

    await throttled(tasks, 4)
    if (sceneVoiceFailCount > 0) {
      const saved = linesToRegen.length - sceneVoiceFailCount
      setBatchRegenStatus({ done: saved, total: linesToRegen.length, failed: sceneVoiceFailCount })
      setTimeout(() => setBatchRegenStatus(null), 3000)
    }
  }

  // Batch-regenerate ALL scene images (force-refresh, including existing ones)
  const handleBatchRegenAllImages = async () => {
    const targets = scenes.filter(s => !s.is_locked && s.script?.scene_prompt)
    if (targets.length === 0) return
    batchAbortRef.current?.abort()
    const batchController = new AbortController()
    batchAbortRef.current = batchController
    const { signal: batchSignal } = batchController
    setBatchImageStatus({ done: 0, total: targets.length })
    const imageTasks = targets.map(scene => async () => {
      if (batchSignal.aborted) return
      const prompt = scene.script.scene_prompt
      setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: '' } : s))
      try {
        const res = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            seed: stableImageSeed(characters, localStorage.getItem('scene_image_style') ?? ''),
          }),
          signal: batchSignal,
        })
        if (!res.ok) { setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: 'error' } : s)); return }
        const data = await res.json()
        setScenes(prev => {
          const next = prev.map(s => s.id === scene.id ? { ...s, image: data.url } : s)
          setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
          return next
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: 'error' } : s))
      } finally {
        if (!batchSignal.aborted) setBatchImageStatus(prev => prev ? { ...prev, done: prev.done + 1 } : null)
      }
    })
    try {
      await throttled(imageTasks, 2)
    } finally {
      if (batchSignal.aborted) setBatchImageStatus(null)
      else setTimeout(() => setBatchImageStatus(null), 1500)
    }
  }

  // Batch-regenerate images for all scenes that are missing or errored
  const handleBatchRegenImages = async () => {
    const targets = scenes.filter(s => !s.is_locked && (!s.image || s.image === 'error'))
    if (targets.length === 0) return

    batchAbortRef.current?.abort()
    const batchController = new AbortController()
    batchAbortRef.current = batchController
    const { signal: batchSignal } = batchController

    setBatchImageStatus({ done: 0, total: targets.length })

    const imageTasks = targets.map(scene => async () => {
      if (batchSignal.aborted) return
      const prompt = scene.script.scene_prompt
      if (!prompt) { setBatchImageStatus(prev => prev ? { ...prev, done: prev.done + 1 } : null); return }
      setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: '' } : s))
      try {
        const res = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            seed: stableImageSeed(characters, localStorage.getItem('scene_image_style') ?? ''),
          }),
          signal: batchSignal,
        })
        if (!res.ok) { setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: 'error' } : s)); return }
        const data = await res.json()
        // Save incrementally after each image so progress survives a mid-batch
        // tab close.  Matches the pattern used by handleBatchRegenVoice; the
        // 1.5 s autoSave debounce coalesces rapid updates automatically.
        setScenes(prev => {
          const next = prev.map(s => s.id === scene.id ? { ...s, image: data.url } : s)
          setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, next, characters) }, 0)
          return next
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: 'error' } : s))
      } finally {
        if (!batchSignal.aborted) setBatchImageStatus(prev => prev ? { ...prev, done: prev.done + 1 } : null)
      }
    })

    // Image generation is slow; run at most 2 in parallel to respect rate limits
    try {
      await throttled(imageTasks, 2)
    } finally {
      if (batchSignal.aborted) setBatchImageStatus(null)
      else setTimeout(() => setBatchImageStatus(null), 1500)
    }
  }

  // Re-generate entire scene
  const handleSceneRegen = async (sceneId: string, newDescription: string, style: string, lineLength?: string, imageStyle?: string, mood?: string, lineCount?: string, ageGroup?: string) => {
    // Snapshot the old scene BEFORE clearing — needed for rollback on failure.
    // `scenes` here refers to the closure-captured state at call time (correct).
    const oldScene = scenes.find(s => s.id === sceneId)
    if (!oldScene) return
    if (oldScene.is_locked) return  // locked scenes cannot be regenerated

    batchAbortRef.current?.abort()

    // Determine the line_length to use: prefer the new value from the regen form,
    // fall back to the scene's stored value, then 'standard' as the global default.
    const effectiveLineLength = lineLength ?? oldScene.line_length ?? 'standard'

    setScenes(prev => prev.map(s =>
      s.id === sceneId
        ? { ...s, description: newDescription, style, line_length: effectiveLineLength as Scene['line_length'], lines: [], image: '', script: { lines: [], scene_prompt: '', sfx_description: '' } }
        : s
    ))

    // Build story context from ALL scenes before this one (compact summary per scene)
    const sceneIndex = scenes.findIndex(s => s.id === sceneId)
    const storyContext = buildStoryContext(scenes, sceneIndex)

    // Determine which characters to send for regen:
    // 1. If the user has characters in the drop zone, use those (explicit intent).
    // 2. Otherwise reconstruct from the original scene's lines — avoids injecting
    //    unrelated characters that happen to exist in the character list.
    // 3. Final fallback: all characters (e.g. when original lines are empty).
    const sceneCharIds = new Set(oldScene.lines.map(l => l.character_id).filter(Boolean))
    const sceneChars = characters.filter(c => sceneCharIds.has(c.id))
    const charsForRegen = droppedCharacters.length > 0 ? droppedCharacters
      : sceneChars.length > 0 ? sceneChars
      : characters

    try {
      const scriptRes = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_description: newDescription,
          characters: charsForRegen,
          style,
          story_context: storyContext,
          line_length: effectiveLineLength,
          line_count: lineCount ?? localStorage.getItem('scene_line_count') ?? 'standard',
          image_style: imageStyle ?? localStorage.getItem('scene_image_style') ?? undefined,
          mood: mood || undefined,
          age_group: ageGroup ?? localStorage.getItem('scene_age_group') ?? 'child',
        }),
      })
      if (!scriptRes.ok) {
        if (scriptRes.status === 429) {
          const wait = parseInt(scriptRes.headers.get('Retry-After') ?? '10', 10)
          setGenerateRateLimitSecs(wait)
          if (generateRateLimitTimerRef.current) clearInterval(generateRateLimitTimerRef.current)
          generateRateLimitTimerRef.current = setInterval(() => {
            setGenerateRateLimitSecs(prev => {
              if (prev <= 1) { clearInterval(generateRateLimitTimerRef.current!); generateRateLimitTimerRef.current = null; return 0 }
              return prev - 1
            })
          }, 1000)
        }
        const errBody = await scriptRes.json().catch(() => ({}))
        throw new Error(errBody.detail ?? `場景重新生成失敗（${scriptRes.status}）`)
      }
      const script = await scriptRes.json()

      // Assign stable IDs to all lines NOW, before state is set and before voice
      // tasks are created.  This mirrors the handleGenerate pattern and prevents
      // the race condition where a user reorders lines between the two setScenes
      // calls, causing audio to be applied to the wrong line via positional index.
      const linesWithIds: ScriptLine[] = script.lines.map((l: ScriptLine) => ({ ...l, id: _lid() }))

      const regenLlmTitle = (script.scene_title || '').trim().slice(0, 30)
      setScenes(prev => prev.map(s => {
        if (s.id !== sceneId) return s
        return {
          ...s,
          script,
          lines: linesWithIds,
          // Preserve user-set title; apply LLM title only when scene had none (oldScene snapshot)
          title: oldScene.title || regenLlmTitle,
        }
      }))

      // Parallel: image + voices
      const imageP = fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: script.scene_prompt,
          seed: stableImageSeed(characters, localStorage.getItem('scene_image_style') ?? ''),
        }),
      }).then(async r => {
        if (!r.ok) { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)); return }
        const d = await r.json()
        setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: d.url } : s))
      }).catch(() => { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)) })

      let regenVoiceFailCount = 0
      const voiceTs = linesWithIds.map((line: ScriptLine, index: number) => async () => {
        const lineId = line.id   // snapshot stable ID before any async gap
        try {
          const res = await fetch('/api/generate-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion }),
          })
          if (res.status === 402) { setPlanWarning('voice'); return }
          if (!res.ok) { regenVoiceFailCount++; return }
          const data = await res.json()
          setScenes(prev => {
            const next = prev.map(s => {
              if (s.id !== sceneId) return s
              const lines = [...s.lines] as ScriptLine[]
              const idx = lineId ? lines.findIndex(l => l.id === lineId) : index
              if (idx === -1) return s
              lines[idx] = { ...lines[idx], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
              return { ...s, lines }
            })
            return next
          })
        } catch (err) {
          regenVoiceFailCount++
          console.warn(`[voice-regen] line ${index} failed:`, err)
        }
      })

      await Promise.all([imageP, throttled(voiceTs, 4)])
      setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, voices_attempted: true } : s))
      if (regenVoiceFailCount > 0) {
        setError(`${regenVoiceFailCount} 句配音生成失敗，可點擊各句的「⚠️ 配音失敗」按鈕重試`)
        setTimeout(() => setError(e => e.startsWith(String(regenVoiceFailCount)) ? '' : e), 8000)
      }
      setScenes(prev => {
        setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, prev, characters) }, 0)
        return prev
      })
    } catch (e) {
      // Restore old scene so the user doesn't lose their existing content
      setScenes(prev => prev.map(s => s.id === sceneId ? oldScene : s))
      throw e   // rethrow so SceneCard can display the error message
    }
  }

  // Copy the full story script to clipboard as plain text
  const handleCopyStory = async () => {
    const title = projectName || '繪本故事'
    const textLines: string[] = [`《${title}》`, '']
    scenes.forEach((s, i) => {
      textLines.push(`── 第${i + 1}幕：${s.description} ──`)
      s.lines.forEach(l => textLines.push(`${l.character_name}：${l.text}`))
      textLines.push('')
    })
    const fullText = textLines.join('\n')
    try {
      await navigator.clipboard.writeText(fullText)
    } catch {
      // Fallback for environments where clipboard API is unavailable
      const ta = document.createElement('textarea')
      ta.value = fullText
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopiedFeedback(true)
    setTimeout(() => setCopiedFeedback(false), 2000)
  }

  const handleGenerateSummary = async () => {
    if (!storyContext || summaryLoading) return
    setSummaryLoading(true)
    setStorySummary(null)
    try {
      const res = await fetch('/api/generate-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characters, story_context: storyContext }),
      })
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
        const msg = `摘要生成請求過於頻繁，請 ${wait} 秒後再試`
        setError(msg)
        setTimeout(() => setError(e => e === msg ? '' : e), wait * 1000)
        return
      }
      if (!res.ok) {
        const msg = '故事摘要生成失敗，請稍後再試'
        setError(msg)
        setTimeout(() => setError(e => e === msg ? '' : e), 6000)
        return
      }
      const data = await res.json()
      setStorySummary(data.summary || null)
    } catch {
      const msg = '故事摘要生成失敗，請確認網路連線'
      setError(msg)
      setTimeout(() => setError(e => e === msg ? '' : e), 6000)
    } finally {
      setSummaryLoading(false)
    }
  }

  const handleExport = async (format: string) => {
    if (!currentProjectId) return
    setExporting(true)
    setExportOpen(false)
    try {
      const res = await fetch(`/api/projects/${currentProjectId}/export?format=${format}`)
      if (!res.ok) {
        let msg = '匯出失敗'
        let autoHideMs = 8000
        if (res.status === 429) {
          const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
          msg = `匯出請求過於頻繁，請 ${wait} 秒後再試`
          autoHideMs = wait * 1000
        } else {
          try {
            const body = await res.json()
            if (body?.detail) msg = body.detail
          } catch {}
        }
        setError(msg)
        setTimeout(() => setError(e => e === msg ? '' : e), autoHideMs)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const extMap: Record<string, string> = { pdf: 'pdf', epub: 'epub', html: 'html', mp3: 'zip', images: 'zip' }
      const ext = extMap[format] || format
      a.download = `${projectName || '繪本'}.${ext}`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      const msg = '匯出失敗，請確認網路連線'
      setError(msg)
      setTimeout(() => setError(e => e === msg ? '' : e), 6000)
    } finally {
      setExporting(false)
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (importInputRef.current) importInputRef.current.value = ''
    if (!file) return
    setImporting(true)
    setImportMsg(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.scenes)) {
        setImportMsg('檔案格式錯誤，請選擇由本工坊匯出的 JSON 備份檔')
        return
      }
      const res = await fetch('/api/projects/import-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: parsed.name || '匯入作品',
          characters: parsed.characters || [],
          scenes: parsed.scenes || [],
        }),
      })
      if (!res.ok) {
        const detail = await res.json().then(d => d.detail).catch(() => '匯入失敗')
        setImportMsg(typeof detail === 'string' ? detail : '匯入失敗')
        return
      }
      const created = await res.json()
      // Load the full project detail
      const proj = await fetch(`/api/projects/${created.id}`).then(r => r.json())
      loadProjectData(proj)
      setImportMsg(`✓ 已匯入「${created.name}」（共 ${parsed.scenes.length} 幕）`)
      setTimeout(() => setImportMsg(null), 5000)
    } catch {
      setImportMsg('檔案讀取失敗，請確認選擇正確的 JSON 備份檔')
    } finally {
      setImporting(false)
    }
  }

  const handleSuggestTitle = async () => {
    if (!currentProjectId || scenes.length === 0) return
    setTitleSuggestOpen(true)
    setTitleSuggestions([])
    setTitleSuggestLoading(true)
    try {
      const storyContext = buildStoryContext(scenes)
      // Pick the most common style across scenes as the dominant style
      const styleCounts = scenes.reduce<Record<string, number>>((acc, s) => {
        acc[s.style] = (acc[s.style] ?? 0) + 1; return acc
      }, {})
      const dominantStyle = Object.entries(styleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '溫馨童趣'
      const res = await fetch('/api/suggest-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story_context: storyContext, style: dominantStyle }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setTitleSuggestions(data.suggestions ?? [])
    } catch {
      setTitleSuggestions([])
    } finally {
      setTitleSuggestLoading(false)
    }
  }

  const handleApplyTitle = async (newName: string) => {
    if (!currentProjectId || !newName.trim()) return
    setTitleSuggestOpen(false)
    setTitleSuggestions([])
    try {
      await fetch(`/api/projects/${currentProjectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      })
      setProjectName(newName.trim())
      setTitleSparkle(true)
      setTimeout(() => setTitleSparkle(false), 2500)
    } catch {}
  }

  const handleStartEditTitle = () => {
    if (!currentProjectId) return
    setEditTitleValue(projectName)
    setEditingTitle(true)
    // Focus after React renders the input
    setTimeout(() => editTitleInputRef.current?.select(), 0)
  }

  const handleConfirmEditTitle = async () => {
    const trimmed = editTitleValue.trim()
    setEditingTitle(false)
    if (!trimmed || trimmed === projectName) return
    await handleApplyTitle(trimmed)
  }

  const handleEditTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirmEditTitle() }
    if (e.key === 'Escape') { setEditingTitle(false) }
  }

  const handleProjectLoad = (proj: ProjectDetail) => {
    loadProjectData(proj)
  }

  const handleProjectCreated = (id: string, name: string) => {
    setCurrentProjectId(id || null)
    setProjectName(name)
    setScenes([])
    setCharacters([])
    setDroppedCharacters([])
    setError('')
    setPlanWarning(null)
  }

  // ── Memoized derived state ─────────────────────────────────────
  // These run on every render that changes `scenes`; memoizing prevents
  // them from recomputing during unrelated state updates (savedStatus,
  // genStatus, batch regen progress, etc.).

  const storyContext = useMemo(() => buildStoryContext(scenes), [scenes])

  const lineCountsByCharId = useMemo(() =>
    scenes.reduce<Record<string, number>>((acc, s) => {
      s.lines.forEach(l => {
        if (l.character_id) acc[l.character_id] = (acc[l.character_id] ?? 0) + 1
      })
      return acc
    }, {}),
  [scenes])

  const sceneIndicesByCharId = useMemo(() =>
    scenes.reduce<Record<string, number[]>>((acc, s, idx) => {
      const seen = new Set<string>()
      s.lines.forEach(l => {
        if (l.character_id && !seen.has(l.character_id)) {
          seen.add(l.character_id)
          acc[l.character_id] = [...(acc[l.character_id] ?? []), idx + 1]
        }
      })
      return acc
    }, {}),
  [scenes])

  const storyStats = useMemo(() => {
    if (scenes.length === 0) return null
    const totalLines  = scenes.reduce((n, s) => n + s.lines.length, 0)
    const audioLines  = scenes.reduce((n, s) => n + s.lines.filter(l => l.audio_base64).length, 0)
    const imagesDone  = scenes.filter(s => s.image && s.image !== 'error').length
    const audioPct    = totalLines > 0 ? Math.round((audioLines / totalLines) * 100) : 0
    const totalChars  = scenes.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.text.length, 0), 0)
    // Estimated listening time at ~4 Chinese chars per second (same formula as SceneOutput)
    const audioSecs   = Math.round(totalChars / 4)
    return { totalLines, audioLines, imagesDone, audioPct, totalChars, audioSecs }
  }, [scenes])

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="app">
        <header className="app-header">
          <div className="app-header-left">
            <button
              className="btn-toggle-drawer"
              onClick={() => setProjectPanelOpen(v => !v)}
              title={projectPanelOpen ? '收起作品列表' : '展開作品列表'}
            >
              {projectPanelOpen ? '◀' : '▶'}
            </button>
            <button
              className="btn-keyboard-help"
              onClick={() => setShowKeyboardHelp(true)}
              title="鍵盤快捷鍵說明（?）"
            >
              ?
            </button>
          </div>
          <div className="app-header-center">
            <h1>🎨 繪本有聲書創作工坊</h1>
            <p>建立角色 → 描述場景 → 一鍵生成故事、配音、插圖</p>
          </div>
          <div className="app-header-right">
            {savedStatus === 'saving' && <span className="save-indicator saving">儲存中...</span>}
            {savedStatus === 'saved'  && <span className="save-indicator saved">✓ 已儲存</span>}
            {savedStatus === 'failed' && (
              <button className="save-indicator failed save-retry" onClick={handleRetrySave} title="點擊重新儲存">
                ⚠️ 儲存失敗 · 重試
              </button>
            )}
            {currentProjectId && projectName && (
              <div className="title-suggest-wrap" ref={titleSuggestRef}>
                {editingTitle ? (
                  <input
                    ref={editTitleInputRef}
                    className="current-project-name-input"
                    value={editTitleValue}
                    onChange={e => setEditTitleValue(e.target.value)}
                    onBlur={handleConfirmEditTitle}
                    onKeyDown={handleEditTitleKeyDown}
                    maxLength={60}
                  />
                ) : (
                  <span
                    className={`current-project-name editable${titleSparkle ? ' sparkle' : ''}`}
                    title="點擊改名"
                    onClick={handleStartEditTitle}
                  >
                    {titleSparkle ? '✨ ' : ''}{projectName} ✏️
                  </span>
                )}
                {scenes.length > 0 && (
                  <button
                    className="btn-suggest-title"
                    onClick={() => titleSuggestOpen ? setTitleSuggestOpen(false) : handleSuggestTitle()}
                    title="AI 建議書名"
                  >
                    {titleSuggestLoading ? <span className="spinner-sm" /> : '✨'}
                  </button>
                )}
                {titleSuggestOpen && (
                  <div className="title-suggest-menu">
                    <div className="title-suggest-header">AI 書名建議</div>
                    {titleSuggestLoading && (
                      <div className="title-suggest-loading">生成中...</div>
                    )}
                    {!titleSuggestLoading && titleSuggestions.length === 0 && (
                      <div className="title-suggest-loading">生成失敗，請重試</div>
                    )}
                    {titleSuggestions.map((t, i) => (
                      <button
                        key={i}
                        className="title-suggest-item"
                        onClick={() => handleApplyTitle(t)}
                      >{t}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* JSON import */}
            <div className="import-wrap">
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleImport}
              />
              <button
                className="btn-import-json"
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
                title="從 JSON 備份檔匯入專案（文字結構，不含音檔和插圖）"
              >
                {importing ? '匯入中...' : '📥 匯入'}
              </button>
              {importMsg && <span className="import-msg">{importMsg}</span>}
            </div>
            <div className="export-dropdown-wrap" ref={exportMenuRef}>
              <button
                className="btn-export"
                onClick={() => setExportOpen(v => !v)}
                disabled={exporting || !currentProjectId || scenes.length === 0}
              >
                {exporting ? '匯出中...' : '📤 匯出'}
              </button>
              {exportOpen && (
                <div className="export-menu">
                  <button onClick={() => handleExport('pdf')}>📄 PDF（印刷/Gumroad）</button>
                  <button onClick={() => handleExport('epub')}>📚 EPUB 3（Apple Books/Kobo）</button>
                  <div className="export-menu-row">
                    <button className="export-menu-row-main" onClick={() => handleExport('html')}>🌐 HTML（互動網頁版）</button>
                    <button
                      className="export-menu-preview-btn"
                      onClick={() => { setExportOpen(false); window.open(`/api/projects/${currentProjectId}/export?format=html&inline=true`, '_blank') }}
                      title="在新分頁預覽互動網頁版（不下載）"
                    >預覽</button>
                  </div>
                  <button onClick={() => handleExport('mp3')}>🎵 MP3 音檔包</button>
                  <button onClick={() => handleExport('md')}>🔖 Markdown（Notion/GitHub）</button>
                  <button onClick={() => handleExport('txt')}>📝 純文字稿本</button>
                  <button onClick={() => handleExport('srt')} title="SRT 字幕檔（適用 YouTube / 影片剪輯）">🎞 SRT 字幕檔</button>
                  <button onClick={() => handleExport('images')}>🖼️ 插圖包（ZIP）</button>
                  <hr className="export-menu-divider" />
                  <button onClick={() => handleExport('json')} title="匯出完整故事結構為 JSON 備份（不含音檔與插圖）">📦 JSON 備份（可還原文字）</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="app-main">
          {/* Project drawer */}
          {projectPanelOpen && (
            <ProjectPanel
              currentProjectId={currentProjectId}
              projectName={projectName}
              onProjectLoad={handleProjectLoad}
              onProjectCreated={handleProjectCreated}
              onProjectNameChange={name => setProjectName(name)}
            />
          )}

          <CharacterPanel
            characters={characters}
            lineCountsByCharId={lineCountsByCharId}
            sceneIndicesByCharId={sceneIndicesByCharId}
            droppedCharacterIds={droppedCharacters.map(c => c.id)}
            onAddToScene={char => {
              if (!droppedCharacters.find(c => c.id === char.id)) {
                setDroppedCharacters(prev => [...prev, char])
              }
            }}
            onChange={updated => {
              // Build a lookup of what changed from the current characters array
              const prevMap = new Map(characters.map(c => [c.id, c]))
              const updatedIds = new Set(updated.map(u => u.id))

              // Detect a single-character deletion → arm undo toast
              const deletedChars = characters.filter(c => !updatedIds.has(c.id))
              if (deletedChars.length === 1) {
                const deletedChar = deletedChars[0]
                const originalIndex = characters.findIndex(c => c.id === deletedChar.id)
                setUndoCharState({ char: deletedChar, index: originalIndex })
                if (undoCharTimerRef.current) clearTimeout(undoCharTimerRef.current)
                undoCharTimerRef.current = setTimeout(() => setUndoCharState(null), 5000)
              }

              const changed = new Map(
                updated
                  .filter(u => {
                    const p = prevMap.get(u.id)
                    return p && (p.name !== u.name || p.voice_id !== u.voice_id || p.emoji !== u.emoji)
                  })
                  .map(u => [u.id, u])
              )
              if (changed.size > 0) {
                // Sync droppedCharacters
                setDroppedCharacters(prev => prev.map(dc => changed.get(dc.id) ?? dc))

                // Count lines that will lose audio due to voice change (read current
                // scenes BEFORE setScenes clears audio — React 18 batches these updates)
                let clearedCount = 0
                for (const u of changed.values()) {
                  if (u.voice_id !== prevMap.get(u.id)?.voice_id) {
                    scenes.forEach(s => s.lines.forEach(l => {
                      if (l.character_id === u.id && l.audio_base64) clearedCount++
                    }))
                  }
                }

                // Sync scene lines: update name/voice, clear audio if voice changed.
                // Compute the next scenes explicitly (not via functional updater) so we
                // can pass them directly to autoSave.  This ensures the updated voice_ids
                // are persisted to the DB immediately — without this, closing the browser
                // before any other scene edit would leave the old voice_id on the lines.
                const nextScenes = scenes.map(scene => ({
                  ...scene,
                  lines: scene.lines.map(line => {
                    const upd = changed.get(line.character_id)
                    if (!upd) return line
                    const voiceChanged = upd.voice_id !== prevMap.get(upd.id)?.voice_id
                    return {
                      ...line,
                      character_name: upd.name,
                      voice_id: upd.voice_id,
                      audio_base64: voiceChanged ? undefined : line.audio_base64,
                      audio_format: voiceChanged ? undefined : line.audio_format,
                    }
                  }),
                }))
                setScenes(nextScenes)
                if (currentProjectId) autoSave(currentProjectId, nextScenes, updated)

                // Show regen hint if any audio was cleared
                if (clearedCount > 0) {
                  setVoiceRegenCount(clearedCount)
                  if (voiceRegenTimerRef.current) clearTimeout(voiceRegenTimerRef.current)
                  voiceRegenTimerRef.current = setTimeout(() => setVoiceRegenCount(0), 8000)
                }
              }
              setCharacters(updated)
              if (currentProjectId) saveCharacters(currentProjectId, updated)
            }}
          />

          <div className="right-panel">
            <div ref={sceneEditorRef}>
              <SceneEditor
                droppedCharacters={droppedCharacters}
                allCharacters={characters}
                onRemoveCharacter={removeDropped}
                onReorderDropped={handleReorderDropped}
                onGenerate={handleGenerate}
                onCancel={handleCancelGeneration}
                isLoading={isLoading}
                genStatus={genStatus}
                sceneCount={scenes.length}
                onReset={handleReset}
                storyContext={storyContext}
                focusTrigger={editorFocusTrigger}
                projectId={currentProjectId}
                generateRateLimitSecs={generateRateLimitSecs}
              />
            </div>

            {serviceWarning && (
              <div className="service-warning">
                <span>⚠️ {serviceWarning}</span>
                <button className="service-warning-close" onClick={() => setServiceWarning(null)} title="關閉">✕</button>
              </div>
            )}

            {error && <div className="error-box">⚠️ {error}</div>}

            {planWarning && (
              <div className="plan-warning">
                💡 {planWarning === 'voice' ? '配音' : '插圖'}功能需升級至
                {' '}<strong>MiniMax Token Plan Plus</strong> 以上方案才能使用。
                劇本文字仍可正常生成。
              </div>
            )}

            {storyStats && (() => {
              const { totalLines, audioLines, imagesDone, audioPct, totalChars, audioSecs } = storyStats
              const activeChars = characters
                .filter(c => (lineCountsByCharId[c.id] ?? 0) > 0)
                .sort((a, b) => (lineCountsByCharId[b.id] ?? 0) - (lineCountsByCharId[a.id] ?? 0))
              return (
                <>
                  <div className="story-stats-strip">
                    <span className="stats-item">📖 <strong>{scenes.length}</strong> 幕</span>
                    <span className="stats-divider">·</span>
                    <span className="stats-item">💬 <strong>{totalLines}</strong> 句台詞</span>
                    <span className="stats-divider">·</span>
                    <span className="stats-item">📝 <strong>{totalChars}</strong> 字</span>
                    {audioSecs >= 5 && <>
                      <span className="stats-divider">·</span>
                      <span
                        className="stats-item"
                        title="依台詞總字數估算聆聽時長（約 4 字/秒），實際時長依語速而異"
                      >
                        🎙 約 <strong>{Math.floor(audioSecs / 60)}:{String(audioSecs % 60).padStart(2, '0')}</strong>
                      </span>
                    </>}
                    <span className="stats-divider">·</span>
                    <span className="stats-item">
                      🎵 配音&nbsp;
                      <strong style={{ color: audioPct === 100 ? '#38a169' : audioPct > 0 ? '#667eea' : '#aaa' }}>
                        {audioLines}/{totalLines}
                      </strong>
                      <span className="stats-audio-bar">
                        <span className="stats-audio-fill" style={{ width: `${audioPct}%` }} />
                      </span>
                    </span>
                    <span className="stats-divider">·</span>
                    <span className="stats-item">🖼️ 插圖 <strong>{imagesDone}/{scenes.length}</strong></span>
                    <span className="stats-divider">·</span>
                    <button
                      className={`btn-copy-story${copiedFeedback ? ' copied' : ''}`}
                      onClick={handleCopyStory}
                      title="複製全書台詞文字"
                    >
                      {copiedFeedback ? '✓ 已複製' : '📋 複製文字'}
                    </button>
                    <span className="stats-divider">·</span>
                    <button
                      className="btn-story-summary"
                      onClick={handleGenerateSummary}
                      disabled={summaryLoading}
                      title="AI 自動生成故事摘要"
                    >
                      {summaryLoading ? <span className="spinner-sm" /> : '📖 故事摘要'}
                    </button>
                  </div>

                  {storySummary && (
                    <div className="story-summary-box">
                      <div className="story-summary-header">
                        <span>📖 故事摘要</span>
                        <button className="story-summary-close" onClick={() => setStorySummary(null)} title="關閉摘要">×</button>
                      </div>
                      <p className="story-summary-text">{storySummary}</p>
                    </div>
                  )}

                  {activeChars.length >= 2 && (
                    <div className="char-balance-strip">
                      <span className="char-balance-label">台詞比重</span>
                      {activeChars.map(c => {
                        const count = lineCountsByCharId[c.id] ?? 0
                        const pct   = Math.round((count / totalLines) * 100)
                        return (
                          <div key={c.id} className="char-balance-item" title={`${c.name}：${count} 句（${pct}%）`}>
                            <span className="char-balance-emoji">{c.emoji}</span>
                            <span className="char-balance-name">{c.name}</span>
                            <div className="char-balance-track">
                              <div
                                className="char-balance-fill"
                                style={{ width: `${pct}%`, background: c.color }}
                              />
                            </div>
                            <span className="char-balance-pct" style={{ color: c.color }}>{pct}%</span>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Emotion arc — dominant emotion per scene as coloured dots */}
                  {scenes.length >= 2 && (() => {
                    const _emotionMeta: Record<string, { emoji: string; label: string; color: string }> = {
                      happy:     { emoji: '😄', label: '開心',  color: '#48bb78' },
                      sad:       { emoji: '😢', label: '難過',  color: '#4299e1' },
                      angry:     { emoji: '😠', label: '生氣',  color: '#fc8181' },
                      surprised: { emoji: '😲', label: '驚訝',  color: '#ed8936' },
                      fearful:   { emoji: '😨', label: '害怕',  color: '#9f7aea' },
                      disgusted: { emoji: '🤢', label: '厭惡',  color: '#b794f4' },
                      neutral:   { emoji: '😐', label: '平靜',  color: '#a0aec0' },
                    }
                    const arc = scenes.map(s => {
                      if (s.lines.length === 0) return null
                      const counts: Record<string, number> = {}
                      s.lines.forEach(l => {
                        const e = l.emotion || 'neutral'
                        counts[e] = (counts[e] ?? 0) + 1
                      })
                      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral'
                    })
                    if (arc.every(e => e === null)) return null
                    return (
                      <div className="emotion-arc-strip">
                        <span className="emotion-arc-label">情緒弧線</span>
                        <div className="emotion-arc-dots">
                          {arc.map((emotion, i) => {
                            if (!emotion) return (
                              <span key={i} className="emotion-arc-empty" title={`第${i + 1}幕（尚無台詞）`} />
                            )
                            const meta = _emotionMeta[emotion] ?? _emotionMeta.neutral
                            return (
                              <span
                                key={i}
                                className="emotion-arc-dot"
                                style={{ background: meta.color }}
                                title={`第${i + 1}幕：${meta.emoji} ${meta.label}`}
                              />
                            )
                          })}
                        </div>
                        <span className="emotion-arc-legend">
                          {Object.entries(_emotionMeta)
                            .filter(([k]) => arc.some(e => e === k))
                            .map(([, v]) => (
                              <span key={v.label} className="emotion-arc-legend-item">
                                <span className="emotion-arc-legend-dot" style={{ background: v.color }} />
                                {v.emoji} {v.label}
                              </span>
                            ))}
                        </span>
                      </div>
                    )
                  })()}
                </>
              )
            })()}

            <SceneOutput
              scenes={scenes}
              characters={characters}
              onSceneDelete={handleSceneDelete}
              onSceneMove={handleSceneMove}
              onScenesReorder={handleScenesReorder}
              onSceneDuplicate={handleSceneDuplicate}
              onLineEditConfirm={handleLineEditConfirm}
              onLineEditTextOnly={handleLineEditTextOnly}
              onLineMove={handleLineMove}
              onLineDelete={handleLineDelete}
              onLineDuplicate={handleLineDuplicate}
              onLineAdd={handleLineAdd}
              onLineVoiceRegen={handleLineVoiceRegen}
              onLineEmotionChange={handleLineEmotionChange}
              onLineCharacterChange={handleLineCharacterChange}
              onImageRegen={handleImageRegen}
              onImageUpload={handleImageUpload}
              onSceneDescriptionUpdate={handleSceneDescriptionUpdate}
              onSceneTitleUpdate={handleSceneTitleUpdate}
              onSceneNotesUpdate={handleSceneNotesUpdate}
              onSceneSfxUpdate={handleSceneSfxUpdate}
              onSceneRegen={handleSceneRegen}
              onSceneLockToggle={handleSceneLockToggle}
              onBatchRegenVoice={handleBatchRegenVoice}
              onSceneRegenAllVoices={handleSceneRegenAllVoices}
              batchRegenStatus={batchRegenStatus}
              onBatchRegenImages={handleBatchRegenImages}
              onBatchRegenAllImages={handleBatchRegenAllImages}
              batchImageStatus={batchImageStatus}
              onBatchGenerateTitles={handleBatchGenerateTitles}
              batchTitleStatus={batchTitleStatus}
              onLinesReorder={handleLinesReorder}
              onBatchReplaceAll={handleBatchReplaceAll}
              onScrollToEditor={() => {
                sceneEditorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                setEditorFocusTrigger(n => n + 1)
              }}
            />
          </div>
        </main>
      </div>

      {/* Undo-delete toast (line) */}
      {undoState && (
        <div className="undo-toast">
          <span className="undo-toast-msg">🗑️ 台詞已刪除</span>
          <button className="undo-toast-btn" onClick={handleUndoDelete}>復原 (Ctrl+Z)</button>
          <button className="undo-toast-dismiss" onClick={() => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); setUndoState(null) }} title="關閉">✕</button>
        </div>
      )}

      {/* Undo-delete toast (scene) */}
      {undoSceneState && (
        <div className={`undo-toast undo-toast-scene${undoState ? ' undo-toast-stacked' : ''}`}>
          <span className="undo-toast-msg">🎬 第 {undoSceneState.index + 1} 幕已刪除</span>
          <button className="undo-toast-btn" onClick={handleUndoSceneDelete}>復原 (Ctrl+Z)</button>
          <button className="undo-toast-dismiss" onClick={() => { if (undoSceneTimerRef.current) clearTimeout(undoSceneTimerRef.current); setUndoSceneState(null) }} title="關閉">✕</button>
        </div>
      )}

      {/* Undo-delete toast (character) */}
      {undoCharState && (
        <div className={`undo-toast undo-toast-char${undoState || undoSceneState ? ' undo-toast-stacked' : ''}`}>
          <span className="undo-toast-msg">👤 角色「{undoCharState.char.emoji} {undoCharState.char.name}」已刪除</span>
          <button className="undo-toast-btn" onClick={handleUndoCharDelete}>復原 (Ctrl+Z)</button>
          <button className="undo-toast-dismiss" onClick={() => { if (undoCharTimerRef.current) clearTimeout(undoCharTimerRef.current); setUndoCharState(null) }} title="關閉">✕</button>
        </div>
      )}

      {/* Voice regen hint: shown when a character voice change cleared audio */}
      {voiceRegenCount > 0 && (
        <div className="voice-regen-toast">
          <span className="voice-regen-toast-msg">🎙️ {voiceRegenCount} 條配音已清除</span>
          <button
            className="voice-regen-toast-btn"
            onClick={() => {
              if (voiceRegenTimerRef.current) clearTimeout(voiceRegenTimerRef.current)
              setVoiceRegenCount(0)
              handleBatchRegenVoice()
            }}
          >立即重新生成</button>
          <button
            className="undo-toast-dismiss"
            onClick={() => {
              if (voiceRegenTimerRef.current) clearTimeout(voiceRegenTimerRef.current)
              setVoiceRegenCount(0)
            }}
            title="關閉"
          >✕</button>
        </div>
      )}
      {/* Keyboard shortcuts help modal */}
      {showKeyboardHelp && (
        <KeyboardShortcutsModal onClose={() => setShowKeyboardHelp(false)} />
      )}
    </DndContext>
  )
}

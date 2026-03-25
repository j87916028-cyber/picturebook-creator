import { useState, useRef, useEffect, useCallback } from 'react'
import { DndContext, DragEndEvent } from '@dnd-kit/core'
import { Character, ScriptLine, ScriptResponse, Scene, ProjectDetail } from './types'
import CharacterPanel from './components/CharacterPanel'
import SceneEditor from './components/SceneEditor'
import SceneOutput from './components/SceneOutput'
import ProjectPanel from './components/ProjectPanel'

/**
 * Build a compact story context from all scenes up to (but not including) endIndex.
 * Each scene contributes: scene number, description, and first + last dialogue line.
 * This keeps every scene in context for long stories while staying under the
 * backend's 5000-char limit (~200 chars × 25 scenes = ~5000 chars worst case).
 */
function buildStoryContext(scenes: Scene[], endIndex?: number): string | undefined {
  const relevant = endIndex !== undefined ? scenes.slice(0, endIndex) : scenes
  if (relevant.length === 0) return undefined
  return relevant.map((s, i) => {
    const lines = s.lines.filter(l => l.text)
    const first = lines[0]
    const last = lines.length > 1 ? lines[lines.length - 1] : null
    const snippets = [first, last]
      .filter((l): l is NonNullable<typeof l> => l != null)
      .map(l => `${l.character_name}：「${l.text}」`)
      .join('…')
    return `第${i + 1}幕（${s.description}）：${snippets || '（生成中）'}`
  }).join('\n')
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

export default function App() {
  const [characters, setCharacters] = useState<Character[]>([])
  const [droppedCharacters, setDroppedCharacters] = useState<Character[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [genStatus, setGenStatus] = useState<{ step: string; done: number; total: number } | null>(null)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [error, setError] = useState('')
  const [planWarning, setPlanWarning] = useState<'voice' | 'image' | null>(null)
  const voiceDoneRef = useRef(0)
  const [batchRegenStatus, setBatchRegenStatus] = useState<{ done: number; total: number } | null>(null)
  const [batchImageStatus, setBatchImageStatus] = useState<{ done: number; total: number } | null>(null)

  // Project state
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [titleSparkle, setTitleSparkle] = useState(false)
  const [savedStatus, setSavedStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [projectPanelOpen, setProjectPanelOpen] = useState(true)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ projectId: string; scenes: Scene[]; characters: Character[] } | null>(null)

  // Undo-delete state: remembers the last deleted line for 5 seconds
  type UndoState = { sceneId: string; lineIndex: number; line: ScriptLine }
  const [undoState, setUndoState] = useState<UndoState | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Undo-delete state for scenes: remembers the last deleted scene for 5 seconds
  type UndoSceneState = { scene: Scene; index: number }
  const [undoSceneState, setUndoSceneState] = useState<UndoSceneState | null>(null)
  const undoSceneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Export state
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const [copiedFeedback, setCopiedFeedback] = useState(false)

  // AI title-suggest state
  const [titleSuggestOpen, setTitleSuggestOpen] = useState(false)
  const [titleSuggestions, setTitleSuggestions] = useState<string[]>([])
  const [titleSuggestLoading, setTitleSuggestLoading] = useState(false)
  const titleSuggestRef = useRef<HTMLDivElement>(null)

  // Inline title-editing state
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const editTitleInputRef = useRef<HTMLInputElement>(null)

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
    setCurrentProjectId(proj.id)
    setProjectName(proj.name)
    const loaded: Scene[] = proj.scenes.map(s => ({
      id: s.id,
      description: s.description,
      style: s.style,
      line_length: s.line_length ?? 'standard',
      script: s.script,
      lines: s.lines,
      image: s.image,
    }))
    setScenes(loaded)
    if (proj.characters && proj.characters.length > 0) {
      setCharacters(proj.characters)
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
      const body = {
        scenes: data.scenes.map((s, idx) => ({
          idx,
          description: s.description,
          style: s.style,
          line_length: s.line_length ?? 'standard',
          script: s.script,
          lines: s.lines,
          image: s.image,
        })),
        characters: data.characters,
      }
      await fetch(`/api/projects/${data.projectId}/scenes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
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
    setScenes([])
    setError('')
    setPlanWarning(null)
  }

  // Cancel the in-progress generation only; preserves all existing scenes
  const handleCancelGeneration = () => {
    abortControllerRef.current?.abort()
  }

  // Duplicate a scene: clone with new ID, insert immediately after the original
  const handleSceneDuplicate = (sceneId: string) => {
    const idx = scenes.findIndex(s => s.id === sceneId)
    if (idx < 0) return
    const original = scenes[idx]
    const copy: Scene = {
      ...original,
      id: `scene-${Date.now()}`,
    }
    const next = [...scenes.slice(0, idx + 1), copy, ...scenes.slice(idx + 1)]
    setScenes(next)
    if (currentProjectId) autoSave(currentProjectId, next, characters)
  }

  const handleGenerate = async (description: string, style: string, lineLength: 'short' | 'standard' | 'long' = 'standard', isEnding?: boolean) => {
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
          is_ending: isEnding ?? false,
        }),
        signal,
      })
      if (!scriptRes.ok) {
        const body = await scriptRes.json().catch(() => ({}))
        throw new Error(body.detail ?? `劇本生成失敗（${scriptRes.status}）`)
      }
      const script: ScriptResponse = await scriptRes.json()
      scriptOk = true
      updateScene(s => ({ ...s, script, lines: script.lines.map(l => ({ ...l })) }))

      // Step 2: 並行生成圖片 + 各台詞語音
      const totalLines = script.lines.length
      voiceDoneRef.current = 0
      setGenStatus({ step: 'media', done: 0, total: totalLines })

      const imagePromise = fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: script.scene_prompt }),
        signal,
      }).then(async r => {
        if (r.status === 402) { setPlanWarning('image'); return }
        if (!r.ok) { updateScene(s => ({ ...s, image: 'error' })); return }
        const d = await r.json()
        updateScene(s => ({ ...s, image: d.url }))
      }).catch(() => { updateScene(s => ({ ...s, image: 'error' })) })

      const voiceTasks = script.lines.map((line, index) => async () => {
        try {
          const res = await fetch('/api/generate-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion }),
            signal,
          })
          if (res.status === 402) { setPlanWarning('voice'); return }
          if (!res.ok) return
          const data = await res.json()
          updateScene(s => {
            const updated = [...s.lines] as ScriptLine[]
            updated[index] = { ...updated[index], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
            return { ...s, lines: updated }
          })
          voiceDoneRef.current += 1
          setGenStatus({ step: 'media', done: voiceDoneRef.current, total: totalLines })
        } catch {}
      })

      await Promise.all([
        imagePromise,
        throttled(voiceTasks, 4),
      ])
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
      if (projId && scenes.length === 0 && projectName === '未命名作品') {
        try {
          const tr = await fetch('/api/generate-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              characters: droppedCharacters,
              scene_description: description,
              first_lines: script.lines.map(l => l.text),
            }),
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
            })
          }
        } catch {}
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

  // Confirm a line text edit: update text then auto-regenerate voice (mirrors
  // the emotion-change flow so the user never needs a separate "重新配音" click).
  const handleLineEditConfirm = useCallback(async (sceneId: string, lineIndex: number, newText: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const { voice_id, emotion } = scene.lines[lineIndex]

    // 1. Commit new text + clear stale audio immediately
    const next = scenes.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines[lineIndex] = { ...lines[lineIndex], text: newText, audio_base64: undefined, audio_format: undefined }
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
      let saved: Scene[] | null = null
      setScenes(prev => {
        const updated = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          lines[lineIndex] = { ...lines[lineIndex], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        saved = updated
        return updated
      })
      if (saved && currentProjectId) autoSave(currentProjectId, saved, characters)
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

  // Append or insert a new dialogue line and generate its voice.
  // insertAfterIndex: undefined = append; number = insert after that line index.
  const handleLineAdd = async (sceneId: string, characterId: string, text: string, insertAfterIndex?: number) => {
    const character = characters.find(c => c.id === characterId)
    const scene = scenes.find(s => s.id === sceneId)
    if (!character || !scene || !text.trim()) return

    const insertAt = insertAfterIndex !== undefined ? insertAfterIndex + 1 : scene.lines.length
    const newLine = {
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
      let saved: Scene[] | null = null
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          if (lines[insertAt]) {
            lines[insertAt] = { ...lines[insertAt], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          }
          return { ...s, lines }
        })
        saved = next
        return next
      })
      if (saved && currentProjectId) autoSave(currentProjectId, saved, characters)
    } catch {}
  }

  // Re-generate voice for a single line
  const handleLineVoiceRegen = async (sceneId: string, lineIndex: number) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const line = scene.lines[lineIndex]
    // Snapshot old audio so we can restore it if the request fails
    const prevAudio  = line.audio_base64
    const prevFormat = line.audio_format
    // Mark as loading (clear audio)
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines[lineIndex] = { ...lines[lineIndex], audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    }))
    const restoreOldAudio = () => {
      setScenes(prev => prev.map(s => {
        if (s.id !== sceneId) return s
        const lines = [...s.lines]
        lines[lineIndex] = { ...lines[lineIndex], audio_base64: prevAudio, audio_format: prevFormat }
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
      let saved: Scene[] | null = null
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          lines[lineIndex] = { ...lines[lineIndex], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        saved = next
        return next
      })
      if (saved && currentProjectId) autoSave(currentProjectId, saved, characters)
    } catch { restoreOldAudio() }
  }

  // Change emotion for a single line and auto-regen voice
  const handleLineEmotionChange = async (sceneId: string, lineIndex: number, newEmotion: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const line = scene.lines[lineIndex]
    const prevAudio  = line.audio_base64
    const prevFormat = line.audio_format
    // Update emotion + clear stale audio immediately
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines[lineIndex] = { ...lines[lineIndex], emotion: newEmotion, audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    }))
    const restoreOldAudio = () => {
      setScenes(prev => prev.map(s => {
        if (s.id !== sceneId) return s
        const lines = [...s.lines]
        lines[lineIndex] = { ...lines[lineIndex], audio_base64: prevAudio, audio_format: prevFormat }
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
      let saved: Scene[] | null = null
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          lines[lineIndex] = { ...lines[lineIndex], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        saved = next
        return next
      })
      if (saved && currentProjectId) autoSave(currentProjectId, saved, characters)
    } catch { restoreOldAudio() }
  }

  // Change character for a single line and auto-regen voice with new voice_id
  const handleLineCharacterChange = async (sceneId: string, lineIndex: number, newCharacterId: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    const newChar = characters.find(c => c.id === newCharacterId)
    if (!scene || !newChar) return
    const line = scene.lines[lineIndex]
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
      lines[lineIndex] = {
        ...lines[lineIndex],
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
        lines[lineIndex] = {
          ...lines[lineIndex],
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
      let saved: Scene[] | null = null
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          lines[lineIndex] = { ...lines[lineIndex], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        saved = next
        return next
      })
      if (saved && currentProjectId) autoSave(currentProjectId, saved, characters)
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
        body: JSON.stringify({ prompt }),
      })
      if (!res.ok) { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)); return }
      const data = await res.json()
      let saved: Scene[] | null = null
      setScenes(prev => {
        const next = prev.map(s => s.id === sceneId
          ? { ...s, image: data.url, script: { ...s.script, scene_prompt: prompt } }
          : s)
        saved = next
        return next
      })
      if (saved && currentProjectId) autoSave(currentProjectId, saved, characters)
    } catch { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)) }
  }

  // Batch-regenerate all lines that are missing audio (e.g. after a voice change)
  const handleBatchRegenVoice = async () => {
    // Collect every (sceneId, lineIndex) that has text but no audio
    type Task = { sceneId: string; lineIndex: number; text: string; voice_id: string; emotion: string }
    const tasks: Task[] = []
    for (const scene of scenes) {
      scene.lines.forEach((line, i) => {
        if (line.text && !line.audio_base64) {
          tasks.push({ sceneId: scene.id, lineIndex: i, text: line.text, voice_id: line.voice_id, emotion: line.emotion || 'neutral' })
        }
      })
    }
    if (tasks.length === 0) return

    setBatchRegenStatus({ done: 0, total: tasks.length })

    const voiceTasks = tasks.map(task => async () => {
      try {
        const res = await fetch('/api/generate-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: task.text, voice_id: task.voice_id, emotion: task.emotion }),
        })
        if (!res.ok) return
        const data = await res.json()
        setScenes(prev => prev.map(s => {
          if (s.id !== task.sceneId) return s
          const lines = [...s.lines]
          lines[task.lineIndex] = { ...lines[task.lineIndex], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        }))
      } catch {}
    })
    await throttled(voiceTasks, 5, (done, total) => setBatchRegenStatus({ done, total }))

    // Save after all complete
    setScenes(prev => {
      setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, prev, characters) }, 0)
      return prev
    })
    setTimeout(() => setBatchRegenStatus(null), 1500)
  }

  // Batch-regenerate images for all scenes that are missing or errored
  const handleBatchRegenImages = async () => {
    const targets = scenes.filter(s => !s.image || s.image === 'error')
    if (targets.length === 0) return

    setBatchImageStatus({ done: 0, total: targets.length })

    const imageTasks = targets.map(scene => async () => {
      const prompt = scene.script.scene_prompt
      if (!prompt) { setBatchImageStatus(prev => prev ? { ...prev, done: prev.done + 1 } : null); return }
      setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: '' } : s))
      try {
        const res = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        if (!res.ok) { setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: 'error' } : s)); return }
        const data = await res.json()
        setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: data.url } : s))
      } catch {
        setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image: 'error' } : s))
      } finally {
        setBatchImageStatus(prev => prev ? { ...prev, done: prev.done + 1 } : null)
      }
    })

    // Image generation is slow; run at most 2 in parallel to respect rate limits
    await throttled(imageTasks, 2)

    setScenes(prev => {
      setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, prev, characters) }, 0)
      return prev
    })
    setTimeout(() => setBatchImageStatus(null), 1500)
  }

  // Re-generate entire scene
  const handleSceneRegen = async (sceneId: string, newDescription: string, style: string, lineLength?: string) => {
    // Snapshot the old scene BEFORE clearing — needed for rollback on failure.
    // `scenes` here refers to the closure-captured state at call time (correct).
    const oldScene = scenes.find(s => s.id === sceneId)
    if (!oldScene) return

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

    try {
      const scriptRes = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_description: newDescription,
          characters: droppedCharacters.length > 0 ? droppedCharacters : characters,
          style,
          story_context: storyContext,
          line_length: effectiveLineLength,
        }),
      })
      if (!scriptRes.ok) {
        const errBody = await scriptRes.json().catch(() => ({}))
        throw new Error(errBody.detail ?? `場景重新生成失敗（${scriptRes.status}）`)
      }
      const script = await scriptRes.json()

      setScenes(prev => prev.map(s =>
        s.id === sceneId ? { ...s, script, lines: script.lines.map((l: ScriptLine) => ({ ...l })) } : s
      ))

      // Parallel: image + voices
      const imageP = fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: script.scene_prompt }),
      }).then(async r => {
        if (!r.ok) { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)); return }
        const d = await r.json()
        setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: d.url } : s))
      }).catch(() => { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)) })

      const voicePs = script.lines.map(async (line: ScriptLine, index: number) => {
        try {
          const res = await fetch('/api/generate-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion }),
          })
          if (!res.ok) return
          const data = await res.json()
          setScenes(prev => {
            const next = prev.map(s => {
              if (s.id !== sceneId) return s
              const lines = [...s.lines] as ScriptLine[]
              lines[index] = { ...lines[index], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
              return { ...s, lines }
            })
            return next
          })
        } catch {}
      })

      await Promise.all([imageP, ...voicePs])
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

  const handleExport = async (format: string) => {
    if (!currentProjectId) return
    setExporting(true)
    setExportOpen(false)
    try {
      const res = await fetch(`/api/projects/${currentProjectId}/export?format=${format}`)
      if (!res.ok) throw new Error('匯出失敗')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const extMap: Record<string, string> = { pdf: 'pdf', epub: 'epub', html: 'zip', mp3: 'zip' }
      const ext = extMap[format] || format
      a.download = `${projectName || '繪本'}.${ext}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : '匯出失敗')
    } finally {
      setExporting(false)
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
    setError('')
    setPlanWarning(null)
  }

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
          </div>
          <div className="app-header-center">
            <h1>🎨 繪本有聲書創作工坊</h1>
            <p>建立角色 → 描述場景 → 一鍵生成故事、配音、插圖</p>
          </div>
          <div className="app-header-right">
            {savedStatus === 'saving' && <span className="save-indicator saving">儲存中...</span>}
            {savedStatus === 'saved'  && <span className="save-indicator saved">✓ 已儲存</span>}
            {savedStatus === 'failed' && <span className="save-indicator failed">⚠️ 儲存失敗</span>}
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
                  <button onClick={() => handleExport('html')}>🌐 HTML（互動網頁版）</button>
                  <button onClick={() => handleExport('mp3')}>🎵 MP3 音檔包</button>
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
            lineCountsByCharId={scenes.reduce<Record<string, number>>((acc, s) => {
              s.lines.forEach(l => {
                if (l.character_id) acc[l.character_id] = (acc[l.character_id] ?? 0) + 1
              })
              return acc
            }, {})}
            onChange={updated => {
              // Build a lookup of what changed from the current characters array
              const prevMap = new Map(characters.map(c => [c.id, c]))
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
                // Sync scene lines: update name/voice, clear audio if voice changed
                setScenes(prev => prev.map(scene => ({
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
                })))
              }
              setCharacters(updated)
              if (currentProjectId) saveCharacters(currentProjectId, updated)
            }}
          />

          <div className="right-panel">
            <SceneEditor
              droppedCharacters={droppedCharacters}
              onRemoveCharacter={removeDropped}
              onGenerate={handleGenerate}
              onCancel={handleCancelGeneration}
              isLoading={isLoading}
              genStatus={genStatus}
              sceneCount={scenes.length}
              onReset={handleReset}
              storyContext={buildStoryContext(scenes)}
            />

            {error && <div className="error-box">⚠️ {error}</div>}

            {planWarning && (
              <div className="plan-warning">
                💡 {planWarning === 'voice' ? '配音' : '插圖'}功能需升級至
                {' '}<strong>MiniMax Token Plan Plus</strong> 以上方案才能使用。
                劇本文字仍可正常生成。
              </div>
            )}

            {scenes.length > 0 && (() => {
              const totalLines  = scenes.reduce((n, s) => n + s.lines.length, 0)
              const audioLines  = scenes.reduce((n, s) => n + s.lines.filter(l => l.audio_base64).length, 0)
              const imagesDone  = scenes.filter(s => s.image && s.image !== 'error').length
              const audioPct    = totalLines > 0 ? Math.round((audioLines / totalLines) * 100) : 0
              const totalChars  = scenes.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.text.length, 0), 0)
              // Children's read-aloud pace ≈ 200 Chinese chars / minute
              const readMinutes = totalChars > 0 ? Math.max(1, Math.round(totalChars / 200)) : 0

              // Per-character line counts for dialogue-balance bar
              const charLineCounts: Record<string, number> = {}
              scenes.forEach(s => s.lines.forEach(l => {
                if (l.character_id) charLineCounts[l.character_id] = (charLineCounts[l.character_id] ?? 0) + 1
              }))
              const activeChars = characters
                .filter(c => (charLineCounts[c.id] ?? 0) > 0)
                .sort((a, b) => (charLineCounts[b.id] ?? 0) - (charLineCounts[a.id] ?? 0))

              return (
                <>
                  <div className="story-stats-strip">
                    <span className="stats-item">📖 <strong>{scenes.length}</strong> 幕</span>
                    <span className="stats-divider">·</span>
                    <span className="stats-item">💬 <strong>{totalLines}</strong> 句台詞</span>
                    <span className="stats-divider">·</span>
                    <span className="stats-item">📝 <strong>{totalChars}</strong> 字</span>
                    {readMinutes > 0 && <>
                      <span className="stats-divider">·</span>
                      <span className="stats-item">🕐 約 <strong>{readMinutes}</strong> 分鐘</span>
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
                  </div>

                  {activeChars.length >= 2 && (
                    <div className="char-balance-strip">
                      <span className="char-balance-label">台詞比重</span>
                      {activeChars.map(c => {
                        const count = charLineCounts[c.id] ?? 0
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
              onLineMove={handleLineMove}
              onLineDelete={handleLineDelete}
              onLineAdd={handleLineAdd}
              onLineVoiceRegen={handleLineVoiceRegen}
              onLineEmotionChange={handleLineEmotionChange}
              onLineCharacterChange={handleLineCharacterChange}
              onImageRegen={handleImageRegen}
              onImageUpload={handleImageUpload}
              onSceneDescriptionUpdate={handleSceneDescriptionUpdate}
              onSceneRegen={handleSceneRegen}
              onBatchRegenVoice={handleBatchRegenVoice}
              batchRegenStatus={batchRegenStatus}
              onBatchRegenImages={handleBatchRegenImages}
              batchImageStatus={batchImageStatus}
            />
          </div>
        </main>
      </div>

      {/* Undo-delete toast (line) */}
      {undoState && (
        <div className="undo-toast">
          <span className="undo-toast-msg">🗑️ 台詞已刪除</span>
          <button className="undo-toast-btn" onClick={handleUndoDelete}>復原</button>
          <button className="undo-toast-dismiss" onClick={() => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); setUndoState(null) }} title="關閉">✕</button>
        </div>
      )}

      {/* Undo-delete toast (scene) */}
      {undoSceneState && (
        <div className={`undo-toast undo-toast-scene${undoState ? ' undo-toast-stacked' : ''}`}>
          <span className="undo-toast-msg">🎬 第 {undoSceneState.index + 1} 幕已刪除</span>
          <button className="undo-toast-btn" onClick={handleUndoSceneDelete}>復原</button>
          <button className="undo-toast-dismiss" onClick={() => { if (undoSceneTimerRef.current) clearTimeout(undoSceneTimerRef.current); setUndoSceneState(null) }} title="關閉">✕</button>
        </div>
      )}
    </DndContext>
  )
}

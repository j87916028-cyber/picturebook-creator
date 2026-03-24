import { useState, useRef, useEffect, useCallback } from 'react'
import { DndContext, DragEndEvent } from '@dnd-kit/core'
import { Character, ScriptLine, ScriptResponse, Scene, ProjectDetail } from './types'
import CharacterPanel from './components/CharacterPanel'
import SceneEditor from './components/SceneEditor'
import SceneOutput from './components/SceneOutput'
import ProjectPanel from './components/ProjectPanel'

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

  // Project state
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [titleSparkle, setTitleSparkle] = useState(false)
  const [savedStatus, setSavedStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [projectPanelOpen, setProjectPanelOpen] = useState(true)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Export state
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

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

  // ── Auto-save scenes + characters after generation completes ──
  const autoSave = useCallback(async (projectId: string, currentScenes: Scene[], currentCharacters?: Character[]) => {
    if (!projectId || currentScenes.length === 0) return
    setSavedStatus('saving')
    try {
      const body = {
        scenes: currentScenes.map((s, idx) => ({
          idx,
          description: s.description,
          style: s.style,
          script: s.script,
          lines: s.lines,
          image: s.image,
        })),
        characters: currentCharacters ?? [],
      }
      await fetch(`/api/projects/${projectId}/scenes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setSavedStatus('saved')
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSavedStatus('idle'), 2500)
    } catch {
      setSavedStatus('idle')
    }
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
    setScenes([])
    setError('')
    setPlanWarning(null)
  }

  // Cancel the in-progress generation only; preserves all existing scenes
  const handleCancelGeneration = () => {
    abortControllerRef.current?.abort()
  }

  const handleGenerate = async (description: string, style: string) => {
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

    // Build story context from previous scenes (last 3 max)
    const prevScenes = scenes.slice(-3)
    const storyContext = prevScenes.length > 0
      ? prevScenes.map((s, i) => {
          const idx = scenes.length - prevScenes.length + i + 1
          const dialogue = s.lines.map(l => `${l.character_name}：「${l.text}」`).join(' ')
          return `第${idx}幕（${s.description}）：${dialogue}`
        }).join('\n')
      : undefined

    const newSceneId = `scene-${Date.now()}`
    const placeholderScene: Scene = {
      id: newSceneId,
      description,
      style,
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

      const voicePromises = script.lines.map(async (line, index) => {
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

      await Promise.all([imagePromise, ...voicePromises])
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

  // Delete a scene
  const handleSceneDelete = (sceneId: string) => {
    const next = scenes.filter(s => s.id !== sceneId)
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

  // Re-generate voice for a single line
  const handleLineVoiceRegen = async (sceneId: string, lineIndex: number) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return
    const line = scene.lines[lineIndex]
    // Mark as loading (clear audio)
    setScenes(prev => prev.map(s => {
      if (s.id !== sceneId) return s
      const lines = [...s.lines]
      lines[lineIndex] = { ...lines[lineIndex], audio_base64: undefined, audio_format: undefined }
      return { ...s, lines }
    }))
    try {
      const res = await fetch('/api/generate-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line.text, voice_id: line.voice_id, emotion: line.emotion }),
      })
      if (!res.ok) return
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
    } catch {}
  }

  // Re-generate scene image
  const handleImageRegen = async (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId)
    if (!scene || !scene.script.scene_prompt) return
    // Clear image to show loading
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: '' } : s))
    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: scene.script.scene_prompt }),
      })
      if (!res.ok) { setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: 'error' } : s)); return }
      const data = await res.json()
      let saved: Scene[] | null = null
      setScenes(prev => {
        const next = prev.map(s => s.id === sceneId ? { ...s, image: data.url } : s)
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

    let done = 0
    await Promise.all(tasks.map(async task => {
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
      done += 1
      setBatchRegenStatus({ done, total: tasks.length })
    }))

    // Save after all complete
    setScenes(prev => {
      setTimeout(() => { if (currentProjectId) autoSave(currentProjectId, prev, characters) }, 0)
      return prev
    })
    setTimeout(() => setBatchRegenStatus(null), 1500)
  }

  // Re-generate entire scene
  const handleSceneRegen = async (sceneId: string, newDescription: string, style: string) => {
    // Snapshot the old scene BEFORE clearing — needed for rollback on failure.
    // `scenes` here refers to the closure-captured state at call time (correct).
    const oldScene = scenes.find(s => s.id === sceneId)
    if (!oldScene) return

    setScenes(prev => prev.map(s =>
      s.id === sceneId ? { ...s, description: newDescription, style, lines: [], image: '', script: { lines: [], scene_prompt: '', sfx_description: '' } } : s
    ))

    // Build story context from scenes before this one (uses pre-update `scenes`)
    const sceneIndex = scenes.findIndex(s => s.id === sceneId)
    const prevScenes = scenes.slice(Math.max(0, sceneIndex - 3), sceneIndex)
    const storyContext = prevScenes.length > 0
      ? prevScenes.map((s, i) => {
          const dialogue = s.lines.map(l => `${l.character_name}：「${l.text}」`).join(' ')
          return `第${sceneIndex - prevScenes.length + i + 1}幕（${s.description}）：${dialogue}`
        }).join('\n')
      : undefined

    try {
      const scriptRes = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_description: newDescription,
          characters: droppedCharacters.length > 0 ? droppedCharacters : characters,
          style,
          story_context: storyContext,
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
            {savedStatus === 'saved' && <span className="save-indicator saved">✓ 已儲存</span>}
            {currentProjectId && projectName && (
              <span className={`current-project-name${titleSparkle ? ' sparkle' : ''}`} title={projectName}>
                {titleSparkle ? '✨ ' : ''}{projectName}
              </span>
            )}
            <div className="export-dropdown-wrap">
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
              storyContext={scenes.length > 0
                ? scenes.slice(-3).map((s, i) => {
                    const idx = scenes.length - Math.min(scenes.length, 3) + i + 1
                    const dialogue = s.lines.map(l => `${l.character_name}：「${l.text}」`).join(' ')
                    return `第${idx}幕（${s.description}）：${dialogue}`
                  }).join('\n')
                : undefined
              }
            />

            {error && <div className="error-box">⚠️ {error}</div>}

            {planWarning && (
              <div className="plan-warning">
                💡 {planWarning === 'voice' ? '配音' : '插圖'}功能需升級至
                {' '}<strong>MiniMax Token Plan Plus</strong> 以上方案才能使用。
                劇本文字仍可正常生成。
              </div>
            )}

            <SceneOutput
              scenes={scenes}
              characters={characters}
              onSceneDelete={handleSceneDelete}
              onSceneMove={handleSceneMove}
              onLineTextChange={handleLineTextChange}
              onLineVoiceRegen={handleLineVoiceRegen}
              onImageRegen={handleImageRegen}
              onSceneRegen={handleSceneRegen}
              onBatchRegenVoice={handleBatchRegenVoice}
              batchRegenStatus={batchRegenStatus}
            />
          </div>
        </main>
      </div>
    </DndContext>
  )
}

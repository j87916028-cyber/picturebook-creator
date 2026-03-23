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
  const [scenes, setScenes] = useState<Scene[]>([])
  const [error, setError] = useState('')
  const [planWarning, setPlanWarning] = useState<'voice' | 'image' | null>(null)

  // Project state
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [savedStatus, setSavedStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [projectPanelOpen, setProjectPanelOpen] = useState(true)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    setError('')
    setPlanWarning(null)
  }

  // ── Auto-save scenes after generation completes ──────────────
  const autoSave = useCallback(async (projectId: string, currentScenes: Scene[]) => {
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
      const imagePromise = fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: script.scene_prompt }),
        signal,
      }).then(async r => {
        if (r.status === 402) { setPlanWarning('image'); return }
        if (!r.ok) return
        const d = await r.json()
        updateScene(s => ({ ...s, image: d.url }))
      }).catch(() => {})

      const voicePromises = script.lines.map(async (line, index) => {
        try {
          const res = await fetch('/api/generate-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, voice_id: line.voice_id }),
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
        } catch {}
      })

      await Promise.all([imagePromise, ...voicePromises])

      // Auto-save after all generation completes
      if (projId) {
        setScenes(prev => {
          autoSave(projId!, prev)
          return prev
        })
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
    }
  }

  // ── Edit callbacks ────────────────────────────────────────────

  // Delete a scene
  const handleSceneDelete = (sceneId: string) => {
    setScenes(prev => {
      const next = prev.filter(s => s.id !== sceneId)
      if (currentProjectId) autoSave(currentProjectId, next)
      return next
    })
  }

  // Update a single line's text (inline edit)
  const handleLineTextChange = (sceneId: string, lineIndex: number, newText: string) => {
    setScenes(prev => {
      const next = prev.map(s => {
        if (s.id !== sceneId) return s
        const lines = [...s.lines]
        lines[lineIndex] = { ...lines[lineIndex], text: newText, audio_base64: undefined, audio_format: undefined }
        return { ...s, lines }
      })
      if (currentProjectId) autoSave(currentProjectId, next)
      return next
    })
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
        body: JSON.stringify({ text: line.text, voice_id: line.voice_id }),
      })
      if (!res.ok) return
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => {
          if (s.id !== sceneId) return s
          const lines = [...s.lines]
          lines[lineIndex] = { ...lines[lineIndex], audio_base64: data.audio_base64, audio_format: data.format || 'wav' }
          return { ...s, lines }
        })
        if (currentProjectId) autoSave(currentProjectId, next)
        return next
      })
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
      if (!res.ok) return
      const data = await res.json()
      setScenes(prev => {
        const next = prev.map(s => s.id === sceneId ? { ...s, image: data.url } : s)
        if (currentProjectId) autoSave(currentProjectId, next)
        return next
      })
    } catch {}
  }

  // Re-generate entire scene
  const handleSceneRegen = async (sceneId: string, newDescription: string, style: string) => {
    setScenes(prev => prev.map(s =>
      s.id === sceneId ? { ...s, description: newDescription, style, lines: [], image: '', script: { lines: [], scene_prompt: '', sfx_description: '' } } : s
    ))

    const scene = scenes.find(s => s.id === sceneId)
    if (!scene) return

    // Build story context from scenes before this one
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
      if (!scriptRes.ok) return
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
        if (!r.ok) return
        const d = await r.json()
        setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image: d.url } : s))
      }).catch(() => {})

      const voicePs = script.lines.map(async (line: ScriptLine, index: number) => {
        try {
          const res = await fetch('/api/generate-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, voice_id: line.voice_id }),
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
        if (currentProjectId) autoSave(currentProjectId, prev)
        return prev
      })
    } catch {}
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
              <span className="current-project-name" title={projectName}>{projectName}</span>
            )}
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

          <CharacterPanel characters={characters} onChange={setCharacters} />

          <div className="right-panel">
            <SceneEditor
              droppedCharacters={droppedCharacters}
              onRemoveCharacter={removeDropped}
              onGenerate={handleGenerate}
              isLoading={isLoading}
              sceneCount={scenes.length}
              onReset={handleReset}
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
              onLineTextChange={handleLineTextChange}
              onLineVoiceRegen={handleLineVoiceRegen}
              onImageRegen={handleImageRegen}
              onSceneRegen={handleSceneRegen}
            />
          </div>
        </main>
      </div>
    </DndContext>
  )
}

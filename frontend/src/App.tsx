import { useState, useRef } from 'react'
import { DndContext, DragEndEvent } from '@dnd-kit/core'
import { Character, ScriptLine, ScriptResponse, Scene } from './types'
import CharacterPanel from './components/CharacterPanel'
import SceneEditor from './components/SceneEditor'
import SceneOutput from './components/SceneOutput'

export default function App() {
  const [characters, setCharacters] = useState<Character[]>([])
  const [droppedCharacters, setDroppedCharacters] = useState<Character[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [error, setError] = useState('')
  const [planWarning, setPlanWarning] = useState<'voice' | 'image' | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)

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

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="app">
        <header className="app-header">
          <h1>🎨 繪本有聲書創作工坊</h1>
          <p>建立角色 → 描述場景 → 一鍵生成故事、配音、插圖</p>
        </header>

        <main className="app-main">
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

            <SceneOutput scenes={scenes} characters={characters} />
          </div>
        </main>
      </div>
    </DndContext>
  )
}

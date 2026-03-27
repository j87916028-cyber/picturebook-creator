import { useRef, useState, useEffect, useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Character } from '../types'

interface OutlineScene { title: string; description: string }

interface GenStatus {
  step: string   // 'script' | 'media' | 'done'
  done: number
  total: number
}

type LineLength = 'short' | 'standard' | 'long'
type LineCount  = 'few' | 'standard' | 'many'
type AgeGroup   = 'toddler' | 'child' | 'preteen'

interface Props {
  droppedCharacters: Character[]
  allCharacters: Character[]   // full character list from the left panel
  onRemoveCharacter: (id: string) => void
  onReorderDropped: (fromIdx: number, toIdx: number) => void
  onGenerate: (description: string, style: string, lineLength: LineLength, isEnding?: boolean, imageStyle?: string, mood?: string, lineCount?: LineCount, ageGroup?: AgeGroup) => void
  onCancel: () => void
  isLoading: boolean
  genStatus: GenStatus | null
  sceneCount: number
  onReset: () => void
  storyContext?: string   // context from previous scenes for suggestions
  focusTrigger?: number  // increment to focus the description textarea
  projectId?: string | null  // scope the description draft to the current project
  generateRateLimitSecs?: number  // countdown from App when generate-script hits 429
  onBatchOutlineGenerate?: (outlineScenes: Array<{ description: string; title?: string }>, style: string, lineLength: LineLength, imageStyle: string, mood?: string, lineCount?: LineCount, ageGroup?: AgeGroup) => void
  onCancelBatchOutline?: () => void
  batchOutlineStatus?: { done: number; total: number } | null
}

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

interface ImageStyleOption {
  label: string       // displayed in Chinese
  value: string       // English value sent to the image API
}
const IMAGE_STYLES: ImageStyleOption[] = [
  { label: '水彩繪本',   value: "watercolor children's book illustration" },
  { label: '粉彩卡通',   value: 'soft pastel cartoon, cute kawaii style' },
  { label: '鉛筆素描',   value: 'pencil sketch children illustration, warm tones' },
  { label: '宮崎駿風',   value: 'Studio Ghibli anime style illustration' },
  { label: '3D 卡通',   value: '3D render cartoon, Pixar style, vibrant colors' },
]

export default function SceneEditor({
  droppedCharacters,
  allCharacters,
  onRemoveCharacter,
  onReorderDropped,
  onGenerate,
  onCancel,
  isLoading,
  genStatus,
  sceneCount,
  onReset,
  storyContext,
  focusTrigger,
  projectId,
  generateRateLimitSecs = 0,
  onBatchOutlineGenerate,
  onCancelBatchOutline,
  batchOutlineStatus,
}: Props) {
  // Scope the draft key to the current project so switching projects never
  // leaks a stale description into a different project's editor.
  // Fall back to a global key when no project is active (new session).
  const draftKey = projectId ? `scene_description_draft_${projectId}` : 'scene_description_draft'

  // Restore description draft from localStorage so the user doesn't lose work on
  // accidental page refresh. The draft is cleared after a scene is successfully
  // generated (sceneCount increments) and when the user resets the project.
  const [description, setDescription] = useState<string>(
    () => localStorage.getItem(draftKey) || ''
  )
  const prevSceneCountRef = useRef(sceneCount)

  // Restore last-used style from localStorage; if it was a custom (non-preset) value,
  // pre-fill the custom input so the user doesn't lose their setting across page loads.
  const [style, setStyle] = useState<string>(() => {
    return localStorage.getItem('scene_style') || '溫馨童趣'
  })
  const [customStyleText, setCustomStyleText] = useState<string>(() => {
    const saved = localStorage.getItem('scene_style') || ''
    return STYLES.includes(saved) ? '' : saved
  })
  const [showCustomStyle, setShowCustomStyle] = useState<boolean>(() => {
    const saved = localStorage.getItem('scene_style') || ''
    return !!saved && !STYLES.includes(saved)
  })
  const customStyleRef = useRef<HTMLInputElement>(null)

  // Restore last-used line length from localStorage.
  const [lineLength, setLineLength] = useState<LineLength>(() => {
    const saved = localStorage.getItem('scene_line_length') as LineLength | null
    return saved && ['short', 'standard', 'long'].includes(saved) ? saved : 'standard'
  })

  // Restore last-used line count from localStorage.
  const [lineCount, setLineCount] = useState<LineCount>(() => {
    const saved = localStorage.getItem('scene_line_count') as LineCount | null
    return saved && ['few', 'standard', 'many'].includes(saved) ? saved : 'standard'
  })

  // Restore last-used image style from localStorage.
  const [imageStyle, setImageStyle] = useState<string>(() => {
    const saved = localStorage.getItem('scene_image_style') || ''
    return IMAGE_STYLES.some(s => s.value === saved) ? saved : IMAGE_STYLES[0].value
  })

  // Age group for vocabulary/complexity adjustment
  const [ageGroup, setAgeGroup] = useState<AgeGroup>(() => {
    const saved = localStorage.getItem('scene_age_group') as AgeGroup | null
    return saved && ['toddler', 'child', 'preteen'].includes(saved) ? saved : 'child'
  })

  // Mood / emotional tone for this scene ('' = auto / no override)
  const [mood, setMood] = useState<string>(() => localStorage.getItem('scene_mood') ?? '')
  const [suggestingMood, setSuggestingMood] = useState(false)
  const [moodSuggestError, setMoodSuggestError] = useState<string | null>(null)
  const [imageLoading, setImageLoading] = useState(false)
  const [audioLoading, setAudioLoading] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const [showCharRef, setShowCharRef] = useState(false)
  const [copiedCharId, setCopiedCharId] = useState<string | null>(null)

  // Voice preview state for the drop-zone chips
  const [previewingChipId, setPreviewingChipId] = useState<string | null>(null)
  const chipAudioRef = useRef<HTMLAudioElement | null>(null)
  const chipPreviewLoadingRef = useRef<string | null>(null) // tracks which id is loading

  // When the active project changes, load that project's saved draft (or clear the field).
  // Also reset the suggestion-fetch sentinel so switching to a project with the same
  // scene count still triggers a fresh suggestion fetch for the new project's context.
  const prevProjectIdRef = useRef(projectId)
  useEffect(() => {
    if (projectId !== prevProjectIdRef.current) {
      prevProjectIdRef.current = projectId
      setDescription(localStorage.getItem(draftKey) || '')
      lastFetchedForCount.current = -1   // force re-fetch on next sceneCount/storyContext change
    }
  }, [projectId, draftKey])

  // Clean up rate-limit countdown timer and chip preview audio on unmount
  useEffect(() => () => {
    if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
    chipAudioRef.current?.pause()
  }, [])

  // Persist description draft and all other settings to localStorage.
  useEffect(() => { localStorage.setItem(draftKey, description) }, [draftKey, description])
  useEffect(() => { localStorage.setItem('scene_style', style) }, [style])
  useEffect(() => { localStorage.setItem('scene_line_length', lineLength) }, [lineLength])
  useEffect(() => { localStorage.setItem('scene_line_count',  lineCount)  }, [lineCount])
  useEffect(() => { localStorage.setItem('scene_image_style', imageStyle) }, [imageStyle])
  useEffect(() => { localStorage.setItem('scene_age_group',   ageGroup)   }, [ageGroup])
  useEffect(() => {
    if (mood) localStorage.setItem('scene_mood', mood)
    else localStorage.removeItem('scene_mood')
  }, [mood])

  // When sceneCount increases a scene was successfully generated — clear the draft.
  useEffect(() => {
    if (sceneCount > prevSceneCountRef.current) {
      setDescription('')
      localStorage.removeItem(draftKey)
    }
    prevSceneCountRef.current = sceneCount
  }, [sceneCount])

  // Elapsed-time counter for script generation step
  const [scriptElapsed, setScriptElapsed] = useState(0)
  const scriptTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const isScriptStep = isLoading && genStatus?.step === 'script'
    if (isScriptStep) {
      setScriptElapsed(0)
      scriptTimerRef.current = setInterval(() => setScriptElapsed(s => s + 1), 1000)
    } else {
      if (scriptTimerRef.current) { clearInterval(scriptTimerRef.current); scriptTimerRef.current = null }
    }
    return () => { if (scriptTimerRef.current) clearInterval(scriptTimerRef.current) }
  }, [isLoading, genStatus?.step])

  // Suggestion state
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState(false)
  // When the server returns 429 with a Retry-After header, count down to 0 then allow retry
  const [rateLimitSecs, setRateLimitSecs] = useState(0)
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Outline generation state
  const [showOutlinePanel, setShowOutlinePanel] = useState(false)
  const [outlineTheme, setOutlineTheme] = useState('')
  const [outlineSceneCount, setOutlineSceneCount] = useState(5)
  const [outlineLoading, setOutlineLoading] = useState(false)
  const [outlineScenes, setOutlineScenes] = useState<OutlineScene[]>([])
  const [outlineError, setOutlineError] = useState<string | null>(null)

  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  // Track which sceneCount we last fetched suggestions for, so we re-fetch
  // every time a new scene is added instead of stopping at suggestions.length > 0.
  const lastFetchedForCount = useRef(0)

  const { setNodeRef, isOver } = useDroppable({ id: 'scene-drop-zone' })

  // Characters to use for suggestions: prefer those in the drop zone; fall back to
  // the full character list so the feature remains accessible even before any dragging.
  const suggestChars = droppedCharacters.length > 0 ? droppedCharacters : allCharacters

  const fetchSuggestions = useCallback(async () => {
    if (suggestChars.length === 0 || suggestLoading || rateLimitSecs > 0) return
    setSuggestLoading(true)
    setSuggestError(false)
    try {
      const res = await fetch('/api/suggest-next-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characters: suggestChars,
          story_context: storyContext || null,  // null → first-scene prompt on backend
          style,
        }),
      })
      if (res.status === 429) {
        // Server sent Retry-After — show a countdown so the user knows when to retry
        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
        setRateLimitSecs(wait)
        setSuggestions([])
        if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
        rateLimitTimerRef.current = setInterval(() => {
          setRateLimitSecs(prev => {
            if (prev <= 1) {
              clearInterval(rateLimitTimerRef.current!)
              rateLimitTimerRef.current = null
              return 0
            }
            return prev - 1
          })
        }, 1000)
        return
      }
      if (!res.ok) throw new Error()
      const data = await res.json()
      setSuggestions(data.suggestions ?? [])
    } catch {
      setSuggestError(true)
      setSuggestions([])
    } finally {
      setSuggestLoading(false)
    }
  }, [storyContext, droppedCharacters, style, suggestLoading, rateLimitSecs])

  const handleGenerateOutline = async () => {
    if (!outlineTheme.trim() || outlineLoading || suggestChars.length === 0) return
    setOutlineLoading(true)
    setOutlineError(null)
    setOutlineScenes([])
    try {
      const res = await fetch('/api/generate-outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characters: suggestChars,
          theme: outlineTheme.trim(),
          style,
          scene_count: outlineSceneCount,
        }),
      })
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
        setOutlineError(`請求過於頻繁，請 ${wait} 秒後再試`)
        setTimeout(() => setOutlineError(null), wait * 1000)
      } else if (res.ok) {
        const data = await res.json()
        setOutlineScenes(data.scenes ?? [])
        if (!data.scenes?.length) setOutlineError('大綱生成失敗，請重試')
      } else {
        const data = await res.json().catch(() => ({}))
        setOutlineError(data.detail || '大綱生成失敗，請重試')
      }
    } catch {
      setOutlineError('網路錯誤，請稍後再試')
    } finally {
      setOutlineLoading(false)
    }
  }

  const handleSuggestMood = async () => {
    if (!description.trim() || suggestingMood) return
    setSuggestingMood(true)
    setMoodSuggestError(null)
    try {
      const res = await fetch('/api/suggest-mood', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          style,
          characters: suggestChars,
        }),
      })
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
        const msg = `請求過於頻繁，請 ${wait} 秒後再試`
        setMoodSuggestError(msg)
        setTimeout(() => setMoodSuggestError(e => e === msg ? null : e), wait * 1000)
      } else if (res.ok) {
        const data = await res.json()
        if (data.suggestions?.[0]) setMood(data.suggestions[0])
      } else {
        setMoodSuggestError('建議失敗，請稍後再試')
        setTimeout(() => setMoodSuggestError(null), 5000)
      }
    } catch {
      setMoodSuggestError('建議失敗，請確認網路連線')
      setTimeout(() => setMoodSuggestError(null), 5000)
    } finally {
      setSuggestingMood(false)
    }
  }

  // Collapsible editor state: collapsed = slim sticky bar, expanded = full form
  const [collapsed, setCollapsed] = useState(false)

  // Auto-expand when generation starts (don't hide progress indicator)
  useEffect(() => { if (isLoading) setCollapsed(false) }, [isLoading])

  // Focus description textarea when focusTrigger increments (e.g. "繼續創作下一幕")
  // Also auto-expand so the textarea is actually visible.
  useEffect(() => {
    if (focusTrigger) {
      setCollapsed(false)
      descriptionRef.current?.focus()
    }
  }, [focusTrigger])

  // Auto-fetch for first scene: trigger when characters become available for the
  // first time (either dragged in OR present in the full character list on load).
  const prevSuggestCountRef = useRef(0)
  useEffect(() => {
    const cur = suggestChars.length
    const prev = prevSuggestCountRef.current
    prevSuggestCountRef.current = cur
    if (cur > 0 && prev === 0 && sceneCount === 0 && !suggestLoading) {
      setSuggestions([])
      setSuggestError(false)
      fetchSuggestions()
    }
  }, [suggestChars.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch suggestions every time sceneCount increases.
  useEffect(() => {
    if (
      sceneCount > 0 &&
      sceneCount !== lastFetchedForCount.current &&
      suggestChars.length > 0 &&
      !suggestLoading
    ) {
      lastFetchedForCount.current = sceneCount
      setSuggestions([])
      setSuggestError(false)
      fetchSuggestions()
    }
  }, [sceneCount, storyContext]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the story style changes, clear and re-fetch after a short debounce.
  const styleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (suggestChars.length === 0) return
    setSuggestions([])
    setSuggestError(false)
    if (styleDebounceRef.current) clearTimeout(styleDebounceRef.current)
    styleDebounceRef.current = setTimeout(() => {
      fetchSuggestions()
    }, 600)
    return () => { if (styleDebounceRef.current) clearTimeout(styleDebounceRef.current) }
  }, [style]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear suggestions when description is filled manually
  const handleDescChange = (val: string) => {
    setDescription(val.slice(0, 500))
  }

  async function recognizeImageFile(file: File) {
    setInputError(null)
    setImageLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/recognize-image', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) throw new Error(json.detail || '圖片辨識失敗')
      setDescription(json.description.slice(0, 500))
    } catch (err: unknown) {
      setInputError(err instanceof Error ? err.message : '圖片辨識失敗，請稍後重試')
    } finally {
      setImageLoading(false)
    }
  }

  async function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!imageInputRef.current) return
    imageInputRef.current.value = ''
    if (!file) return
    await recognizeImageFile(file)
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items)
    const imageItem = items.find(item => item.type.startsWith('image/'))
    if (!imageItem) return
    // Clipboard has an image — intercept the paste and send to recognize-image instead
    e.preventDefault()
    const file = imageItem.getAsFile()
    if (!file) return
    await recognizeImageFile(file)
  }

  async function handleAudioFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!audioInputRef.current) return
    audioInputRef.current.value = ''
    if (!file) return

    setInputError(null)
    setAudioLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/transcribe', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) throw new Error(json.detail || '語音辨識失敗')
      setDescription(json.text.slice(0, 500))
    } catch (err: unknown) {
      setInputError(err instanceof Error ? err.message : '語音辨識失敗，請稍後重試')
    } finally {
      setAudioLoading(false)
    }
  }

  // Toggle voice preview for a dropped character chip.
  // Mirrors the CharacterCard preview pattern: GET /api/voices/{id}/preview → base64 audio.
  const handleChipPreview = useCallback(async (e: React.MouseEvent, char: Character) => {
    e.stopPropagation()
    // If this char is already playing, stop it
    if (previewingChipId === char.id) {
      chipAudioRef.current?.pause()
      chipAudioRef.current = null
      setPreviewingChipId(null)
      return
    }
    // Stop any previous preview
    chipAudioRef.current?.pause()
    chipAudioRef.current = null
    if (chipPreviewLoadingRef.current) return  // another fetch in flight
    if (!char.voice_id) return
    chipPreviewLoadingRef.current = char.id
    setPreviewingChipId(char.id)
    try {
      const res = await fetch(`/api/voices/${char.voice_id}/preview`)
      if (!res.ok) { setPreviewingChipId(null); return }
      const data = await res.json()
      const fmt = data.format || 'mp3'
      const audio = new Audio(`data:audio/${fmt};base64,${data.audio_base64}`)
      chipAudioRef.current = audio
      audio.onended = () => { setPreviewingChipId(null); chipAudioRef.current = null }
      audio.onerror = () => { setPreviewingChipId(null); chipAudioRef.current = null }
      audio.play().catch(() => { setPreviewingChipId(null); chipAudioRef.current = null })
    } catch {
      setPreviewingChipId(null)
    } finally {
      chipPreviewLoadingRef.current = null
    }
  }, [previewingChipId])

  return (
    <div className={`scene-editor${collapsed ? ' scene-editor-collapsed' : ''}`}>
      {/* ── Always-visible titlebar with collapse toggle ── */}
      <div className="scene-editor-titlebar">
        <h2>場景編輯</h2>
        {collapsed && (
          <div className="scene-editor-collapsed-info">
            {droppedCharacters.length > 0 && (
              <span className="scene-editor-char-preview">
                {droppedCharacters.map(c => c.emoji).join('')}
              </span>
            )}
            {sceneCount > 0 && (
              <span className="scene-editor-scene-count">已有 {sceneCount} 幕</span>
            )}
            {description.trim() && (
              <span className="scene-editor-desc-preview">
                「{description.slice(0, 24)}{description.length > 24 ? '…' : ''}」
              </span>
            )}
          </div>
        )}
        <button
          className="btn-collapse-editor"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? '展開場景編輯' : '收合場景編輯（收合後固定在頂端）'}
        >
          {collapsed ? '▼ 展開編輯' : '▲ 收合'}
        </button>
      </div>

      {/* ── Collapsible form body ── */}
      {!collapsed && (
      <div className="scene-top">

        {/* 場景描述 */}
        <textarea
          ref={descriptionRef}
          className="scene-input"
          placeholder="描述場景...&#10;例：在一片大森林裡，小兔子迷路了，遇見了一隻友善的狐狸&#10;（Ctrl+Enter 快速生成，可貼上圖片自動辨識）"
          value={description}
          onChange={e => handleDescChange(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              if (!isLoading && generateRateLimitSecs <= 0 && droppedCharacters.length > 0 && description.trim()) {
                onGenerate(description, style, lineLength, false, imageStyle, mood || undefined, lineCount, ageGroup)
              }
            }
          }}
          onPaste={handlePaste}
          rows={3}
          maxLength={500}
        />
        <div className="scene-input-toolbar">
          <p className="char-count" style={{ color: description.length >= 450 ? '#e53e3e' : '#bbb' }}>
            {description.length} / 500
          </p>
          <div className="scene-input-actions">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleImageFile}
            />
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/webm,video/webm"
              style={{ display: 'none' }}
              onChange={handleAudioFile}
            />
            <button
              className="btn-input-tool"
              onClick={() => imageInputRef.current?.click()}
              disabled={imageLoading || audioLoading}
              title="上傳圖片辨識場景"
            >
              {imageLoading
                ? <><span className="spinner spinner-sm" />辨識中...</>
                : '📷 辨識圖片'}
            </button>
            <button
              className="btn-input-tool"
              onClick={() => audioInputRef.current?.click()}
              disabled={imageLoading || audioLoading}
              title="上傳錄音轉換為文字"
            >
              {audioLoading
                ? <><span className="spinner spinner-sm" />辨識中...</>
                : '🎤 語音輸入'}
            </button>
          </div>
        </div>
        {inputError && (
          <div className="error-box" style={{ marginTop: '-8px' }}>{inputError}</div>
        )}

        {/* ✨ 開場/下一幕靈感建議：只要有角色（不論是否已拖入）就顯示 */}
        {suggestChars.length > 0 && (
          <div className="suggest-section">
            <div className="suggest-header">
              <span className="suggest-title">
                {sceneCount === 0 ? '✨ 開場靈感' : '✨ 下一幕靈感'}
              </span>
              <button
                className="btn-suggest-refresh"
                onClick={fetchSuggestions}
                disabled={suggestLoading || rateLimitSecs > 0}
                title={rateLimitSecs > 0 ? `${rateLimitSecs} 秒後可重試` : '換一批建議'}
              >
                {suggestLoading ? <span className="spinner-sm" /> : '🔄'}
              </button>
            </div>
            {suggestLoading && (
              <div className="suggest-loading">靈感生成中...</div>
            )}
            {!suggestLoading && rateLimitSecs > 0 && (
              <div className="suggest-error">
                請求過於頻繁，請等 <strong>{rateLimitSecs}</strong> 秒後再試
              </div>
            )}
            {!suggestLoading && rateLimitSecs === 0 && suggestError && (
              <div className="suggest-error">建議生成失敗，<button className="link-btn" onClick={fetchSuggestions}>重試</button></div>
            )}
            {!suggestLoading && suggestions.length > 0 && (
              <div className="suggest-chips">
                {suggestions.map((s, i) => {
                  const canQuickGen = droppedCharacters.length > 0 && !isLoading && (generateRateLimitSecs ?? 0) <= 0
                  return (
                    <div key={i} className={`suggest-chip-row${canQuickGen ? ' has-gen' : ''}`}>
                      <button
                        className={`suggest-chip${description === s ? ' active' : ''}`}
                        onClick={() => setDescription(s)}
                        title="點擊填入此描述"
                        type="button"
                      >
                        {s}
                      </button>
                      {canQuickGen && (
                        <button
                          className="suggest-chip-gen"
                          type="button"
                          onClick={() => {
                            setDescription(s)
                            onGenerate(s, style, lineLength, false, imageStyle, mood || undefined, lineCount)
                          }}
                          title="一鍵填入並立即生成此場景"
                        >⚡</button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 🗺️ 故事大綱生成 */}
        {suggestChars.length > 0 && (
          <div className="outline-section">
            <button
              className={`btn-outline-toggle${showOutlinePanel ? ' active' : ''}`}
              type="button"
              onClick={() => { setShowOutlinePanel(v => !v); setOutlineError(null) }}
              title="AI 一次規劃整本繪本的幕次結構"
            >
              🗺️ 生成故事大綱{showOutlinePanel ? ' ▲' : ' ▼'}
            </button>

            {showOutlinePanel && (
              <div className="outline-panel">
                <div className="outline-theme-row">
                  <input
                    className="outline-theme-input"
                    type="text"
                    placeholder="故事主題或靈感（例如：小兔子在森林裡迷路，遇到新朋友的故事）"
                    value={outlineTheme}
                    onChange={e => setOutlineTheme(e.target.value.slice(0, 200))}
                    onKeyDown={e => { if (e.key === 'Enter') handleGenerateOutline() }}
                    maxLength={200}
                  />
                </div>
                <div className="outline-controls">
                  <span className="outline-label">幕數</span>
                  {[3, 4, 5, 6, 7].map(n => (
                    <button
                      key={n}
                      type="button"
                      className={`outline-count-btn${outlineSceneCount === n ? ' active' : ''}`}
                      onClick={() => setOutlineSceneCount(n)}
                    >{n} 幕</button>
                  ))}
                  <button
                    type="button"
                    className="btn-outline-gen"
                    onClick={handleGenerateOutline}
                    disabled={outlineLoading || !outlineTheme.trim() || suggestChars.length === 0}
                    title={suggestChars.length === 0 ? '請先建立角色' : ''}
                  >
                    {outlineLoading
                      ? <><span className="spinner spinner-sm" />生成中...</>
                      : '✨ 生成大綱'}
                  </button>
                </div>
                {outlineError && <div className="suggest-error">{outlineError}</div>}
                {outlineScenes.length > 0 && (
                  <div className="outline-scenes">
                    {/* 批次生成全部 / 取消 按鈕 */}
                    {onBatchOutlineGenerate && droppedCharacters.length > 0 && (generateRateLimitSecs ?? 0) <= 0 && (
                      <div className="outline-batch-bar">
                        {batchOutlineStatus ? (
                          <>
                            <span className="outline-batch-progress">
                              <span className="spinner spinner-sm" />
                              批次生成中 {batchOutlineStatus.done}/{batchOutlineStatus.total} 幕…
                            </span>
                            <button
                              type="button"
                              className="btn-outline-cancel"
                              onClick={onCancelBatchOutline}
                            >✕ 取消</button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-batch-outline"
                            disabled={isLoading}
                            onClick={() => onBatchOutlineGenerate(outlineScenes, style, lineLength, imageStyle, mood || undefined, lineCount, ageGroup)}
                            title="依大綱順序逐幕生成完整場景（含劇本、語音、插圖）"
                          >🚀 批次生成全部（{outlineScenes.length} 幕）</button>
                        )}
                      </div>
                    )}
                    {outlineScenes.map((scene, i) => (
                      <div key={i} className="outline-scene-card">
                        <div className="outline-scene-header">
                          <span className="outline-scene-num">第 {i + 1} 幕</span>
                          <span className="outline-scene-title">《{scene.title}》</span>
                          <button
                            type="button"
                            className="outline-scene-use"
                            onClick={() => setDescription(scene.description)}
                            title="將此描述填入場景編輯器"
                          >使用</button>
                          {droppedCharacters.length > 0 && !isLoading && !batchOutlineStatus && (generateRateLimitSecs ?? 0) <= 0 && (
                            <button
                              type="button"
                              className="outline-scene-gen"
                              onClick={() => {
                                setDescription(scene.description)
                                onGenerate(scene.description, style, lineLength, false, imageStyle, mood || undefined, lineCount)
                              }}
                              title="填入描述並立即生成此場景"
                            >⚡ 立即生成</button>
                          )}
                        </div>
                        <p className="outline-scene-desc">{scene.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 風格選擇 */}
        <div className="style-row">
          <label>故事風格</label>
          <div className="style-buttons">
            {STYLES.map(s => (
              <button
                key={s}
                className={`style-btn ${style === s && !showCustomStyle ? 'active' : ''}`}
                onClick={() => { setStyle(s); setShowCustomStyle(false); setCustomStyleText('') }}
              >{s}</button>
            ))}
            <button
              className={`style-btn ${showCustomStyle ? 'active' : ''}`}
              onClick={() => {
                setShowCustomStyle(true)
                setTimeout(() => customStyleRef.current?.focus(), 50)
              }}
              title="輸入自訂故事風格"
            >✏️ 自訂</button>
          </div>
          {showCustomStyle && (
            <div className="custom-style-wrap">
              <input
                ref={customStyleRef}
                className="custom-style-input"
                type="text"
                placeholder="輸入風格（最多 10 字）"
                maxLength={20}
                value={customStyleText}
                onChange={e => {
                  setCustomStyleText(e.target.value)
                  if (e.target.value.trim()) setStyle(e.target.value.trim())
                }}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    setShowCustomStyle(false)
                    setCustomStyleText('')
                    setStyle('溫馨童趣')
                  }
                }}
              />
              {customStyleText.trim() && (
                <span className="custom-style-preview">目前：{customStyleText.trim()}</span>
              )}
            </div>
          )}
        </div>

        {/* 台詞長度設定 */}
        <div className="style-row">
          <label>台詞長度</label>
          <div className="style-buttons">
            {([
              { value: 'short',    label: '幼兒（≤12字）' },
              { value: 'standard', label: '標準（≤20字）' },
              { value: 'long',     label: '進階（≤35字）' },
            ] as { value: LineLength; label: string }[]).map(opt => (
              <button
                key={opt.value}
                className={`style-btn ${lineLength === opt.value ? 'active' : ''}`}
                onClick={() => setLineLength(opt.value)}
                type="button"
                title={
                  opt.value === 'short'    ? '適合 2–4 歲，用詞極簡單' :
                  opt.value === 'standard' ? '適合 5–7 歲（預設）' :
                                             '適合 8 歲以上，詞彙較豐富'
                }
              >{opt.label}</button>
            ))}
          </div>
        </div>

        {/* 台詞數量設定 */}
        <div className="style-row">
          <label>台詞數量</label>
          <div className="style-buttons">
            {([
              { value: 'few',      label: '精簡（3-5句）' },
              { value: 'standard', label: '標準（6-9句）' },
              { value: 'many',     label: '豐富（10-14句）' },
            ] as { value: LineCount; label: string }[]).map(opt => (
              <button
                key={opt.value}
                className={`style-btn ${lineCount === opt.value ? 'active' : ''}`}
                onClick={() => setLineCount(opt.value)}
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

        {/* 年齡層設定 */}
        <div className="style-row">
          <label>年齡層</label>
          <div className="style-buttons">
            {([
              { value: 'toddler', label: '🐣 幼兒（3-6歲）', title: '極簡用語、重複句型，適合最小的讀者' },
              { value: 'child',   label: '🧒 兒童（7-10歲）', title: '清楚易懂的詞彙，標準兒童故事（預設）' },
              { value: 'preteen', label: '📚 少年（11-14歲）', title: '豐富詞彙與比喻，情節更有深度' },
            ] as { value: AgeGroup; label: string; title: string }[]).map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`style-btn ${ageGroup === opt.value ? 'active' : ''}`}
                onClick={() => setAgeGroup(opt.value)}
                title={opt.title}
              >{opt.label}</button>
            ))}
          </div>
        </div>

        {/* 情感基調 */}
        <div className="style-row">
          <label>
            情感基調
            <button
              type="button"
              className="btn-ai-inline"
              onClick={handleSuggestMood}
              disabled={!description.trim() || suggestingMood}
              title={description.trim() ? 'AI 根據場景描述建議情感基調' : '請先填寫場景描述'}
            >
              {suggestingMood ? <span className="spinner-sm" /> : '✨'}
            </button>
          </label>
          <div className="style-buttons">
            <button
              type="button"
              className={`style-btn ${mood === '' ? 'active' : ''}`}
              onClick={() => setMood('')}
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
                type="button"
                className={`style-btn ${mood === opt.value ? 'active' : ''}`}
                onClick={() => setMood(opt.value)}
                title={opt.value}
              >{opt.emoji} {opt.value}</button>
            ))}
          </div>
          {moodSuggestError && <div className="suggest-error">{moodSuggestError}</div>}
        </div>

        {/* 插圖風格 */}
        <div className="style-row">
          <label>插圖風格</label>
          <div className="style-buttons">
            {IMAGE_STYLES.map(opt => (
              <button
                key={opt.value}
                className={`style-btn ${imageStyle === opt.value ? 'active' : ''}`}
                onClick={() => setImageStyle(opt.value)}
                title={opt.value}
                type="button"
              >{opt.label}</button>
            ))}
          </div>
        </div>

        {/* 角色拖放區 */}
        <div
          ref={setNodeRef}
          className={`drop-zone ${isOver ? 'over' : ''} ${droppedCharacters.length > 0 ? 'has-chars' : ''}`}
        >
          {droppedCharacters.length === 0 ? (
            <div className="drop-hint">
              <span className="drop-icon">🎭</span>
              <span>從左側拖曳角色卡片到這裡</span>
            </div>
          ) : (
            <div className="dropped-chars">
              {droppedCharacters.map((c, i) => (
                <div
                  key={c.id}
                  className="dropped-char-chip"
                  style={{ borderColor: c.color, background: `${c.color}22` }}
                >
                  {droppedCharacters.length > 1 && (
                    <div className="char-reorder-btns">
                      <button
                        className="btn-char-reorder"
                        onClick={() => onReorderDropped(i, i - 1)}
                        disabled={i === 0}
                        title="向左移（調整對話順序）"
                      >‹</button>
                      <button
                        className="btn-char-reorder"
                        onClick={() => onReorderDropped(i, i + 1)}
                        disabled={i === droppedCharacters.length - 1}
                        title="向右移（調整對話順序）"
                      >›</button>
                    </div>
                  )}
                  <span>{c.emoji}</span>
                  <span style={{ color: c.color }}>{c.name}</span>
                  {c.voice_id && (
                    <button
                      className={`btn-chip-preview${previewingChipId === c.id ? ' playing' : ''}`}
                      onClick={e => handleChipPreview(e, c)}
                      title={previewingChipId === c.id ? '停止試聽' : '試聽角色聲音'}
                    >
                      {previewingChipId === c.id ? '⏹' : '🔊'}
                    </button>
                  )}
                  <button onClick={() => onRemoveCharacter(c.id)} title="移除角色">×</button>
                </div>
              ))}
              <div className="drop-more-hint">可繼續拖入角色 · 順序影響對話結構</div>
            </div>
          )}
        </div>

        {/* 角色外觀速查 — 輔助撰寫一致的場景描述 */}
        {droppedCharacters.length > 0 && droppedCharacters.some(c => c.visual_description) && (
          <div className="char-ref-panel">
            <button
              className="char-ref-toggle"
              onClick={() => setShowCharRef(v => !v)}
              type="button"
            >
              {showCharRef ? '▲' : '▼'} 角色外觀速查
              <span className="char-ref-toggle-hint">（輔助撰寫場景描述）</span>
            </button>
            {showCharRef && (
              <div className="char-ref-list">
                {droppedCharacters.filter(c => c.visual_description).map(c => (
                  <div key={c.id} className="char-ref-item" style={{ borderLeftColor: c.color }}>
                    <span className="char-ref-name" style={{ color: c.color }}>{c.emoji} {c.name}</span>
                    <span className="char-ref-desc">{c.visual_description}</span>
                    <button
                      className={`char-ref-copy${copiedCharId === c.id ? ' copied' : ''}`}
                      onClick={() => {
                        navigator.clipboard.writeText(c.visual_description!).catch(() => {})
                        setCopiedCharId(c.id)
                        setTimeout(() => setCopiedCharId(null), 1500)
                      }}
                      title="複製外觀描述"
                      type="button"
                    >
                      {copiedCharId === c.id ? '✓' : '📋'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 生成按鈕列 */}
        <div className="generate-row">
          {isLoading ? (
            <>
              <button className="btn-generate" disabled>
                <span className="loading-text"><span className="spinner" />生成中...</span>
              </button>
              <button className="btn-cancel" onClick={onCancel} title="取消本次生成，保留已有幕次">
                ✕ 取消
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-generate"
                onClick={() => onGenerate(description, style, lineLength, false, imageStyle, mood || undefined, lineCount, ageGroup)}
                disabled={droppedCharacters.length === 0 || !description.trim() || generateRateLimitSecs > 0}
                title={generateRateLimitSecs > 0 ? `請求過於頻繁，請等 ${generateRateLimitSecs} 秒後再試` : undefined}
              >
                {generateRateLimitSecs > 0
                  ? `⏳ 請稍候 ${generateRateLimitSecs} 秒…`
                  : sceneCount > 0 ? `✨ 繼續第 ${sceneCount + 1} 幕` : '✨ 生成繪本場景'}
              </button>
              {sceneCount > 0 && (
                <button
                  className="btn-reset"
                  onClick={() => {
                    setDescription('')
                    localStorage.removeItem(draftKey)
                    onReset()
                  }}
                  title="清除所有幕次，重新開始"
                >
                  🔄 重新開始
                </button>
              )}
              {sceneCount >= 2 && (
                <button
                  className="btn-ending"
                  onClick={() => {
                    const desc = description.trim() || '故事結尾'
                    onGenerate(desc, style, lineLength, true, imageStyle, mood || undefined, lineCount, ageGroup)
                  }}
                  disabled={droppedCharacters.length === 0 || generateRateLimitSecs > 0}
                  title={generateRateLimitSecs > 0 ? `請稍候 ${generateRateLimitSecs} 秒` : '讓 AI 自動為故事寫一個圓滿結尾'}
                >
                  🏁 生成結尾
                </button>
              )}
            </>
          )}
        </div>

        {/* 生成進度指示器 */}
        {isLoading && genStatus && (
          <div className="gen-progress">
            {genStatus.step === 'script' && (
              <>
                <div className="gen-step">
                  <span className="gen-step-icon spinning">⟳</span>
                  <span>
                    正在生成劇本...
                    {scriptElapsed > 0 && (
                      <span className="gen-elapsed"> {scriptElapsed} 秒</span>
                    )}
                  </span>
                </div>
                <div className="gen-progress-bar">
                  <div className="gen-progress-indeterminate" />
                </div>
              </>
            )}
            {genStatus.step === 'media' && (
              <>
                <div className="gen-step">
                  <span className="gen-step-icon">✓</span>
                  <span>劇本完成</span>
                </div>
                <div className="gen-step active">
                  <span className="gen-step-icon spinning">⟳</span>
                  <span>
                    合成配音
                    {genStatus.total > 0 && ` ${genStatus.done} / ${genStatus.total}`}
                    &nbsp;· 繪製插圖
                  </span>
                </div>
                {genStatus.total > 0 && (
                  <div className="gen-progress-bar">
                    <div
                      className="gen-progress-fill"
                      style={{ width: `${Math.round((genStatus.done / genStatus.total) * 100)}%` }}
                    />
                  </div>
                )}
              </>
            )}
            {genStatus.step === 'done' && (
              <div className="gen-step done">
                <span className="gen-step-icon">✓</span>
                <span>生成完成！</span>
              </div>
            )}
          </div>
        )}

        {droppedCharacters.length === 0 && (
          <p className="form-hint">請先拖入至少一個角色</p>
        )}
        {sceneCount > 0 && !isLoading && (
          <p className="form-hint">已有 {sceneCount} 幕，下一幕將自動銜接前情</p>
        )}
      </div>
      )}
    </div>
  )
}

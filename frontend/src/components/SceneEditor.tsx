import { useRef, useState, useEffect, useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Character } from '../types'

interface GenStatus {
  step: string   // 'script' | 'media' | 'done'
  done: number
  total: number
}

type LineLength = 'short' | 'standard' | 'long'

interface Props {
  droppedCharacters: Character[]
  allCharacters: Character[]   // full character list from the left panel
  onRemoveCharacter: (id: string) => void
  onReorderDropped: (fromIdx: number, toIdx: number) => void
  onGenerate: (description: string, style: string, lineLength: LineLength, isEnding?: boolean, imageStyle?: string) => void
  onCancel: () => void
  isLoading: boolean
  genStatus: GenStatus | null
  sceneCount: number
  onReset: () => void
  storyContext?: string   // context from previous scenes for suggestions
  focusTrigger?: number  // increment to focus the description textarea
  projectId?: string | null  // scope the description draft to the current project
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

  // Restore last-used image style from localStorage.
  const [imageStyle, setImageStyle] = useState<string>(() => {
    const saved = localStorage.getItem('scene_image_style') || ''
    return IMAGE_STYLES.some(s => s.value === saved) ? saved : IMAGE_STYLES[0].value
  })
  const [imageLoading, setImageLoading] = useState(false)
  const [audioLoading, setAudioLoading] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const [showCharRef, setShowCharRef] = useState(false)
  const [copiedCharId, setCopiedCharId] = useState<string | null>(null)

  // When the active project changes, load that project's saved draft (or clear the field).
  const prevProjectIdRef = useRef(projectId)
  useEffect(() => {
    if (projectId !== prevProjectIdRef.current) {
      prevProjectIdRef.current = projectId
      setDescription(localStorage.getItem(draftKey) || '')
    }
  }, [projectId, draftKey])

  // Clean up rate-limit countdown timer on unmount
  useEffect(() => () => {
    if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current)
  }, [])

  // Persist description draft and all other settings to localStorage.
  useEffect(() => { localStorage.setItem(draftKey, description) }, [draftKey, description])
  useEffect(() => { localStorage.setItem('scene_style', style) }, [style])
  useEffect(() => { localStorage.setItem('scene_line_length', lineLength) }, [lineLength])
  useEffect(() => { localStorage.setItem('scene_image_style', imageStyle) }, [imageStyle])

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
              if (!isLoading && droppedCharacters.length > 0 && description.trim()) {
                onGenerate(description, style, lineLength, false, imageStyle)
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
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    className={`suggest-chip ${description === s ? 'active' : ''}`}
                    onClick={() => setDescription(s)}
                    title="點擊填入此描述"
                  >
                    {s}
                  </button>
                ))}
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
                onClick={() => onGenerate(description, style, lineLength, false, imageStyle)}
                disabled={droppedCharacters.length === 0 || !description.trim()}
              >
                {sceneCount > 0 ? `✨ 繼續第 ${sceneCount + 1} 幕` : '✨ 生成繪本場景'}
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
                    onGenerate(desc, style, lineLength, true, imageStyle)
                  }}
                  disabled={droppedCharacters.length === 0}
                  title="讓 AI 自動為故事寫一個圓滿結尾"
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

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
  onRemoveCharacter: (id: string) => void
  onGenerate: (description: string, style: string, lineLength: LineLength, isEnding?: boolean, imageStyle?: string) => void
  onCancel: () => void
  isLoading: boolean
  genStatus: GenStatus | null
  sceneCount: number
  onReset: () => void
  storyContext?: string   // context from previous scenes for suggestions
  focusTrigger?: number  // increment to focus the description textarea
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
  onRemoveCharacter,
  onGenerate,
  onCancel,
  isLoading,
  genStatus,
  sceneCount,
  onReset,
  storyContext,
  focusTrigger,
}: Props) {
  const [description, setDescription] = useState('')

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

  // Persist style, lineLength, and imageStyle to localStorage whenever they change.
  useEffect(() => { localStorage.setItem('scene_style', style) }, [style])
  useEffect(() => { localStorage.setItem('scene_line_length', lineLength) }, [lineLength])
  useEffect(() => { localStorage.setItem('scene_image_style', imageStyle) }, [imageStyle])

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

  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  // Track which sceneCount we last fetched suggestions for, so we re-fetch
  // every time a new scene is added instead of stopping at suggestions.length > 0.
  const lastFetchedForCount = useRef(0)

  const { setNodeRef, isOver } = useDroppable({ id: 'scene-drop-zone' })

  const fetchSuggestions = useCallback(async () => {
    if (droppedCharacters.length === 0 || suggestLoading) return
    setSuggestLoading(true)
    setSuggestError(false)
    try {
      const res = await fetch('/api/suggest-next-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characters: droppedCharacters,
          story_context: storyContext || null,  // null → first-scene prompt on backend
          style,
        }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setSuggestions(data.suggestions ?? [])
    } catch {
      setSuggestError(true)
      setSuggestions([])
    } finally {
      setSuggestLoading(false)
    }
  }, [storyContext, droppedCharacters, style, suggestLoading])

  // Focus description textarea when focusTrigger increments (e.g. "繼續創作下一幕")
  useEffect(() => {
    if (focusTrigger) descriptionRef.current?.focus()
  }, [focusTrigger])

  // Auto-fetch for first scene: trigger when characters are first dropped in
  const prevCharCountRef = useRef(0)
  useEffect(() => {
    const cur = droppedCharacters.length
    const prev = prevCharCountRef.current
    prevCharCountRef.current = cur
    // Fetch when the first character is added (prev=0 → cur>0) and this is scene 0
    if (cur > 0 && prev === 0 && sceneCount === 0 && !suggestLoading) {
      setSuggestions([])
      setSuggestError(false)
      fetchSuggestions()
    }
  }, [droppedCharacters.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch suggestions every time sceneCount increases.
  // Previously this was gated on suggestions.length === 0, which meant after the
  // first fetch the suggestions never updated for subsequent scenes.
  useEffect(() => {
    if (
      sceneCount > 0 &&
      sceneCount !== lastFetchedForCount.current &&
      droppedCharacters.length > 0 &&
      !suggestLoading
    ) {
      lastFetchedForCount.current = sceneCount
      setSuggestions([])
      setSuggestError(false)
      fetchSuggestions()
    }
  }, [sceneCount, storyContext]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the story style changes, existing suggestions were generated for the old
  // style and may be misleading.  Clear them immediately and re-fetch after a short
  // debounce so rapid style-switching doesn't spam the backend.
  const styleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (droppedCharacters.length === 0) return
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

  async function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!imageInputRef.current) return
    imageInputRef.current.value = ''
    if (!file) return

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
    <div className="scene-editor">
      <div className="scene-top">
        <h2>場景編輯</h2>

        {/* 場景描述 */}
        <textarea
          ref={descriptionRef}
          className="scene-input"
          placeholder="描述場景...&#10;例：在一片大森林裡，小兔子迷路了，遇見了一隻友善的狐狸&#10;（Ctrl+Enter 快速生成）"
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

        {/* ✨ 開場/下一幕靈感建議 */}
        {droppedCharacters.length > 0 && (
          <div className="suggest-section">
            <div className="suggest-header">
              <span className="suggest-title">
                {sceneCount === 0 ? '✨ 開場靈感' : '✨ 下一幕靈感'}
              </span>
              <button
                className="btn-suggest-refresh"
                onClick={fetchSuggestions}
                disabled={suggestLoading}
                title="換一批建議"
              >
                {suggestLoading ? <span className="spinner-sm" /> : '🔄'}
              </button>
            </div>
            {suggestLoading && (
              <div className="suggest-loading">靈感生成中...</div>
            )}
            {!suggestLoading && suggestError && (
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
              {droppedCharacters.map(c => (
                <div
                  key={c.id}
                  className="dropped-char-chip"
                  style={{ borderColor: c.color, background: `${c.color}22` }}
                >
                  <span>{c.emoji}</span>
                  <span style={{ color: c.color }}>{c.name}</span>
                  <button onClick={() => onRemoveCharacter(c.id)}>×</button>
                </div>
              ))}
              <div className="drop-more-hint">可繼續拖入更多角色</div>
            </div>
          )}
        </div>

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
                <button className="btn-reset" onClick={onReset} title="清除所有幕次，重新開始">
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
    </div>
  )
}

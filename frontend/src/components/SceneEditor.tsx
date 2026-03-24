import { useRef, useState, useEffect, useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Character } from '../types'

interface GenStatus {
  step: string   // 'script' | 'media' | 'done'
  done: number
  total: number
}

interface Props {
  droppedCharacters: Character[]
  onRemoveCharacter: (id: string) => void
  onGenerate: (description: string, style: string) => void
  isLoading: boolean
  genStatus: GenStatus | null
  sceneCount: number
  onReset: () => void
  storyContext?: string   // context from previous scenes for suggestions
}

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

export default function SceneEditor({
  droppedCharacters,
  onRemoveCharacter,
  onGenerate,
  isLoading,
  genStatus,
  sceneCount,
  onReset,
  storyContext,
}: Props) {
  const [description, setDescription] = useState('')
  const [style, setStyle] = useState('溫馨童趣')
  const [imageLoading, setImageLoading] = useState(false)
  const [audioLoading, setAudioLoading] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)

  // Suggestion state
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState(false)

  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  // Track which sceneCount we last fetched suggestions for, so we re-fetch
  // every time a new scene is added instead of stopping at suggestions.length > 0.
  const lastFetchedForCount = useRef(0)

  const { setNodeRef, isOver } = useDroppable({ id: 'scene-drop-zone' })

  const fetchSuggestions = useCallback(async () => {
    if (!storyContext || droppedCharacters.length === 0 || suggestLoading) return
    setSuggestLoading(true)
    setSuggestError(false)
    try {
      const res = await fetch('/api/suggest-next-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characters: droppedCharacters,
          story_context: storyContext,
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

  // Re-fetch suggestions every time sceneCount increases.
  // Previously this was gated on suggestions.length === 0, which meant after the
  // first fetch the suggestions never updated for subsequent scenes.
  useEffect(() => {
    if (
      sceneCount > 0 &&
      sceneCount !== lastFetchedForCount.current &&
      storyContext &&
      droppedCharacters.length > 0 &&
      !suggestLoading
    ) {
      lastFetchedForCount.current = sceneCount
      setSuggestions([])
      setSuggestError(false)
      fetchSuggestions()
    }
  }, [sceneCount, storyContext]) // eslint-disable-line react-hooks/exhaustive-deps

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
          className="scene-input"
          placeholder="描述場景...&#10;例：在一片大森林裡，小兔子迷路了，遇見了一隻友善的狐狸&#10;（Ctrl+Enter 快速生成）"
          value={description}
          onChange={e => handleDescChange(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              if (!isLoading && droppedCharacters.length > 0 && description.trim()) {
                onGenerate(description, style)
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

        {/* ✨ 下一幕靈感建議（只在已有幕次時顯示） */}
        {sceneCount > 0 && (
          <div className="suggest-section">
            <div className="suggest-header">
              <span className="suggest-title">✨ 下一幕靈感</span>
              <button
                className="btn-suggest-refresh"
                onClick={fetchSuggestions}
                disabled={suggestLoading || droppedCharacters.length === 0}
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
                className={`style-btn ${style === s ? 'active' : ''}`}
                onClick={() => setStyle(s)}
              >{s}</button>
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
          <button
            className="btn-generate"
            onClick={() => onGenerate(description, style)}
            disabled={isLoading || droppedCharacters.length === 0 || !description.trim()}
          >
            {isLoading ? (
              <span className="loading-text"><span className="spinner" />生成中...</span>
            ) : sceneCount > 0 ? (
              `✨ 繼續第 ${sceneCount + 1} 幕`
            ) : (
              '✨ 生成繪本場景'
            )}
          </button>
          {sceneCount > 0 && (
            <button className="btn-reset" onClick={onReset} disabled={isLoading} title="清除所有幕次，重新開始">
              🔄 重新開始
            </button>
          )}
        </div>

        {/* 生成進度指示器 */}
        {isLoading && genStatus && (
          <div className="gen-progress">
            {genStatus.step === 'script' && (
              <div className="gen-step">
                <span className="gen-step-icon spinning">⟳</span>
                <span>正在生成劇本...</span>
              </div>
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

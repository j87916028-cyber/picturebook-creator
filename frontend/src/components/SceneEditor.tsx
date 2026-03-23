import { useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Character } from '../types'

interface Props {
  droppedCharacters: Character[]
  onRemoveCharacter: (id: string) => void
  onGenerate: (description: string, style: string) => void
  isLoading: boolean
  sceneCount: number
  onReset: () => void
}

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

export default function SceneEditor({
  droppedCharacters,
  onRemoveCharacter,
  onGenerate,
  isLoading,
  sceneCount,
  onReset,
}: Props) {
  const [description, setDescription] = useState('')
  const [style, setStyle] = useState('溫馨童趣')
  const [imageLoading, setImageLoading] = useState(false)
  const [audioLoading, setAudioLoading] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)

  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)

  const { setNodeRef, isOver } = useDroppable({ id: 'scene-drop-zone' })

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
          placeholder="描述場景...&#10;例：在一片大森林裡，小兔子迷路了，遇見了一隻友善的狐狸"
          value={description}
          onChange={e => setDescription(e.target.value.slice(0, 500))}
          rows={3}
          maxLength={500}
        />
        <div className="scene-input-toolbar">
          <p className="char-count" style={{ color: description.length >= 450 ? '#e53e3e' : '#bbb' }}>
            {description.length} / 500
          </p>
          <div className="scene-input-actions">
            {/* 隱藏的圖片 input */}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleImageFile}
            />
            {/* 隱藏的音訊 input */}
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

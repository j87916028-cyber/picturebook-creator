import { useRef, useState, useCallback, useEffect } from 'react'
import { Scene, Character } from '../types'
import PlaybackModal from './PlaybackModal'

// Resolve image src: use data URI if base64 blob, else bare URL
function resolveImgSrc(image: string): string {
  if (!image) return ''
  if (image.startsWith('data:') || image.startsWith('http') || image.startsWith('/')) return image
  return `data:image/jpeg;base64,${image}`
}

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

const EMOTION_LABELS: Record<string, string> = {
  happy:     '😄 開心',
  sad:       '😢 難過',
  angry:     '😠 生氣',
  surprised: '😲 驚訝',
  fearful:   '😨 害怕',
  disgusted: '🤢 厭惡',
  neutral:   '😐 平靜',
}

interface Props {
  scenes: Scene[]
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onSceneMove: (sceneId: string, direction: 'up' | 'down') => void
  onLineTextChange: (sceneId: string, lineIndex: number, newText: string) => void
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onImageRegen: (sceneId: string) => Promise<void>
  onSceneRegen: (sceneId: string, newDescription: string, style: string) => Promise<void>
}

interface SceneCardProps {
  scene: Scene
  sceneIndex: number
  totalScenes: number
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onSceneMove: (sceneId: string, direction: 'up' | 'down') => void
  onLineTextChange: (sceneId: string, lineIndex: number, newText: string) => void
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onImageRegen: (sceneId: string) => Promise<void>
  onSceneRegen: (sceneId: string, newDescription: string, style: string) => Promise<void>
  onPlayFromScene: (sceneIndex: number) => void
}

function SceneCard({
  scene,
  sceneIndex,
  totalScenes,
  characters,
  onSceneDelete,
  onSceneMove,
  onLineTextChange,
  onLineVoiceRegen,
  onImageRegen,
  onSceneRegen,
  onPlayFromScene,
}: SceneCardProps) {
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

  // Edit state
  const [editingLineIndex, setEditingLineIndex] = useState<number | null>(null)
  const [editLineText, setEditLineText] = useState('')
  const [regenVoiceIndex, setRegenVoiceIndex] = useState<number | null>(null)
  const [regenImage, setRegenImage] = useState(false)
  const [showRegenForm, setShowRegenForm] = useState(false)
  const [regenDesc, setRegenDesc] = useState(scene.description)
  const [regenStyle, setRegenStyle] = useState(scene.style)
  const [regenLoading, setRegenLoading] = useState(false)
  const [regenError, setRegenError] = useState<string | null>(null)
  const [expandedImage, setExpandedImage] = useState(false)

  const getCharacter = (id: string) => characters.find(c => c.id === id)

  // Close lightbox on Escape
  useEffect(() => {
    if (!expandedImage) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedImage(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expandedImage])

  const playLine = useCallback((index: number) => {
    audioRefs.current.forEach((a, i) => {
      if (a && i !== index) { a.pause(); a.currentTime = 0 }
    })
    const audio = audioRefs.current[index]
    if (!audio) return

    setPlayingIndex(prev => {
      if (prev === index) {
        audio.pause()
        return null
      }
      audio.play()
      audio.onended = () => {
        setPlayingIndex(null)
        if (index + 1 < scene.lines.length) {
          setTimeout(() => playLine(index + 1), 300)
        }
      }
      return index
    })
  }, [scene.lines])

  const playAll = () => {
    if (scene.lines.length > 0) playLine(0)
  }

  const handleDownloadImage = () => {
    if (!scene.image) return
    const filename = `第${sceneIndex + 1}幕插圖`
    if (scene.image.startsWith('data:')) {
      // data: URI — browser can download directly
      const ext = scene.image.match(/^data:image\/(\w+)/)?.[1] ?? 'png'
      const a = document.createElement('a')
      a.href = scene.image
      a.download = `${filename}.${ext}`
      a.click()
    } else {
      // External URL — fetch then blob-download to force save-as instead of navigating
      fetch(scene.image)
        .then(r => r.blob())
        .then(blob => {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `${filename}.jpg`
          a.click()
          URL.revokeObjectURL(url)
        })
        .catch(() => {})
    }
  }

  const isGenerating = scene.lines.length === 0

  const handleDeleteScene = () => {
    if (window.confirm(`確定要刪除第 ${sceneIndex + 1} 幕嗎？此動作無法復原。`)) {
      onSceneDelete(scene.id)
    }
  }

  const handleStartEditLine = (index: number, text: string) => {
    setEditingLineIndex(index)
    setEditLineText(text)
  }

  const handleConfirmEditLine = (index: number) => {
    if (editLineText.trim()) {
      onLineTextChange(scene.id, index, editLineText.trim())
    }
    setEditingLineIndex(null)
  }

  const handleCancelEditLine = () => {
    setEditingLineIndex(null)
    setEditLineText('')
  }

  const handleVoiceRegen = async (index: number) => {
    setRegenVoiceIndex(index)
    try {
      await onLineVoiceRegen(scene.id, index)
    } finally {
      setRegenVoiceIndex(null)
    }
  }

  const handleImageRegen = async () => {
    setRegenImage(true)
    try {
      await onImageRegen(scene.id)
    } finally {
      setRegenImage(false)
    }
  }

  const handleSceneRegenSubmit = async () => {
    if (!regenDesc.trim()) return
    setRegenLoading(true)
    setRegenError(null)
    try {
      await onSceneRegen(scene.id, regenDesc.trim(), regenStyle)
      setShowRegenForm(false)
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : '重新生成失敗，請稍後重試')
    } finally {
      setRegenLoading(false)
    }
  }

  const hasAudio = scene.lines.some(l => l.audio_base64)

  return (
    <div className="scene-card">
      <div className="scene-card-header">
        <span className="scene-card-title">第 {sceneIndex + 1} 幕</span>
        <span className="scene-card-desc">{scene.description}</span>
        <div className="scene-header-right">
          {hasAudio && (
            <button
              className="btn-play-from-scene"
              onClick={() => onPlayFromScene(sceneIndex)}
              title="從此幕開始播放"
            >
              ▶ 從此幕
            </button>
          )}
          <div className="scene-move-btns">
            <button
              className="btn-scene-move"
              onClick={() => onSceneMove(scene.id, 'up')}
              disabled={sceneIndex === 0}
              title="上移"
            >↑</button>
            <button
              className="btn-scene-move"
              onClick={() => onSceneMove(scene.id, 'down')}
              disabled={sceneIndex === totalScenes - 1}
              title="下移"
            >↓</button>
          </div>
        </div>
      </div>

      {/* Action buttons row */}
      <div className="scene-card-actions">
        {scene.image && (
          <button
            className="btn-scene-action btn-download-image"
            onClick={handleDownloadImage}
            title="下載插圖"
          >
            💾 下載插圖
          </button>
        )}
        {scene.script.scene_prompt && (
          <button
            className="btn-scene-action"
            onClick={handleImageRegen}
            disabled={regenImage || isGenerating}
            title="重新生成插圖"
          >
            {regenImage ? <><span className="spinner-sm" /> 生成中...</> : '🔄 重新生成插圖'}
          </button>
        )}
        <button
          className="btn-scene-action"
          onClick={() => {
            setRegenDesc(scene.description)
            setRegenStyle(scene.style)
            setShowRegenForm(v => !v)
          }}
          disabled={regenLoading || isGenerating}
          title="重新生成此幕"
        >
          ✏️ 重新生成此幕
        </button>
        <button
          className="btn-scene-action btn-scene-delete"
          onClick={handleDeleteScene}
          disabled={regenLoading}
          title="刪除此幕"
        >
          🗑️ 刪除此幕
        </button>
      </div>

      {/* Re-generate scene form */}
      {showRegenForm && (
        <div className="regen-scene-form">
          <label className="regen-scene-label">場景描述</label>
          <textarea
            className="line-edit-textarea"
            value={regenDesc}
            onChange={e => setRegenDesc(e.target.value.slice(0, 500))}
            rows={3}
            maxLength={500}
            placeholder="描述新場景內容..."
          />
          <div className="style-row" style={{ marginTop: '8px' }}>
            <label style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>故事風格</label>
            <div className="style-buttons">
              {STYLES.map(s => (
                <button
                  key={s}
                  className={`style-btn ${regenStyle === s ? 'active' : ''}`}
                  onClick={() => setRegenStyle(s)}
                  type="button"
                >{s}</button>
              ))}
            </div>
          </div>
          {regenError && (
            <div className="error-box regen-error-box">⚠️ {regenError}</div>
          )}
          <div className="line-edit-btns" style={{ marginTop: '10px' }}>
            <button
              className="btn-scene-action"
              onClick={handleSceneRegenSubmit}
              disabled={regenLoading || !regenDesc.trim()}
            >
              {regenLoading ? <><span className="spinner-sm" /> 生成中...</> : '✓ 確認重新生成'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => { setShowRegenForm(false); setRegenError(null) }}
              disabled={regenLoading}
              style={{ fontSize: '0.8rem', padding: '5px 12px' }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 場景插圖 */}
      <div className="scene-card-image-wrap">
        {scene.image ? (
          <>
            <img
              src={scene.image}
              alt={`第${sceneIndex + 1}幕插圖`}
              className="scene-image scene-image-zoomable"
              onClick={() => setExpandedImage(true)}
              title="點擊放大"
            />
            <span className="image-zoom-hint">🔍</span>
          </>
        ) : (
          <div className="image-loading">
            {isGenerating ? '劇本生成中...' : regenImage ? '重新生成插圖中...' : '插圖生成中...'}
          </div>
        )}
      </div>

      {/* Lightbox overlay */}
      {expandedImage && scene.image && (
        <div className="image-lightbox-overlay" onClick={() => setExpandedImage(false)}>
          <button className="lightbox-close" onClick={() => setExpandedImage(false)} title="關閉 (Esc)">✕</button>
          <button
            className="lightbox-download"
            onClick={e => { e.stopPropagation(); handleDownloadImage() }}
            title="下載插圖"
          >💾</button>
          <img
            src={scene.image}
            alt={`第${sceneIndex + 1}幕插圖（放大）`}
            className="lightbox-img"
            onClick={e => e.stopPropagation()}
          />
          <p className="lightbox-caption">第 {sceneIndex + 1} 幕 · {scene.description}</p>
        </div>
      )}

      {scene.script.sfx_description && (
        <p className="sfx-note">🎵 {scene.script.sfx_description}</p>
      )}

      {/* 對話劇本 */}
      {scene.lines.length > 0 && (
        <div className="scene-card-dialogue">
          <div className="output-header">
            <h4>對話劇本</h4>
            <button className="btn-play-all" onClick={playAll}>▶ 全部播放</button>
          </div>

          <div className="dialogue-list">
            {scene.lines.map((line, i) => {
              const char = getCharacter(line.character_id)
              const color = char?.color || '#888'
              const isPlaying = playingIndex === i
              const isEditingThis = editingLineIndex === i
              const isRegenVoice = regenVoiceIndex === i

              return (
                <div
                  key={i}
                  className={`dialogue-line ${isPlaying ? 'playing' : ''}`}
                  style={{ borderLeftColor: color }}
                >
                  <div className="dialogue-speaker">
                    <span className="speaker-emoji">{char?.emoji || '🎭'}</span>
                    <span className="speaker-name" style={{ color }}>{line.character_name}</span>
                    <span className="emotion-badge">{EMOTION_LABELS[line.emotion] ?? line.emotion}</span>
                  </div>
                  <div className="dialogue-content">
                    {isEditingThis ? (
                      <div className="line-edit-area">
                        <textarea
                          className="line-edit-textarea"
                          value={editLineText}
                          onChange={e => setEditLineText(e.target.value)}
                          rows={2}
                          autoFocus
                        />
                        <div className="line-edit-btns">
                          <button
                            className="btn-scene-action"
                            onClick={() => handleConfirmEditLine(i)}
                            disabled={!editLineText.trim()}
                          >
                            ✓ 確認
                          </button>
                          <button
                            className="btn-ghost"
                            onClick={handleCancelEditLine}
                            style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                          >
                            ✗ 取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="dialogue-text-row">
                        <p className="dialogue-text">{line.text}</p>
                        <button
                          className="btn-edit-line"
                          onClick={() => handleStartEditLine(i, line.text)}
                          title="編輯台詞"
                        >
                          ✏️
                        </button>
                      </div>
                    )}
                    <div className="dialogue-controls">
                      {line.audio_base64 ? (
                        <>
                          <audio
                            ref={(el: HTMLAudioElement | null) => { audioRefs.current[i] = el }}
                            src={`data:audio/${line.audio_format || 'wav'};base64,${line.audio_base64}`}
                          />
                          <button
                            className={`btn-play-line ${isPlaying ? 'playing' : ''}`}
                            onClick={() => playLine(i)}
                            style={{ borderColor: color, color: isPlaying ? '#fff' : color, background: isPlaying ? color : 'transparent' }}
                          >
                            {isPlaying ? '⏸' : '▶'} {isPlaying ? '播放中' : '播放'}
                          </button>
                        </>
                      ) : (
                        <span className="audio-loading">
                          {isRegenVoice ? '配音生成中...' : '音訊生成中...'}
                        </span>
                      )}
                      {line.text && (
                        <button
                          className="btn-regen-voice"
                          onClick={() => handleVoiceRegen(i)}
                          disabled={isRegenVoice || isEditingThis}
                          title="重新配音"
                        >
                          {isRegenVoice
                            ? <><span className="spinner-sm" /> 配音中...</>
                            : '🎤 重新配音'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function SceneOutput({
  scenes,
  characters,
  onSceneDelete,
  onSceneMove,
  onLineTextChange,
  onLineVoiceRegen,
  onImageRegen,
  onSceneRegen,
}: Props) {
  const [showPlayback, setShowPlayback] = useState(false)
  const [playbackStartScene, setPlaybackStartScene] = useState(0)
  const sceneRefs = useRef<(HTMLDivElement | null)[]>([])

  if (scenes.length === 0) return null

  const hasAudio = scenes.some(s => s.lines.some(l => l.audio_base64))

  const scrollToScene = (index: number) => {
    sceneRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handlePlayFromScene = (sceneIndex: number) => {
    setPlaybackStartScene(sceneIndex)
    setShowPlayback(true)
  }

  return (
    <div className="scene-output-panel">
      {hasAudio && (
        <div className="playbook-bar">
          <button className="btn-playbook" onClick={() => { setPlaybackStartScene(0); setShowPlayback(true) }}>
            🎬 播放全書
          </button>
          <span className="playbook-hint">全螢幕朗讀模式・各幕可單獨播放 ▶</span>
        </div>
      )}

      {/* Scene navigation strip — only shown when there are 2+ scenes */}
      {scenes.length > 1 && (
        <div className="scene-nav-strip">
          {scenes.map((scene, i) => (
            <button
              key={scene.id}
              className="scene-nav-chip"
              onClick={() => scrollToScene(i)}
              title={scene.description}
            >
              {scene.image ? (
                <img
                  className="scene-nav-thumb"
                  src={resolveImgSrc(scene.image)}
                  alt={`第${i + 1}幕`}
                />
              ) : (
                <span className="scene-nav-placeholder">🎭</span>
              )}
              <span className="scene-nav-num">第 {i + 1} 幕</span>
              <span className="scene-nav-desc">{scene.description}</span>
            </button>
          ))}
        </div>
      )}

      {showPlayback && (
        <PlaybackModal
          scenes={scenes}
          characters={characters}
          onClose={() => setShowPlayback(false)}
          initialSceneIdx={playbackStartScene}
        />
      )}

      {scenes.map((scene, i) => (
        <div key={scene.id} ref={el => { sceneRefs.current[i] = el }}>
          <SceneCard
            scene={scene}
            sceneIndex={i}
            totalScenes={scenes.length}
            characters={characters}
            onSceneDelete={onSceneDelete}
            onSceneMove={onSceneMove}
            onLineTextChange={onLineTextChange}
            onLineVoiceRegen={onLineVoiceRegen}
            onImageRegen={onImageRegen}
            onSceneRegen={onSceneRegen}
            onPlayFromScene={handlePlayFromScene}
          />
        </div>
      ))}
    </div>
  )
}

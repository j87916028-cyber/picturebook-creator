import { useRef, useState, useCallback } from 'react'
import { Scene, Character } from '../types'
import PlaybackModal from './PlaybackModal'

const STYLES = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

interface Props {
  scenes: Scene[]
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onLineTextChange: (sceneId: string, lineIndex: number, newText: string) => void
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onImageRegen: (sceneId: string) => Promise<void>
  onSceneRegen: (sceneId: string, newDescription: string, style: string) => Promise<void>
}

interface SceneCardProps {
  scene: Scene
  sceneIndex: number
  characters: Character[]
  onSceneDelete: (sceneId: string) => void
  onLineTextChange: (sceneId: string, lineIndex: number, newText: string) => void
  onLineVoiceRegen: (sceneId: string, lineIndex: number) => Promise<void>
  onImageRegen: (sceneId: string) => Promise<void>
  onSceneRegen: (sceneId: string, newDescription: string, style: string) => Promise<void>
}

function SceneCard({
  scene,
  sceneIndex,
  characters,
  onSceneDelete,
  onLineTextChange,
  onLineVoiceRegen,
  onImageRegen,
  onSceneRegen,
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

  const getCharacter = (id: string) => characters.find(c => c.id === id)

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
    try {
      await onSceneRegen(scene.id, regenDesc.trim(), regenStyle)
      setShowRegenForm(false)
    } finally {
      setRegenLoading(false)
    }
  }

  return (
    <div className="scene-card">
      <div className="scene-card-header">
        <span className="scene-card-title">第 {sceneIndex + 1} 幕</span>
        <span className="scene-card-desc">{scene.description}</span>
      </div>

      {/* Action buttons row */}
      <div className="scene-card-actions">
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
              onClick={() => setShowRegenForm(false)}
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
          <img src={scene.image} alt={`第${sceneIndex + 1}幕插圖`} className="scene-image" />
        ) : (
          <div className="image-loading">
            {isGenerating ? '劇本生成中...' : regenImage ? '重新生成插圖中...' : '插圖生成中...'}
          </div>
        )}
      </div>

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
                    <span className="emotion-badge">{line.emotion}</span>
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
  onLineTextChange,
  onLineVoiceRegen,
  onImageRegen,
  onSceneRegen,
}: Props) {
  const [showPlayback, setShowPlayback] = useState(false)

  if (scenes.length === 0) return null

  const hasAudio = scenes.some(s => s.lines.some(l => l.audio_base64))

  return (
    <div className="scene-output-panel">
      {hasAudio && (
        <div className="playbook-bar">
          <button className="btn-playbook" onClick={() => setShowPlayback(true)}>
            🎬 播放全書
          </button>
          <span className="playbook-hint">全螢幕朗讀模式</span>
        </div>
      )}

      {showPlayback && (
        <PlaybackModal
          scenes={scenes}
          characters={characters}
          onClose={() => setShowPlayback(false)}
        />
      )}

      {scenes.map((scene, i) => (
        <SceneCard
          key={scene.id}
          scene={scene}
          sceneIndex={i}
          characters={characters}
          onSceneDelete={onSceneDelete}
          onLineTextChange={onLineTextChange}
          onLineVoiceRegen={onLineVoiceRegen}
          onImageRegen={onImageRegen}
          onSceneRegen={onSceneRegen}
        />
      ))}
    </div>
  )
}

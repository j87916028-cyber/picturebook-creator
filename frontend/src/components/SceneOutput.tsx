import { useRef, useState, useCallback } from 'react'
import { Scene, Character } from '../types'

interface Props {
  scenes: Scene[]
  characters: Character[]
}

interface SceneCardProps {
  scene: Scene
  sceneIndex: number
  characters: Character[]
}

function SceneCard({ scene, sceneIndex, characters }: SceneCardProps) {
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

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

  return (
    <div className="scene-card">
      <div className="scene-card-header">
        <span className="scene-card-title">第 {sceneIndex + 1} 幕</span>
        <span className="scene-card-desc">{scene.description}</span>
      </div>

      {/* 場景插圖 */}
      <div className="scene-card-image-wrap">
        {scene.image ? (
          <img src={scene.image} alt={`第${sceneIndex + 1}幕插圖`} className="scene-image" />
        ) : (
          <div className="image-loading">
            {isGenerating ? '劇本生成中...' : '插圖生成中...'}
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
                    <p className="dialogue-text">{line.text}</p>
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
                        <span className="audio-loading">音訊生成中...</span>
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

export default function SceneOutput({ scenes, characters }: Props) {
  if (scenes.length === 0) return null

  return (
    <div className="scene-output-panel">
      {scenes.map((scene, i) => (
        <SceneCard key={scene.id} scene={scene} sceneIndex={i} characters={characters} />
      ))}
    </div>
  )
}

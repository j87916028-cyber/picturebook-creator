import { useEffect, useRef, useState, useCallback } from 'react'
import { Scene, Character } from '../types'

const EMOTION_LABELS: Record<string, string> = {
  happy:     '😄 開心',
  sad:       '😢 難過',
  angry:     '😠 生氣',
  surprised: '😲 驚訝',
  fearful:   '😨 害怕',
  disgusted: '🤢 厭惡',
  neutral:   '',   // don't show neutral in playback — it's the default
}

const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0]

interface Props {
  scenes: Scene[]
  characters: Character[]
  onClose: () => void
  initialSceneIdx?: number   // open modal starting at this scene (0-based)
}

// Flatten all (sceneIdx, lineIdx) pairs that have audio
interface PlayItem {
  sceneIdx: number
  lineIdx: number
}

function buildPlaylist(scenes: Scene[]): PlayItem[] {
  const items: PlayItem[] = []
  scenes.forEach((scene, si) => {
    scene.lines.forEach((line, li) => {
      if (line.audio_base64) items.push({ sceneIdx: si, lineIdx: li })
    })
  })
  return items
}

export default function PlaybackModal({ scenes, characters, onClose, initialSceneIdx = 0 }: Props) {
  const playlist = buildPlaylist(scenes)

  // Find the first playlist entry at or after the requested scene
  const startCursor = (() => {
    if (initialSceneIdx <= 0) return 0
    const idx = playlist.findIndex(p => p.sceneIdx >= initialSceneIdx)
    return idx >= 0 ? idx : 0
  })()

  const [cursor, setCursor] = useState(startCursor)  // index into playlist
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1.0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const activeLineRef = useRef<HTMLDivElement | null>(null)

  const current = playlist[cursor]
  const currentScene = current ? scenes[current.sceneIdx] : null
  const currentLine = current ? scenes[current.sceneIdx]?.lines[current.lineIdx] : null
  const currentChar = currentLine
    ? characters.find(c => c.id === currentLine.character_id)
    : null

  const goTo = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, playlist.length - 1))
    setCursor(clamped)
    setPlaying(true)
  }, [playlist.length])

  const togglePlay = useCallback(() => {
    setPlaying(p => {
      if (p) audioRef.current?.pause()
      else audioRef.current?.play()
      return !p
    })
  }, [])

  // Play audio when cursor changes; apply current speed
  useEffect(() => {
    if (!currentLine?.audio_base64) return
    const src = `data:audio/${currentLine.audio_format || 'mp3'};base64,${currentLine.audio_base64}`
    if (audioRef.current) {
      audioRef.current.src = src
      audioRef.current.playbackRate = speed
      if (playing) {
        audioRef.current.play().catch(() => {})
      }
    }
  }, [cursor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply speed change to live audio immediately
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  // Auto-scroll active transcript line into view
  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor])

  // Auto-advance when audio ends
  const handleEnded = useCallback(() => {
    if (cursor < playlist.length - 1) {
      setCursor(c => c + 1)
    } else {
      setPlaying(false)
    }
  }, [cursor, playlist.length])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay() }
      else if (e.key === 'ArrowRight' || e.key === 'l') goTo(cursor + 1)
      else if (e.key === 'ArrowLeft' || e.key === 'j') goTo(cursor - 1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cursor, togglePlay, goTo, onClose])

  if (playlist.length === 0) {
    return (
      <div className="playback-overlay" onClick={onClose}>
        <div className="playback-empty" onClick={e => e.stopPropagation()}>
          <p>尚無可播放的音訊，請先生成場景。</p>
          <button className="playback-close-btn" onClick={onClose}>關閉</button>
        </div>
      </div>
    )
  }

  const sceneProgress = current
    ? `第 ${current.sceneIdx + 1} 幕／共 ${scenes.length} 幕`
    : ''
  const lineProgress = current
    ? `台詞 ${current.lineIdx + 1}／${scenes[current.sceneIdx]?.lines.filter(l => l.audio_base64).length}`
    : ''
  const pct = playlist.length > 1 ? (cursor / (playlist.length - 1)) * 100 : 100

  return (
    <div className="playback-overlay" ref={containerRef}>
      {/* Hidden audio element */}
      <audio ref={audioRef} onEnded={handleEnded} />

      {/* Close */}
      <button className="playback-close-btn" onClick={onClose} title="關閉 (Esc)">✕</button>

      <div className="playback-body">
        {/* Scene image */}
        <div className="playback-image-wrap">
          {currentScene?.image ? (
            <img
              src={currentScene.image}
              alt={`第${(current?.sceneIdx ?? 0) + 1}幕`}
              className="playback-image"
            />
          ) : (
            <div className="playback-image-placeholder">🖼️</div>
          )}
          <div className="playback-scene-badge">{sceneProgress}</div>
        </div>

        {/* Karaoke transcript — all lines in current scene */}
        <div className="playback-transcript">
          {currentScene?.lines.map((line, i) => {
            const char = characters.find(c => c.id === line.character_id)
            const isActive = i === current?.lineIdx
            const hasAudio = !!line.audio_base64
            // Find this line's position in the global playlist for click-to-jump
            const targetIdx = playlist.findIndex(
              p => p.sceneIdx === current?.sceneIdx && p.lineIdx === i
            )
            const emotion = isActive && line.emotion ? EMOTION_LABELS[line.emotion] : null
            return (
              <div
                key={i}
                ref={isActive ? activeLineRef : null}
                className={`transcript-line${isActive ? ' active' : ''}${hasAudio && !isActive ? ' clickable' : ''}`}
                style={{ borderLeftColor: char?.color || '#667eea' }}
                onClick={() => { if (hasAudio && targetIdx >= 0) goTo(targetIdx) }}
                title={hasAudio && !isActive ? '點擊跳至此句' : undefined}
              >
                <span className="transcript-char" style={{ color: char?.color }}>
                  {char?.emoji} {line.character_name}
                  {emotion && <span className="transcript-emotion">{emotion}</span>}
                </span>
                <span className="transcript-text">{line.text}</span>
              </div>
            )
          })}
        </div>

        {/* Controls */}
        <div className="playback-controls">
          <button
            className="playback-btn"
            onClick={() => goTo(cursor - 1)}
            disabled={cursor === 0}
            title="上一句 (←)"
          >⏮</button>

          <button
            className="playback-btn playback-btn-main"
            onClick={togglePlay}
            title="播放/暫停 (空白鍵)"
          >
            {playing ? '⏸' : '▶'}
          </button>

          <button
            className="playback-btn"
            onClick={() => goTo(cursor + 1)}
            disabled={cursor === playlist.length - 1}
            title="下一句 (→)"
          >⏭</button>
        </div>

        {/* Progress bar */}
        <div className="playback-progress-wrap">
          <div className="playback-progress-bar">
            <div className="playback-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="playback-progress-label">{lineProgress}</span>
        </div>

        {/* Speed control */}
        <div className="playback-speed-row">
          <span className="playback-speed-label">播放速度</span>
          <div className="playback-speed-btns">
            {SPEED_OPTIONS.map(s => (
              <button
                key={s}
                className={`playback-speed-btn ${speed === s ? 'active' : ''}`}
                onClick={() => setSpeed(s)}
                title={`${s}x 速度`}
              >
                {s === 1.0 ? '1×' : `${s}×`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

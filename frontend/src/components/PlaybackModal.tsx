import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
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

function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

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
  // Memoize so goToScene / keyboard effect don't re-run on every timeupdate render
  const playlist = useMemo(() => buildPlaylist(scenes), [scenes])

  // Find the first playlist entry at or after the requested scene
  const startCursor = (() => {
    if (initialSceneIdx <= 0) return 0
    const idx = playlist.findIndex(p => p.sceneIdx >= initialSceneIdx)
    return idx >= 0 ? idx : 0
  })()

  const [cursor, setCursor] = useState(startCursor)  // index into playlist
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('pb_speed') ?? '')
    return SPEED_OPTIONS.includes(saved) ? saved : 1.0
  })
  const [volume, setVolume] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('pb_volume') ?? '')
    return isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1.0
  })
  const [muted, setMuted] = useState(false)
  // loopMode: 'none' = no loop | 'all' = loop playlist | 'scene' = loop current scene
  type LoopMode = 'none' | 'all' | 'scene'
  const [loopMode, setLoopMode] = useState<LoopMode>(() => {
    const saved = localStorage.getItem('pb_loop')
    return (saved === 'all' || saved === 'scene') ? saved : 'none'
  })
  const loopModeRef = useRef<LoopMode>(loopMode)
  const [showHelp, setShowHelp] = useState(false)
  const [audioProgress, setAudioProgress] = useState(0)   // 0–100 within current line
  const [audioDuration, setAudioDuration] = useState(0)   // seconds
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const activeLineRef = useRef<HTMLDivElement | null>(null)

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  // Sync isFullscreen state with actual fullscreen status
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

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

  // Jump to the first audio line of a given scene (absolute index)
  const goToScene = useCallback((targetSceneIdx: number) => {
    const idx = playlist.findIndex(p => p.sceneIdx === targetSceneIdx)
    if (idx >= 0) goTo(idx)
  }, [playlist, goTo])

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

  // Apply speed change to live audio immediately; persist preference
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
    localStorage.setItem('pb_speed', String(speed))
  }, [speed])

  // Apply volume / mute changes to live audio immediately; persist volume preference
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : volume
    localStorage.setItem('pb_volume', String(volume))
  }, [volume, muted])

  // Per-line audio progress tracking
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => {
      const cur = audio.currentTime
      const dur = audio.duration
      setAudioCurrentTime(cur)
      if (dur) setAudioProgress((cur / dur) * 100)
    }
    const onMeta = () => setAudioDuration(audio.duration)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
    }
  }, [])  // attach once; same element lives for modal's lifetime

  // Reset per-line progress when the cursor moves to a new line
  useEffect(() => {
    setAudioProgress(0)
    setAudioDuration(0)
    setAudioCurrentTime(0)
  }, [cursor])

  const handleAudioSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    if (!audio || !audio.duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = pct * audio.duration
    setAudioProgress(pct * 100)
  }

  // Auto-scroll active transcript line into view
  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor])

  // Keep loopModeRef in sync so handleEnded always reads the latest value
  useEffect(() => { loopModeRef.current = loopMode }, [loopMode])

  // Persist loop preference
  useEffect(() => { localStorage.setItem('pb_loop', loopMode) }, [loopMode])

  // Auto-advance when audio ends
  const handleEnded = useCallback(() => {
    const mode = loopModeRef.current
    const currentSceneIdx = playlist[cursor]?.sceneIdx
    const nextCursor = cursor + 1
    const nextSceneIdx = playlist[nextCursor]?.sceneIdx

    if (mode === 'scene') {
      // If next line is in the same scene, advance normally; otherwise loop scene
      if (nextCursor < playlist.length && nextSceneIdx === currentSceneIdx) {
        setCursor(nextCursor)
      } else {
        // Jump back to the first line of the current scene
        const sceneStart = playlist.findIndex(p => p.sceneIdx === currentSceneIdx)
        setCursor(sceneStart >= 0 ? sceneStart : 0)
        setPlaying(true)
      }
    } else if (nextCursor < playlist.length) {
      setCursor(nextCursor)
    } else if (mode === 'all') {
      setCursor(0)
      setPlaying(true)
    } else {
      setPlaying(false)
    }
  }, [cursor, playlist])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (showHelp) { setShowHelp(false); return } onClose() }
      else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay() }
      else if (e.key === 'ArrowRight' || e.key === 'l') goTo(cursor + 1)
      else if (e.key === 'ArrowLeft'  || e.key === 'j') goTo(cursor - 1)
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setMuted(false); setVolume(v => Math.min(1, Math.round((v + 0.1) * 10) / 10)) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(v => Math.max(0, Math.round((v - 0.1) * 10) / 10)) }
      else if (e.key === 'm' || e.key === 'M') setMuted(v => !v)
      else if (e.key === 'PageDown') { e.preventDefault(); if (current) goToScene(current.sceneIdx + 1) }
      else if (e.key === 'PageUp')   { e.preventDefault(); if (current) goToScene(current.sceneIdx - 1) }
      else if (e.key === 'f' || e.key === 'F') toggleFullscreen()
      else if (e.key === 'L') setLoopMode(m => m === 'none' ? 'all' : m === 'all' ? 'scene' : 'none')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cursor, showHelp, togglePlay, goTo, goToScene, onClose, toggleFullscreen])

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

      {/* Fullscreen toggle */}
      <button
        className="playback-fullscreen-btn"
        onClick={toggleFullscreen}
        title={isFullscreen ? '退出全螢幕 (F)' : '全螢幕 (F)'}
      >
        {isFullscreen ? '🗗' : '🗖'}
      </button>

      {/* Help / keyboard shortcuts */}
      <button
        className={`playback-help-btn${showHelp ? ' active' : ''}`}
        onClick={() => setShowHelp(v => !v)}
        title="快捷鍵說明"
      >?</button>
      {showHelp && (
        <div className="playback-help-panel" onClick={() => setShowHelp(false)}>
          <div className="playback-help-inner" onClick={e => e.stopPropagation()}>
            <div className="playback-help-title">⌨️ 鍵盤快捷鍵</div>
            <table className="playback-help-table">
              <tbody>
                <tr><td><kbd>Space</kbd> / <kbd>K</kbd></td><td>播放 / 暫停</td></tr>
                <tr><td><kbd>→</kbd> / <kbd>L</kbd></td><td>下一句台詞</td></tr>
                <tr><td><kbd>←</kbd> / <kbd>J</kbd></td><td>上一句台詞</td></tr>
                <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>音量 +10% / -10%</td></tr>
                <tr><td><kbd>M</kbd></td><td>靜音切換</td></tr>
                <tr><td><kbd>PageDown</kbd></td><td>跳至下一幕</td></tr>
                <tr><td><kbd>PageUp</kbd></td><td>跳至上一幕</td></tr>
                <tr><td><kbd>F</kbd></td><td>全螢幕切換</td></tr>
                <tr><td><kbd>Shift+L</kbd></td><td>循環模式切換（關閉 → 全書 → 單幕）</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>關閉播放器</td></tr>
              </tbody>
            </table>
            <div className="playback-help-tip">💡 點擊字幕列可直接跳至該句</div>
            <button className="playback-help-close" onClick={() => setShowHelp(false)}>關閉</button>
          </div>
        </div>
      )}

      <div className="playback-body">
        {/* Scene image — key forces remount on scene change for fade-in animation */}
        <div className="playback-image-wrap">
          {currentScene?.image && currentScene.image !== 'error' ? (
            <img
              key={current?.sceneIdx}
              src={currentScene.image}
              alt={`第${(current?.sceneIdx ?? 0) + 1}幕`}
              className="playback-image playback-image-fade"
            />
          ) : (
            <div key={current?.sceneIdx} className="playback-image-placeholder">🖼️</div>
          )}
          <div className="playback-scene-badge">{sceneProgress}</div>
        </div>

        {/* Speaking character indicator */}
        {currentChar && playing && (
          <div className="playback-speaker-bar">
            <span className="playback-speaker-emoji" key={cursor}>{currentChar.emoji}</span>
            <span className="playback-speaker-name" style={{ color: currentChar.color }}>
              {currentChar.name}
            </span>
            {currentLine?.emotion && currentLine.emotion !== 'neutral' && (
              <span className="playback-speaker-emotion">
                {EMOTION_LABELS[currentLine.emotion]}
              </span>
            )}
            <span className="playback-speaker-wave">
              <span /><span /><span />
            </span>
          </div>
        )}

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
            className="playback-btn playback-btn-scene"
            onClick={() => current && goToScene(current.sceneIdx - 1)}
            disabled={!current || current.sceneIdx === 0}
            title="上一幕 (PageUp)"
          >⏮</button>

          <button
            className="playback-btn"
            onClick={() => goTo(cursor - 1)}
            disabled={cursor === 0}
            title="上一句 (←)"
          >◀</button>

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
          >▶</button>

          <button
            className="playback-btn playback-btn-scene"
            onClick={() => current && goToScene(current.sceneIdx + 1)}
            disabled={!current || current.sceneIdx >= scenes.length - 1}
            title="下一幕 (PageDown)"
          >⏭</button>
        </div>

        {/* Scene selector chips — jump to any scene instantly */}
        {scenes.length > 1 && (
          <div className="playback-scene-chips">
            {scenes.map((scene, si) => {
              const hasAudio = playlist.some(p => p.sceneIdx === si)
              const isCurrentScene = current?.sceneIdx === si
              const thumb = scene.image && scene.image !== 'error' ? scene.image : null
              return (
                <button
                  key={si}
                  className={`playback-scene-chip${isCurrentScene ? ' active' : ''}${!hasAudio ? ' no-audio' : ''}`}
                  onClick={() => { if (hasAudio) goToScene(si) }}
                  disabled={!hasAudio}
                  title={hasAudio ? `跳至第 ${si + 1} 幕` : `第 ${si + 1} 幕（無音訊）`}
                >
                  {thumb
                    ? <img src={thumb} alt={`第${si + 1}幕`} className="chip-thumb" />
                    : <span className="chip-fallback">🖼️</span>
                  }
                  <span className="chip-num">{si + 1}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Per-line audio progress bar (seekable) */}
        <div className="playback-progress-wrap">
          <div
            className="playback-progress-bar playback-audio-bar"
            onClick={handleAudioSeek}
            title="點擊跳轉播放位置"
          >
            <div className="playback-progress-fill" style={{ width: `${audioProgress}%` }} />
          </div>
          <div className="playback-progress-meta">
            <span className="playback-progress-label">{lineProgress}</span>
            {audioDuration > 0 && (
              <span className="playback-time-display">
                {formatTime(audioCurrentTime)} / {formatTime(audioDuration)}
              </span>
            )}
          </div>
          {/* Playlist-level progress indicator (thin) */}
          <div className="playback-playlist-bar">
            <div className="playback-playlist-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Speed + Volume + Loop controls */}
        <div className="playback-speed-row">
          <span className="playback-speed-label">速度</span>
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

          {/* Volume control */}
          <div className="playback-volume-wrap">
            <button
              className={`playback-mute-btn${muted || volume === 0 ? ' muted' : ''}`}
              onClick={() => setMuted(v => !v)}
              title={muted ? '取消靜音 (M)' : '靜音 (M)'}
            >
              {muted || volume === 0 ? '🔇' : volume < 0.4 ? '🔈' : '🔊'}
            </button>
            <input
              type="range"
              className="playback-volume-slider"
              min={0}
              max={100}
              step={10}
              value={muted ? 0 : Math.round(volume * 100)}
              onChange={e => {
                const v = Number(e.target.value) / 100
                setVolume(v)
                if (v > 0) setMuted(false)
                else setMuted(true)
              }}
              title={`音量 ${muted ? 0 : Math.round(volume * 100)}%（↑↓ 調整）`}
            />
            <span className="playback-volume-pct">
              {muted ? '0' : Math.round(volume * 100)}%
            </span>
          </div>

          <button
            className={`playback-loop-btn${loopMode !== 'none' ? ' active' : ''}`}
            onClick={() => setLoopMode(m => m === 'none' ? 'all' : m === 'all' ? 'scene' : 'none')}
            title={
              loopMode === 'none'  ? '點擊開啟全書循環 (Shift+L)' :
              loopMode === 'all'   ? '全書循環中，點擊切換單幕循環 (Shift+L)' :
                                     '單幕循環中，點擊關閉循環 (Shift+L)'
            }
          >
            {loopMode === 'scene' ? '🔂' : '🔁'}
          </button>
        </div>
      </div>
    </div>
  )
}

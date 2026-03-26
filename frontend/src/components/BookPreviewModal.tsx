import { useEffect, useRef, useState, useCallback } from 'react'
import { Scene, Character } from '../types'

interface Props {
  scenes: Scene[]
  characters: Character[]
  initialScene?: number
  onClose: () => void
}

function resolveImgSrc(image: string): string {
  if (!image || image === 'error') return ''
  if (image.startsWith('data:') || image.startsWith('http') || image.startsWith('/')) return image
  return `data:image/jpeg;base64,${image}`
}

export default function BookPreviewModal({ scenes, characters, initialScene = 0, onClose }: Props) {
  const [page, setPage] = useState(Math.min(initialScene, scenes.length - 1))
  const [imgLoaded, setImgLoaded] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingLine, setPlayingLine] = useState<number | null>(null)
  // When autoPlay is active, advance through lines automatically
  const autoPlayRef = useRef(false)
  const [autoPlaying, setAutoPlaying] = useState(false)

  const scene = scenes[page]
  const imgSrc = scene?.image ? resolveImgSrc(scene.image) : ''

  // Stop any playing audio
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current = null
    }
    setPlayingLine(null)
    autoPlayRef.current = false
    setAutoPlaying(false)
  }, [])

  // Reset image-loaded flag, scroll back to top, and stop audio when page changes
  useEffect(() => {
    setImgLoaded(false)
    if (textRef.current) textRef.current.scrollTop = 0
    stopAudio()
  }, [page, stopAudio])

  // Stop audio on unmount
  useEffect(() => () => stopAudio(), [stopAudio])

  // Play a specific line; if it's already playing, stop it
  const playLine = useCallback((lineIdx: number) => {
    const line = scene?.lines[lineIdx]
    if (!line?.audio_base64) return

    // Toggle off if already playing this line
    if (playingLine === lineIdx) {
      stopAudio()
      return
    }

    // Stop previous audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current = null
    }

    const fmt = line.audio_format || 'mp3'
    const audio = new Audio(`data:audio/${fmt};base64,${line.audio_base64}`)
    audioRef.current = audio
    setPlayingLine(lineIdx)

    audio.onended = () => {
      audioRef.current = null
      setPlayingLine(null)
      // Auto-advance: if autoPlay is active, play the next line that has audio
      if (autoPlayRef.current && scene) {
        const nextIdx = scene.lines.findIndex(
          (l, i) => i > lineIdx && !!l.audio_base64
        )
        if (nextIdx >= 0) {
          playLine(nextIdx)
        } else {
          autoPlayRef.current = false
          setAutoPlaying(false)
        }
      }
    }
    audio.onerror = () => {
      audioRef.current = null
      setPlayingLine(null)
      autoPlayRef.current = false
      setAutoPlaying(false)
    }
    audio.play().catch(() => {
      audioRef.current = null
      setPlayingLine(null)
      autoPlayRef.current = false
      setAutoPlaying(false)
    })
  }, [scene, playingLine, stopAudio]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-play all lines in the current scene
  const handleAutoPlay = useCallback(() => {
    if (autoPlaying) {
      stopAudio()
      return
    }
    if (!scene) return
    const firstIdx = scene.lines.findIndex(l => !!l.audio_base64)
    if (firstIdx < 0) return
    autoPlayRef.current = true
    setAutoPlaying(true)
    playLine(firstIdx)
  }, [autoPlaying, scene, stopAudio, playLine])

  const hasAnyAudio = scene?.lines.some(l => !!l.audio_base64) ?? false

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault()
        setPage(p => Math.min(p + 1, scenes.length - 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        setPage(p => Math.max(p - 1, 0))
      } else if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Home') {
        e.preventDefault()
        setPage(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setPage(scenes.length - 1)
      } else if (e.key === ' ') {
        e.preventDefault()
        handleAutoPlay()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, scenes.length, handleAutoPlay])

  const getCharacter = (name: string): Character | undefined =>
    characters.find(c => c.name === name)

  if (!scene) return null

  const isFirst = page === 0
  const isLast  = page === scenes.length - 1

  return (
    <div className="book-preview-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="閱讀模式">
      <div className="book-preview-modal" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="book-preview-header">
          <span className="book-page-num">第 {page + 1} 幕 <span className="book-page-total">/ 共 {scenes.length} 幕</span></span>
          {hasAnyAudio && (
            <button
              className={`book-auto-play-btn${autoPlaying ? ' playing' : ''}`}
              onClick={handleAutoPlay}
              title={autoPlaying ? '停止播放（Space）' : '自動朗讀此幕（Space）'}
            >
              {autoPlaying ? '⏹ 停止' : '▶ 朗讀'}
            </button>
          )}
          <button className="book-preview-close" onClick={onClose} title="關閉閱讀模式（Esc）">✕</button>
        </div>

        {/* ── Main content ── */}
        <div className="book-preview-body">
          {/* Image panel */}
          <div className="book-preview-image-panel">
            {imgSrc ? (
              <>
                <img
                  key={imgSrc}
                  src={imgSrc}
                  alt={`第 ${page + 1} 幕插圖`}
                  className={`book-preview-img${imgLoaded ? ' loaded' : ''}`}
                  onLoad={() => setImgLoaded(true)}
                />
                {!imgLoaded && <div className="book-img-placeholder">🎨</div>}
              </>
            ) : (
              <div className="book-img-placeholder">🎨</div>
            )}
          </div>

          {/* Text panel */}
          <div className="book-preview-text-panel" ref={textRef}>
            {scene.description && (
              <p className="book-preview-description">{scene.description}</p>
            )}
            <div className="book-preview-lines">
              {scene.lines.length === 0 && (
                <p className="book-no-lines">（此幕尚無台詞）</p>
              )}
              {scene.lines.map((line, i) => {
                const char = getCharacter(line.character_name)
                const hasAudio = !!line.audio_base64
                const isPlaying = playingLine === i
                return (
                  <div
                    key={i}
                    className={`book-line${isPlaying ? ' playing' : ''}${hasAudio ? ' has-audio' : ''}`}
                    onClick={() => hasAudio && playLine(i)}
                    title={hasAudio ? (isPlaying ? '點擊停止' : '點擊播放此句配音') : undefined}
                  >
                    <div className="book-line-speaker" style={{ color: char?.color ?? '#555' }}>
                      {char?.emoji ?? '🎭'} {line.character_name}
                      {hasAudio && (
                        <span className={`book-line-audio-icon${isPlaying ? ' playing' : ''}`}>
                          {isPlaying ? '⏹' : '🔊'}
                        </span>
                      )}
                    </div>
                    <p className="book-line-text">{line.text}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Navigation ── */}
        <div className="book-preview-nav">
          <button
            className="book-nav-btn"
            onClick={() => setPage(p => Math.max(p - 1, 0))}
            disabled={isFirst}
            title="上一幕（← 方向鍵）"
          >
            ← 上一幕
          </button>

          {/* Page dots — show up to 20; beyond that use a counter */}
          {scenes.length <= 20 ? (
            <div className="book-nav-dots" role="tablist" aria-label="幕次">
              {scenes.map((_, i) => (
                <button
                  key={i}
                  role="tab"
                  aria-selected={i === page}
                  aria-label={`第 ${i + 1} 幕`}
                  className={`book-nav-dot${i === page ? ' active' : ''}`}
                  onClick={() => setPage(i)}
                />
              ))}
            </div>
          ) : (
            <span className="book-nav-counter">{page + 1} / {scenes.length}</span>
          )}

          <button
            className="book-nav-btn"
            onClick={() => setPage(p => Math.min(p + 1, scenes.length - 1))}
            disabled={isLast}
            title="下一幕（→ 方向鍵）"
          >
            下一幕 →
          </button>
        </div>

        {/* ── Keyboard hint ── */}
        <p className="book-keyboard-hint">← → 翻頁 · Space 朗讀 · Esc 關閉</p>
      </div>
    </div>
  )
}

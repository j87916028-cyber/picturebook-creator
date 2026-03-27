import { useEffect, useRef, useState, useCallback } from 'react'
import { Scene, Character } from '../types'

const EMOTION_LABELS: Record<string, string> = {
  happy:     '😄',
  sad:       '😢',
  angry:     '😠',
  surprised: '😲',
  fearful:   '😨',
  disgusted: '🤢',
}

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
  const [zoomedImg, setZoomedImg] = useState(false)
  const [showDirectorNotes, setShowDirectorNotes] = useState(() =>
    localStorage.getItem('book_preview_show_notes') === 'true'
  )
  const [fontSize, setFontSize] = useState<'sm' | 'md' | 'lg'>(() => {
    const saved = localStorage.getItem('book_preview_font_size')
    return (saved === 'sm' || saved === 'lg') ? saved : 'md'
  })
  const textRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const activeLineRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showThumbnails, setShowThumbnails] = useState(() =>
    localStorage.getItem('book_preview_show_thumbnails') === 'true'
  )
  const thumbnailStripRef = useRef<HTMLDivElement>(null)

  // Touch/swipe state — tracked in refs to avoid re-renders on every touchmove
  const touchStartXRef = useRef<number | null>(null)
  const touchStartYRef = useRef<number | null>(null)

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingLine, setPlayingLine] = useState<number | null>(null)
  // Playback speed — persisted to localStorage so it's remembered across sessions
  const [playSpeed, setPlaySpeed] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('book_preview_speed') ?? '')
    return [0.75, 1, 1.25, 1.5, 2.0].includes(saved) ? saved : 1
  })
  const playSpeedRef = useRef(playSpeed)
  // When autoPlay is active, advance through lines automatically
  const autoPlayRef = useRef(false)
  const [autoPlaying, setAutoPlaying] = useState(false)
  // Cross-scene autoplay: set to true when the last line of a scene ends and there are more scenes
  const pendingAutoStartRef = useRef(false)
  // Incrementing counter that triggers the cross-scene auto-start effect
  const [autoStartTrigger, setAutoStartTrigger] = useState(0)

  // Auto-advance timer: null = off; 8/15/20/30 = seconds per page
  const [autoAdvanceSecs, setAutoAdvanceSecs] = useState<number | null>(() => {
    const saved = parseInt(localStorage.getItem('book_preview_auto_advance') ?? '')
    return [8, 15, 20, 30].includes(saved) ? saved : null
  })
  const [timerProgress, setTimerProgress] = useState(0)

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
    pendingAutoStartRef.current = false
    setAutoPlaying(false)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = modalRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  // Keep isFullscreen state in sync with the browser's actual fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // Reset image-loaded flag, scroll back to top, stop audio, and close zoom when page changes.
  // If pendingAutoStartRef is set, signal the auto-start effect instead of doing a full stop.
  useEffect(() => {
    setImgLoaded(false)
    setZoomedImg(false)
    if (textRef.current) textRef.current.scrollTop = 0
    const shouldContinue = pendingAutoStartRef.current
    pendingAutoStartRef.current = false
    stopAudio()                // clears autoPlayRef + setAutoPlaying(false)
    if (shouldContinue) {
      setAutoStartTrigger(n => n + 1)   // triggers the cross-scene auto-start effect below
    }
  }, [page, stopAudio])

  const handleDownloadImage = () => {
    if (!imgSrc) return
    const titleSuffix = scene?.title ? `_${scene.title}` : ''
    const filename = `第${page + 1}幕${titleSuffix}插圖`
    if (imgSrc.startsWith('data:')) {
      const ext = imgSrc.match(/^data:image\/(\w+)/)?.[1] ?? 'png'
      const a = document.createElement('a')
      a.href = imgSrc
      a.download = `${filename}.${ext}`
      a.click()
    } else {
      fetch(imgSrc)
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

  // Persist font size when it changes
  useEffect(() => {
    localStorage.setItem('book_preview_font_size', fontSize)
  }, [fontSize])

  // Auto-scroll active line into view during auto-play
  useEffect(() => {
    if (!autoPlaying || playingLine === null) return
    const el = activeLineRef.current
    if (!el || !textRef.current) return
    // Use scrollIntoView only when the line is outside the visible area of the panel
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [playingLine, autoPlaying])

  // Persist speed and apply to active audio when it changes
  useEffect(() => {
    playSpeedRef.current = playSpeed
    localStorage.setItem('book_preview_speed', String(playSpeed))
    if (audioRef.current) audioRef.current.playbackRate = playSpeed
  }, [playSpeed])

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
    audio.playbackRate = playSpeedRef.current
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
          // More lines in this scene
          playLine(nextIdx)
        } else if (page < scenes.length - 1) {
          // Last line of scene — advance to next scene and continue playing
          pendingAutoStartRef.current = true
          setPage(p => p + 1)
        } else {
          // Story finished
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

  // Cross-scene auto-start: fires after page advances from a cross-scene autoplay signal.
  // autoStartTrigger increments in the page-change effect when pendingAutoStartRef was true.
  // By the time this effect runs, scene/playLine are already updated for the new page.
  useEffect(() => {
    if (autoStartTrigger === 0 || !scene) return
    const firstIdx = scene.lines.findIndex(l => !!l.audio_base64)
    if (firstIdx < 0) return
    autoPlayRef.current = true
    setAutoPlaying(true)
    playLine(firstIdx)
  }, [autoStartTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

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
        if (zoomedImg) { setZoomedImg(false); return }
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
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        toggleFullscreen()
      } else if (e.key === ']') {
        e.preventDefault()
        setFontSize(s => s === 'sm' ? 'md' : 'lg')
      } else if (e.key === '[') {
        e.preventDefault()
        setFontSize(s => s === 'lg' ? 'md' : 'sm')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, scenes.length, handleAutoPlay, zoomedImg, toggleFullscreen])

  const getCharacter = (id: string): Character | undefined =>
    characters.find(c => c.id === id)

  const isFirst = page === 0
  const isLast  = page === scenes.length - 1

  // Persist auto-advance preference
  useEffect(() => {
    localStorage.setItem('book_preview_auto_advance', autoAdvanceSecs === null ? '' : String(autoAdvanceSecs))
  }, [autoAdvanceSecs])

  // Persist thumbnail strip toggle
  useEffect(() => {
    localStorage.setItem('book_preview_show_thumbnails', String(showThumbnails))
  }, [showThumbnails])

  // Auto-scroll thumbnail strip to keep the active thumbnail visible
  useEffect(() => {
    if (!showThumbnails || !thumbnailStripRef.current) return
    const strip = thumbnailStripRef.current
    const activeThumb = strip.querySelector<HTMLElement>('.book-thumb-item.active')
    if (!activeThumb) return
    const stripRect = strip.getBoundingClientRect()
    const thumbRect = activeThumb.getBoundingClientRect()
    const scrollLeft = strip.scrollLeft + (thumbRect.left - stripRect.left) - stripRect.width / 2 + thumbRect.width / 2
    strip.scrollTo({ left: scrollLeft, behavior: 'smooth' })
  }, [page, showThumbnails])

  // Auto-advance timer: restart on every page change or settings change
  useEffect(() => {
    if (!autoAdvanceSecs || isLast || autoPlaying) {
      setTimerProgress(0)
      return
    }
    setTimerProgress(0)
    let progress = 0
    const increment = 100 / (autoAdvanceSecs * 10)
    const id = setInterval(() => {
      progress += increment
      if (progress >= 100) {
        clearInterval(id)
        setTimerProgress(0)
        setPage(p => Math.min(p + 1, scenes.length - 1))
      } else {
        setTimerProgress(progress)
      }
    }, 100)
    return () => clearInterval(id)
  }, [autoAdvanceSecs, isLast, page, autoPlaying, scenes.length])

  if (!scene) return null

  // Swipe navigation handlers — record start position and decide direction on lift.
  // We only trigger a page change when the horizontal component dominates (|ΔX| > |ΔY|)
  // so vertical scrolling in the text panel isn't hijacked.
  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStartXRef.current = t.clientX
    touchStartYRef.current = t.clientY
  }
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartXRef.current === null || touchStartYRef.current === null) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStartXRef.current
    const dy = t.clientY - touchStartYRef.current
    touchStartXRef.current = null
    touchStartYRef.current = null
    // Require 50 px minimum swipe AND horizontal dominance to avoid false-fires
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return
    if (dx < 0) {
      // Swipe left → next page
      setPage(p => Math.min(p + 1, scenes.length - 1))
    } else {
      // Swipe right → previous page
      setPage(p => Math.max(p - 1, 0))
    }
  }

  return (
    <div className="book-preview-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="閱讀模式">
      <div
        className="book-preview-modal"
        ref={modalRef}
        onClick={e => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* ── Reading progress bar ── thin accent at top, only when >1 scene */}
        {scenes.length > 1 && (
          <div
            className="book-reading-progress"
            role="progressbar"
            aria-valuenow={Math.round((page / (scenes.length - 1)) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            title={`閱讀進度：第 ${page + 1} 幕 / 共 ${scenes.length} 幕（${Math.round((page / (scenes.length - 1)) * 100)}%）`}
          >
            <div
              className="book-reading-progress-fill"
              style={{ width: `${(page / (scenes.length - 1)) * 100}%` }}
            />
          </div>
        )}

        {/* ── Header ── */}
        <div className="book-preview-header">
          <span className="book-page-num">
            第 {page + 1} 幕
            {scene.title && <span className="book-page-scene-title">· {scene.title}</span>}
            <span className="book-page-total">/ 共 {scenes.length} 幕</span>
          </span>
          {hasAnyAudio && (
            <>
              <button
                className={`book-auto-play-btn${autoPlaying ? ' playing' : ''}`}
                onClick={handleAutoPlay}
                title={autoPlaying ? '停止播放（Space）' : page < scenes.length - 1 ? '自動朗讀（可跨幕連續播放，Space）' : '自動朗讀此幕（Space）'}
              >
                {autoPlaying ? '⏹ 停止' : '▶ 朗讀'}
              </button>
              <div className="book-speed-btns" title="朗讀速度">
                {([0.75, 1, 1.25, 1.5, 2.0] as const).map(s => (
                  <button
                    key={s}
                    className={`book-speed-btn${playSpeed === s ? ' active' : ''}`}
                    onClick={() => setPlaySpeed(s)}
                    title={`朗讀速度 ${s}×`}
                  >{s === 1 ? '1×' : `${s}×`}</button>
                ))}
              </div>
            </>
          )}
          <div className="book-fontsize-btns" title="字級大小（[ 縮小 / ] 放大）">
            {(['sm', 'md', 'lg'] as const).map((s, i) => (
              <button
                key={s}
                className={`book-fontsize-btn${fontSize === s ? ' active' : ''}`}
                onClick={() => setFontSize(s)}
                title={['小字（[）', '中字', '大字（]）'][i]}
              >{['小', '中', '大'][i]}</button>
            ))}
          </div>
          {/* Auto-advance timer selector */}
          <div className="book-timer-wrap" title="自動翻頁計時器：無需音訊，定時切換到下一幕">
            {([null, 8, 15, 20, 30] as const).map(secs => (
              <button
                key={secs ?? 'off'}
                className={`book-timer-btn${autoAdvanceSecs === secs ? ' active' : ''}`}
                onClick={() => setAutoAdvanceSecs(secs)}
                title={secs === null ? '關閉自動翻頁' : `每 ${secs} 秒自動翻至下一幕`}
              >
                {secs === null ? '⏱ 關' : `${secs}s`}
              </button>
            ))}
          </div>
          {scene.notes && (
            <button
              className={`book-notes-toggle${showDirectorNotes ? ' active' : ''}`}
              onClick={() => {
                const next = !showDirectorNotes
                setShowDirectorNotes(next)
                localStorage.setItem('book_preview_show_notes', String(next))
              }}
              title={showDirectorNotes ? '隱藏導演備註' : '顯示導演備註'}
            >
              📋 備註
            </button>
          )}
          {scenes.length > 1 && (
            <button
              className={`book-thumb-toggle${showThumbnails ? ' active' : ''}`}
              onClick={() => setShowThumbnails(v => !v)}
              title={showThumbnails ? '隱藏場景縮圖列' : '顯示場景縮圖列（快速跳幕）'}
            >🎞 縮圖</button>
          )}
          <button
            className={`book-fullscreen-btn${isFullscreen ? ' active' : ''}`}
            onClick={toggleFullscreen}
            title={isFullscreen ? '離開全螢幕（F）' : '全螢幕閱讀（F）'}
          >
            {isFullscreen ? '⊡' : '⊞'}
          </button>
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
                  className={`book-preview-img${imgLoaded ? ' loaded' : ''}${imgLoaded ? ' zoomable' : ''}`}
                  onLoad={() => setImgLoaded(true)}
                  onClick={() => imgLoaded && setZoomedImg(true)}
                  title={imgLoaded ? '點擊放大插圖' : undefined}
                />
                {!imgLoaded && <div className="book-img-placeholder">🎨</div>}
                {imgLoaded && (
                  <div className="book-img-actions">
                    <button className="book-img-action-btn" onClick={() => setZoomedImg(true)} title="放大插圖">🔍</button>
                    <button className="book-img-action-btn" onClick={handleDownloadImage} title="下載插圖">💾</button>
                  </div>
                )}
              </>
            ) : (
              <div className="book-img-placeholder">🎨</div>
            )}
            {/* Auto-advance timer progress bar */}
            {autoAdvanceSecs && !isLast && !autoPlaying && (
              <div className="book-timer-bar-wrap" title={`${autoAdvanceSecs} 秒後自動翻至下一幕`}>
                <div className="book-timer-bar" style={{ width: `${timerProgress}%` }} />
              </div>
            )}
          </div>

          {/* Text panel */}
          <div
            className="book-preview-text-panel"
            ref={textRef}
            style={{ fontSize: fontSize === 'sm' ? '0.9rem' : fontSize === 'lg' ? '1.3rem' : undefined }}
          >
            {scene.description && (
              <p className="book-preview-description">{scene.description}</p>
            )}
            {scene.script?.sfx_description && (
              <p className="book-preview-sfx">🎵 {scene.script.sfx_description}</p>
            )}
            {showDirectorNotes && scene.notes && (
              <div className="book-preview-notes">
                <span className="book-preview-notes-label">📋 導演備註</span>
                <p className="book-preview-notes-text">{scene.notes}</p>
              </div>
            )}
            <div className="book-preview-lines">
              {scene.lines.length === 0 && (
                <p className="book-no-lines">（此幕尚無台詞）</p>
              )}
              {scene.lines.map((line, i) => {
                const char = getCharacter(line.character_id)
                const hasAudio = !!line.audio_base64
                const isPlaying = playingLine === i
                return (
                  <div
                    key={i}
                    ref={isPlaying ? activeLineRef : undefined}
                    className={`book-line${isPlaying ? ' playing' : ''}${hasAudio ? ' has-audio' : ''}`}
                    onClick={() => hasAudio && playLine(i)}
                    title={hasAudio ? (isPlaying ? '點擊停止' : '點擊播放此句配音') : undefined}
                  >
                    <div className="book-line-speaker" style={{ color: char?.color ?? '#555' }}>
                      {char?.emoji ?? '🎭'} {line.character_name}
                      {line.emotion && line.emotion !== 'neutral' && EMOTION_LABELS[line.emotion] && (
                        <span className="book-line-emotion" title={line.emotion}>
                          {EMOTION_LABELS[line.emotion]}
                        </span>
                      )}
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

        {/* ── Thumbnail strip ── */}
        {showThumbnails && scenes.length > 1 && (
          <div className="book-thumb-strip" ref={thumbnailStripRef} role="tablist" aria-label="場景縮圖列">
            {scenes.map((s, i) => {
              const thumbSrc = s.image ? resolveImgSrc(s.image) : ''
              return (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={i === page}
                  aria-label={`第 ${i + 1} 幕${s.title ? `：${s.title}` : ''}`}
                  className={`book-thumb-item${i === page ? ' active' : ''}`}
                  onClick={() => setPage(i)}
                  title={`第 ${i + 1} 幕${s.title ? `：${s.title}` : ''}`}
                >
                  {thumbSrc ? (
                    <img src={thumbSrc} alt={`第 ${i + 1} 幕`} className="book-thumb-img" loading="lazy" />
                  ) : (
                    <div className="book-thumb-placeholder">🎨</div>
                  )}
                  <span className="book-thumb-label">{i + 1}{s.title ? ` ${s.title}` : ''}</span>
                </button>
              )
            })}
          </div>
        )}

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

          {/* Page dots ≤ 20; jump-select for larger stories */}
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
            <select
              className="book-nav-select"
              value={page}
              onChange={e => setPage(Number(e.target.value))}
              aria-label="跳至指定幕"
              title="選擇幕次快速跳轉"
            >
              {scenes.map((s, i) => (
                <option key={i} value={i}>
                  {`第 ${i + 1} 幕${s.title ? `：${s.title}` : ''}`}
                </option>
              ))}
            </select>
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
        <p className="book-keyboard-hint">← → 翻頁 · 左右滑動 · Space 朗讀 · [ ] 字級 · F 全螢幕 · Esc 關閉</p>
      </div>

      {/* ── Image lightbox ── */}
      {zoomedImg && imgSrc && (
        <div className="book-img-lightbox" onClick={() => setZoomedImg(false)}>
          <button className="book-img-lightbox-close" onClick={() => setZoomedImg(false)} title="關閉放大 (Esc)">✕</button>
          <button
            className="book-img-lightbox-download"
            onClick={e => { e.stopPropagation(); handleDownloadImage() }}
            title="下載插圖"
          >💾 下載</button>
          <img
            src={imgSrc}
            alt={`第 ${page + 1} 幕插圖（放大）`}
            className="book-img-lightbox-img"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}

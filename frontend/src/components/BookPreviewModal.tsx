import { useEffect, useRef, useState } from 'react'
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

  const scene = scenes[page]
  const imgSrc = scene?.image ? resolveImgSrc(scene.image) : ''

  // Reset image-loaded flag and scroll text back to top when page changes
  useEffect(() => {
    setImgLoaded(false)
    if (textRef.current) textRef.current.scrollTop = 0
  }, [page])

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
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, scenes.length])

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
                return (
                  <div key={i} className="book-line">
                    <div className="book-line-speaker" style={{ color: char?.color ?? '#555' }}>
                      {char?.emoji ?? '🎭'} {line.character_name}
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
        <p className="book-keyboard-hint">← → 翻頁 · Esc 關閉</p>
      </div>
    </div>
  )
}

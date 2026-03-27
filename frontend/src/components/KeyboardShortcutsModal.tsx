import { useEffect, useRef } from 'react'

interface Props {
  onClose: () => void
}

const SECTIONS = [
  {
    title: '全域快捷鍵',
    shortcuts: [
      { keys: ['Ctrl', 'S'], desc: '立即儲存專案' },
      { keys: ['Ctrl', 'Z'], desc: '復原刪除（台詞 / 場景 / 角色）' },
      { keys: ['P'], desc: '開啟 / 關閉全書播放器（需有已生成配音）' },
      { keys: ['B'], desc: '開啟 / 關閉繪本閱讀模式' },
      { keys: ['←'], desc: '場景列表：跳至上一幕（無文字輸入框聚焦時）' },
      { keys: ['→'], desc: '場景列表：跳至下一幕（無文字輸入框聚焦時）' },
      { keys: ['?'], desc: '開啟此快捷鍵說明' },
      { keys: ['Esc'], desc: '關閉目前開啟的視窗' },
    ],
  },
  {
    title: '全書播放器',
    shortcuts: [
      { keys: ['Space'], desc: '播放 / 暫停' },
      { keys: ['←'], desc: '上一句' },
      { keys: ['→'], desc: '下一句' },
      { keys: ['↑'], desc: '音量增加' },
      { keys: ['↓'], desc: '音量降低' },
      { keys: ['['], desc: '減慢播放速度' },
      { keys: [']'], desc: '加快播放速度' },
      { keys: ['PageDown'], desc: '跳至下一幕' },
      { keys: ['PageUp'], desc: '跳至上一幕' },
      { keys: ['F'], desc: '切換全螢幕' },
      { keys: ['Shift', 'L'], desc: '切換循環播放（關閉→全書→單幕）' },
      { keys: ['M'], desc: '靜音 / 取消靜音' },
      { keys: ['← 滑動'], desc: '下一句台詞（觸控）' },
      { keys: ['→ 滑動'], desc: '上一句台詞（觸控）' },
    ],
  },
  {
    title: '閱讀模式（繪本預覽）',
    shortcuts: [
      { keys: ['←'], desc: '上一幕' },
      { keys: ['→'], desc: '下一幕' },
      { keys: ['Home'], desc: '跳至第一幕' },
      { keys: ['End'], desc: '跳至最後一幕' },
      { keys: ['Space'], desc: '朗讀目前幕' },
      { keys: ['['], desc: '縮小字級' },
      { keys: [']'], desc: '放大字級' },
      { keys: ['F'], desc: '切換全螢幕' },
      { keys: ['Esc'], desc: '關閉閱讀模式' },
      { keys: ['← 滑動'], desc: '翻至下一幕（觸控）' },
      { keys: ['→ 滑動'], desc: '翻至上一幕（觸控）' },
    ],
  },
  {
    title: '場景編輯',
    shortcuts: [
      { keys: ['Ctrl', 'Enter'], desc: '快速生成故事（場景描述欄）' },
      { keys: ['Enter'], desc: '確認台詞文字編輯' },
      { keys: ['Esc'], desc: '取消台詞文字編輯' },
    ],
  },
]

export default function KeyboardShortcutsModal({ onClose }: Props) {
  const modalRef = useRef<HTMLDivElement>(null)

  // Close on Escape or click outside
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="ks-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ks-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="鍵盤快捷鍵">
        <div className="ks-header">
          <span className="ks-title">⌨️ 鍵盤快捷鍵</span>
          <button className="ks-close" onClick={onClose} title="關閉">✕</button>
        </div>
        <div className="ks-body">
          {SECTIONS.map(section => (
            <div key={section.title} className="ks-section">
              <div className="ks-section-title">{section.title}</div>
              <table className="ks-table">
                <tbody>
                  {section.shortcuts.map((s, i) => (
                    <tr key={i} className="ks-row">
                      <td className="ks-keys">
                        {s.keys.map((k, ki) => (
                          <span key={ki}>
                            {ki > 0 && <span className="ks-plus"> + </span>}
                            <kbd className="ks-kbd">{k}</kbd>
                          </span>
                        ))}
                      </td>
                      <td className="ks-desc">{s.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div className="ks-footer">按 <kbd className="ks-kbd">?</kbd> 或 <kbd className="ks-kbd">Esc</kbd> 關閉</div>
      </div>
    </div>
  )
}

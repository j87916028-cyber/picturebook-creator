import { useState, useEffect } from 'react'
import { Character, Voice, CHARACTER_COLORS } from '../types'
import CharacterCard from './CharacterCard'

interface Props {
  characters: Character[]
  onChange: (characters: Character[]) => void
}

const DEFAULT_VOICES: Voice[] = [
  { id: 'female-tianmei-jingpin', label: '甜美女聲', emoji: '👧' },
  { id: 'female-shaonv', label: '少女音', emoji: '🧒' },
  { id: 'female-yujie', label: '御姐音', emoji: '👩' },
  { id: 'male-qn-qingse', label: '青澀男聲', emoji: '👦' },
  { id: 'male-qn-badao', label: '霸道男聲', emoji: '👨' },
  { id: 'audiobook_male_2', label: '說書男聲', emoji: '📖' },
  { id: 'cute_boy', label: '可愛男孩', emoji: '🐣' },
  { id: 'elderly_man', label: '老爺爺音', emoji: '👴' },
  { id: 'elderly_woman', label: '老奶奶音', emoji: '👵' },
]

const EMOJIS = ['🐰', '🦊', '🐻', '🐼', '🦁', '🐸', '🦄', '🐧', '🐶', '🐱', '🐮', '🐷']

export default function CharacterPanel({ characters, onChange }: Props) {
  const [voices, setVoices] = useState<Voice[]>(DEFAULT_VOICES)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    name: '',
    personality: '',
    voice_id: DEFAULT_VOICES[0].id,
    emoji: EMOJIS[0],
  })

  useEffect(() => {
    fetch('/api/voices')
      .then(r => r.json())
      .then(setVoices)
      .catch(() => {})
  }, [])

  const addCharacter = () => {
    if (!form.name.trim()) return
    const newChar: Character = {
      id: `char_${Date.now()}`,
      name: form.name.trim(),
      personality: form.personality.trim() || '開朗活潑',
      voice_id: form.voice_id,
      color: CHARACTER_COLORS[characters.length % CHARACTER_COLORS.length],
      emoji: form.emoji,
    }
    onChange([...characters, newChar])
    setForm({ name: '', personality: '', voice_id: DEFAULT_VOICES[0].id, emoji: EMOJIS[0] })
    setShowForm(false)
  }

  const deleteCharacter = (id: string) => {
    onChange(characters.filter(c => c.id !== id))
  }

  return (
    <div className="character-panel">
      <div className="panel-header">
        <h2>角色卡片</h2>
        <span className="panel-hint">拖曳到場景中</span>
      </div>

      <div className="character-list">
        {characters.map(c => (
          <CharacterCard key={c.id} character={c} onDelete={deleteCharacter} />
        ))}
        {characters.length === 0 && (
          <div className="empty-hint">還沒有角色，<br />點下方按鈕新增</div>
        )}
      </div>

      {showForm ? (
        <div className="add-form">
          <div className="form-row">
            <label>選擇表情</label>
            <div className="emoji-picker">
              {EMOJIS.map(e => (
                <button
                  key={e}
                  className={`emoji-btn ${form.emoji === e ? 'selected' : ''}`}
                  onClick={() => setForm(f => ({ ...f, emoji: e }))}
                >{e}</button>
              ))}
            </div>
          </div>
          <div className="form-row">
            <label>角色名稱</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value.slice(0, 30) }))}
              placeholder="例：小兔子"
              maxLength={30}
              onKeyDown={e => e.key === 'Enter' && addCharacter()}
            />
          </div>
          <div className="form-row">
            <label>個性描述</label>
            <input
              value={form.personality}
              onChange={e => setForm(f => ({ ...f, personality: e.target.value.slice(0, 100) }))}
              placeholder="例：膽小但善良"
              maxLength={100}
              onKeyDown={e => e.key === 'Enter' && addCharacter()}
            />
          </div>
          <div className="form-row">
            <label>選擇聲音</label>
            <select
              value={form.voice_id}
              onChange={e => setForm(f => ({ ...f, voice_id: e.target.value }))}
            >
              {voices.map(v => (
                <option key={v.id} value={v.id}>{v.emoji} {v.label}</option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button className="btn-primary" onClick={addCharacter}>新增角色</button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="btn-add-character" onClick={() => setShowForm(true)}>
          ＋ 新增角色
        </button>
      )}
    </div>
  )
}

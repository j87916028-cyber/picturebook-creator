import { useState, useEffect, useRef } from 'react'
import { Character, Voice, CHARACTER_COLORS } from '../types'
import CharacterCard from './CharacterCard'

interface Props {
  characters: Character[]
  onChange: (characters: Character[]) => void
  lineCountsByCharId?: Record<string, number>
}

const DEFAULT_VOICES: Voice[] = [
  { id: 'cn-natural-female',  label: '自然女聲 ★',  emoji: '🌟', group: '精選推薦' },
  { id: 'cn-natural-male',    label: '自然男聲 ★',  emoji: '⭐', group: '精選推薦' },
  { id: 'cn-story-male',      label: '說書聲音 ★',  emoji: '📻', group: '精選推薦' },
  { id: 'cn-child-girl',      label: '活潑小女孩',  emoji: '👧', group: '孩童聲音' },
  { id: 'cn-girl-clear',      label: '清亮女孩',    emoji: '🎀', group: '孩童聲音' },
  { id: 'cute_boy',           label: '可愛男孩',    emoji: '🐣', group: '孩童聲音' },
  { id: 'cn-girl-soft',       label: '成熟女聲',    emoji: '👩‍💼', group: '女聲' },
  { id: 'female-yujie',       label: '御姐音',      emoji: '👩',  group: '女聲' },
  { id: 'audiobook_female_2', label: '說書女聲',    emoji: '📚',  group: '女聲' },
  { id: 'elderly_woman',      label: '老奶奶音',    emoji: '👵', group: '女聲' },
  { id: 'male-qn-qingse',     label: '青澀男聲',    emoji: '👦', group: '男聲' },
  { id: 'male-qn-jingying',   label: '精英男聲',    emoji: '🧑‍💼', group: '男聲' },
  { id: 'male-qn-badao',      label: '霸道男聲',    emoji: '👨', group: '男聲' },
  { id: 'presenter_male',     label: '播報男聲',    emoji: '🎙️', group: '男聲' },
  { id: 'audiobook_male_2',   label: '說書男聲',    emoji: '📖', group: '男聲' },
  { id: 'elderly_man',        label: '老爺爺音',    emoji: '👴', group: '男聲' },
]

const EMOJI_GROUPS = [
  {
    label: '🐾 動物',
    emojis: ['🐰', '🦊', '🐻', '🐼', '🦁', '🐸', '🦄', '🐧', '🐶', '🐱',
             '🐮', '🐷', '🐭', '🐹', '🐨', '🦝', '🦔', '🐺', '🦅', '🐢',
             '🦋', '🐬', '🐘', '🦒', '🦓'],
  },
  {
    label: '👥 人物',
    emojis: ['👦', '👧', '🧒', '👨', '👩', '🧑', '👴', '👵', '🧓',
             '👨‍🍳', '👩‍🍳', '🧙', '🧝', '🧚', '🧜', '🧞', '🕵️'],
  },
  {
    label: '✨ 奇幻',
    emojis: ['🐉', '👾', '🤖', '👻', '🎃', '🦸', '🦹', '🧸', '🪄',
             '⭐', '🌟', '🌈', '☁️', '🔮', '💎', '🏰'],
  },
]

interface FormState {
  name: string
  personality: string
  visual_description: string
  voice_id: string
  emoji: string
}

function VoicePicker({
  voices,
  value,
  onChange,
}: {
  voices: Voice[]
  value: string
  onChange: (id: string) => void
}) {
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const handlePreview = async (e: React.MouseEvent, voiceId: string) => {
    e.stopPropagation()
    if (loadingId) return
    setLoadingId(voiceId)
    try {
      const res = await fetch(`/api/voices/${voiceId}/preview`)
      if (!res.ok) return
      const data = await res.json()
      const src = `data:audio/${data.format};base64,${data.audio_base64}`
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = src
        audioRef.current.play().catch(() => {})
      }
    } catch {}
    finally {
      setLoadingId(null)
    }
  }

  const groups: string[] = []
  for (const v of voices) {
    const g = v.group ?? '其他'
    if (!groups.includes(g)) groups.push(g)
  }

  return (
    <div className="voice-picker">
      <audio ref={audioRef} />
      {groups.map(group => {
        const groupVoices = voices.filter(v => (v.group ?? '其他') === group)
        return (
          <div key={group} className="voice-group">
            <div className="voice-group-header">{group}</div>
            {groupVoices.map(v => {
              const isSelected = v.id === value
              const isLoading = loadingId === v.id
              return (
                <div
                  key={v.id}
                  className={`voice-option ${isSelected ? 'selected' : ''}`}
                  onClick={() => onChange(v.id)}
                >
                  <span className="voice-option-emoji">{v.emoji}</span>
                  <span className="voice-option-label">{v.label}</span>
                  <button
                    className="btn-voice-preview"
                    onClick={e => handlePreview(e, v.id)}
                    disabled={!!loadingId}
                    title="試聽"
                  >
                    {isLoading ? <span className="spinner-sm" /> : '▶'}
                  </button>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function CharacterForm({
  initial,
  voices,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState
  voices: Voice[]
  submitLabel: string
  onSubmit: (f: FormState) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<FormState>(initial)
  const [emojiTab, setEmojiTab] = useState(0)

  return (
    <div className="add-form">
      <div className="form-row">
        <label>選擇表情</label>
        <div className="emoji-picker-wrap">
          <div className="emoji-tab-row">
            {EMOJI_GROUPS.map((g, gi) => (
              <button
                key={gi}
                className={`emoji-tab-btn${emojiTab === gi ? ' active' : ''}`}
                onClick={() => setEmojiTab(gi)}
                type="button"
              >{g.label}</button>
            ))}
          </div>
          <div className="emoji-picker">
            {EMOJI_GROUPS[emojiTab].emojis.map(e => (
              <button
                key={e}
                className={`emoji-btn ${form.emoji === e ? 'selected' : ''}`}
                onClick={() => setForm(f => ({ ...f, emoji: e }))}
                type="button"
              >{e}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="form-row">
        <label>角色名稱</label>
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value.slice(0, 30) }))}
          placeholder="例：小兔子"
          maxLength={30}
          onKeyDown={e => e.key === 'Enter' && form.name.trim() && onSubmit(form)}
          autoFocus
        />
      </div>
      <div className="form-row">
        <label>個性描述</label>
        <input
          value={form.personality}
          onChange={e => setForm(f => ({ ...f, personality: e.target.value.slice(0, 100) }))}
          placeholder="例：膽小但善良"
          maxLength={100}
        />
      </div>
      <div className="form-row">
        <label>
          外形描述
          <span style={{ fontSize: '0.7rem', color: '#aaa', marginLeft: 4 }}>（影響插圖一致性）</span>
        </label>
        <input
          value={form.visual_description}
          onChange={e => setForm(f => ({ ...f, visual_description: e.target.value.slice(0, 200) }))}
          placeholder="例：白色小兔，穿粉紅圍裙，有長耳朵"
          maxLength={200}
        />
      </div>
      <div className="form-row">
        <label>選擇聲音 <span style={{ fontSize: '0.72rem', color: '#aaa' }}>（▶ 試聽）</span></label>
        <VoicePicker
          voices={voices}
          value={form.voice_id}
          onChange={id => setForm(f => ({ ...f, voice_id: id }))}
        />
      </div>
      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={() => form.name.trim() && onSubmit(form)}
          disabled={!form.name.trim()}
        >{submitLabel}</button>
        <button className="btn-ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

export default function CharacterPanel({ characters, onChange, lineCountsByCharId = {} }: Props) {
  const [voices, setVoices] = useState<Voice[]>(DEFAULT_VOICES)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/voices')
      .then(r => r.json())
      .then(setVoices)
      .catch(() => {})
  }, [])

  const handleAdd = (form: FormState) => {
    const newChar: Character = {
      id: `char_${Date.now()}`,
      name: form.name.trim(),
      personality: form.personality.trim() || '開朗活潑',
      visual_description: form.visual_description.trim() || undefined,
      voice_id: form.voice_id,
      color: CHARACTER_COLORS[characters.length % CHARACTER_COLORS.length],
      emoji: form.emoji,
    }
    onChange([...characters, newChar])
    setShowAddForm(false)
  }

  const handleEditSave = (id: string, form: FormState) => {
    onChange(characters.map(c =>
      c.id === id
        ? { ...c, name: form.name.trim(), personality: form.personality.trim() || '開朗活潑', visual_description: form.visual_description.trim() || undefined, voice_id: form.voice_id, emoji: form.emoji }
        : c
    ))
    setEditingId(null)
  }

  const deleteCharacter = (id: string) => {
    onChange(characters.filter(c => c.id !== id))
    if (editingId === id) setEditingId(null)
  }

  return (
    <div className="character-panel">
      <div className="panel-header">
        <h2>角色卡片</h2>
        <span className="panel-hint">拖曳到場景中</span>
      </div>

      <div className="character-list">
        {characters.map(c => (
          <div key={c.id}>
            <CharacterCard
              character={c}
              onDelete={deleteCharacter}
              onEdit={id => setEditingId(id === editingId ? null : id)}
              lineCount={lineCountsByCharId[c.id]}
            />
            {editingId === c.id && (
              <CharacterForm
                initial={{ name: c.name, personality: c.personality, visual_description: c.visual_description ?? '', voice_id: c.voice_id, emoji: c.emoji }}
                voices={voices}
                submitLabel="儲存變更"
                onSubmit={form => handleEditSave(c.id, form)}
                onCancel={() => setEditingId(null)}
              />
            )}
          </div>
        ))}
        {characters.length === 0 && (
          <div className="empty-hint">還沒有角色，<br />點下方按鈕新增</div>
        )}
      </div>

      {showAddForm ? (
        <CharacterForm
          initial={{ name: '', personality: '', visual_description: '', voice_id: DEFAULT_VOICES[0].id, emoji: EMOJI_GROUPS[0].emojis[0] }}
          voices={voices}
          submitLabel="新增角色"
          onSubmit={handleAdd}
          onCancel={() => setShowAddForm(false)}
        />
      ) : (
        <button className="btn-add-character" onClick={() => { setShowAddForm(true); setEditingId(null) }}>
          ＋ 新增角色
        </button>
      )}
    </div>
  )
}

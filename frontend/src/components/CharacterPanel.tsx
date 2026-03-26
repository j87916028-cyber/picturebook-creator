import { useState, useEffect, useRef } from 'react'
import { Character, Voice, CHARACTER_COLORS } from '../types'
import CharacterCard from './CharacterCard'

interface Props {
  characters: Character[]
  onChange: (characters: Character[]) => void
  lineCountsByCharId?: Record<string, number>
  sceneIndicesByCharId?: Record<string, number[]>
  droppedCharacterIds?: string[]
  onAddToScene?: (char: Character) => void
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

// ── Quick character presets ──────────────────────────────────────────────────
interface CharacterPreset {
  emoji: string
  name: string
  personality: string
  visual_description: string
  voice_id: string
  color: string
}

const CHARACTER_PRESETS: CharacterPreset[] = [
  { emoji: '🐰', name: '小兔子', personality: '活潑好奇、膽小但善良', visual_description: '白色小兔，穿粉紅圍裙，有長耳朵和短尾巴', voice_id: 'cn-child-girl', color: '#ff90b0' },
  { emoji: '🦊', name: '狐狸',   personality: '聰明機靈、有點調皮',   visual_description: '橘色狐狸，有蓬鬆大尾巴，眼睛閃亮', voice_id: 'male-qn-qingse', color: '#ff8c42' },
  { emoji: '🐻', name: '小熊',   personality: '憨厚善良、愛吃蜂蜜',   visual_description: '棕色小熊，戴紅色帽子，肚子圓滾滾', voice_id: 'cute_boy', color: '#a0522d' },
  { emoji: '👧', name: '小女孩', personality: '溫柔善良、富有同情心', visual_description: '穿黃色洋裝，綁長辮子，戴花圈', voice_id: 'cn-girl-clear', color: '#f6c90e' },
  { emoji: '👦', name: '小男孩', personality: '勇敢冒險、充滿好奇心', visual_description: '穿藍色條紋衣服，短黑髮，背著小背包', voice_id: 'male-qn-qingse', color: '#4a90d9' },
  { emoji: '👴', name: '老爺爺', personality: '智慧慈祥、說話幽默',   visual_description: '白鬍子老人，穿長袍，拄著木杖', voice_id: 'elderly_man', color: '#7c6f64' },
  { emoji: '🧙', name: '魔法師', personality: '神秘莫測、法力高強',   visual_description: '穿星星圖案長袍，戴尖頂帽，手持魔杖', voice_id: 'audiobook_male_2', color: '#6c5ce7' },
  { emoji: '🐉', name: '小龍',   personality: '熱情開朗、偶爾噴火',   visual_description: '綠色小龍，有翅膀和小角，噴出五彩泡泡', voice_id: 'cn-story-male', color: '#2ecc71' },
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
  color: string
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
  const [previewText, setPreviewText] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const handlePreview = async (e: React.MouseEvent, voiceId: string) => {
    e.stopPropagation()
    if (loadingId) return
    setLoadingId(voiceId)
    try {
      const custom = previewText.trim()
      const url = custom
        ? `/api/voices/${voiceId}/preview?text=${encodeURIComponent(custom)}`
        : `/api/voices/${voiceId}/preview`
      const res = await fetch(url)
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
      <div className="voice-preview-text-row">
        <input
          className="voice-preview-text-input"
          type="text"
          value={previewText}
          onChange={e => setPreviewText(e.target.value.slice(0, 100))}
          placeholder="輸入試聽文字（空白則播預設範例）"
          maxLength={100}
        />
      </div>
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
  const [suggestingVisual, setSuggestingVisual] = useState(false)
  const [suggestingPersonality, setSuggestingPersonality] = useState(false)
  const [personalityError, setPersonalityError] = useState<string | null>(null)
  const [visualError, setVisualError] = useState<string | null>(null)

  const handleSuggestPersonality = async () => {
    if (!form.name.trim() || suggestingPersonality) return
    setSuggestingPersonality(true)
    setPersonalityError(null)
    try {
      const res = await fetch('/api/suggest-personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          emoji: form.emoji,
          style: localStorage.getItem('scene_style') || '溫馨童趣',
        }),
      })
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
        const msg = `請求過於頻繁，請 ${wait} 秒後再試`
        setPersonalityError(msg)
        setTimeout(() => setPersonalityError(e => e === msg ? null : e), wait * 1000)
      } else if (res.ok) {
        const data = await res.json()
        if (data.personality) setForm(f => ({ ...f, personality: data.personality.slice(0, 100) }))
      } else {
        setPersonalityError('個性建議生成失敗，請稍後再試')
        setTimeout(() => setPersonalityError(null), 5000)
      }
    } catch {
      setPersonalityError('個性建議生成失敗，請確認網路連線')
      setTimeout(() => setPersonalityError(null), 5000)
    } finally {
      setSuggestingPersonality(false)
    }
  }

  const handleSuggestVisual = async () => {
    if (!form.name.trim() || suggestingVisual) return
    setSuggestingVisual(true)
    setVisualError(null)
    try {
      const res = await fetch('/api/suggest-visual-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          personality: form.personality.trim(),
          emoji: form.emoji,
          style: localStorage.getItem('scene_style') || '溫馨童趣',
        }),
      })
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') ?? '10', 10)
        const msg = `請求過於頻繁，請 ${wait} 秒後再試`
        setVisualError(msg)
        setTimeout(() => setVisualError(e => e === msg ? null : e), wait * 1000)
      } else if (res.ok) {
        const data = await res.json()
        if (data.description) setForm(f => ({ ...f, visual_description: data.description.slice(0, 200) }))
      } else {
        setVisualError('外形描述生成失敗，請稍後再試')
        setTimeout(() => setVisualError(null), 5000)
      }
    } catch {
      setVisualError('外形描述生成失敗，請確認網路連線')
      setTimeout(() => setVisualError(null), 5000)
    } finally {
      setSuggestingVisual(false)
    }
  }

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
        <div className="visual-desc-input-wrap">
          <input
            value={form.personality}
            onChange={e => setForm(f => ({ ...f, personality: e.target.value.slice(0, 100) }))}
            placeholder="例：膽小但善良"
            maxLength={100}
          />
          <button
            type="button"
            className="btn-ai-visual"
            onClick={handleSuggestPersonality}
            disabled={!form.name.trim() || suggestingPersonality}
            title={form.name.trim() ? 'AI 自動建議個性描述' : '請先填寫角色名稱'}
          >
            {suggestingPersonality ? <span className="spinner-sm" /> : '✨ AI'}
          </button>
        </div>
        {personalityError && <div className="suggest-error">{personalityError}</div>}
      </div>
      <div className="form-row">
        <label>
          外形描述
          <span style={{ fontSize: '0.7rem', color: '#aaa', marginLeft: 4 }}>（影響插圖一致性）</span>
        </label>
        <div className="visual-desc-input-wrap">
          <input
            value={form.visual_description}
            onChange={e => setForm(f => ({ ...f, visual_description: e.target.value.slice(0, 200) }))}
            placeholder="例：white rabbit in pink apron, long ears..."
            maxLength={200}
          />
          <button
            type="button"
            className="btn-ai-visual"
            onClick={handleSuggestVisual}
            disabled={!form.name.trim() || suggestingVisual}
            title={form.name.trim() ? 'AI 自動生成英文外形描述' : '請先填寫角色名稱'}
          >
            {suggestingVisual ? <span className="spinner-sm" /> : '✨ AI'}
          </button>
        </div>
        {visualError && <div className="suggest-error">{visualError}</div>}
      </div>
      <div className="form-row">
        <label>角色顏色</label>
        <div className="color-picker-wrap">
          <div className="color-swatches">
            {CHARACTER_COLORS.map(c => (
              <button
                key={c}
                type="button"
                className={`color-swatch${form.color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => setForm(f => ({ ...f, color: c }))}
                title={c}
              />
            ))}
          </div>
          <input
            type="color"
            className="color-custom-input"
            value={form.color}
            onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
            title="自訂顏色"
          />
        </div>
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

export default function CharacterPanel({ characters, onChange, lineCountsByCharId = {}, sceneIndicesByCharId = {}, droppedCharacterIds = [], onAddToScene }: Props) {
  const [voices, setVoices] = useState<Voice[]>(DEFAULT_VOICES)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showPresets, setShowPresets] = useState(false)

  // Cross-project character library (persisted to localStorage)
  const [library, setLibrary] = useState<Character[]>(() => {
    try { return JSON.parse(localStorage.getItem('character_library') || '[]') }
    catch { return [] }
  })
  const [showLibrary, setShowLibrary] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('character_library', JSON.stringify(library))
  }, [library])

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
      color: form.color,
      emoji: form.emoji,
    }
    onChange([...characters, newChar])
    setShowAddForm(false)
  }

  const handleEditSave = (id: string, form: FormState) => {
    onChange(characters.map(c =>
      c.id === id
        ? { ...c, name: form.name.trim(), personality: form.personality.trim() || '開朗活潑', visual_description: form.visual_description.trim() || undefined, voice_id: form.voice_id, emoji: form.emoji, color: form.color }
        : c
    ))
    setEditingId(null)
  }

  const deleteCharacter = (id: string) => {
    onChange(characters.filter(c => c.id !== id))
    if (editingId === id) setEditingId(null)
  }

  const handleDuplicate = (id: string) => {
    const original = characters.find(c => c.id === id)
    if (!original) return
    // Strip any existing "(副本N)" suffix then add a fresh one
    const baseName = original.name.replace(/\s*（副本\d*）$/, '')
    const copies = characters.filter(c => c.name.startsWith(baseName) && c.name !== baseName).length
    const copyName = `${baseName}（副本${copies > 0 ? copies + 1 : ''}）`.replace(/（副本）/, '（副本）')
    const nextColor = CHARACTER_COLORS[(characters.length) % CHARACTER_COLORS.length]
    const copy: Character = {
      ...original,
      id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: copyName.slice(0, 30),
      color: nextColor,
    }
    const idx = characters.findIndex(c => c.id === id)
    const next = [...characters.slice(0, idx + 1), copy, ...characters.slice(idx + 1)]
    onChange(next)
  }

  const handleMoveUp = (id: string) => {
    const idx = characters.findIndex(c => c.id === id)
    if (idx <= 0) return
    const next = [...characters]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    onChange(next)
  }

  const handleMoveDown = (id: string) => {
    const idx = characters.findIndex(c => c.id === id)
    if (idx < 0 || idx >= characters.length - 1) return
    const next = [...characters]
    ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
    onChange(next)
  }

  const handleAddPreset = (preset: CharacterPreset) => {
    // Skip if a character with the same name already exists
    if (characters.some(c => c.name === preset.name)) return
    const newChar: Character = {
      id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: preset.name,
      personality: preset.personality,
      visual_description: preset.visual_description,
      voice_id: preset.voice_id,
      color: preset.color,
      emoji: preset.emoji,
    }
    onChange([...characters, newChar])
  }

  // Save a character to the cross-project library (dedup by name)
  const handleSaveToLibrary = (char: Character) => {
    if (library.some(c => c.name === char.name)) return
    setLibrary(prev => [...prev, char])
  }

  // Load a character from library into current project (new ID to avoid conflicts)
  const handleLoadFromLibrary = (char: Character) => {
    if (characters.some(c => c.name === char.name)) return
    onChange([...characters, {
      ...char,
      id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }])
  }

  // Export library as a JSON file for backup or sharing across devices
  const handleExportLibrary = () => {
    if (library.length === 0) return
    // Strip internal IDs — they're meaningless on other devices/browsers
    const data = JSON.stringify(library.map(({ id: _id, ...rest }) => rest), null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '角色庫.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Import characters from a JSON file into the library, skipping duplicates by name
  const handleImportLibrary = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (importInputRef.current) importInputRef.current.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string)
        if (!Array.isArray(parsed)) throw new Error('not array')
        const newChars: Character[] = parsed
          .filter((c: unknown): c is Record<string, unknown> =>
            !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).name === 'string'
          )
          .map(c => ({
            id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: String(c.name || '').slice(0, 30),
            personality: String(c.personality || '').slice(0, 100),
            visual_description: c.visual_description ? String(c.visual_description).slice(0, 200) : undefined,
            voice_id: String(c.voice_id || ''),
            color: typeof c.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : '#667eea',
            emoji: String(c.emoji || '🎭').slice(0, 10),
          }))
          .filter(c => c.name.trim().length > 0)
        if (newChars.length === 0) {
          setImportMsg('未找到有效角色資料')
          setTimeout(() => setImportMsg(null), 3500)
          return
        }
        setLibrary(prev => {
          const existingNames = new Set(prev.map(c => c.name))
          const added = newChars.filter(c => !existingNames.has(c.name))
          const skipped = newChars.length - added.length
          setImportMsg(`已匯入 ${added.length} 個角色${skipped > 0 ? `（${skipped} 個重複略過）` : ''}`)
          setTimeout(() => setImportMsg(null), 4000)
          return [...prev, ...added]
        })
        setShowLibrary(true)
      } catch {
        setImportMsg('檔案格式錯誤，請選擇正確的 JSON 角色庫檔案')
        setTimeout(() => setImportMsg(null), 4000)
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="character-panel">
      <div className="panel-header">
        <h2>角色卡片</h2>
        <span className="panel-hint">拖曳或點 ➕ 加入場景</span>
      </div>

      <div className="character-list">
        {characters.map(c => (
          <div key={c.id}>
            <CharacterCard
              character={c}
              onDelete={deleteCharacter}
              onEdit={id => setEditingId(id === editingId ? null : id)}
              onDuplicate={handleDuplicate}
              onMoveUp={characters.indexOf(c) > 0 ? () => handleMoveUp(c.id) : undefined}
              onMoveDown={characters.indexOf(c) < characters.length - 1 ? () => handleMoveDown(c.id) : undefined}
              lineCount={lineCountsByCharId[c.id]}
              sceneIndices={sceneIndicesByCharId[c.id]}
              voiceLabel={voices.find(v => v.id === c.voice_id)?.label}
              isInScene={droppedCharacterIds.includes(c.id)}
              onAddToScene={onAddToScene ? () => onAddToScene(c) : undefined}
              onSaveToLibrary={() => handleSaveToLibrary(c)}
              isInLibrary={library.some(l => l.name === c.name)}
            />
            {editingId === c.id && (
              <CharacterForm
                initial={{ name: c.name, personality: c.personality, visual_description: c.visual_description ?? '', voice_id: c.voice_id, emoji: c.emoji, color: c.color }}
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

      {/* Quick preset section */}
      <div className="preset-section">
        <button
          className="btn-preset-toggle"
          onClick={() => setShowPresets(v => !v)}
          title="從常用角色範本快速新增"
        >
          {showPresets ? '▲' : '▼'} 快速角色範本
        </button>
        {showPresets && (
          <div className="preset-chips">
            {CHARACTER_PRESETS.map(p => {
              const added = characters.some(c => c.name === p.name)
              return (
                <button
                  key={p.name}
                  className={`preset-chip${added ? ' added' : ''}`}
                  onClick={() => handleAddPreset(p)}
                  disabled={added}
                  title={added ? `「${p.name}」已在角色列表中` : `新增 ${p.name}（${p.personality}）`}
                  style={{ borderColor: p.color, color: added ? '#aaa' : p.color }}
                >
                  {p.emoji} {p.name}
                  {added && <span className="preset-chip-check">✓</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Cross-project character library */}
      {library.length > 0 && (
        <div className="library-section">
          <div className="library-header-row">
            <button
              className="btn-preset-toggle"
              onClick={() => setShowLibrary(v => !v)}
              title="從角色庫載入跨專案保存的角色"
            >
              {showLibrary ? '▲' : '▼'} 我的角色庫（{library.length}）
            </button>
            <button
              className="btn-library-action"
              onClick={handleExportLibrary}
              title="匯出角色庫為 JSON 檔案（可在其他裝置或瀏覽器匯入）"
            >💾 匯出</button>
          </div>
          {showLibrary && (
            <div className="library-chips">
              {library.map(char => {
                const inProject = characters.some(c => c.name === char.name)
                return (
                  <div key={char.id} className="library-entry" style={{ borderColor: char.color }}>
                    <button
                      className={`library-entry-main${inProject ? ' in-project' : ''}`}
                      onClick={() => handleLoadFromLibrary(char)}
                      disabled={inProject}
                      title={inProject ? '已在當前專案的角色列表中' : `新增「${char.name}」到本專案`}
                    >
                      <span className="library-entry-emoji">{char.emoji}</span>
                      <span className="library-entry-name" style={{ color: char.color }}>{char.name}</span>
                      <span className="library-entry-personality">{char.personality}</span>
                      {inProject
                        ? <span className="library-status-in">✓</span>
                        : <span className="library-status-add">＋</span>}
                    </button>
                    <button
                      className="library-entry-delete"
                      onClick={() => setLibrary(prev => prev.filter(c => c.id !== char.id))}
                      title={`從角色庫移除「${char.name}」`}
                    >×</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showAddForm ? (
        <CharacterForm
          initial={{ name: '', personality: '', visual_description: '', voice_id: DEFAULT_VOICES[0].id, emoji: EMOJI_GROUPS[0].emojis[0], color: CHARACTER_COLORS[characters.length % CHARACTER_COLORS.length] }}
          voices={voices}
          submitLabel="新增角色"
          onSubmit={handleAdd}
          onCancel={() => setShowAddForm(false)}
        />
      ) : (
        <button className="btn-add-character" onClick={() => { setShowAddForm(true); setEditingId(null) }}>
          ＋ 自訂角色
        </button>
      )}

      {/* Library import — always accessible so users can restore/migrate their library */}
      <div className="library-import-row">
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handleImportLibrary}
        />
        <button
          className="btn-library-action btn-library-import"
          onClick={() => importInputRef.current?.click()}
          title="從 JSON 檔案匯入角色庫（支援跨裝置、跨瀏覽器）"
        >
          📥 匯入角色庫
        </button>
        {importMsg && <span className="library-import-msg">{importMsg}</span>}
      </div>
    </div>
  )
}

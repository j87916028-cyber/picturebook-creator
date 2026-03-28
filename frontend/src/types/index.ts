export interface Voice {
  id: string
  label: string
  emoji: string
  group?: string
}

export interface Character {
  id: string
  name: string
  personality: string
  visual_description?: string
  voice_id: string
  color: string
  emoji: string
  /** AI-generated character portrait (data URI). Optional, stored in project characters. */
  portrait_url?: string
}

export interface ScriptLine {
  /** Stable client-side ID assigned when the line is first created.
   *  Used to correctly route async voice results back to the right line
   *  even if the user reorders lines while a voice request is in flight. */
  id?: string
  character_name: string
  character_id: string
  voice_id: string
  text: string
  emotion: string
  audio_base64?: string
  audio_format?: string
}

export interface ScriptResponse {
  lines: ScriptLine[]
  scene_prompt: string
  sfx_description: string
  scene_title?: string   // Auto-suggested short title (4-8 Chinese chars)
}

export interface Scene {
  id: string
  title?: string
  description: string
  style: string
  line_length?: 'short' | 'standard' | 'long'
  /** Image style (English value) used when generating this scene's illustration.
   *  Persisted per-scene so regeneration defaults to the original style. */
  image_style?: string
  /** Private director/author notes — saved to DB but never included in any export */
  notes?: string
  /** Mood used when the script was generated (e.g. 輕鬆愉快). Persisted per-scene
   *  so the regeneration form can pre-fill the original setting. */
  mood?: string
  /** Age group used when the script was generated. Persisted per-scene. */
  age_group?: 'toddler' | 'child' | 'preteen'
  script: ScriptResponse
  lines: ScriptLine[]
  image: string
  /** True once the voice-generation pass for this scene has completed (success or failure).
   *  Used to distinguish "still loading" from "generation finished but audio failed". */
  voices_attempted?: boolean
  /** When true, the scene is protected from batch / accidental regeneration. */
  is_locked?: boolean
}

/** Canonical emotion metadata used by SceneOutput, PlaybackModal, BookPreviewModal, and App.
 *  Single source of truth — add / rename emotions here only. */
export const EMOTION_META: Record<string, { emoji: string; label: string; color: string }> = {
  happy:     { emoji: '😄', label: '開心', color: '#4caf50' },
  sad:       { emoji: '😢', label: '難過', color: '#5c9bd6' },
  angry:     { emoji: '😠', label: '生氣', color: '#e53935' },
  surprised: { emoji: '😲', label: '驚訝', color: '#ff9800' },
  fearful:   { emoji: '😨', label: '害怕', color: '#7c4dff' },
  disgusted: { emoji: '🤢', label: '厭惡', color: '#78909c' },
  neutral:   { emoji: '😐', label: '平靜', color: '#bdbdbd' },
}

/** Pre-computed "emoji label" per emotion — e.g. "😄 開心" */
export const EMOTION_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(EMOTION_META).map(([k, v]) => [k, `${v.emoji} ${v.label}`])
)

/** Pre-computed color hex per emotion — e.g. "#4caf50" for happy */
export const EMOTION_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(EMOTION_META).map(([k, v]) => [k, v.color])
)

/** Story style options — shared by SceneEditor and SceneOutput. */
export const STORY_STYLES: string[] = ['溫馨童趣', '奇幻冒險', '搞笑幽默', '感動溫情', '懸疑神秘']

/** Image style options — shared by SceneEditor and SceneOutput. */
export interface ImageStyleOption {
  label: string   // displayed in Chinese
  value: string   // English value sent to the image API
}
export const IMAGE_STYLES: ImageStyleOption[] = [
  { label: '水彩繪本', value: "watercolor children's book illustration" },
  { label: '粉彩卡通', value: 'soft pastel cartoon, cute kawaii style' },
  { label: '鉛筆素描', value: 'pencil sketch children illustration, warm tones' },
  { label: '宮崎駿風', value: 'Studio Ghibli anime style illustration' },
  { label: '3D 卡通',  value: '3D render cartoon, Pixar style, vibrant colors' },
]

/** Safe localStorage.setItem — silently ignores QuotaExceededError
 *  (private browsing, storage full) so a failed preference write
 *  doesn't crash the React error boundary. */
export function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* quota exceeded or disabled */ }
}

export const CHARACTER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
]

export interface ProjectMeta {
  id: string
  name: string
  created_at: string
  updated_at: string
  scene_count: number
  line_count?: number
  total_chars?: number   // sum of all dialogue text lengths; used for estimated duration
  cover_image?: string
}

export interface ProjectDetail extends ProjectMeta {
  characters?: Character[]
  scenes: Array<{
    id: string
    idx: number
    title?: string
    description: string
    style: string
    line_length?: 'short' | 'standard' | 'long'
    image_style?: string
    mood?: string
    age_group?: string
    notes?: string
    script: ScriptResponse
    lines: ScriptLine[]
    image: string
    is_locked?: boolean
  }>
}

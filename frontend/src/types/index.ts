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
  /** Private director/author notes — saved to DB but never included in any export */
  notes?: string
  script: ScriptResponse
  lines: ScriptLine[]
  image: string
  /** True once the voice-generation pass for this scene has completed (success or failure).
   *  Used to distinguish "still loading" from "generation finished but audio failed". */
  voices_attempted?: boolean
  /** When true, the scene is protected from batch / accidental regeneration. */
  is_locked?: boolean
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
    notes?: string
    script: ScriptResponse
    lines: ScriptLine[]
    image: string
    is_locked?: boolean
  }>
}

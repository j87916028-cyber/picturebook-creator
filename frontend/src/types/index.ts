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
    script: ScriptResponse
    lines: ScriptLine[]
    image: string
  }>
}

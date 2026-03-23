export interface Voice {
  id: string
  label: string
  emoji: string
}

export interface Character {
  id: string
  name: string
  personality: string
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
}

export interface Scene {
  id: string
  description: string
  style: string
  script: ScriptResponse
  lines: ScriptLine[]
  image: string
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
}

export interface ProjectDetail extends ProjectMeta {
  scenes: Array<{
    id: string
    idx: number
    description: string
    style: string
    script: ScriptResponse
    lines: ScriptLine[]
    image: string
  }>
}

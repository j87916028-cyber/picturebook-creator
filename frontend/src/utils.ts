/**
 * Pure utility functions extracted from App.tsx to improve navigability.
 * No React dependencies — all functions are independently testable.
 */
import type { Scene, Character } from './types'

/** DJB2 hash → stable image seed from character IDs + style.
 *  Ensures the same character set always gets the same illustration seed. */
export function stableImageSeed(characters: Character[], imageStyle: string): number {
  const key = [...characters]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(c => c.id)
    .join('|') + '|' + imageStyle
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  }
  return (Math.abs(h) % 2147483647) + 1
}

/** Cheap fingerprint of a scene's media blobs (image + all audio).
 *  Uses only the tail of each base64 string — enough to detect any change
 *  without spending time hashing megabytes of data. */
export function blobChecksum(s: { image?: string; lines?: Array<{ audio_base64?: string }> }): string {
  const img = s.image ? s.image.slice(-24) : ''
  const audio = (s.lines ?? []).map(l => l.audio_base64 ? l.audio_base64.slice(-12) : '-').join('')
  return `${img}|${audio}`
}

/** Build a compact story context from all scenes up to (but not including) endIndex.
 *  Keeps every scene in context while staying under the backend's 5000-char limit. */
export function buildStoryContext(scenes: Scene[], endIndex?: number): string | undefined {
  const relevant = endIndex !== undefined ? scenes.slice(0, endIndex) : scenes
  if (relevant.length === 0) return undefined

  const MAX_SCENES = 8
  let selected: Array<{ scene: Scene; num: number }>
  if (relevant.length <= MAX_SCENES) {
    selected = relevant.map((s, i) => ({ scene: s, num: i + 1 }))
  } else {
    const tailStart = relevant.length - (MAX_SCENES - 1)
    selected = [
      { scene: relevant[0], num: 1 },
      ...relevant.slice(tailStart).map((s, i) => ({ scene: s, num: tailStart + i + 1 })),
    ]
  }

  const context = selected.map(({ scene: s, num }) => {
    const lines = s.lines.filter(l => l.text)
    const first = lines[0]
    const last  = lines.length > 1 ? lines[lines.length - 1] : null
    const snippets = [first, last]
      .filter((l): l is NonNullable<typeof l> => l != null)
      .map(l => `${l.character_name}：「${l.text}」`)
      .join('…')
    const titlePart = s.title ? `《${s.title}》` : ''
    return `第${num}幕${titlePart}（${s.description}）：${snippets || '（生成中）'}`
  }).join('\n')

  return context.length > 4800 ? context.slice(0, 4800) : context
}

/** Run `tasks` with at most `concurrency` running simultaneously. */
export async function throttled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let nextIdx = 0
  let done = 0
  const total = tasks.length
  const run = async () => {
    while (nextIdx < total) {
      const i = nextIdx++
      await tasks[i]()
      done++
      onProgress?.(done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, run))
}

/** Generate a short stable ID for a ScriptLine (7 random base-36 chars). */
export const lineId = () => Math.random().toString(36).slice(2, 9)

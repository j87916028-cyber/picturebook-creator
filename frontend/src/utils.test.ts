import { describe, it, expect } from 'vitest'
import { stableImageSeed, blobChecksum, buildStoryContext, throttled, lineId } from './utils'
import type { Scene, Character } from './types'

describe('stableImageSeed', () => {
  const chars: Character[] = [
    { id: 'c1', name: 'A', personality: '', voice_id: 'v1', color: '#f00', emoji: '🐰' },
    { id: 'c2', name: 'B', personality: '', voice_id: 'v2', color: '#0f0', emoji: '🦊' },
  ]

  it('returns a positive integer', () => {
    const seed = stableImageSeed(chars, 'watercolor')
    expect(seed).toBeGreaterThan(0)
    expect(Number.isInteger(seed)).toBe(true)
  })

  it('is deterministic for same input', () => {
    expect(stableImageSeed(chars, 'watercolor')).toBe(stableImageSeed(chars, 'watercolor'))
  })

  it('is order-independent (sorts by id)', () => {
    const reversed = [...chars].reverse()
    expect(stableImageSeed(chars, 'x')).toBe(stableImageSeed(reversed, 'x'))
  })

  it('changes when style changes', () => {
    expect(stableImageSeed(chars, 'a')).not.toBe(stableImageSeed(chars, 'b'))
  })
})

describe('blobChecksum', () => {
  it('returns stable string for same data', () => {
    const scene = { image: 'data:image/png;base64,abc123', lines: [{ audio_base64: 'xyz789' }] }
    expect(blobChecksum(scene)).toBe(blobChecksum(scene))
  })

  it('changes when image changes', () => {
    const a = { image: 'aaa', lines: [] }
    const b = { image: 'bbb', lines: [] }
    expect(blobChecksum(a)).not.toBe(blobChecksum(b))
  })

  it('handles empty scene', () => {
    expect(blobChecksum({})).toBe('|')
  })
})

describe('buildStoryContext', () => {
  const makeScene = (i: number): Scene => ({
    id: `s${i}`, description: `Scene ${i}`, style: 'test',
    script: { lines: [], scene_prompt: '', sfx_description: '' },
    lines: [{ character_name: 'A', character_id: 'c1', voice_id: 'v1', text: `Line ${i}`, emotion: 'neutral' }],
    image: '',
  })

  it('returns undefined for empty array', () => {
    expect(buildStoryContext([])).toBeUndefined()
  })

  it('includes scene descriptions', () => {
    const ctx = buildStoryContext([makeScene(1)])!
    expect(ctx).toContain('Scene 1')
    expect(ctx).toContain('Line 1')
  })

  it('respects endIndex', () => {
    const scenes = [makeScene(1), makeScene(2), makeScene(3)]
    const ctx = buildStoryContext(scenes, 2)!
    expect(ctx).toContain('Scene 1')
    expect(ctx).toContain('Scene 2')
    expect(ctx).not.toContain('Scene 3')
  })

  it('caps at 4800 chars', () => {
    const longScenes = Array.from({ length: 30 }, (_, i) => ({
      ...makeScene(i),
      description: 'x'.repeat(200),
      lines: [{ character_name: 'A', character_id: 'c1', voice_id: 'v1', text: 'y'.repeat(200), emotion: 'neutral' }],
    }))
    const ctx = buildStoryContext(longScenes)!
    expect(ctx.length).toBeLessThanOrEqual(4800)
  })
})

describe('throttled', () => {
  it('runs all tasks', async () => {
    let count = 0
    const tasks = Array.from({ length: 5 }, () => async () => { count++ })
    await throttled(tasks, 2)
    expect(count).toBe(5)
  })

  it('respects concurrency limit', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const tasks = Array.from({ length: 6 }, () => async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 10))
      concurrent--
    })
    await throttled(tasks, 3)
    expect(maxConcurrent).toBeLessThanOrEqual(3)
  })

  it('calls onProgress', async () => {
    const progress: number[] = []
    const tasks = Array.from({ length: 3 }, () => async () => {})
    await throttled(tasks, 3, (done) => progress.push(done))
    expect(progress).toEqual([1, 2, 3])
  })
})

describe('lineId', () => {
  it('returns a 7-char string', () => {
    const id = lineId()
    expect(id.length).toBe(7)
  })

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, lineId))
    expect(ids.size).toBe(100)
  })
})

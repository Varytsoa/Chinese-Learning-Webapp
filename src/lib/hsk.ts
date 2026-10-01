export type HskLevel = number | '7-9'
export interface HskPart {
  word: string
  level?: HskLevel
}

export interface HskAnalysis {
  parts: HskPart[]
  complete: boolean
}

export const HSK_COLORS: Record<HskLevel, string> = {
  1: '#E8B931',
  2: '#6C8CF0',
  3: '#F08C3A',
  4: '#F06EAA',
  5: '#5CC878',
  6: '#A06CE0',
  '7-9': '#E85A5A',
}

let hskPromise: Promise<Map<string, HskLevel>> | undefined

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }
  fields.push(field)
  return fields
}

function parseLevel(value: string): HskLevel | undefined {
  const normalized = value.trim()
  if (normalized === '7-9') return normalized
  const level = Number(normalized)
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined
}

async function loadHskMap(): Promise<Map<string, HskLevel>> {
  const module = await import('../data/hsk30-expanded.csv?raw')
  const lines = module.default.split(/\r?\n/).filter(Boolean)
  const rows = lines.slice(1).map(parseCsvLine)
  const hasNewRows = rows.some((row) => row[0]?.startsWith('new-'))
  const map = new Map<string, HskLevel>()

  for (const row of rows) {
    if (hasNewRows && !row[0]?.startsWith('new-')) continue
    const word = row[1]?.trim()
    const level = parseLevel(row[5] ?? '')
    if (word && level !== undefined && !map.has(word)) map.set(word, level)
  }
  return map
}

export function getHskMap(): Promise<Map<string, HskLevel>> {
  hskPromise ??= loadHskMap()
  return hskPromise
}

export function hskRank(level: HskLevel | undefined): number {
  return level === '7-9' ? 7 : level ?? 0
}

export function highestHskLevel(levels: Array<HskLevel | undefined>): HskLevel | undefined {
  return levels.filter((level): level is HskLevel => level !== undefined)
    .sort((left, right) => hskRank(right) - hskRank(left))[0]
}

export function getHskLevelForWord(word: string, map: Map<string, HskLevel>): HskLevel | undefined {
  const direct = map.get(word)
  if (direct !== undefined) return direct
  return highestHskLevel(analyzeHskWord(word, map).parts.map((part) => part.level))
}

export function analyzeHskWord(word: string, map: Map<string, HskLevel>): HskAnalysis {
  const fullLevel = map.get(word)
  if (fullLevel !== undefined) return { parts: [{ word, level: fullLevel }], complete: true }

  const characters = [...word]
  const best: Array<HskPart[] | undefined> = Array(characters.length + 1)
  best[0] = []

  for (let position = 0; position < characters.length; position += 1) {
    if (!best[position]) continue
    for (let end = position + 1; end <= characters.length; end += 1) {
      const candidate = characters.slice(position, end).join('')
      const level = map.get(candidate)
      if (level === undefined) continue
      const parts = [...best[position]!, { word: candidate, level }]
      const current = best[end]
      if (!current || parts.length < current.length || (parts.length === current.length && parts[0].word.length > current[0].word.length)) {
        best[end] = parts
      }
    }
  }

  if (best[characters.length]) return { parts: best[characters.length]!, complete: true }

  const partial: HskPart[] = []
  let position = 0
  while (position < characters.length) {
    let match: HskPart | undefined
    for (let end = characters.length; end > position; end -= 1) {
      const candidate = characters.slice(position, end).join('')
      const level = map.get(candidate)
      if (level !== undefined) {
        match = { word: candidate, level }
        break
      }
    }
    if (match) {
      partial.push(match)
      position += match.word.length
    } else {
      partial.push({ word: characters[position] })
      position += 1
    }
  }
  return { parts: partial, complete: false }
}

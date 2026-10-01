import { pinyin } from 'pinyin-pro'
import type { DictionaryEntry } from 'cc-cedict'

type Cedict = {
  getBySimplified: (
    word: string,
    pinyin?: string | null,
    options?: { asObject?: boolean; allowVariants?: boolean },
  ) => Record<string, DictionaryEntry[]> | null
}

const deferredSenseMarkers = [
  'surname',
  'variant of',
  'old variant of',
  'archaic',
  'abbr. for',
  'see ',
  'cl:',
  'also written',
  'taiwan pr.',
]

export function isDeferredSense(sense: string): boolean {
  return deferredSenseMarkers.some((marker) => sense.toLowerCase().includes(marker))
}

let dictionaryPromise: Promise<Cedict> | undefined
let hskPinyinPromise: Promise<Map<string, string>> | undefined

function loadDictionary(): Promise<Cedict> {
  dictionaryPromise ??= import('cc-cedict').then(({ default: dictionary }) => dictionary as unknown as Cedict)
  return dictionaryPromise
}

async function loadHskPinyin(): Promise<Map<string, string>> {
  const module = await import('../data/hsk30-expanded.csv?raw')
  const lines = module.default.split(/\r?\n/).filter(Boolean)
  const map = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line)
    const word = fields[1]?.trim()
    const wordPinyin = fields[3]?.trim()
    if (word && wordPinyin && !map.has(word)) map.set(word, wordPinyin)
  }
  return map
}

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

function normalizePinyin(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[1-5]/g, '')
    .replace(/[^a-züv]+/g, '')
}

function reorderSenses(senses: string[]): string[] {
  return senses
    .map((sense, index) => ({ sense, index, deferred: isDeferredSense(sense) }))
    .sort((left, right) => Number(left.deferred) - Number(right.deferred) || left.index - right.index)
    .map(({ sense }) => sense)
}

function entryPinyin(entry: DictionaryEntry): string {
  return typeof entry.pinyin === 'string' ? entry.pinyin : ''
}

function entryIsDeferred(entry: DictionaryEntry): boolean {
  if (!entry.english.length) return false
  const deferredCount = entry.english.filter(isDeferredSense).length
  return deferredCount > entry.english.length / 2
}

function rankEntries(entries: DictionaryEntry[], hskPinyin: string | undefined, contextPinyin: string | undefined): DictionaryEntry[] {
  const normalizedHsk = hskPinyin ? normalizePinyin(hskPinyin) : ''
  const normalizedContext = contextPinyin ? normalizePinyin(contextPinyin) : ''
  return entries
    .map((entry, index) => ({
      entry,
      index,
      hskMatch: normalizedHsk !== '' && normalizePinyin(entryPinyin(entry)) === normalizedHsk,
      contextMatch: normalizedContext !== '' && normalizePinyin(entryPinyin(entry)) === normalizedContext,
      deferred: entryIsDeferred(entry),
    }))
    .sort((left, right) => Number(right.hskMatch) - Number(left.hskMatch) ||
      Number(right.contextMatch) - Number(left.contextMatch) ||
      Number(left.deferred) - Number(right.deferred) ||
      left.index - right.index)
    .map(({ entry }) => ({ ...entry, english: reorderSenses(entry.english) }))
}

function flatten(result: Record<string, DictionaryEntry[]> | null): DictionaryEntry[] {
  return result ? Object.values(result).flat() : []
}

export async function getRankedEntries(word: string, contextPinyin?: string): Promise<DictionaryEntry[]> {
  const [dictionary, hskPinyin] = await Promise.all([loadDictionary(), hskPinyinPromise ??= loadHskPinyin()])
  const entries = flatten(dictionary.getBySimplified(word, null, { asObject: true, allowVariants: true }))
  return rankEntries(entries, hskPinyin.get(word), contextPinyin)
}

export async function getPrimarySenses(word: string, contextPinyin?: string): Promise<string[]> {
  const entries = await getRankedEntries(word, contextPinyin)
  const best = entries[0]
  if (!best) return []
  return best.english.filter((sense) => !isDeferredSense(sense))
}

import { pinyin } from 'pinyin-pro'
import type { DictionaryEntry } from 'cc-cedict'
import { getHskPinyinMap } from './hsk'

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
const rankedEntriesCache = new Map<string, DictionaryEntry[]>()

function loadDictionary(): Promise<Cedict> {
  dictionaryPromise ??= import('cc-cedict').then(({ default: dictionary }) => dictionary as unknown as Cedict)
  return dictionaryPromise
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
  const cacheKey = `${word}\u0000${contextPinyin ?? ''}`
  const cached = rankedEntriesCache.get(cacheKey)
  if (cached) return cached
  const [dictionary, hskPinyin] = await Promise.all([loadDictionary(), getHskPinyinMap()])
  const entries = flatten(dictionary.getBySimplified(word, null, { asObject: true, allowVariants: true }))
  const ranked = rankEntries(entries, hskPinyin.get(word), contextPinyin)
  rankedEntriesCache.set(cacheKey, ranked)
  return ranked
}

export async function getPrimarySenses(word: string, contextPinyin?: string): Promise<string[]> {
  const entries = await getRankedEntries(word, contextPinyin)
  const best = entries[0]
  if (!best) return []
  return best.english.filter((sense) => !isDeferredSense(sense))
}

import { pinyin } from 'pinyin-pro'
import type { DictionaryEntry } from 'cc-cedict'
import { getPrimarySenses, getRankedEntries } from './dictRank'

export interface DictionaryLookup {
  hanzi: string
  pinyin: string
  definitions: string[]
  entries: DictionaryEntry[]
  found: boolean
}

const lookupCache = new Map<string, Promise<DictionaryLookup>>()

function pinyinFor(word: string): string {
  return pinyin(word, { toneType: 'symbol', type: 'string' })
}

export async function lookupWord(word: string): Promise<DictionaryLookup> {
  const cached = lookupCache.get(word)
  if (cached) return cached
  const request = lookupWordUncached(word)
  lookupCache.set(word, request)
  return request
}

async function lookupWordUncached(word: string): Promise<DictionaryLookup> {
  const fullEntries = await getRankedEntries(word, pinyinFor(word))
  const definitions = fullEntries.length
    ? (await getPrimarySenses(word, pinyinFor(word))).slice(0, 8)
    : (await Promise.all([...word].map(async (character) => getPrimarySenses(character, pinyinFor(character))))).flat().slice(0, 8)

  return {
    hanzi: word,
    pinyin: fullEntries[0]?.pinyin ?? pinyinFor(word),
    definitions,
    entries: fullEntries,
    found: fullEntries.length > 0,
  }
}

export function getPinyin(word: string): string {
  return pinyinFor(word)
}

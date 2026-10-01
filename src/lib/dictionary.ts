import { pinyin } from 'pinyin-pro'
import type { DictionaryEntry } from 'cc-cedict'

export interface DictionaryLookup {
  hanzi: string
  pinyin: string
  definitions: string[]
  found: boolean
}

type Cedict = {
  getBySimplified: (
    word: string,
    pinyin?: string | null,
    options?: { asObject?: boolean; allowVariants?: boolean },
  ) => Record<string, DictionaryEntry[]> | null
}

let cedictPromise: Promise<Cedict> | undefined

async function loadDictionary(): Promise<Cedict> {
  cedictPromise ??= import('cc-cedict').then(({ default: dictionary }) => dictionary as unknown as Cedict)
  return cedictPromise
}

function pinyinFor(word: string): string {
  return pinyin(word, { toneType: 'symbol', type: 'string' })
}

function flattenDefinitions(result: Record<string, DictionaryEntry[]> | null): DictionaryEntry[] {
  return result ? Object.values(result).flat() : []
}

export async function lookupWord(word: string): Promise<DictionaryLookup> {
  const dictionary = await loadDictionary()
  const fullEntries = flattenDefinitions(dictionary.getBySimplified(word, null, { asObject: true, allowVariants: true }))
  const entries = fullEntries.length ? fullEntries : [...word].flatMap((character) =>
        flattenDefinitions(dictionary.getBySimplified(character, null, { asObject: true, allowVariants: true })),
      )
  const definitions = [...new Set(entries.flatMap((entry) => entry.english))].slice(0, 8)

  return {
    hanzi: word,
    pinyin: pinyinFor(word),
    definitions,
    found: fullEntries.length > 0,
  }
}

export function getPinyin(word: string): string {
  return pinyinFor(word)
}

import type { VocabularyCard } from '../types'
import { getRankedEntries } from './dictRank'
import { getPinyin } from './dictionary'
import { getShortMeaning } from './shortMeaning'
import { getHskLevelForWord, getHskMap, type HskLevel } from './hsk'

export interface ResolvedCardData {
  meaning: string
  pinyin: string
  hskLevel?: HskLevel
}

export async function resolveCardData(vocabEntry: VocabularyCard, flashcard?: VocabularyCard): Promise<ResolvedCardData> {
  const hanzi = (vocabEntry.hanzi ?? vocabEntry.front).trim()
  const rankedEntries = await getRankedEntries(hanzi, vocabEntry.pinyin)
  const hskMap = await getHskMap()
  const meaning = flashcard?.shortMeaning?.trim()
    || (vocabEntry.meaning ? await getShortMeaning(hanzi, [vocabEntry.meaning]) : '')
    || await getShortMeaning(hanzi)
    || 'No meaning available'
  const pinyin = vocabEntry.pinyin?.trim() || rankedEntries[0]?.pinyin?.trim() || getPinyin(hanzi)
  const hskLevel = vocabEntry.hskLevel ?? getHskLevelForWord(hanzi, hskMap)
  return { meaning, pinyin, hskLevel }
}

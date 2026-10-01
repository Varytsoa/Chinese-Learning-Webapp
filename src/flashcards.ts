import { makeId, storage } from './storage'
import type { VocabularyCard } from './types'

export async function generateFlashcards(entry: VocabularyCard): Promise<VocabularyCard[]> {
  const hanzi = entry.hanzi?.trim() || entry.front.trim()
  const pinyin = entry.pinyin?.trim() || ''
  const meaning = entry.meaning?.trim() || entry.back.trim()
  const answerWithPinyin = [pinyin, meaning].filter(Boolean).join(' · ')
  const answerWithHanzi = [hanzi, pinyin].filter(Boolean).join(' · ')
  const now = Date.now()
  const base = {
    textId: entry.textId,
    vocabularyEntryId: entry.id,
    note: entry.note,
    listIds: entry.listIds,
    dueDate: now,
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    createdAt: now,
  }

  const candidates: VocabularyCard[] = [
    {
      ...base,
      id: makeId(),
      cardType: 'recognition',
      front: hanzi,
      back: answerWithPinyin,
    },
    {
      ...base,
      id: makeId(),
      cardType: 'recall',
      front: meaning,
      back: answerWithHanzi,
    },
  ]
  const existing = await Promise.all(
    candidates.map((card) => storage.findFlashcardDuplicate(entry.id, card.cardType!)),
  )
  return candidates.filter((_, index) => !existing[index])
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

export interface TextRecord {
  id: string
  title: string
  content: string
  createdAt: number
  translations?: Record<string, string>
}

export interface VocabularyCard {
  id: string
  textId: string
  vocabularyEntryId?: string
  cardType?: 'recognition' | 'recall'
  front: string
  back: string
  note: string
  hanzi?: string
  pinyin?: string
  meaning?: string
  hskLevel?: number | '7-9'
  inStudyList?: boolean
  listIds: string[]
  dueDate: number
  intervalDays: number
  ease: number
  reps: number
  lapses: number
  lastReviewedAt?: number
  createdAt: number
}

export interface StudyList {
  id: string
  name: string
  createdAt: number
}

export interface ReviewLog {
  id: string
  cardId: string
  rating: ReviewRating
  reviewedAt: number
}

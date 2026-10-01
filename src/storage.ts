import type { ReviewLog, StudyList, TextRecord, VocabularyCard } from './types'

const DB_NAME = 'hanzi-study'
const DB_VERSION = 1
const STORES = ['texts', 'cards', 'lists', 'reviewLogs'] as const

type StoreName = (typeof STORES)[number]

export interface AppDataExport {
  version: 1
  exportedAt: string
  texts: TextRecord[]
  vocabulary: VocabularyCard[]
  flashcards: VocabularyCard[]
  lists: StudyList[]
  reviewLogs: ReviewLog[]
}

export type ImportMode = 'merge' | 'replace'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store, { keyPath: 'id' })
        }
      }
    }
  })
}

async function request<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const databaseRequest = operation(transaction.objectStore(storeName))
    databaseRequest.onsuccess = () => resolve(databaseRequest.result)
    databaseRequest.onerror = () => reject(databaseRequest.error)
    transaction.onabort = () => reject(transaction.error)
  }).finally(() => database.close())
}

async function getAll<T>(storeName: StoreName): Promise<T[]> {
  return request<T[]>(storeName, 'readonly', (store) => store.getAll())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEntity(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
}

export function parseAppDataExport(json: string): AppDataExport {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('Import file is not valid JSON.')
  }

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.texts) ||
    !Array.isArray(value.vocabulary) ||
    !Array.isArray(value.flashcards) ||
    !Array.isArray(value.lists) ||
    !Array.isArray(value.reviewLogs) ||
    !value.texts.every(isEntity) ||
    !value.vocabulary.every(isEntity) ||
    !value.flashcards.every(isEntity) ||
    !value.lists.every(isEntity) ||
    !value.reviewLogs.every(isEntity)
  ) {
    throw new Error('Import file has an unsupported data shape.')
  }

  return value as unknown as AppDataExport
}

export const storage = {
  getTexts: () => getAll<TextRecord>('texts'),
  saveText: (text: TextRecord) => request('texts', 'readwrite', (store) => store.put(text)),
  deleteText: (id: string) => request('texts', 'readwrite', (store) => store.delete(id)),
  getCards: () => getAll<VocabularyCard>('cards'),
  saveCard: async (card: VocabularyCard, allowDuplicate = false) => {
    if (!allowDuplicate && !card.vocabularyEntryId) {
      const existing = await storage.findVocabularyDuplicate(card.hanzi ?? card.front, card.textId, card.id)
      if (existing) throw new DOMException('Duplicate vocabulary entry', 'ConstraintError')
    }
    if (!allowDuplicate && card.vocabularyEntryId && card.cardType) {
      const existing = await storage.findFlashcardDuplicate(card.vocabularyEntryId, card.cardType, card.id)
      if (existing) throw new DOMException('Duplicate flashcard', 'ConstraintError')
    }
    return request('cards', 'readwrite', (store) => store.put(card))
  },
  findVocabularyDuplicate: async (hanzi: string, textId: string, excludeId?: string) => {
    const normalized = hanzi.trim().toLowerCase()
    const cards = await getAll<VocabularyCard>('cards')
    return cards.find((card) =>
      !card.vocabularyEntryId &&
      card.textId === textId &&
      (card.hanzi ?? card.front).trim().toLowerCase() === normalized &&
      card.id !== excludeId,
    )
  },
  findFlashcardDuplicate: async (vocabularyEntryId: string, cardType: NonNullable<VocabularyCard['cardType']>, excludeId?: string) => {
    const cards = await getAll<VocabularyCard>('cards')
    return cards.find((card) =>
      card.vocabularyEntryId === vocabularyEntryId &&
      card.cardType === cardType &&
      card.id !== excludeId,
    )
  },
  addCardToList: async (cardId: string, listId: string) => {
    const card = await storage.getCard(cardId)
    if (!card || card.vocabularyEntryId) return
    if (card.listIds.includes(listId)) return
    await storage.saveCard({ ...card, listIds: [...card.listIds, listId] })
  },
  removeCardFromList: async (cardId: string, listId: string) => {
    const card = await storage.getCard(cardId)
    if (!card || card.vocabularyEntryId) return
    await storage.saveCard({ ...card, listIds: card.listIds.filter((id) => id !== listId) })
  },
  getCard: (id: string) => request<VocabularyCard | undefined>('cards', 'readonly', (store) => store.get(id)),
  getLists: () => getAll<StudyList>('lists'),
  getReviewLogs: () => getAll<ReviewLog>('reviewLogs'),
  saveList: (list: StudyList) => request('lists', 'readwrite', (store) => store.put(list)),
  deleteList: (id: string) => request('lists', 'readwrite', (store) => store.delete(id)),
  saveReviewLog: (log: ReviewLog) => request('reviewLogs', 'readwrite', (store) => store.put(log)),
  exportData: async (): Promise<AppDataExport> => {
    const [texts, cards, lists, reviewLogs] = await Promise.all([
      getAll<TextRecord>('texts'),
      getAll<VocabularyCard>('cards'),
      getAll<StudyList>('lists'),
      getAll<ReviewLog>('reviewLogs'),
    ])

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      texts,
      vocabulary: cards.filter((card) => !card.vocabularyEntryId),
      flashcards: cards.filter((card) => Boolean(card.vocabularyEntryId)),
      lists,
      reviewLogs,
    }
  },
  importData: async (data: AppDataExport, mode: ImportMode): Promise<void> => {
    const database = await openDatabase()
    const transaction = database.transaction([...STORES], 'readwrite')

    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => {
        database.close()
        reject(transaction.error)
      }
      transaction.onabort = () => {
        database.close()
        reject(transaction.error)
      }

      const stores = Object.fromEntries(
        STORES.map((storeName) => [storeName, transaction.objectStore(storeName)]),
      ) as Record<StoreName, IDBObjectStore>

      if (mode === 'replace') {
        STORES.forEach((storeName) => stores[storeName].clear())
      }

      data.texts.forEach((text) => stores.texts.put(text))
      data.vocabulary.forEach((entry) => stores.cards.put(entry))
      data.flashcards.forEach((flashcard) => stores.cards.put(flashcard))
      data.lists.forEach((list) => stores.lists.put(list))
      data.reviewLogs.forEach((log) => stores.reviewLogs.put(log))
    })
  },
}

export function makeId(): string {
  return crypto.randomUUID()
}

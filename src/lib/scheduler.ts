import type { ReviewRating, VocabularyCard } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

export function isDue(card: VocabularyCard, now = Date.now()): boolean {
  return card.dueDate <= now
}

export function scheduleCard(
  card: VocabularyCard,
  rating: ReviewRating,
  now = Date.now(),
): VocabularyCard {
  const previousInterval = Math.max(0, card.intervalDays)
  let intervalDays: number
  let reps = card.reps
  let lapses = card.lapses
  let ease = card.ease

  if (rating === 'again') {
    intervalDays = 0
    reps = Math.max(0, reps - 1)
    lapses += 1
    ease = Math.max(1.3, ease - 0.2)
  } else {
    reps += 1
    const startingInterval = Math.max(1, previousInterval)
    const multiplier = rating === 'hard' ? 1.2 : rating === 'good' ? 2 : 3.2
    intervalDays = Math.max(1, Math.round(startingInterval * multiplier))
    ease = Math.max(1.3, ease + (rating === 'hard' ? -0.05 : rating === 'easy' ? 0.1 : 0))
  }

  return {
    ...card,
    dueDate: now + (intervalDays === 0 ? 10 * 60 * 1000 : intervalDays * DAY_MS),
    intervalDays,
    ease,
    reps,
    lapses,
    lastReviewedAt: now,
  }
}

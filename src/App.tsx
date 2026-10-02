import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { makeId, storage } from './storage'
import { parseAppDataExport, type ImportMode } from './storage'
import { isDue, scheduleCard } from './lib/scheduler'
import { generateFlashcards } from './flashcards'
import { getPinyin, lookupWord, type DictionaryLookup } from './lib/dictionary'
import { getShortMeaning } from './lib/shortMeaning'
import { resolveCardData } from './lib/cardData'
import { analyzeHskWord, getHskLevelForWord, getHskMap, hskRank, HSK_COLORS, type HskLevel } from './lib/hsk'
import { isDeferredSense } from './lib/dictRank'
import type { ReviewLog, ReviewRating, StudyList, TextRecord, VocabularyCard } from './types'

type Section = 'dashboard' | 'reader' | 'saved' | 'study' | 'review' | 'settings'
type Theme = 'light' | 'dark' | 'system'
type CardDirection = 'chinese-to-english' | 'english-to-chinese' | 'mixed'
interface ReadingHistoryEntry { id: string; title: string; content: string; readAt: number; savedId?: string; hskLevel?: HskLevel; wordCount?: number; preview?: string }
interface OpenText { id: string; title: string; content: string; saved: boolean; origin: 'reader' | 'saved' }
const MASTERED_INTERVAL_DAYS = 21
const NEAR_MASTERED_INTERVAL_DAYS = 7
const RECENT_LAPSE_DAYS = 14
type SegmenterLike = { segment: (value: string) => Iterable<{ segment: string; isWordLike?: boolean }> }
const segmenter: SegmenterLike | undefined = (() => {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity?: 'word' }) => SegmenterLike }).Segmenter
  return Segmenter ? new Segmenter('zh-Hans', { granularity: 'word' }) : undefined
})()
const pinyinCache = new Map<string, string>()
function getCachedPinyin(word: string): string {
  const cached = pinyinCache.get(word)
  if (cached) return cached
  const value = getPinyin(word)
  pinyinCache.set(word, value)
  return value
}

const emptyCard = (textId: string): VocabularyCard => ({
  id: makeId(), textId, front: '', back: '', note: '', listIds: [], dueDate: Date.now(),
  intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, createdAt: Date.now(),
})

async function runBackgroundBackfill(): Promise<void> {
  if (localStorage.getItem('hanzi-study-card-data-backfill-v1') === 'done') return
  const cards = await storage.getCards()
  const vocabulary = useMemo(() => cards.filter((card) => !card.vocabularyEntryId), [cards])
  for (let start = 0; start < vocabulary.length; start += 50) {
    for (const entry of vocabulary.slice(start, start + 50)) {
      const linked = cards.find((card) => card.vocabularyEntryId === entry.id)
      const resolved = await resolveCardData(entry, linked)
      const updatedEntry = { ...entry }
      if (!entry.meaning?.trim() && resolved.meaning !== 'No meaning available') updatedEntry.meaning = resolved.meaning
      if (!entry.pinyin?.trim() && resolved.pinyin) updatedEntry.pinyin = resolved.pinyin
      if (entry.hskLevel === undefined && resolved.hskLevel !== undefined) updatedEntry.hskLevel = resolved.hskLevel
      if (updatedEntry.meaning !== entry.meaning || updatedEntry.pinyin !== entry.pinyin || updatedEntry.hskLevel !== entry.hskLevel) await storage.saveCard(updatedEntry, true)
      for (const flashcard of cards.filter((card) => card.vocabularyEntryId === entry.id)) {
        if (!flashcard.shortMeaning && resolved.meaning !== 'No meaning available') await storage.saveCard({ ...flashcard, shortMeaning: resolved.meaning }, true)
      }

    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }
  localStorage.setItem('hanzi-study-card-data-backfill-v1', 'done')
}

export function App() {
  const [section, setSection] = useState<Section>('dashboard')
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('hanzi-study-theme') as Theme | null) ?? 'system')
  const [cardDirection, setCardDirection] = useState<CardDirection>(() => (localStorage.getItem('hanzi-study-card-direction') as CardDirection | null) ?? 'mixed')
  const [openText, setOpenText] = useState<OpenText | null>(null)
  const [history, setHistory] = useState<ReadingHistoryEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem('hanzi-study-history') ?? '[]') as ReadingHistoryEntry[] } catch { return [] }
  })
  const [texts, setTexts] = useState<TextRecord[]>([])
  const [cards, setCards] = useState<VocabularyCard[]>([])
  const [lists, setLists] = useState<StudyList[]>([])
  const [reviewLogs, setReviewLogs] = useState<ReviewLog[]>([])
  const [selectedListId, setSelectedListId] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [hskMap, setHskMap] = useState<Map<string, HskLevel>>(new Map())

  const refresh = async () => {
    const [nextTexts, nextCards, nextLists, nextLogs] = await Promise.all([storage.getTexts(), storage.getCards(), storage.getLists(), storage.getReviewLogs()])
    const textMap = hskMap.size ? hskMap : await getHskMap()
    const enrichedTexts = await Promise.all(nextTexts.map(async (text) => {
      if (text.hskLevel !== undefined && text.wordCount !== undefined) return text
      const stats = getTextStats(text.content, textMap)
      const enriched = { ...text, hskLevel: text.hskLevel ?? stats.hskLevel, wordCount: text.wordCount ?? stats.wordCount }
      await storage.saveText(enriched)
      return enriched
    }))
    setTexts(enrichedTexts.sort((a, b) => b.createdAt - a.createdAt))
    setCards(nextCards)
    setLists(nextLists.sort((a, b) => a.createdAt - b.createdAt))
    setReviewLogs(nextLogs)
  }
  useEffect(() => {
    let active = true
    void Promise.all([refresh(), getHskMap()]).then(([, map]) => {
      if (active) {
        setHskMap(map)
        window.setTimeout(() => { void runBackgroundBackfill() }, 0)
      }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('hanzi-study-theme', theme)
  }, [theme])
  const navigate = (nextSection: Section) => {
    setSection(nextSection)
    setOpenText(null)
  }
  const openReader = (next: Omit<OpenText, 'origin'> | null, origin: OpenText['origin']) => {
    if (!next) { setOpenText(null); return }
    setSection(origin)
    setOpenText({ ...next, origin })
    const stats = getTextStats(next.content, hskMap)
    const entry: ReadingHistoryEntry = { id: next.id || makeId(), title: next.title || 'Untitled text', content: next.content, readAt: Date.now(), savedId: next.saved ? next.id : undefined, hskLevel: stats.hskLevel, wordCount: stats.wordCount, preview: next.content.split(/\r?\n/)[0] ?? '' }
    const nextHistory = [entry, ...history.filter((item) => item.id !== entry.id)].slice(0, 30)
    setHistory(nextHistory)
    localStorage.setItem('hanzi-study-history', JSON.stringify(nextHistory))
  }
  const saveReaderText = async () => {
    if (!openText || openText.saved) return
    const firstWords = openText.content.trim().slice(0, 24)
    const title = window.prompt('Title for this text:', firstWords)
    if (!title?.trim()) return
    const id = makeId()
    const stats = getTextStats(openText.content, hskMap)
    await storage.saveText({ id, title: title.trim(), content: openText.content, createdAt: Date.now(), hskLevel: stats.hskLevel, wordCount: stats.wordCount })
    setOpenText({ ...openText, id, title: title.trim(), saved: true })
    const nextHistory = history.map((item) => item.id === openText.id ? { ...item, id, title: title.trim(), savedId: id } : item)
    setHistory(nextHistory)
    localStorage.setItem('hanzi-study-history', JSON.stringify(nextHistory))
    await refresh()
  }

  const dueCards = useMemo(() => cards.filter((card) => isDue(card) && (selectedListId === 'all' || card.listIds.includes(selectedListId))), [cards, selectedListId])
  if (loading) return <main className="loading">Loading your study space…</main>

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><p className="eyebrow">PERSONAL STUDY SPACE</p><h1>Hanzi Study</h1></div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {(['dashboard', 'reader', 'saved', 'study', 'review', 'settings'] as Section[]).map((item) => <button key={item} className={section === item ? 'nav-button active' : 'nav-button'} onClick={() => navigate(item)}>{item === 'dashboard' ? 'Dashboard' : item === 'reader' ? 'Reader' : item === 'saved' ? 'Saved Texts' : item === 'study' ? 'Study List' : item === 'review' ? `Review${dueCards.length ? ` (${dueCards.length})` : ''}` : 'Settings'}</button>)}
        </nav>
        <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle light and dark theme">{theme === 'dark' ? '☀' : '☾'} <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button>
      </aside>
      <main className="content">
        {section === 'dashboard' && <DashboardPage texts={texts} cards={cards} reviewLogs={reviewLogs} dueCount={dueCards.length} hskMap={hskMap} onNavigate={navigate} onOpenSavedText={(text) => openReader({ ...text, saved: true }, 'saved')} />}
        {section === 'reader' && <ReaderPage texts={texts} cards={cards} lists={lists} hskMap={hskMap} onRefresh={refresh} openText={openText?.origin === 'reader' ? openText : null} history={history} onOpenReader={(text) => openReader(text, 'reader')} onBack={() => setOpenText(null)} onSaveReader={saveReaderText} onSetHistory={setHistory} />}
        {section === 'saved' && <SavedTextsPage texts={texts} cards={cards} lists={lists} hskMap={hskMap} onRefresh={refresh} openText={openText?.origin === 'saved' ? openText : null} onOpenReader={(text) => openReader(text, 'saved')} onBack={() => setOpenText(null)} onSaveReader={saveReaderText} onGoToReader={() => navigate('reader')} />}
        {section === 'study' && <StudyPage texts={texts} cards={cards} lists={lists} onRefresh={refresh} onReviewNow={() => navigate('review')} />}
        {section === 'review' && <ReviewPage cards={dueCards} allCards={cards} lists={lists} texts={texts} onRefresh={refresh} cardDirection={cardDirection} />}
        {section === 'settings' && <SettingsPage onRefresh={refresh} theme={theme} onThemeChange={setTheme} cardDirection={cardDirection} onCardDirectionChange={(direction) => { setCardDirection(direction); localStorage.setItem('hanzi-study-card-direction', direction) }} />}
      </main>
    </div>
  )
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function getTextStats(content: string, hskMap: Map<string, HskLevel>): { hskLevel?: HskLevel; wordCount: number } {
  const words = segmentChineseText(content).filter((segment) => segment.isWordLike)
  const levels = words.map((word) => getHskLevelForWord(word.text, hskMap)).filter((level): level is HskLevel => level !== undefined)
  return { hskLevel: levels.sort((left, right) => hskRank(right) - hskRank(left))[0], wordCount: words.length }
}

function wordStatus(entry: VocabularyCard, cards: VocabularyCard[]): 'known' | 'learning' | 'new' {
  const linked = cards.filter((card) => card.vocabularyEntryId === entry.id)
  if (!linked.length || linked.every((card) => card.reps === 0)) return 'new'
  if (linked.some((card) => card.lapses > 0 && card.lastReviewedAt && Date.now() - card.lastReviewedAt < 14 * 86400000 || card.intervalDays < 7)) return 'learning'
  return linked.every((card) => card.intervalDays >= 21) ? 'known' : 'learning'
}

function DashboardPage({ texts, cards, reviewLogs, dueCount, hskMap, onNavigate, onOpenSavedText }: { texts: TextRecord[]; cards: VocabularyCard[]; reviewLogs: ReviewLog[]; dueCount: number; hskMap: Map<string, HskLevel>; onNavigate: (section: Section) => void; onOpenSavedText: (text: TextRecord) => void }) {
  const [recentCardData, setRecentCardData] = useState<Record<string, Awaited<ReturnType<typeof resolveCardData>>>>({})
  const vocabulary = cards.filter((card) => !card.vocabularyEntryId)
  const today = dayKey(Date.now())
  const reviewedToday = reviewLogs.filter((log) => dayKey(log.reviewedAt) === today)
  const recentWords = useMemo(() => [...vocabulary].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6), [vocabulary])
  const streak = (() => {
    const days = new Set(reviewLogs.map((log) => dayKey(log.reviewedAt)))
    let cursor = new Date()
    let count = 0
    while (days.has(dayKey(cursor.getTime()))) { count += 1; cursor.setDate(cursor.getDate() - 1) }
    return count
  })()
  useEffect(() => {
    let active = true
    void Promise.all(recentWords.map(async (entry) => [entry.id, await resolveCardData(entry)] as const)).then((results) => {
      if (active) setRecentCardData(Object.fromEntries(results))
    })
    return () => { active = false }
  }, [recentWords])
  const hskRows = useMemo(() => ([1, 2, 3, 4, 5, 6, '7-9'] as HskLevel[]).map((level) => {
    const total = [...hskMap.values()].filter((item) => item === level).length
    const entries = vocabulary.filter((entry) => getHskLevelForWord(entry.hanzi ?? entry.front, hskMap) === level)
    const known = entries.filter((entry) => wordStatus(entry, cards) === 'known').length
    return { level, total, studied: entries.length, known }
  }), [vocabulary, cards, hskMap])
  const statuses = useMemo(() => vocabulary.reduce((result, entry) => { const status = wordStatus(entry, cards); result[status] += 1; return result }, { new: 0, learning: 0, known: 0 }), [vocabulary, cards])
  const chars = useMemo(() => new Set(vocabulary.flatMap((entry) => [...(entry.hanzi ?? entry.front)])), [vocabulary])
  const knownChars = useMemo(() => new Set(vocabulary.filter((entry) => wordStatus(entry, cards) === 'known').flatMap((entry) => [...(entry.hanzi ?? entry.front)])), [vocabulary, cards])
  const reviewCounts = useMemo(() => {
    const counts = new Map<string, number>()
    reviewLogs.forEach((log) => counts.set(dayKey(log.reviewedAt), (counts.get(dayKey(log.reviewedAt)) ?? 0) + 1))
    return counts
  }, [reviewLogs])
  const currentMonday = new Date()
  currentMonday.setHours(0, 0, 0, 0)
  currentMonday.setDate(currentMonday.getDate() - ((currentMonday.getDay() + 6) % 7))
  const activityWeeks = Array.from({ length: 26 }, (_, weekIndex) => Array.from({ length: 7 }, (_, dayIndex) => {
    const date = new Date(currentMonday)
    date.setDate(date.getDate() - (25 - weekIndex) * 7 + dayIndex)
    return date
  }))
  const monthLabels = activityWeeks.map((week, index) => {
    const monthStart = week.find((date) => date.getDate() === 1)
    return monthStart ? { index, label: monthStart.toLocaleDateString(undefined, { month: 'short' }) } : null
  })
  const toughest = [...vocabulary].sort((a, b) => {
    const lapses = (entry: VocabularyCard) => cards.filter((card) => card.vocabularyEntryId === entry.id).reduce((sum, card) => sum + card.lapses, 0)
    return lapses(b) - lapses(a)
  }).slice(0, 3)
  const hskBadge = (word: string) => { const level = getHskLevelForWord(word, hskMap); return level ? `HSK ${level}` : 'Not in HSK' }
  const textStats = useMemo(() => new Map(texts.map((text) => {
    const computed = text.hskLevel === undefined || text.wordCount === undefined ? getTextStats(text.content, hskMap) : undefined
    return [text.id, { hskLevel: text.hskLevel ?? computed?.hskLevel, wordCount: text.wordCount ?? computed?.wordCount ?? 0 }] as const
  })), [texts, hskMap])
  const hardestTextLevel = (content: string) => {
    const levels = segmentChineseText(content).filter((segment) => segment.isWordLike).map((segment) => getHskLevelForWord(segment.text, hskMap))
    return levels.filter((level): level is HskLevel => level !== undefined).sort((a, b) => hskRank(b) - hskRank(a))[0]
  }
  const empty = (message: string, section: Section) => <div className="dashboard-empty"><span>{message}</span><button className="quiet" onClick={() => onNavigate(section)}>Get started</button></div>
  return <section className="dashboard-page">
    <SectionHeading title="Dashboard" description="Your local Chinese study space at a glance." />
    <div className="dashboard-columns">
      <div className="dashboard-main">
        <article className="dashboard-panel dashboard-full-width due-panel"><p className="dashboard-title">DUE FOR REVIEW</p><strong className="due-number">{dueCount}</strong><span className="muted">cards waiting</span><button className="primary" onClick={() => onNavigate('review')}>Flashcards</button></article>
        <div className="stat-tiles"><div className="dashboard-panel stat-tile"><strong>{streak}</strong><span className="muted">day streak</span></div><div className="dashboard-panel stat-tile"><strong>{reviewedToday.length}</strong><span className="muted">reviewed today</span></div><div className="dashboard-panel stat-tile"><strong>{reviewedToday.filter((log) => log.rating === 'good' || log.rating === 'easy').length}</strong><span className="muted">promoted today</span></div></div>
        <article className="dashboard-panel"><div className="dashboard-panel-heading"><p className="dashboard-title">RECENTLY ADDED TO STUDY LIST</p><button className="link-button" onClick={() => onNavigate('study')}>View all →</button></div>{recentWords.length ? <div className="mini-card-grid">{recentWords.map((entry) => { const word = entry.hanzi ?? entry.front; const data = recentCardData[entry.id]; const level = data?.hskLevel ?? getHskLevelForWord(word, hskMap); return <div className="mini-word-card" key={entry.id}><strong style={{ color: level ? HSK_COLORS[level] : undefined }}>{word}</strong><span className="tag recent-hsk-badge">{level ? `HSK ${level}` : 'Not in HSK'}</span><span className="word-pinyin">{data?.pinyin ?? entry.pinyin ?? ''}</span><span className="muted small recent-meaning">{data?.meaning ?? 'No meaning available'}</span></div> })}</div> : empty('No vocabulary added yet.', 'study')}</article>
        <article className="dashboard-panel"><div className="dashboard-panel-heading"><p className="dashboard-title">RECENTLY SAVED TEXTS</p><button className="link-button" onClick={() => onNavigate('saved')}>View all →</button></div>{texts.length ? <div className="saved-text-list">{texts.slice(0, 3).map((text) => { const stats = textStats.get(text.id); return <div className="saved-text-row" key={text.id} onClick={() => onOpenSavedText(text)}><strong>{text.title}</strong><span className="muted small">{new Date(text.createdAt).toLocaleDateString()}</span><span className="tag hsk-badge">{stats?.hskLevel ? `HSK ${stats.hskLevel}` : 'Not in HSK'}</span></div> })}</div> : empty('Save a text to see it here.', 'reader')}</article>
      </div>
      <div className="dashboard-side">
        <article className="dashboard-panel dashboard-full-width"><div className="dashboard-panel-heading"><p className="dashboard-title">STUDY ACTIVITY</p><span className="muted small">{reviewLogs.length} reviews · {new Set(reviewLogs.map((log) => dayKey(log.reviewedAt))).size} days</span></div><div className="heatmap-months">{monthLabels.map((month) => month && <span key={month.index} style={{ gridColumn: month.index + 1 }}>{month.label}</span>)}</div><div className="heatmap-layout"><div className="heatmap-weekdays"><span>Mon</span><span>Wed</span><span>Fri</span></div><div className="heatmap">{activityWeeks.map((week, weekIndex) => <div className="heatmap-week" key={weekIndex}>{week.map((date) => { const count = reviewCounts.get(dayKey(date.getTime())) ?? 0; return <span className={`heatmap-cell heatmap-level-${Math.min(4, count)}`} key={date.toISOString()} title={`${date.toLocaleDateString()}: ${count} reviews`} /> })}</div>)}</div></div><div className="heatmap-legend"><span>Less</span><i /><i /><i /><i /><span>More</span></div></article>
        <article className="dashboard-panel dashboard-full-width"><p className="dashboard-title">HSK PROGRESS</p><div className="hsk-progress-list">{hskRows.map((row) => <div className="hsk-progress-row" key={String(row.level)}><div><strong>HSK {row.level}</strong><span className="muted small">{row.studied} / {row.total || 0} · {row.total ? Math.round(row.studied / row.total * 100) : 0}%</span></div><div className="progress-track"><span style={{ width: `${row.total ? row.studied / row.total * 100 : 0}%` }} /><b style={{ width: `${row.total ? row.known / row.total * 100 : 0}%` }} /></div></div>)}</div></article>
      </div>
    </div>
    <div className="dashboard-columns">
      <article className="dashboard-panel"><p className="dashboard-title">VOCABULARY</p><div className="large-stats"><span><strong>{statuses.learning + statuses.new}</strong><small>studying</small></span><span><strong className="green">{statuses.known}</strong><small>known</small></span><span><strong>{hskRows.reduce((sum, row) => sum + row.studied, 0) && hskMap.size ? ((hskRows.reduce((sum, row) => sum + row.studied, 0) / hskMap.size) * 100).toFixed(2) : '0.00'}%</strong><small>of dictionary</small></span></div></article>
      <article className="dashboard-panel"><p className="dashboard-title">STUDY LIST PROGRESS</p><div className="progress-tiles"><span className="red"><strong>{statuses.new}</strong><small>New or struggling</small></span><span className="orange"><strong>{statuses.learning}</strong><small>Learning</small></span><span className="green-bg"><strong>{statuses.known}</strong><small>Near mastered</small></span></div></article>
    </div>
    <div className="dashboard-columns">
      <article className="dashboard-panel"><p className="dashboard-title">UNIQUE CHARACTERS</p><div className="large-stats"><span><strong className="green">{knownChars.size}</strong><small>known</small></span><span><strong>{chars.size - knownChars.size}</strong><small>studying</small></span><span><strong>{chars.size}</strong><small>total</small></span></div>{!knownChars.size && empty('Mark words as known through review.', 'review')}</article>
      <article className="dashboard-panel"><p className="dashboard-title">YOUR TOUGHEST WORDS</p>{toughest.length ? <div className="toughest-grid">{toughest.map((entry) => <div className="mini-word-card" key={entry.id}><strong>{entry.hanzi ?? entry.front}</strong><span className="tag">{hskBadge(entry.hanzi ?? entry.front)}</span><span className="word-pinyin">{entry.pinyin}</span><span className="muted small">{entry.meaning ?? entry.back}</span><b className="lapse-count">{cards.filter((card) => card.vocabularyEntryId === entry.id).reduce((sum, card) => sum + card.lapses, 0)} lapses</b></div>)}</div> : empty('Review cards to find your toughest words.', 'review')}</article>
    </div>
  </section>
}

function SettingsPage({ onRefresh, theme, onThemeChange, cardDirection, onCardDirectionChange }: { onRefresh: () => Promise<void>; theme: Theme; onThemeChange: (theme: Theme) => void; cardDirection: CardDirection; onCardDirectionChange: (direction: CardDirection) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const exportData = async () => {
    const data = await storage.exportData()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `hanzi-study-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setStatus({ type: 'success', message: 'Your study data was exported.' })
  }

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const data = parseAppDataExport(await file.text())
      if (mode === 'replace' && !window.confirm('Replace all local data with this import?')) return
      await storage.importData(data, mode)
      await onRefresh()
      setStatus({ type: 'success', message: mode === 'merge' ? 'Data merged successfully.' : 'Local data replaced successfully.' })
    } catch (error) {
      setStatus({ type: 'error', message: error instanceof Error ? error.message : 'Import failed.' })
    }
  }

  return <section>
    <SectionHeading title="Settings" description="Keep a portable backup of your local study space." />
    <div className="settings-grid">
      <div className="panel settings-card">
        <p className="eyebrow">THEME</p>
        <h2>Appearance</h2>
        <p className="muted">Choose how Hanzi Study looks on this device.</p>
        <select value={theme} onChange={(event) => onThemeChange(event.target.value as Theme)} aria-label="Theme">
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </div>
      <div className="panel settings-card card-direction-settings">
        <p className="eyebrow">REVIEW</p>
        <h2>Card direction</h2>
        <p className="muted">Choose which side of a card appears first during review.</p>
        <div className="direction-options">
          {([
            ['chinese-to-english', 'Chinese → English', 'See the character, recall the meaning'],
            ['english-to-chinese', 'English → Chinese', 'See the meaning, recall the character'],
            ['mixed', 'Mixed', 'Random direction per card'],
          ] as Array<[CardDirection, string, string]>).map(([value, title, description]) => <button key={value} type="button" className={`direction-option${cardDirection === value ? ' selected' : ''}`} onClick={() => onCardDirectionChange(value)} aria-pressed={cardDirection === value}><strong>{title}</strong><span>{description}</span></button>)}
        </div>
      </div>
      <div className="panel settings-card">
        <p className="eyebrow">EXPORT</p>
        <h2>Download your data</h2>
        <p className="muted">Export texts, vocabulary, flashcards, custom lists, and review logs as one JSON file.</p>
        <button className="primary" onClick={exportData}>Export JSON</button>
      </div>
      <div className="panel settings-card">
        <p className="eyebrow">IMPORT</p>
        <h2>Restore or merge data</h2>
        <p className="muted">Imports are validated before writing to IndexedDB. Merge keeps existing records; replace clears local data first.</p>
        <select value={mode} onChange={(event) => setMode(event.target.value as ImportMode)} aria-label="Import mode">
          <option value="merge">Merge with existing data</option>
          <option value="replace">Replace all local data</option>
        </select>
        <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={importData} />
        <button className="primary" onClick={() => fileInputRef.current?.click()}>Choose JSON file</button>
      </div>
    </div>
    {status && <p className={`settings-status ${status.type}`}>{status.message}</p>}
  </section>
}

function ReaderPage({ texts, cards, lists, hskMap, onRefresh, openText, history, onOpenReader, onBack, onSaveReader, onSetHistory }: { texts: TextRecord[]; cards: VocabularyCard[]; lists: StudyList[]; hskMap: Map<string, HskLevel>; onRefresh: () => Promise<void>; openText: OpenText | null; history: ReadingHistoryEntry[]; onOpenReader: (text: Omit<OpenText, 'origin'>) => void; onBack: () => void; onSaveReader: () => Promise<void>; onSetHistory: (history: ReadingHistoryEntry[]) => void }) {
  const [content, setContent] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.name.toLowerCase().endsWith('.epub')) {
      window.alert('EPUB import is not available in this local reader yet. Paste the text instead.')
      return
    }
    setContent(await file.text())
  }
  const read = () => { if (content.trim()) onOpenReader({ id: '', title: 'Untitled text', content: content.trim(), saved: false }) }
  const removeHistory = (id: string) => {
    const next = history.filter((item) => item.id !== id)
    onSetHistory(next)
    localStorage.setItem('hanzi-study-history', JSON.stringify(next))
  }
  useEffect(() => {
    const missing = history.filter((item) => item.wordCount === undefined || item.preview === undefined)
    if (!missing.length) return
    let cancelled = false
    const process = () => {
      if (cancelled) return
      const batch = missing.slice(0, 3)
      const updates = new Map(batch.map((item) => {
        const stats = getTextStats(item.content, hskMap)
        return [item.id, { ...item, hskLevel: item.hskLevel ?? stats.hskLevel, wordCount: item.wordCount ?? stats.wordCount, preview: item.preview ?? item.content.split(/\r?\n/)[0] ?? '' }]
      }))
      const next = history.map((item) => updates.get(item.id) ?? item)
      if (next.some((item, index) => item.wordCount !== history[index].wordCount || item.preview !== history[index].preview)) {
        onSetHistory(next)
        localStorage.setItem('hanzi-study-history', JSON.stringify(next))
      }
    }
    const idle = window.setTimeout(process, 0)
    return () => { cancelled = true; window.clearTimeout(idle) }
  }, [history, hskMap, onSetHistory])
  const deleteText = async (text: TextRecord) => {
    if (!window.confirm(`Delete "${text.title}"?`)) return
    await storage.deleteText(text.id)
    await onRefresh()
  }
  const wordCount = (content: string) => segmentChineseText(content).filter((segment) => segment.isWordLike).length
  return <section className="import-page">
    {!openText && <><div className="import-heading"><div><h2>Import Text</h2><p className="muted">Turn any text, image or SRT into an interactive Chinese reader.</p></div><label className="upload-button">Upload <select onChange={() => uploadRef.current?.click()} aria-label="Upload text file"><option value="">Choose file</option><option value=".txt">.txt</option><option value=".srt">.srt</option><option value=".epub">.epub</option></select><input ref={uploadRef} hidden type="file" accept=".txt,.srt,.epub" onChange={upload} /></label></div><div className="import-box"><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Paste Simplified or Traditional Chinese text here..." rows={12} /><div className="import-actions"><button className="primary import-read" onClick={read}>Read →</button><button className="quiet" onClick={() => setContent('这是一个中文阅读练习。欢迎来到汉字学习。')}>Try sample</button></div></div><div className="history-heading"><h3>Reading History</h3><button className="link-button" onClick={() => { onSetHistory([]); localStorage.removeItem('hanzi-study-history') }}>Clear history</button></div><div className="history-grid">{history.length ? history.map((item) => <HistoryCard key={item.id} item={item} onOpenReader={onOpenReader} onRemove={removeHistory} />) : <p className="muted">No reading history yet.</p>}</div></>}
    {openText && <><div className="reader-page-heading"><button className="quiet" onClick={onBack}>← Reader</button><span className="not-saved-badge">{openText.saved ? 'Saved' : 'Not saved'}</span></div><TextReader text={texts.find((item) => item.id === openText.id) ?? { id: openText.id, title: openText.title, content: openText.content, createdAt: 0 }} cards={cards} lists={lists} hskMap={hskMap} onRefresh={onRefresh} unsaved={!openText.saved} onSave={onSaveReader} /></>}
  </section>
}

const HistoryCard = memo(function HistoryCard({ item, onOpenReader, onRemove }: { item: ReadingHistoryEntry; onOpenReader: (text: Omit<OpenText, 'origin'>) => void; onRemove: (id: string) => void }) {
  return <article className="history-card" onClick={() => onOpenReader({ id: item.savedId ?? '', title: item.title, content: item.content, saved: Boolean(item.savedId) })}>
    <button className="history-remove" aria-label="Remove from reading history" onClick={(event) => { event.stopPropagation(); onRemove(item.id) }}>×</button>
    <strong>{item.title}</strong>
    <span className="tag hsk-badge">{item.hskLevel ? `HSK ${item.hskLevel}` : 'Not in HSK'}</span>
    <span className="muted small">{new Date(item.readAt).toLocaleDateString()} · {item.wordCount ?? 0} words</span>
    <span className="muted small">{item.preview ?? ''}</span>
  </article>
})

function SavedTextsPage({ texts, cards, lists, hskMap, onRefresh, openText, onOpenReader, onBack, onSaveReader, onGoToReader }: { texts: TextRecord[]; cards: VocabularyCard[]; lists: StudyList[]; hskMap: Map<string, HskLevel>; onRefresh: () => Promise<void>; openText: OpenText | null; onOpenReader: (text: Omit<OpenText, 'origin'>) => void; onBack: () => void; onSaveReader: () => Promise<void>; onGoToReader: () => void }) {
  const textStats = useMemo(() => new Map(texts.map((text) => {
    const computed = text.hskLevel === undefined || text.wordCount === undefined ? getTextStats(text.content, hskMap) : undefined
    return [text.id, { hskLevel: text.hskLevel ?? computed?.hskLevel, wordCount: text.wordCount ?? computed?.wordCount ?? 0 }] as const
  })), [texts, hskMap])
  const deleteText = async (text: TextRecord) => {
    if (!window.confirm(`Delete "${text.title}"?`)) return
    await storage.deleteText(text.id)
    await onRefresh()
  }
  const wordCount = (content: string) => segmentChineseText(content).filter((segment) => segment.isWordLike).length
  return <section className="import-page">
    {!openText && <><SectionHeading title="Saved Texts" description="Your saved Chinese reading texts." />{texts.length ? <div className="saved-texts-grid">{texts.map((text) => { const stats = textStats.get(text.id); return <article className="saved-text-card" key={text.id} onClick={() => onOpenReader({ id: text.id, title: text.title, content: text.content, saved: true })}><button className="saved-text-delete" aria-label={`Delete ${text.title}`} onClick={(event) => { event.stopPropagation(); void deleteText(text) }}>×</button><strong>{text.title}</strong><span className="tag hsk-badge">{stats?.hskLevel ? `HSK ${stats.hskLevel}` : 'Not in HSK'}</span><span className="muted small">{new Date(text.createdAt).toLocaleDateString()} · {stats?.wordCount ?? 0} words</span></article> })}</div> : <div className="dashboard-empty"><span>No saved texts yet.</span><button className="quiet" onClick={onGoToReader}>Go to Reader</button></div>}</>}
    {openText && <><div className="reader-page-heading"><button className="quiet" onClick={onBack}>← Saved Texts</button><span className="not-saved-badge">Saved</span></div><TextReader text={texts.find((item) => item.id === openText.id) ?? { id: openText.id, title: openText.title, content: openText.content, createdAt: 0 }} cards={cards} lists={lists} hskMap={hskMap} onRefresh={onRefresh} unsaved={!openText.saved} onSave={onSaveReader} /></>}
  </section>
}

interface Segment {
  text: string
  isWordLike: boolean
}

function segmentChineseText(content: string): Segment[] {
  if (!segmenter) return [...content].map((text) => ({ text, isWordLike: /[\u3400-\u9fff]/u.test(text) }))
  return [...segmenter.segment(content)].map(({ segment, isWordLike }) => ({
    text: segment,
    isWordLike: Boolean(isWordLike && /[\u3400-\u9fff]/u.test(segment)),
  }))
}

function splitSentences(content: string): string[] {
  return (content.match(/[^。！？\n]+[。！？]?|\n+/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

interface BuiltInTranslator {
  translate: (text: string) => Promise<string>
}

interface TranslatorApi {
  availability: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>
  create: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<BuiltInTranslator>
}

function getTranslatorApi(): TranslatorApi | undefined {
  if (typeof self === 'undefined' || !('Translator' in self)) return undefined
  return (self as typeof self & { Translator?: TranslatorApi }).Translator
}

async function translateWithMyMemory(sentence: string): Promise<string> {
  if (new TextEncoder().encode(sentence).length >= 500) {
    throw new Error('This sentence is too long for the fallback translator (500-byte limit).')
  }
  const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(sentence)}&langpair=zh-CN|en`)
  if (!response.ok) throw new Error('The fallback translator is unavailable or its daily limit was reached.')
  const data = await response.json() as { responseStatus?: number; responseData?: { translatedText?: string } }
  if (data.responseStatus !== undefined && data.responseStatus !== 200) {
    throw new Error('The fallback translator daily limit was reached.')
  }
  const translation = data.responseData?.translatedText
  if (!translation) throw new Error('The translator returned no translation.')
  return translation
}

async function translateSentence(sentence: string, translator?: BuiltInTranslator): Promise<string> {
  if (translator) return translator.translate(sentence)
  return translateWithMyMemory(sentence)
}

function TextReader({ text, cards, lists, hskMap: initialHskMap, onRefresh, unsaved = false, onSave }: { text: TextRecord; cards: VocabularyCard[]; lists: StudyList[]; hskMap?: Map<string, HskLevel>; onRefresh: () => Promise<void>; unsaved?: boolean; onSave?: () => Promise<void> }) {
  const displaySetting = (key: string, fallback: boolean) => localStorage.getItem(`manda-display-${key}`) !== null ? localStorage.getItem(`manda-display-${key}`) === 'true' : fallback
  const [showPinyin, setShowPinyin] = useState(() => displaySetting('pinyin', true))
  const [showHskColors, setShowHskColors] = useState(() => displaySetting('hsk', true))
  const [showUnderlines, setShowUnderlines] = useState(() => displaySetting('underlines', true))
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('manda-display-font') ?? 'medium')
  const [showMarkMenu, setShowMarkMenu] = useState(false)
  const [highlightAbove, setHighlightAbove] = useState(0)
  const hskMap = initialHskMap ?? new Map<string, HskLevel>()
  const [selectedWord, setSelectedWord] = useState<string | null>(null)
  const [lookup, setLookup] = useState<DictionaryLookup | null>(null)
  const [loadingLookup, setLoadingLookup] = useState(false)
  const [selectedLists, setSelectedLists] = useState<string[]>([])
  const [createCards, setCreateCards] = useState(true)
  const [busy, setBusy] = useState(false)
  const sentences = useMemo(() => splitSentences(text.content), [text.content])
  const sentenceSegments = useMemo(() => sentences.map((sentence) => segmentChineseText(sentence)), [sentences])
  const [showTranslations, setShowTranslations] = useState(false)
  const [translations, setTranslations] = useState<Record<string, string>>(text.translations ?? {})
  const [translationStatus, setTranslationStatus] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const vocabulary = useMemo(() => cards.filter((card) => card.textId === text.id && !card.vocabularyEntryId), [cards, text.id])
  const knownWords = useMemo(() => new Set(vocabulary.map((card) => (card.hanzi ?? card.front).trim())), [vocabulary])
  const wordList = useMemo(() => [...new Set(sentences.flatMap((sentence) => segmentChineseText(sentence)).filter((segment) => segment.isWordLike).map((segment) => segment.text))], [sentences])
  const [visibleSentenceCount, setVisibleSentenceCount] = useState(sentences.length)
  useEffect(() => {
    let frame = 0
    let cancelled = false
    if (wordList.length <= 1500) {
      setVisibleSentenceCount(sentences.length)
      return () => undefined
    }
    let sentenceIndex = 0
    let wordsShown = 0
    const nextChunk = () => {
      if (cancelled) return
      const start = sentenceIndex
      while (sentenceIndex < sentences.length && (sentenceIndex === start || wordsShown < 300)) {
        wordsShown += sentenceSegments[sentenceIndex].filter((segment) => segment.isWordLike).length
        sentenceIndex += 1
      }
      setVisibleSentenceCount(sentenceIndex)
      if (sentenceIndex < sentences.length) frame = window.requestAnimationFrame(nextChunk)
    }
    setVisibleSentenceCount(0)
    frame = window.requestAnimationFrame(nextChunk)
    return () => { cancelled = true; window.cancelAnimationFrame(frame) }
  }, [sentences, sentenceSegments, wordList.length])
  const selectedAnalysis = useMemo(() => selectedWord ? analyzeHskWord(selectedWord, hskMap) : null, [selectedWord, hskMap])
  const groupedEntries = useMemo(() => {
    if (!lookup) return []
    const groups = new Map<string, typeof lookup.entries>()
    lookup.entries.forEach((entry) => groups.set(entry.pinyin, [...(groups.get(entry.pinyin) ?? []), entry]))
    return [...groups.entries()]
  }, [lookup])
  useEffect(() => { setTranslations(text.translations ?? {}) }, [text.id, text.translations])

  const translateSentences = async (requested: string[]) => {
    const missing = [...new Set(requested)].filter((sentence) => !translations[sentence])
    if (!missing.length) {
      setShowTranslations(true)
      return
    }
    setTranslating(true)
    setTranslationStatus(null)
    try {
      let translator: BuiltInTranslator | undefined
      const api = getTranslatorApi()
      if (api) {
        const availability = await api.availability({ sourceLanguage: 'zh', targetLanguage: 'en' })
        if (availability === 'available' || availability === 'downloadable' || availability === 'downloading') {
          translator = await api.create({ sourceLanguage: 'zh', targetLanguage: 'en' })
        }
      }
      const additions: Record<string, string> = {}
      for (const sentence of missing) additions[sentence] = await translateSentence(sentence, translator)
      const nextTranslations = { ...translations, ...additions }
      setTranslations(nextTranslations)
      if (!unsaved) await storage.saveText({ ...text, translations: nextTranslations })
      setShowTranslations(true)
    } catch (error) {
      setTranslationStatus(error instanceof Error ? error.message : 'Translation is unavailable. Please try again later.')
    } finally {
      setTranslating(false)
    }
  }

  const translateAll = () => { void translateSentences(sentences) }

  const selectWord = async (word: string) => {
    setSelectedWord(word)
    setLookup(null)
    setSelectedLists([])
    setLoadingLookup(true)
    try {
      setLookup(await lookupWord(word))
    } finally {
      setLoadingLookup(false)
    }
  }

  const addVocabulary = async (word: string, result: DictionaryLookup, withFlashcards: boolean) => {
    const meaning = (await getShortMeaning(word, result.definitions)) || 'No dictionary definition'
    const existing = await storage.findVocabularyDuplicate(word, text.id)
    const hskLevel = getHskLevelForWord(word, hskMap)
    const entry: VocabularyCard = existing
      ? { ...existing, pinyin: result.pinyin, meaning, hskLevel, front: word, back: meaning, listIds: [...new Set([...existing.listIds, ...selectedLists])], inStudyList: true }
      : { ...emptyCard(text.id), hanzi: word, pinyin: result.pinyin, meaning, hskLevel, front: word, back: meaning, listIds: selectedLists, inStudyList: true }
    await storage.saveCard(entry, Boolean(existing))
    if (withFlashcards) {
      const generated = await generateFlashcards(entry)
      await Promise.all(generated.map((card) => storage.saveCard(card)))
    }
  }

  const addSelectedWord = async () => {
    if (!selectedWord || !lookup) return
    setBusy(true)
    try {
      await addVocabulary(selectedWord, lookup, createCards)
      await onRefresh()
      setSelectedWord(null)
    } finally {
      setBusy(false)
    }
  }

  const addUnknownWords = async () => {
      const unknownWords = [...new Set(sentences.flatMap((sentence) => segmentChineseText(sentence)).filter((segment) => segment.isWordLike).map((segment) => segment.text))]
      .filter((word) => !knownWords.has(word))
    setBusy(true)
    try {
      const results = await Promise.all(unknownWords.map(async (word) => ({ word, result: await lookupWord(word) })))
      for (const { word, result } of results) await addVocabulary(word, result, true)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const toggleList = (listId: string) => setSelectedLists((current) => current.includes(listId) ? current.filter((id) => id !== listId) : [...current, listId])
  const setDisplay = (key: string, value: boolean, setter: (value: boolean) => void) => { setter(value); localStorage.setItem(`manda-display-${key}`, String(value)) }
  const markWords = async (known: boolean) => {
    setShowMarkMenu(false)
    const missing = wordList.filter((word) => !knownWords.has(word))
    setBusy(true)
    try {
      for (const word of missing) {
        const result = await lookupWord(word)
        await addVocabulary(word, result, true)
      }
      if (known) {
        const entries = await storage.getCards()
        await Promise.all(entries.filter((card) => card.textId === text.id && card.vocabularyEntryId && wordList.includes(card.front)).map((card) => storage.saveCard({ ...card, intervalDays: 21, reps: Math.max(1, card.reps), dueDate: Date.now() })))
      }
      await onRefresh()
    } finally { setBusy(false) }
  }

  const renderSentence = (sentence: string, index: number) => {
    const segments = sentenceSegments[index]
    return <div className="reader-sentence" key={`${sentence}-${index}`}><div className="reader-sentence-row"><span className="reader-sentence-text">{segments.map((segment, segmentIndex) => segment.isWordLike ? <WordToken key={`${segment.text}-${segmentIndex}`} word={segment.text} known={knownWords.has(segment.text)} studyStatus={getStudyStatus(segment.text, vocabulary, cards)} hskLevel={getHskLevelForWord(segment.text, hskMap)} showPinyin={showPinyin} showHskColors={showHskColors} showUnderlines={showUnderlines} highlightAbove={highlightAbove} onClick={() => selectWord(segment.text)} /> : <span key={`${segment.text}-${segmentIndex}`}>{segment.text}</span>)}</span><button className="translate-icon" aria-label={`Translate sentence ${index + 1}`} title="Translate sentence" onClick={() => void translateSentences([sentence])}>↗</button></div>{showTranslations && translations[sentence] && <p className="translation-line">{translations[sentence]}</p>}</div>
  }

  const statusCounts = wordList.reduce((counts, word) => { const entry = vocabulary.find((item) => (item.hanzi ?? item.front) === word); const status = entry ? getStudyStatus(word, vocabulary, cards) : undefined; if (status === 'known') counts.known += 1; else if (status) counts.studying += 1; else counts.unknown += 1; return counts }, { unknown: 0, studying: 0, known: 0 })
  const levelCounts = ([1, 2, 3, 4, 5, 6, '7-9'] as HskLevel[]).map((level) => ({ level, count: wordList.filter((word) => getHskLevelForWord(word, hskMap) === level).length }))
  const highestLevel = levelCounts.find((row) => row.count > 0)?.level ?? 1
  const progress = wordList.length ? ((statusCounts.studying + statusCounts.known) / wordList.length) * 100 : 0
  return <div className="reader-flow">
    <div className="reader-summary-card"><div><p className="reader-counts"><span><b>{statusCounts.unknown}</b> unknown</span><span><b>{statusCounts.studying}</b> studying</span><span><b>{statusCounts.known}</b> known</span></p><p className="muted small">{Math.round(progress)}% covered · {wordList.length} words</p></div><div className="reader-progress"><span style={{ width: `${progress}%` }} /></div></div>
    <div className="reading-workspace">
    <div className="reading-panel">
      <div className="reader-toolbar">
        <details className="display-menu"><summary>Display</summary><label><input type="checkbox" checked={showPinyin} onChange={(event) => setDisplay('pinyin', event.target.checked, setShowPinyin)} />Pinyin</label><label><input type="checkbox" checked={showHskColors} onChange={(event) => setDisplay('hsk', event.target.checked, setShowHskColors)} />HSK colors</label><label><input type="checkbox" checked={showUnderlines} onChange={(event) => setDisplay('underlines', event.target.checked, setShowUnderlines)} />Study underlines</label><label><input type="checkbox" checked={showTranslations} onChange={(event) => setShowTranslations(event.target.checked)} />Translations</label><select value={fontSize} onChange={(event) => { setFontSize(event.target.value); localStorage.setItem('manda-display-font', event.target.value) }}><option value="small">Small font</option><option value="medium">Medium font</option><option value="large">Large font</option></select></details>
        <button className={text.id ? 'quiet' : 'primary'} onClick={() => onSave ? void onSave() : undefined}>{text.id ? 'Saved' : 'Save Text'}</button><div className="mark-menu"><button className="quiet" onClick={() => setShowMarkMenu((value) => !value)}>Mark Words</button>{showMarkMenu && <div className="mark-options"><button onClick={() => void markWords(false)}>Mark as studying</button><button onClick={() => void markWords(true)}>Mark as known</button></div>}</div>
        <button className="quiet" disabled={translating} onClick={translateAll}>{translating ? 'Translating…' : 'Translate'}</button>
      </div>
      {translationStatus && <p className="translation-status">{translationStatus}</p>}
      <div className={`reader-text font-${fontSize}`}>{sentences.slice(0, visibleSentenceCount).map(renderSentence)}</div>
      <ReaderLegend showHskColors={showHskColors} showUnderlines={showUnderlines} />
      <p className="muted small">{vocabulary.length} vocabulary item{vocabulary.length === 1 ? '' : 's'} in Study List from this text</p>
    </div>
    <aside className="vocabulary-panel reader-sidebar">
      <p className="eyebrow">WORD DETAILS</p>
      {!selectedWord && <p className="muted">Click a word in the text to look it up.</p>}
      {selectedWord && <div className="word-popup">
        <h2>{selectedWord}</h2>
        {loadingLookup && <p className="muted">Looking up definition…</p>}
        {lookup && <><p className="word-pinyin">{lookup.pinyin}</p><span className="hsk-badge">{selectedAnalysis?.parts.some((part) => part.level) ? `HSK${getHskLevelForWord(selectedWord, hskMap)}` : 'Not in HSK'}</span>{groupedEntries.length ? <div className="dictionary-entries">{groupedEntries.map(([entryPinyin, entries]) => <section className="dictionary-entry" key={entryPinyin}><strong>{entryPinyin}</strong><ul className="definitions">{entries.flatMap((entry) => entry.english).map((sense, senseIndex) => <li className={isDeferredSense(sense) ? 'deferred-sense' : ''} key={`${sense}-${senseIndex}`}>{sense}</li>)}</ul></section>)}</div> : <ul className="definitions">{lookup.definitions.length ? lookup.definitions.map((definition) => <li key={definition}>{definition}</li>) : <li>No CC-CEDICT definition found; pinyin is still available.</li>}</ul>}<div className="list-picker"><p className="muted small">Custom lists</p>{lists.length ? lists.map((list) => <label className="check" key={list.id}><input type="checkbox" checked={selectedLists.includes(list.id)} onChange={() => toggleList(list.id)} />{list.name}</label>) : <p className="muted small">Create custom lists from Study List.</p>}</div><label className="check"><input type="checkbox" checked={createCards} onChange={(event) => setCreateCards(event.target.checked)} />Create flashcards</label><button className="primary" disabled={busy} onClick={addSelectedWord}>{busy ? 'Saving…' : knownWords.has(selectedWord) ? 'Update word in Study List' : 'Add word to Study List'}</button></>}
      </div>}
    </aside>
    </div>
    <div className="level-breakdown panel"><div><strong>Estimated difficulty: HSK {highestLevel}</strong><span className="muted small"> · Based on the words in this text</span></div><div className="level-breakdown-rows">{levelCounts.map((row) => <div key={String(row.level)}><span>HSK {row.level}</span><div className="progress-track"><span style={{ width: `${wordList.length ? row.count / wordList.length * 100 : 0}%` }} /></div><small>{wordList.length ? Math.round(row.count / wordList.length * 100) : 0}% · {row.count} words</small></div>)}</div><p className="muted small">Estimate confidence improves with longer texts; short texts may not represent the full difficulty.</p></div>
  </div>
}

type StudyStatus = 'known' | 'near-mastered' | 'learning'

function getStudyStatus(word: string, vocabulary: VocabularyCard[], cards: VocabularyCard[]): StudyStatus | undefined {
  const entry = vocabulary.find((item) => (item.hanzi ?? item.front).trim() === word)
  if (!entry) return undefined
  const linkedCards = cards.filter((card) => card.vocabularyEntryId === entry.id)
  if (!linkedCards.length) return 'learning'
  const statuses = linkedCards.map((card) => {
    const recentlyLapsed = card.lapses > 0 && card.lastReviewedAt !== undefined && Date.now() - card.lastReviewedAt <= RECENT_LAPSE_DAYS * 24 * 60 * 60 * 1000
    if (recentlyLapsed || card.intervalDays < NEAR_MASTERED_INTERVAL_DAYS) return 'learning' as const
    if (card.intervalDays < MASTERED_INTERVAL_DAYS) return 'near-mastered' as const
    return 'known' as const
  })
  if (statuses.includes('learning')) return 'learning'
  if (statuses.includes('near-mastered')) return 'near-mastered'
  return 'known'
}

const WordToken = memo(function WordToken({ word, known, studyStatus, hskLevel, showPinyin, showHskColors, showUnderlines, highlightAbove, onClick }: { word: string; known: boolean; studyStatus?: StudyStatus; hskLevel?: HskLevel; showPinyin: boolean; showHskColors: boolean; showUnderlines: boolean; highlightAbove: number; onClick: () => void }) {
  const [tooltip, setTooltip] = useState<DictionaryLookup | null>(null)
  const [hovering, setHovering] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const tooltipCache = useRef(new Map<string, DictionaryLookup>())
  const qualifies = hskRank(hskLevel) > highlightAbove
  const className = ['reader-word', known ? 'known' : '', showUnderlines && studyStatus ? `study-${studyStatus}` : '', showHskColors && hskLevel && highlightAbove > 0 && !qualifies ? 'hsk-dimmed' : ''].filter(Boolean).join(' ')
  const startTooltip = () => {
    if (typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches) {
      timer.current = window.setTimeout(() => {
        const cached = tooltipCache.current.get(word)
        if (cached) { setTooltip(cached); return }
        void lookupWord(word).then((result) => {
          tooltipCache.current.set(word, result)
          setTooltip(result)
        })
      }, 150)
      setHovering(true)
    }

  }
  const stopTooltip = () => {
    if (timer.current) window.clearTimeout(timer.current)
    setHovering(false)
  }
  let characterIndex = 0
  return <span className="reader-token" onMouseEnter={startTooltip} onMouseLeave={stopTooltip}><button className={className} onClick={onClick}><ruby>{[...word].map((character) => { const color = showHskColors && hskLevel && hskRank(hskLevel) > highlightAbove ? HSK_COLORS[hskLevel] : undefined; characterIndex += 1; return <span className="reader-character" style={{ color }} key={`${character}-${characterIndex}`}>{character}</span> })}{showPinyin && <rt>{getCachedPinyin(word)}</rt>}</ruby></button>{hovering && tooltip && <span className="word-tooltip" role="tooltip"><strong>{word}</strong><span className="tooltip-pinyin">{tooltip.pinyin}</span><small className="hsk-badge">{hskLevel ? `HSK${hskLevel}` : 'Not in HSK'}</small><span>{tooltip.definitions.slice(0, 3).join('; ') || 'No definition'}</span></span>}</span>
})

function ReaderLegend({ showHskColors, showUnderlines }: { showHskColors: boolean; showUnderlines: boolean }) {
  return <div className="reader-legend" aria-label="Reading legend">
    {showHskColors && <div className="legend-group"><span className="legend-label">HSK</span><span className="legend-item hsk-legend-1">1</span><span className="legend-item hsk-legend-2">2</span><span className="legend-item hsk-legend-3">3</span><span className="legend-item hsk-legend-4">4</span><span className="legend-item hsk-legend-5">5</span><span className="legend-item hsk-legend-6">6</span><span className="legend-item hsk-legend-7">7–9</span></div>}
    {showUnderlines && <div className="legend-group"><span className="legend-label">Study</span><span className="legend-item study-legend-known">Known</span><span className="legend-item study-legend-near">Near mastered</span><span className="legend-item study-legend-learning">Learning</span></div>}
  </div>
}

type StudyFilter = 'all' | 'list' | 'source' | 'due' | 'new' | 'hsk'

function StudyPage({ texts, cards, lists, onRefresh, onReviewNow }: { texts: TextRecord[]; cards: VocabularyCard[]; lists: StudyList[]; onRefresh: () => Promise<void>; onReviewNow: () => void }) {
  const [name, setName] = useState('')
  const [filter, setFilter] = useState<StudyFilter>('all')
  const [selectedList, setSelectedList] = useState('')
  const [selectedSource, setSelectedSource] = useState('')
  const [selectedHsk, setSelectedHsk] = useState('all')
  const [sortBy, setSortBy] = useState<'recent' | 'hsk'>('recent')
  const [editingId, setEditingId] = useState<string | null>(null)
  const vocabularyCards = cards.filter((card) => !card.vocabularyEntryId)
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)
  const shownCards = vocabularyCards.filter((card) => {
    if (filter === 'list') return selectedList ? card.listIds.includes(selectedList) : true
    if (filter === 'source') return selectedSource ? card.textId === selectedSource : true
    if (filter === 'due') return card.dueDate <= todayEnd.getTime()
    if (filter === 'new') return card.reps === 0
    if (filter === 'hsk') return selectedHsk === 'all' ? true : String(card.hskLevel ?? '') === selectedHsk
    return true
  }).sort((a, b) => sortBy === 'hsk'
    ? hskRank(a.hskLevel) - hskRank(b.hskLevel)
    : b.createdAt - a.createdAt)
  const generateFor = async (card: VocabularyCard) => {
    const generated = cards.filter((item) => item.vocabularyEntryId === card.id)
    if (!generated.length) await Promise.all((await generateFlashcards(card)).map((item) => storage.saveCard(item)))
    await onRefresh()
  }
  const reviewNow = async (card: VocabularyCard) => {
    const generated = cards.filter((item) => item.vocabularyEntryId === card.id)
    const targets = generated.length ? generated : [card]
    await Promise.all(targets.map((item) => storage.saveCard({ ...item, dueDate: Date.now() })))
    await onRefresh()
    onReviewNow()
  }
  return <section>
    <SectionHeading title="Study List" description="Review, organize, and manage every vocabulary entry." />
    <div className="toolbar list-toolbar">
      <select value={filter} onChange={(e) => setFilter(e.target.value as StudyFilter)} aria-label="Vocabulary filter">
        <option value="all">All ({vocabularyCards.length})</option>
        <option value="list">By Custom List</option>
        <option value="source">By Source Text</option>
        <option value="due">Due Today</option>
        <option value="new">New</option>
        <option value="hsk">By HSK Level</option>
      </select>
      {filter === 'list' && <select value={selectedList} onChange={(e) => setSelectedList(e.target.value)} aria-label="Custom list"><option value="">Choose a list</option>{lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select>}
      {filter === 'source' && <select value={selectedSource} onChange={(e) => setSelectedSource(e.target.value)} aria-label="Source text"><option value="">Choose a text</option>{texts.map((text) => <option value={text.id} key={text.id}>{text.title}</option>)}</select>}
      {filter === 'hsk' && <select value={selectedHsk} onChange={(e) => setSelectedHsk(e.target.value)} aria-label="HSK level"><option value="all">Any HSK level</option>{[1, 2, 3, 4, 5, 6, '7-9'].map((level) => <option value={level} key={level}>HSK {level}</option>)}</select>}
      <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'recent' | 'hsk')} aria-label="Sort vocabulary"><option value="recent">Sort by recent</option><option value="hsk">Sort by HSK level</option></select>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New custom list" />
      <button className="primary" onClick={async () => { if (!name.trim()) return; await storage.saveList({ id: makeId(), name: name.trim(), createdAt: Date.now() }); setName(''); await onRefresh() }}>Create list</button>
    </div>
    {shownCards.length === 0 ? <EmptyState text="No vocabulary entries match this filter." /> : <div className="vocabulary-table">{shownCards.map((card) => <VocabularyRow key={card.id} card={card} lists={lists} texts={texts} generatedCardCount={cards.filter((item) => item.vocabularyEntryId === card.id).length} editing={editingId === card.id} onEdit={() => setEditingId(editingId === card.id ? null : card.id)} onSave={async (changes) => { await storage.saveCard({ ...card, ...changes }); setEditingId(null); await onRefresh() }} onGenerate={() => generateFor(card)} onReview={() => reviewNow(card)} />)}</div>}
  </section>
}

function VocabularyRow({ card, lists, texts, generatedCardCount, editing, onEdit, onSave, onGenerate, onReview }: { card: VocabularyCard; lists: StudyList[]; texts: TextRecord[]; generatedCardCount: number; editing: boolean; onEdit: () => void; onSave: (changes: Partial<VocabularyCard>) => Promise<void>; onGenerate: () => Promise<void>; onReview: () => Promise<void> }) {
  const source = texts.find((text) => text.id === card.textId)
  const [hanzi, setHanzi] = useState(card.hanzi ?? card.front)
  const [pinyin, setPinyin] = useState(card.pinyin ?? '')
  const [meaning, setMeaning] = useState(card.meaning ?? card.back)
  if (editing) return <article className="panel vocabulary-row edit-row"><div className="edit-fields"><input value={hanzi} onChange={(e) => setHanzi(e.target.value)} aria-label="Hanzi" /><input value={pinyin} onChange={(e) => setPinyin(e.target.value)} aria-label="Pinyin" /><input value={meaning} onChange={(e) => setMeaning(e.target.value)} aria-label="Meaning" /></div><div className="row-actions"><button className="primary" onClick={() => onSave({ hanzi, pinyin, meaning, front: hanzi, back: meaning })}>Save</button><button className="quiet" onClick={onEdit}>Cancel</button></div></article>
  return <article className="panel vocabulary-row"><div className="vocabulary-main"><div><h2>{card.hanzi ?? card.front}</h2><p className="muted">{card.pinyin || 'No pinyin'} · {card.meaning ?? card.back}</p><p className="muted small">From {source?.title ?? 'deleted text'} · {card.reps === 0 ? 'New' : `${card.reps} reviews`}</p></div><div className="row-tags">{card.hskLevel && <span className="tag">HSK {card.hskLevel}</span>}{card.listIds.map((listId) => <span className="tag" key={listId}>{lists.find((list) => list.id === listId)?.name ?? 'List'}</span>)}</div></div><div className="row-actions"><button className="quiet" onClick={onEdit}>Edit</button><button className="quiet" onClick={onGenerate}>{generatedCardCount > 0 ? 'Flashcards ready' : 'Generate Flashcards'}</button><button className="quiet" onClick={onReview}>Review Now</button></div></article>
}

type ReviewFilter = 'all' | 'list' | 'source'

function ReviewPage({ cards, allCards, lists, texts, onRefresh, cardDirection }: { cards: VocabularyCard[]; allCards: VocabularyCard[]; lists: StudyList[]; texts: TextRecord[]; onRefresh: () => Promise<void>; cardDirection: CardDirection }) {
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [selectedListId, setSelectedListId] = useState('')
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const filteredCards = useMemo(() => cards.filter((card) => {
    if (filter === 'list') return selectedListId ? card.listIds.includes(selectedListId) : false
    if (filter === 'source') return selectedSourceId ? card.textId === selectedSourceId : false
    return true
  }), [cards, filter, selectedListId, selectedSourceId])
  const [sessionCards, setSessionCards] = useState<VocabularyCard[]>(filteredCards)
  const [revealed, setRevealed] = useState(false)
  const [resolvedData, setResolvedData] = useState<Awaited<ReturnType<typeof resolveCardData>> | null>(null)
  const [resolvingData, setResolvingData] = useState(false)
  useEffect(() => {
    setSessionCards(filteredCards)
    setRevealed(false)
  }, [filteredCards])
  const card = sessionCards[0]
  useEffect(() => {
    let active = true
    setResolvedData(null)
    if (!card) return () => { active = false }
    const entry = card.vocabularyEntryId ? allCards.find((item) => item.id === card.vocabularyEntryId) : card
    if (!entry) return () => { active = false }
    setResolvingData(true)
    void resolveCardData(entry, card).then((data) => {
      if (active) setResolvedData(data)
    }).finally(() => {
      if (active) setResolvingData(false)
    })
    return () => { active = false }
  }, [card, allCards])
  const filterControls = <div className="review-filters panel"><label htmlFor="review-filter">Review</label><select id="review-filter" value={filter} onChange={(event) => setFilter(event.target.value as ReviewFilter)}><option value="all">All due cards ({cards.length})</option><option value="list">From custom list</option><option value="source">From saved text</option></select>{filter === 'list' && <select value={selectedListId} onChange={(event) => setSelectedListId(event.target.value)} aria-label="Review custom list"><option value="">Choose a custom list</option>{lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select>}{filter === 'source' && <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)} aria-label="Review saved text"><option value="">Choose a saved text</option>{texts.map((text) => <option value={text.id} key={text.id}>{text.title}</option>)}</select>}</div>
  if (!card) return <section className="review-page"><SectionHeading title="Review" description="Practice cards when they are due." />{filterControls}<EmptyState text={filteredCards.length || cards.length ? 'You finished this review session or this filter has no due cards.' : 'You are all caught up. Add cards or come back later.'} /></section>
  const rate = async (rating: ReviewRating) => {
    const reviewedAt = Date.now()
    await storage.saveCard(scheduleCard(card, rating, reviewedAt))
    await storage.saveReviewLog({ id: makeId(), cardId: card.id, rating, reviewedAt })
    setSessionCards((remaining) => remaining.slice(1))
    setRevealed(false)
    await onRefresh()
  }
  const entry = card.vocabularyEntryId ? allCards.find((item) => item.id === card.vocabularyEntryId) : card
  const hanzi = entry?.hanzi ?? (card.cardType === 'recognition' ? card.front : '')
  const pinyin = resolvedData?.pinyin ?? ''
  const meanings = resolvedData?.meaning && resolvedData.meaning !== 'No meaning available' ? [resolvedData.meaning] : []
  const example = entry?.note?.trim()
  const mixedDirection = [...card.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 2 === 0 ? 'chinese-to-english' : 'english-to-chinese'
  const direction = cardDirection === 'mixed' ? mixedDirection : cardDirection
  const frontContent = direction === 'english-to-chinese' ? (meanings.length ? meanings : ['No meaning available']) : [hanzi]
  const intervalFor = (rating: ReviewRating) => scheduleCard(card, rating, Date.now()).intervalDays
  const intervalLabel = (rating: ReviewRating) => {
    const days = intervalFor(rating)
    return days === 0 ? 'Now' : `${days} day${days === 1 ? '' : 's'}`
  }
  if (resolvingData || !resolvedData) return <section className="review-page"><SectionHeading title="Review" description="Practice cards when they are due." />{filterControls}<div className="review-session-count">{sessionCards.length} cards remaining in this session</div><div className="panel review-loading">Loading dictionary data…</div></section>
  const resolvedFrontContent = direction === 'english-to-chinese' ? (meanings.length ? meanings : ['No meaning available']) : [hanzi]
  return <section className="review-page"><SectionHeading title="Review" description="Practice cards when they are due." />{filterControls}<div className="review-session-count">{sessionCards.length} card{sessionCards.length === 1 ? '' : 's'} remaining in this session</div><div className={`review-card panel${revealed ? ' revealed' : ''}`}><span className="review-card-level hsk-badge">{resolvedData.hskLevel ? `HSK ${resolvedData.hskLevel}` : 'HSK —'}</span><div className="review-prompt-area"><div className={`prompt${direction === 'english-to-chinese' ? ' prompt-meaning' : ''}`}>{resolvedFrontContent.map((meaning, index) => <span key={meaning}>{index > 0 && <br />}{meaning}</span>)}</div></div>{revealed ? <div className="review-answer-area"><p className="review-pinyin">{pinyin || 'No pinyin available'}</p>{direction === 'english-to-chinese' && <p className="review-hanzi">{hanzi}</p>}{direction === 'chinese-to-english' && (meanings.length ? <ol className="review-meanings">{meanings.map((meaning) => <li key={meaning}>{meaning}</li>)}</ol> : <p className="muted">No meaning available</p>)}{example && <p className="review-example">{example}</p>}</div> : <button className="reveal" onClick={() => setRevealed(true)}>Reveal</button>}</div>{revealed && <><div className="rating-grid">{(['again', 'hard', 'good', 'easy'] as ReviewRating[]).map((rating) => <button key={rating} className={`rating ${rating}`} onClick={() => rate(rating)}><strong>{rating[0].toUpperCase() + rating.slice(1)}</strong><small>{intervalLabel(rating)}</small></button>)}</div><button className="mark-known" onClick={() => void rate('easy')}>Mark as known, stop reviewing</button></>}</section>
}

function SectionHeading({ title, description }: { title: string; description: string }) { return <div className="section-heading"><div><p className="eyebrow">YOUR LIBRARY</p><h2>{title}</h2><p className="muted">{description}</p></div></div> }
function EmptyState({ text }: { text: string }) { return <div className="empty panel"><p>{text}</p></div> }

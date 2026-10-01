import { getPrimarySenses } from './dictRank'

export async function getShortMeaning(word: string, definitions: string[] = []): Promise<string> {
  const primarySenses = await getPrimarySenses(word)
  const firstDefinition = (primarySenses[0] ?? definitions[0] ?? '').trim()
  const withoutNotes = firstDefinition
    .replace(/\(\s*s\s*\)/gi, 's')
    .replace(/\s*\([^)]*\)/g, '')
  const firstChunk = withoutNotes.split(';', 1)[0] ?? ''
  return firstChunk
    .trim()
    .replace(/^[\s.,:!?'"“”‘’()[\]{}-]+|[\s.,:!?'"“”‘’()[\]{}-]+$/g, '')
}

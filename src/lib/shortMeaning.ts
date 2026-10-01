export function getShortMeaning(definitions: string[]): string {
  const firstDefinition = definitions[0]?.trim() ?? ''
  const withoutNotes = firstDefinition
    .replace(/\(\s*s\s*\)/gi, 's')
    .replace(/\s*\([^)]*\)/g, '')
  const firstChunk = withoutNotes.split(';', 1)[0] ?? ''
  return firstChunk
    .trim()
    .replace(/^[\s.,:!?'"“”‘’()[\]{}-]+|[\s.,:!?'"“”‘’()[\]{}-]+$/g, '')
}

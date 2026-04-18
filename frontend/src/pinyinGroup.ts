import pinyin from 'pinyin'

/** 用于通讯录分组与排序：首字母 A–Z，其它为 # */
export function bucketLetter(name: string): string {
  const t = name.trim()
  if (!t) return '#'
  const c0 = t[0]
  if (/[a-zA-Z]/.test(c0)) return c0.toUpperCase()
  try {
    const arr = pinyin(c0, { style: pinyin.STYLE_FIRST_LETTER, heteronym: false })
    const x = arr[0]?.[0]
    if (x && /^[A-Za-z]$/.test(x)) return x.toUpperCase()
  } catch {
    /* ignore */
  }
  return '#'
}

/** 全名转拼音用于排序（简：取前 16 字的 normal 拼接） */
export function sortPinyinKey(name: string): string {
  const t = name.trim().slice(0, 16)
  if (!t) return ''
  try {
    const parts = pinyin(t, { style: pinyin.STYLE_NORMAL, heteronym: false }) as string[][]
    return parts
      .map((a) => String(a[0] ?? '').toLowerCase())
      .join('')
      .replace(/\s+/g, '')
  } catch {
    return t.toLowerCase()
  }
}

export const INDEX_LETTERS: readonly string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')

export function groupByLetter<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  const sorted = [...items].sort((a, b) => sortPinyinKey(a.name).localeCompare(sortPinyinKey(b.name), 'en'))
  for (const it of sorted) {
    const L = bucketLetter(it.name)
    if (!map.has(L)) map.set(L, [])
    map.get(L)!.push(it)
  }
  return map
}

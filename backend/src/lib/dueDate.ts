const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const WEEKDAYS: Record<string, number> = {
  minggu: 0, ahad: 0, sunday: 0, sun: 0,
  senin: 1, monday: 1, mon: 1,
  selasa: 2, tuesday: 2, tue: 2, tues: 2,
  rabu: 3, wednesday: 3, wed: 3,
  kamis: 4, thursday: 4, thu: 4, thurs: 4,
  jumat: 5, "jum'at": 5, friday: 5, fri: 5,
  sabtu: 6, saturday: 6, sat: 6,
}

const MONTHS: Record<string, number> = {
  januari: 1, jan: 1, january: 1,
  februari: 2, feb: 2, pebruari: 2, february: 2,
  maret: 3, mar: 3, march: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  agustus: 8, agu: 8, agt: 8, aug: 8, august: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10, october: 10,
  november: 11, nov: 11, nopember: 11,
  desember: 12, des: 12, dec: 12, december: 12,
}

const COUNT_WORDS: Record<string, number> = { satu: 1, se: 1, a: 1, one: 1, dua: 2, two: 2, tiga: 3, three: 3, empat: 4, four: 4, lima: 5, five: 5 }

interface Day {
  year: number
  month: number
  day: number
}

function jakartaDay(at: Date): Day {
  const local = new Date(at.getTime() + JAKARTA_OFFSET_MS)
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() }
}

function toUtc(day: Day): number {
  return Date.UTC(day.year, day.month - 1, day.day)
}

function fromUtc(ms: number): Day {
  const date = new Date(ms)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function addDays(day: Day, count: number): Day {
  return fromUtc(toUtc(day) + count * DAY_MS)
}

function weekday(day: Day): number {
  return new Date(toUtc(day)).getUTCDay()
}

function format(day: Day): string {
  return `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`
}

function validDay(year: number, month: number, day: number): Day | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day)
  const back = fromUtc(ms)
  return back.month === month && back.day === day ? back : null
}

function nextWeekday(from: Day, target: number, nextWeek: boolean): Day {
  if (nextWeek) {
    const mondayOffset = (weekday(from) + 6) % 7
    const nextMonday = addDays(from, 7 - mondayOffset)
    return addDays(nextMonday, (target + 6) % 7)
  }
  const ahead = (target - weekday(from) + 7) % 7
  return addDays(from, ahead === 0 ? 7 : ahead)
}

function countFrom(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token)
  return COUNT_WORDS[token] ?? null
}

export function parseDue(text: string | null | undefined, reference: Date): string | null {
  if (!text || Number.isNaN(reference.getTime())) return null
  const raw = text.toLowerCase().normalize('NFKC').replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const base = jakartaDay(reference)

  const iso = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    const day = validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    return day ? format(day) : null
  }

  const numeric = raw.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/)
  if (numeric) {
    const year = numeric[3] ? (numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : base.year
    let day = validDay(year, Number(numeric[2]), Number(numeric[1]))
    if (day && !numeric[3] && toUtc(day) < toUtc(base)) day = validDay(year + 1, Number(numeric[2]), Number(numeric[1]))
    if (day) return format(day)
  }

  const named = raw.match(/\b(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/)
  if (named && MONTHS[named[2]!]) {
    const month = MONTHS[named[2]!]!
    const year = named[3] ? Number(named[3]) : base.year
    let day = validDay(year, month, Number(named[1]))
    if (day && !named[3] && toUtc(day) < toUtc(base)) day = validDay(year + 1, month, Number(named[1]))
    if (day) return format(day)
  }

  const dateOnly = raw.match(/\btanggal\s+(\d{1,2})\b/)
  if (dateOnly) {
    let day = validDay(base.year, base.month, Number(dateOnly[1]))
    if (!day || toUtc(day) < toUtc(base)) {
      const nextMonth = base.month === 12 ? { year: base.year + 1, month: 1 } : { year: base.year, month: base.month + 1 }
      day = validDay(nextMonth.year, nextMonth.month, Number(dateOnly[1]))
    }
    if (day) return format(day)
  }

  const relative = raw.match(/\b(?:dalam\s+)?(\d{1,3}|satu|se|dua|tiga|empat|lima|a|one|two|three|four|five)\s*(hari|minggu|pekan|bulan|days?|weeks?|months?)\s*(?:lagi|ke depan|dari sekarang|from now)?\b/)
  if (relative && (/\b(lagi|dalam|ke depan|dari sekarang|from now|in)\b/.test(raw) || /^(se|a)/.test(relative[1]!))) {
    const count = countFrom(relative[1]!)
    const unit = relative[2]!
    if (count !== null) {
      if (/^(hari|day)/.test(unit)) return format(addDays(base, count))
      if (/^(minggu|pekan|week)/.test(unit)) return format(addDays(base, count * 7))
      if (/^(bulan|month)/.test(unit)) {
        const month = base.month - 1 + count
        const target = validDay(base.year + Math.floor(month / 12), (month % 12) + 1, base.day) ?? validDay(base.year + Math.floor(month / 12), (month % 12) + 1, 28)
        if (target) return format(target)
      }
    }
  }
  if (/\bseminggu\b/.test(raw)) return format(addDays(base, 7))

  if (/\b(hari ini|today|eod|end of day|sore ini|malam ini|nanti sore|nanti malam|tonight)\b/.test(raw)) return format(base)
  if (/\b(besok lusa|lusa|day after tomorrow)\b/.test(raw)) return format(addDays(base, 2))
  if (/\b(besok|besoknya|tomorrow)\b/.test(raw)) return format(addDays(base, 1))

  if (/\b(akhir (minggu|pekan)|end of (the )?week|eow)\b/.test(raw)) return format(nextWeekday(addDays(base, -1), 5, false))
  if (/\b(akhir bulan|end of (the )?month|eom)\b/.test(raw)) {
    const next = base.month === 12 ? Date.UTC(base.year + 1, 0, 1) : Date.UTC(base.year, base.month, 1)
    return format(fromUtc(next - DAY_MS))
  }

  const nextWeek = /\b(depan|next)\b/.test(raw)
  for (const token of raw.split(' ')) {
    const target = WEEKDAYS[token]
    if (target === undefined) continue
    if (token === 'minggu' && /\bminggu (depan|ini|lagi)\b/.test(raw)) continue
    return format(nextWeekday(base, target, nextWeek && new RegExp(`\\b(${token} depan|next ${token})\\b`).test(raw)))
  }

  if (/\b(minggu depan|pekan depan|next week)\b/.test(raw)) return format(addDays(base, 7))
  if (/\b(bulan depan|next month)\b/.test(raw)) {
    const month = base.month === 12 ? { year: base.year + 1, month: 1 } : { year: base.year, month: base.month + 1 }
    const target = validDay(month.year, month.month, Math.min(base.day, 28))
    return target ? format(target) : null
  }
  return null
}

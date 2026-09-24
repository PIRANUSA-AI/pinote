const PLATFORM_PARTS = [
  /\bmicrosoft teams\b/gi,
  /\bteams\b/gi,
  /\bzoom (meeting|workplace|webinar)s?\b/gi,
  /\bzoom\b/gi,
  /\bgoogle meet\b/gi,
  /^meet\b/gi,
  /\bwhatsapp\b/gi,
]

const GENERIC = /^(rapat|meeting|panggilan|call|video call|obrolan|chat|beranda|home|kalender|calendar|aktivitas|activity|untitled|tanpa judul|meeting now|rapat sekarang|menunggu|waiting|lobby|join|bergabung)$/i
const MEET_CODE = /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/gi
const ZOOM_ID = /\b\d{3}\s?\d{3,4}\s?\d{3,4}\b/g

export function cleanTitleHint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.normalize('NFKC').replace(/[ᅟᅠ​-‏⁠ㅤ﻿ﾠ]/g, ' ')
  text = text.replace(MEET_CODE, ' ').replace(ZOOM_ID, ' ')
  for (const pattern of PLATFORM_PARTS) text = text.replace(pattern, ' ')
  const parts = text
    .split(/\s*[|–—]\s*|\s+-\s+|:\s+/)
    .map((part) => part.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '').trim())
    .filter((part) => part.length >= 3 && !GENERIC.test(part) && /\p{L}/u.test(part))
  const best = parts.sort((a, b) => b.length - a.length)[0]
  return best ? best.slice(0, 120) : null
}

import type { Category, Transaction } from './db'

const DAY = 86_400_000

function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 24
  return Math.min(d, 24 - d)
}

function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

/**
 * Ordina le categorie in base alle abitudini: quanto spesso sono state usate
 * di recente, alla stessa ora e nello stesso tipo di giorno (feriale o weekend).
 * Restituisce le categorie ordinate e se esiste uno storico su cui basarsi.
 */
export function rankCategories(
  categories: Category[],
  transactions: Transaction[],
  now: Date,
): { ranked: Category[]; fromHabits: boolean } {
  const score = new Map<string, number>()
  const nowHour = now.getHours() + now.getMinutes() / 60
  const nowWeekend = isWeekend(now)

  for (const tx of transactions) {
    if (!tx.categoryId) continue
    const age = (now.getTime() - tx.date) / DAY
    if (age < 0 || age > 120) continue
    const when = new Date(tx.date)
    const sameHour = hourDistance(when.getHours() + when.getMinutes() / 60, nowHour) <= 2 ? 3 : 1
    const sameDayType = isWeekend(when) === nowWeekend ? 1.5 : 1
    const recency = Math.exp(-age / 30)
    score.set(tx.categoryId, (score.get(tx.categoryId) ?? 0) + recency * sameHour * sameDayType)
  }

  const ranked = [...categories].sort(
    (a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || a.order - b.order,
  )
  return { ranked, fromHabits: ranked.some((c) => (score.get(c.id) ?? 0) > 0) }
}

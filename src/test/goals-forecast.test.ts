import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeMonth } from '../App'
import type { Goal } from '../db'
import { goalStats, monthsUntil } from '../Goals'
import { appData, tx } from './helpers'

const DAY = 86_400_000
const goal = (extra: Partial<Goal> = {}): Goal => ({ id: 'g', name: 'Viaggio', target: 120000, color: '#000', order: 0, archived: false, ...extra })

describe('gomitoli e previsione', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 20, 12))
  })
  afterEach(() => vi.useRealTimers())

  it('mesi alla scadenza: contano i giorni che restano, non i mesi di calendario', () => {
    expect(monthsUntil(new Date(2026, 11, 31, 23, 59).getTime())).toBe(3)
    expect(monthsUntil(new Date(2026, 8, 1).getTime())).toBe(0)
  })

  it('stato di un gomitolo', () => {
    const now = Date.now()
    const saves = [tx('save', 30000, now - 10 * DAY, { goalId: 'g' })]
    expect(goalStats(goal(), saves, 120000).status).toBe('reached')
    expect(goalStats(goal({ target: 0 }), saves, 30000).status).toBe('noTarget')
    const deadline = new Date(2026, 10, 30, 23, 59).getTime()
    const behind = goalStats(goal({ deadline }), saves, 30000)
    expect(behind.status).toBe('behind')
    expect(behind.missing).toBe(90000)
    expect(behind.needed).toBe(Math.ceil(90000 / monthsUntil(deadline)))
    expect(goalStats(goal(), [], 0).status).toBe('start')
  })

  it('previsione: il ritmo usa solo le spese di tutti i giorni', () => {
    const start = new Date(2026, 8, 1, 8).getTime()
    const everyday = Array.from({ length: 19 }, (_, i) => tx('expense', 1000, start + i * DAY + 3600_000))
    const data = appData([
      tx('opening', 300000, start - 3600_000, { id: 'opening-main' }),
      ...everyday,
      tx('expense', 80000, start + 3600_000, { recurringId: 'affitto' }),
      tx('expense', 60000, start + 4 * DAY, { note: 'Cappotto' }),
      tx('expense', 1500, start + 3 * DAY, { source: 'adjust' }),
    ])
    const view = computeMonth(data, 0)
    const info = view.forecastInfo!
    expect(info).not.toBeNull()
    // Fuori dal ritmo: affitto ricorrente, cappotto (oltre 4 volte la mediana), allineamento.
    expect(info.excluded).toBe(80000 + 60000 + 1500)
    const elapsedDays = (Date.now() - new Date(2026, 8, 1).getTime()) / DAY
    expect(info.perDay).toBe(Math.round(19000 / elapsedDays))
    expect(info.daysLeft).toBe(11)
    expect(view.forecast).toBe(view.endBalance - info.projected)
  })

  it('previsione assente nei mesi passati', () => {
    expect(computeMonth(appData([tx('expense', 1000, new Date(2026, 7, 5))]), -1).forecast).toBeNull()
  })
})

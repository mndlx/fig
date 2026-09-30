import { describe, expect, it } from 'vitest'
import { nextAfter } from '../recurring'

const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h).getTime()
const ymd = (ts: number) => {
  const d = new Date(ts)
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]
}

describe('scadenze ricorrenti', () => {
  it('mensile a fine mese: si adatta ai mesi corti e torna al 31', () => {
    const start = at(2026, 1, 31)
    const feb = nextAfter(start, 'month', start)
    expect(ymd(feb)).toEqual([2026, 2, 28, 9])
    expect(ymd(nextAfter(feb, 'month', start))).toEqual([2026, 3, 31, 9])
  })

  it("mensile a dicembre passa all'anno dopo", () => {
    const start = at(2026, 12, 15)
    expect(ymd(nextAfter(start, 'month', start))).toEqual([2027, 1, 15, 9])
  })

  it('annuale dal 29 febbraio', () => {
    const start = at(2028, 2, 29)
    expect(ymd(nextAfter(start, 'year', start))).toEqual([2029, 2, 28, 9])
  })

  it("settimanale: stesso giorno e stessa ora anche col cambio dell'ora legale", () => {
    const start = at(2026, 10, 21, 8)
    expect(ymd(nextAfter(start, 'week', start))).toEqual([2026, 10, 28, 8])
  })
})

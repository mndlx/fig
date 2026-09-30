import { describe, expect, it } from 'vitest'
import { detectDecimal, parseAmount, parseCsv, parseDate, toCsv } from '../csv'

describe('CSV', () => {
  it('importi nei formati delle banche', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56)
    expect(parseAmount('1,234.56')).toBe(1234.56)
    expect(parseAmount('-12,50')).toBe(-12.5)
    expect(parseAmount('12,50-')).toBe(-12.5)
    expect(parseAmount('(12,50)')).toBe(-12.5)
    expect(parseAmount('€ 1.500')).toBe(1500)
    expect(parseAmount('1,234,567')).toBe(1234567)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })

  it('il separatore decimale si decide sulla colonna intera', () => {
    const decimal = detectDecimal(['1,500', '12,50', '3,00'])
    expect(decimal).toBe(',')
    expect(parseAmount('1,500', decimal)).toBe(1.5)
    expect(detectDecimal(['1.500', '12.50', '7.25'])).toBe('.')
    expect(parseAmount('1,500', detectDecimal(['1,500', '2,000.00', '3.50']))).toBe(1500)
  })

  it('righe con virgolette e separatori dentro i campi', () => {
    const rows = parseCsv('data;descrizione;importo\n28/09/2026;"Bar; caffè";-1,50\n')
    expect(rows[1]).toEqual(['28/09/2026', 'Bar; caffè', '-1,50'])
  })

  it('date italiane e ISO', () => {
    const a = parseDate('28/09/2026')!
    expect([a.getFullYear(), a.getMonth(), a.getDate()]).toEqual([2026, 8, 28])
    const b = parseDate('2026-09-28')!
    expect([b.getFullYear(), b.getMonth(), b.getDate()]).toEqual([2026, 8, 28])
  })

  it('esportazione protetta dalle formule di Excel, numeri negativi intatti', () => {
    const out = toCsv([['=SUM(A1)', '-12,50', '+39 333', 'a;b']])
    expect(out).toContain("'=SUM(A1)")
    expect(out).toContain(';-12,50;')
    expect(out).toContain("'+39 333")
    expect(out).toContain('"a;b"')
  })
})

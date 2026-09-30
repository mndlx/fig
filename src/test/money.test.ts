import { beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../i18n'
import { convertMinor, formatMoney, parseInput, parseTyped } from '../money'
import { ALL, EUR } from './helpers'

const plain = (s: string) => s.replace(/\s/g, ' ')

describe('importi', () => {
  beforeEach(() => setLang('it'))

  it('tastierino: stringa con il punto → unità minime', () => {
    expect(parseInput('12.5', 2)).toBe(1250)
    expect(parseInput('0.1', 2)).toBe(10)
    expect(parseInput('', 2)).toBe(0)
    expect(parseInput('4800', 0)).toBe(4800)
  })

  it('campi di testo in italiano: migliaia col punto, decimali con la virgola', () => {
    expect(parseTyped('1.234,56', 2)).toBe(123456)
    expect(parseTyped('-12,50', 2)).toBe(-1250)
    expect(parseTyped('2417,60', 2)).toBe(241760)
  })

  it('un solo separatore con 1-2 cifre è sempre il decimale (tastiere che hanno solo il punto)', () => {
    expect(parseTyped('1500.50', 2)).toBe(150050)
    expect(parseTyped('2417.6', 2)).toBe(241760)
  })

  it('campi di testo in inglese', () => {
    setLang('en')
    expect(parseTyped('1,234.56', 2)).toBe(123456)
  })

  it('formattazione', () => {
    expect(plain(formatMoney(123456, EUR))).toBe('1.234,56 €')
    expect(plain(formatMoney(-1250, EUR))).toBe('−12,50 €')
    expect(plain(formatMoney(4800, ALL))).toBe('4.800 L')
    setLang('en')
    expect(formatMoney(123456, EUR)).toBe('€1,234.56')
  })

  it('conversione tra valute con decimali diversi', () => {
    // 1000 lek a 0,0095 €/lek = 9,50 €
    expect(convertMinor(1000, ALL, EUR, 0.0095)).toBe(950)
    expect(convertMinor(950, EUR, ALL, 105.26)).toBe(1000)
  })
})

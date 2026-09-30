import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_START, calcReduce, type State } from '../Calculator'
import { setLang } from '../i18n'

const run = (keys: string[], from: State = CALC_START) => keys.reduce(calcReduce, from)
const value = (s: State) => Number(s.entry)

describe('calcolatrice', () => {
  beforeEach(() => setLang('it'))

  it('operazioni di base e "=" ripetuto', () => {
    const s = run(['1', '2', '+', '5', '='])
    expect(value(s)).toBe(17)
    expect(value(calcReduce(s, '='))).toBe(22)
  })

  it('niente errori della virgola mobile', () => {
    expect(value(run(['0', '.', '1', '+', '0', '.', '2', '=']))).toBe(0.3)
  })

  it('da sinistra a destra, come la calcolatrice standard', () => {
    expect(value(run(['2', '+', '3', '×', '4', '=']))).toBe(20)
  })

  it('percentuale: con + è la percentuale del primo numero', () => {
    const s = run(['2', '0', '0', '+', '1', '0', '%'])
    expect(value(s)).toBe(20)
    expect(value(calcReduce(s, '='))).toBe(220)
  })

  it('divisione per zero e radice di un negativo danno errore, C riparte', () => {
    const div = run(['5', '÷', '0', '='])
    expect(div.error).toBe(true)
    expect(run(['C'], div)).toEqual(CALC_START)
    expect(run(['9', '±', '√x']).error).toBe(true)
  })

  it('funzioni: quadrato, inverso, cambio di segno, cancella', () => {
    expect(value(run(['8', 'x²']))).toBe(64)
    expect(value(run(['4', '1/x']))).toBe(0.25)
    expect(value(run(['7', '±']))).toBe(-7)
    expect(value(run(['1', '2', '3', '⌫']))).toBe(12)
  })
})

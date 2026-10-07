import { useEffect, useMemo, useRef, useState } from 'react'
import type { Currency, Transaction } from './db'
import { fetchRate } from './money'
import { dayEnd, gotRate, lastRate, leaveRate, NO_RATES, needsFetch, originOf, rateKey, rateView, typeRate, type RateContext, type RateView } from './rate'

export interface RateHandle extends RateView {
  /** L'utente ha scritto nel campo. */
  type: (text: string) => void
  /** Il campo è stato lasciato: se è vuoto torna il cambio proposto. */
  leave: () => void
}

export interface RatesHandle {
  /** Cambio di una valuta verso la principale (per la principale stessa: nessun campo, vale 1). */
  of: (code: string) => RateView
  type: (code: string, text: string) => void
  leave: () => void
}

/**
 * Cambi verso la valuta principale di tutte le valute che un movimento tocca (la sua, quelle dei suoi conti),
 * per il giorno indicato (aaaa-mm-gg). `origins` dà, per sigla, il cambio "suo" del movimento in modifica.
 * Qui c'è solo il filo con React e con la rete: cosa mostrare e cosa vale lo decide rate.ts. I fatti sono
 * in comune: una valuta ha un solo cambio, che sia quella del movimento o quella di un conto.
 */
export function useRates(p: { transactions: Transaction[]; main: Currency; day: string; currencies: Currency[]; origins?: Record<string, RateContext['origin']> }): RatesHandle {
  const { transactions, main, day, currencies, origins } = p
  const [facts, setFacts] = useState(NO_RATES)
  const codes = currencies.map((c) => `${c.code}:${c.decimals}`).join(',')
  const lasts = useMemo(() => new Map(currencies.map((c) => [c.code, lastRate(transactions, c, main, dayEnd(day))])), [transactions, codes, main, day])
  const ctxOf = (code: string): RateContext => ({ from: code, to: main.code, day, origin: origins?.[code] ?? null, last: lasts.get(code) ?? null })
  const wanted = currencies.map((c) => ctxOf(c.code)).filter((c) => needsFetch(facts, c))
  const wantedKeys = wanted.map(rateKey).join('|')

  // Chiavi già chieste: con due valute l'effetto riparte quando arriva la prima risposta, e senza questo
  // richiederebbe di nuovo quella ancora in viaggio.
  const asked = useRef(new Set<string>())
  useEffect(() => {
    // Nessun annullamento: ogni risposta porta la sua chiave e finisce al suo posto, anche se arriva dopo
    // che valuta o giorno sono cambiati.
    for (const c of wanted) {
      const key = rateKey(c)
      if (asked.current.has(key)) continue
      asked.current.add(key)
      void fetchRate(c.from, c.to, new Date(c.day)).then((r) => setFacts((f) => gotRate(f, key, r)))
    }
  }, [wantedKeys])

  return {
    of: (code) => rateView(facts, ctxOf(code)),
    type: (code, text) => setFacts((f) => typeRate(f, ctxOf(code), text)),
    leave: () => setFacts(leaveRate),
  }
}

/** Il cambio di una sola valuta (allineamento del saldo): come useRates, con la sua vista già pronta. */
export function useRate(p: { transactions: Transaction[]; from: Currency; main: Currency; day: string; editing?: Transaction | null }): RateHandle {
  const { transactions, from, main, day, editing } = p
  const origin = useMemo(() => originOf(editing, from, main), [editing, from, main])
  const currencies = useMemo(() => [from], [from])
  const rates = useRates({ transactions, main, day, currencies, origins: { [from.code]: origin } })
  return { ...rates.of(from.code), type: (text) => rates.type(from.code, text), leave: rates.leave }
}

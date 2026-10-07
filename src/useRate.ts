import { useEffect, useMemo, useState } from 'react'
import type { Currency, Transaction } from './db'
import { fetchRate } from './money'
import { dayEnd, gotRate, lastRate, leaveRate, NO_RATES, needsFetch, originOf, rateKey, rateView, typeRate, type RateContext, type RateView } from './rate'

export interface RateHandle extends RateView {
  /** L'utente ha scritto nel campo. */
  type: (text: string) => void
  /** Il campo è stato lasciato: se è vuoto torna il cambio proposto. */
  leave: () => void
}

/**
 * Cambio di un movimento scritto in `from` verso la valuta principale, per il giorno indicato (aaaa-mm-gg).
 * Qui c'è solo il filo con React e con la rete: cosa mostrare e cosa vale lo decide rate.ts.
 */
export function useRate(p: { transactions: Transaction[]; from: Currency; main: Currency; day: string; editing?: Transaction | null }): RateHandle {
  const { transactions, from, main, day, editing } = p
  const [facts, setFacts] = useState(NO_RATES)
  const origin = useMemo(() => originOf(editing, from, main), [editing, from, main])
  const last = useMemo(() => lastRate(transactions, from, main, dayEnd(day)), [transactions, from, main, day])
  const ctx: RateContext = { from: from.code, to: main.code, day, origin, last }
  const key = rateKey(ctx)
  const wanted = needsFetch(facts, ctx)

  useEffect(() => {
    if (!wanted) return
    // Nessun annullamento: la risposta porta la sua chiave e finisce al suo posto, anche se arriva dopo
    // che valuta o giorno sono cambiati.
    void fetchRate(ctx.from, ctx.to, new Date(ctx.day)).then((r) => setFacts((f) => gotRate(f, key, r)))
  }, [wanted, key])

  return {
    ...rateView(facts, ctx),
    type: (text) => setFacts((f) => typeRate(f, ctx, text)),
    leave: () => setFacts(leaveRate),
  }
}

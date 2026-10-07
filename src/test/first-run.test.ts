import { beforeEach, describe, expect, it, vi } from 'vitest'

// La valuta stimata dipende dal computer che esegue i test: qui è sempre l'euro.
vi.mock('../currencyGuess', () => ({ guessCurrency: () => 'EUR' }))

import { accountBalanceOf } from '../data'
import { db, type Account, type Currency, type Transaction } from '../db'
import { knownCurrency, saveStartingBalances, setFirstRunCurrency, setSetup, undoStartingBalances, validCurrencyCode } from '../firstRun'
import { hasOpening, openingDateBefore, openingFromBalance, saveOpening } from '../opening'
import '../sync'

const NOW = new Date(2026, 9, 5, 12).getTime()
const DAY = 86_400_000

/** Le voci della coda si scrivono in una transazione a parte, un attimo dopo la modifica. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

/** Database appena creato, coi soli dati predefiniti. */
async function fresh() {
  // Prima si lasciano finire le scritture in coda del test precedente: il database sta per essere cancellato.
  await settle()
  await db.delete()
  await db.open()
}
const queued = async () => (await db.syncQueue.toArray()).map((q) => `${q.tbl}|${q.id}${q.deleted ? '|del' : ''}`).sort()

function expense(id: string, amount: number, date: number, extra: Partial<Transaction> = {}): Transaction {
  return { id, kind: 'expense', amount, currency: 'EUR', rate: 1, mainAmount: amount, date, accountId: 'acc-main', note: '', source: 'manual', ...extra }
}

describe('primo avvio: valuta', () => {
  beforeEach(fresh)

  it('cambia insieme impostazioni e conti predefiniti, e le modifiche vanno in coda', async () => {
    expect(await setFirstRunCurrency({ code: 'ALL', symbol: 'L', decimals: 0 })).toBe(true)
    expect((await db.settings.get('main'))?.mainCurrency).toBe('ALL')
    expect((await db.accounts.toArray()).map((a) => a.currency)).toEqual(['ALL', 'ALL'])
    await settle()
    expect(await queued()).toEqual(['accounts|acc-cash', 'accounts|acc-main', 'settings|main'])
  })

  it('una valuta nuova viene aggiunta all’elenco; una che c’è già no', async () => {
    expect(await setFirstRunCurrency({ code: 'JPY', symbol: '¥', decimals: 0 })).toBe(true)
    expect(await db.currencies.get('JPY')).toEqual({ code: 'JPY', symbol: '¥', decimals: 0 })
    // Il simbolo scelto per una valuta esistente non viene sovrascritto.
    expect(await setFirstRunCurrency({ code: 'USD', symbol: 'US$', decimals: 2 })).toBe(true)
    expect((await db.currencies.get('USD'))?.symbol).toBe('$')
    expect((await db.settings.get('main'))?.mainCurrency).toBe('USD')
  })

  it('un conto messo apposta in un’altra valuta resta com’è', async () => {
    await db.accounts.put({ id: 'acc-usd', name: 'Dollari', currency: 'USD', initialBalance: 0, initialMain: 0, order: 2, archived: false })
    await setFirstRunCurrency({ code: 'ALL', symbol: 'L', decimals: 0 })
    expect((await db.accounts.get('acc-usd'))?.currency).toBe('USD')
    expect((await db.accounts.get('acc-main'))?.currency).toBe('ALL')
  })

  it('provando più valute di fila, il conto tenuto apposta in un’altra non viene trascinato', async () => {
    await db.accounts.put({ id: 'acc-usd', name: 'Dollari', currency: 'USD', initialBalance: 0, initialMain: 0, order: 2, archived: false })
    // Il riquadro si segna i conti che ha visto in una valuta diversa dalla principale.
    const keep = new Set(['acc-usd'])
    await setFirstRunCurrency({ code: 'USD', symbol: '$', decimals: 2 }, keep)
    expect((await db.accounts.toArray()).map((a) => a.currency)).toEqual(['USD', 'USD', 'USD'])
    // Un conto nuovo nella valuta principale, arrivato dopo, la segue.
    await db.accounts.put({ id: 'acc-new', name: 'Nuovo', currency: 'USD', initialBalance: 0, initialMain: 0, order: 3, archived: false })
    await setFirstRunCurrency({ code: 'EUR', symbol: '€', decimals: 2 }, keep)
    expect((await db.accounts.get('acc-new'))?.currency).toBe('EUR')
    expect((await db.accounts.get('acc-usd'))?.currency).toBe('USD')
    expect((await db.accounts.get('acc-main'))?.currency).toBe('EUR')
    expect((await db.accounts.get('acc-cash'))?.currency).toBe('EUR')
  })

  it('con movimenti, obiettivi o ricorrenti non tocca niente (lì serve il cambio con tasso)', async () => {
    await db.transactions.put(expense('t1', 500, NOW))
    expect(await setFirstRunCurrency({ code: 'ALL', symbol: 'L', decimals: 0 })).toBe(false)
    await db.transactions.clear()
    await db.goals.put({ id: 'g1', name: 'Vacanza', target: 100000, color: '#000', order: 0, archived: false })
    expect(await setFirstRunCurrency({ code: 'ALL', symbol: 'L', decimals: 0 })).toBe(false)
    expect((await db.settings.get('main'))?.mainCurrency).toBe('EUR')
    expect((await db.accounts.toArray()).map((a) => a.currency)).toEqual(['EUR', 'EUR'])
  })

  it('codici e valute note al browser', () => {
    expect(validCurrencyCode('JPY')).toBe(true)
    expect(validCurrencyCode('jp')).toBe(false)
    expect(validCurrencyCode('EURO')).toBe(false)
    expect(knownCurrency('JPY')?.decimals).toBe(0)
    expect(knownCurrency('USD')).toEqual({ symbol: '$', decimals: 2 })
    expect(knownCurrency('KWD')?.decimals).toBe(3)
    expect(knownCurrency('??')).toBeNull()
  })
})

describe('primo avvio: saldi iniziali', () => {
  beforeEach(fresh)

  it('senza movimenti il saldo iniziale è la cifra scritta, datata adesso', async () => {
    const ids = await saveStartingBalances({ 'acc-main': 125050, 'acc-cash': 4000 }, NOW)
    expect(ids).toEqual(['opening-acc-main', 'opening-acc-cash'])
    const opening = await db.transactions.get('opening-acc-main')
    expect(opening).toMatchObject({ kind: 'opening', amount: 125050, mainAmount: 125050, rate: 1, currency: 'EUR', date: NOW, accountId: 'acc-main' })
    expect((await db.settings.get('main'))?.setup).toBe('done')
  })

  it('con movimenti già registrati la cifra scritta è il saldo di oggi: niente viene contato due volte', async () => {
    // Tre spese in contanti la mattina, poi la sera si scrive quanto c'è nel portafoglio.
    await db.transactions.bulkPut([
      expense('m1', 1200, NOW - 8 * 3_600_000, { accountId: 'acc-cash' }),
      expense('m2', 2200, NOW - 7 * 3_600_000, { accountId: 'acc-cash' }),
      expense('m3', 3000, NOW - 6 * 3_600_000, { accountId: 'acc-cash' }),
    ])
    await saveStartingBalances({ 'acc-cash': 7000 }, NOW)
    const opening = (await db.transactions.get('opening-acc-cash'))!
    expect(opening.amount).toBe(7000 + 6400)
    // Sta alla base del ramo: prima del movimento più vecchio.
    expect(opening.date).toBe(NOW - 8 * 3_600_000 - 60_000)
    const cash = (await db.accounts.get('acc-cash'))!
    expect(accountBalanceOf(cash, await db.transactions.toArray(), 'EUR', NOW)).toBe(7000)
  })

  it('entrate, giroconti e spese pagate da un obiettivo: il saldo di oggi torna comunque', async () => {
    await db.transactions.bulkPut([
      expense('stip', 180000, NOW - 5 * DAY, { kind: 'income' }),
      expense('giro', 20000, NOW - 4 * DAY, { kind: 'transfer', toAccountId: 'acc-cash' }),
      expense('bar', 1500, NOW - 3 * DAY, { accountId: 'acc-cash' }),
      // Messi da parte: escono dal disponibile ma restano sul conto.
      expense('via', 30000, NOW - 2 * DAY, { kind: 'save', goalId: 'g1' }),
      // Pagata coi soldi dell'obiettivo: dal conto escono davvero.
      expense('volo', 9000, NOW - DAY, { goalId: 'g1' }),
    ])
    await saveStartingBalances({ 'acc-main': 250000, 'acc-cash': 20000 }, NOW)
    const txs = await db.transactions.toArray()
    const main = (await db.accounts.get('acc-main'))!
    const cash = (await db.accounts.get('acc-cash'))!
    expect(accountBalanceOf(main, txs, 'EUR', NOW)).toBe(250000)
    expect(accountBalanceOf(cash, txs, 'EUR', NOW)).toBe(20000)
    // Conto: 250.000 − (180.000 − 20.000 − 9.000). Contanti: 20.000 − (20.000 − 1.500).
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(99000)
    expect((await db.transactions.get('opening-acc-cash'))?.amount).toBe(1500)
    // Ognuno prima del proprio movimento più vecchio (per i contanti, il giroconto in arrivo).
    expect((await db.transactions.get('opening-acc-main'))?.date).toBe(NOW - 5 * DAY - 60_000)
    expect((await db.transactions.get('opening-acc-cash'))?.date).toBe(NOW - 4 * DAY - 60_000)
  })

  it('le scadenze future non entrano nel conto', async () => {
    await db.transactions.put(expense('rent', 60000, NOW + 10 * DAY))
    await saveStartingBalances({ 'acc-main': 100000 }, NOW)
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(100000)
    expect((await db.transactions.get('opening-acc-main'))?.date).toBe(NOW)
  })

  it('non sostituisce un saldo iniziale che esiste già', async () => {
    const main = (await db.accounts.get('acc-main'))!
    await saveOpening(main, 50000, 50000, { rate: 1, date: NOW - DAY })
    const ids = await saveStartingBalances({ 'acc-main': 999, 'acc-cash': 2000 }, NOW)
    expect(ids).toEqual(['opening-acc-cash'])
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(50000)
  })

  it('vale solo per i conti nella valuta principale', async () => {
    await db.accounts.put({ id: 'acc-usd', name: 'Dollari', currency: 'USD', initialBalance: 0, initialMain: 0, order: 2, archived: false })
    expect(await saveStartingBalances({ 'acc-usd': 5000, nope: 100 }, NOW)).toEqual([])
    expect(await db.transactions.count()).toBe(0)
    // Nessuna risposta valida: il riquadro resta da completare.
    expect((await db.settings.get('main'))?.setup).toBeUndefined()
  })

  it('zero scritto apposta è una risposta: nessun movimento, riquadro chiuso', async () => {
    expect(await saveStartingBalances({ 'acc-main': 0 }, NOW)).toEqual([])
    expect(await db.transactions.count()).toBe(0)
    expect((await db.settings.get('main'))?.setup).toBe('done')
  })

  it('saldo negativo (conto in rosso)', async () => {
    await saveStartingBalances({ 'acc-main': -35000 }, NOW)
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(-35000)
  })

  it('“Annulla” toglie i saldi e rimette la risposta di prima', async () => {
    await setSetup('later')
    const ids = await saveStartingBalances({ 'acc-main': 1000 }, NOW)
    await undoStartingBalances(ids, 'later')
    expect(await db.transactions.count()).toBe(0)
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'EUR', setup: 'later' })
    await undoStartingBalances([], undefined)
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'EUR' })
  })

  it('la risposta al riquadro non tocca la valuta', async () => {
    await setFirstRunCurrency({ code: 'ALL', symbol: 'L', decimals: 0 })
    await setSetup('later')
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'ALL', setup: 'later' })
    await setSetup('done')
    expect((await db.settings.get('main'))?.setup).toBe('done')
    // Il database è stato ricreato più volte in questa pagina: le modifiche devono continuare a finire in coda.
    await settle()
    expect(await queued()).toEqual(['accounts|acc-cash', 'accounts|acc-main', 'settings|main'])
  })
})

describe('primo avvio: archivio dell’account non ancora scaricato', () => {
  beforeEach(async () => {
    await fresh()
    await db.syncMeta.bulkPut([
      { key: 'owner', value: 'user-1' },
      { key: 'adopt', value: 1 },
    ])
  })

  it('nessuna scrittura: quelli sul dispositivo sono solo dati predefiniti', async () => {
    expect(await setFirstRunCurrency({ code: 'ALL', symbol: 'L', decimals: 0 })).toBe(false)
    expect(await saveStartingBalances({ 'acc-main': 1000 }, NOW)).toEqual([])
    await setSetup('later')
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'EUR' })
    expect(await db.transactions.count()).toBe(0)
    await settle()
    expect(await queued()).toEqual([])
  })
})

describe('saldo iniziale impostato dall’allineamento di un conto', () => {
  const EUR: Currency = { code: 'EUR', symbol: '€', decimals: 2 }
  const USD: Currency = { code: 'USD', symbol: '$', decimals: 2 }
  const ALL: Currency = { code: 'ALL', symbol: 'L', decimals: 0 }
  const acc = (id: string, currency: string): Account => ({ id, name: id, currency, initialBalance: 0, initialMain: 0, order: 0, archived: false })

  it('conto con movimenti: saldo reale meno il loro effetto, in positivo e in negativo', () => {
    const txs = [expense('a', 2000, NOW - 3 * DAY), expense('b', 50000, NOW - 2 * DAY, { kind: 'income' })]
    // In FIG il conto è a +480 €; in banca ce ne sono 300: partiva da −180.
    expect(openingFromBalance(acc('acc-main', 'EUR'), 30000, txs, EUR, EUR, 1, NOW)).toEqual({ amount: -18000, mainAmount: -18000, date: NOW - 3 * DAY - 60_000 })
    // In banca ce ne sono 1.000: partiva da +520.
    expect(openingFromBalance(acc('acc-main', 'EUR'), 100000, txs, EUR, EUR, 1, NOW).amount).toBe(52000)
    // Già allineato: non serve nessun saldo iniziale.
    expect(openingFromBalance(acc('acc-main', 'EUR'), 48000, txs, EUR, EUR, 1, NOW).amount).toBe(0)
  })

  it('conto in un’altra valuta: importo nella sua valuta, controvalore col cambio', () => {
    const usd = acc('acc-usd', 'USD')
    const txs = [expense('c', 4000, NOW - DAY, { accountId: 'acc-usd', currency: 'USD', rate: 0.9, mainAmount: 3600 })]
    // 200 $ reali + 40 $ già spesi = 240 $ di partenza, che a 0,90 fanno 216 €.
    expect(openingFromBalance(usd, 20000, txs, USD, EUR, 0.9, NOW)).toEqual({ amount: 24000, mainAmount: 21600, date: NOW - DAY - 60_000 })
    // Valuta principale senza decimali (lek): 100 $ a 95 L fanno 9.500 L, non 950.000.
    expect(openingFromBalance(usd, 10000, [], USD, ALL, 95, NOW)).toEqual({ amount: 10000, mainAmount: 9500, date: NOW })
    // Conto in rosso: anche il controvalore è negativo.
    expect(openingFromBalance(usd, -5000, [], USD, EUR, 0.9, NOW).mainAmount).toBe(-4500)
  })
})

describe('saldo iniziale: data e presenza', () => {
  it('prima del movimento più vecchio del conto, giroconti in arrivo compresi', () => {
    const txs = [
      expense('a', 100, NOW - 3 * DAY, { accountId: 'acc-cash' }),
      expense('b', 100, NOW - 5 * DAY, { kind: 'transfer', accountId: 'acc-cash', toAccountId: 'acc-main' }),
      expense('c', 100, NOW - 9 * DAY, { accountId: 'other' }),
    ]
    expect(openingDateBefore('acc-main', txs, NOW)).toBe(NOW - 5 * DAY - 60_000)
    expect(openingDateBefore('acc-cash', txs, NOW)).toBe(NOW - 5 * DAY - 60_000)
    expect(openingDateBefore('empty', txs, NOW)).toBe(NOW)
    // Un movimento con data futura non sposta il saldo iniziale nel futuro.
    expect(openingDateBefore('acc-main', [expense('f', 100, NOW + DAY)], NOW)).toBe(NOW)
  })

  it('hasOpening guarda l’id fisso del conto', () => {
    const txs = [expense('opening-acc-main', 100, NOW, { kind: 'opening' })]
    expect(hasOpening('acc-main', txs)).toBe(true)
    expect(hasOpening('acc-cash', txs)).toBe(false)
  })
})

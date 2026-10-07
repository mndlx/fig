import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../currencyGuess', () => ({ guessCurrency: () => 'EUR' }))
// Il CSV non viene scaricato davvero: se ne guarda il contenuto.
vi.mock('../csv', async (original) => ({ ...(await original<typeof import('../csv')>()), download: vi.fn() }))

import { exportCsv } from '../backup'
import { download } from '../csv'
import { db, type Account, type Currency, type Transaction } from '../db'
import { setLang } from '../i18n'
import { convertMinor, impliedRate, rateText, rebaseTransaction, soundRate } from '../money'
import { migrateInitialBalances, saveOpening } from '../opening'
import { ALL, EUR } from './helpers'

const USD: Currency = { code: 'USD', symbol: '$', decimals: 2 }
const KWD: Currency = { code: 'KWD', symbol: 'KD', decimals: 3 }

const row = (currency: string, amount: number, mainAmount: number, rate: number) => ({ currency, amount, mainAmount, rate })

describe('cambio che lega i due importi di un movimento', () => {
  it('si calcola sulle cifre vere, non sulle unità minime', () => {
    // 100,00 $ che valgono 9.200 L: un dollaro vale 92 lek (sulle unità minime verrebbe 0,92).
    expect(impliedRate(10000, USD, 9200, ALL)).toBe(92)
    // 150.000 L che valgono 1.545,00 €: un lek vale 0,0103 euro (sulle unità minime verrebbe 1,03).
    expect(impliedRate(150000, ALL, 154500, EUR)).toBeCloseTo(0.0103, 10)
    // Tre decimali contro due: 1,500 KD che valgono 4,50 €.
    expect(impliedRate(1500, KWD, 450, EUR)).toBe(3)
    // Stessi decimali: il rapporto è quello degli importi.
    expect(impliedRate(10000, USD, 9200, EUR)).toBe(0.92)
    // Conto in rosso: il cambio è sempre positivo.
    expect(impliedRate(-10000, USD, -9200, ALL)).toBe(92)
    expect(impliedRate(0, USD, 0, ALL)).toBeNull()
    expect(impliedRate(1, EUR, 0, ALL)).toBeNull()
  })
})

describe('cambio da usare nei calcoli', () => {
  it('quello salvato, quando torna coi suoi importi', () => {
    expect(soundRate(row('USD', 10000, 9200, 92), USD, ALL)).toBe(92)
    // Scarti di arrotondamento: 1,50 € a 97 fanno 145,5 lek, salvati come 146.
    expect(soundRate(row('EUR', 150, 146, 97), EUR, ALL)).toBe(97)
    // Controvalore ritoccato di poco (per esempio da un import che sposta il saldo iniziale): resta quello salvato.
    expect(soundRate(row('USD', 10000, 9230, 92), USD, ALL)).toBe(92)
    // Conto in rosso col cambio giusto: il segno non c'entra col confronto.
    expect(soundRate(row('EUR', -150, -146, 97), EUR, ALL)).toBe(97)
    // Nella valuta principale il cambio è 1, qualunque cosa sia stata salvata.
    expect(soundRate(row('ALL', 5000, 5000, 7), ALL, ALL)).toBe(1)
  })

  it('quello vero, quando il salvato è sbagliato di scala (saldi iniziali delle versioni precedenti)', () => {
    // Conto in dollari in un archivio in lek: salvato 0,92 invece di 92.
    expect(soundRate(row('USD', 10000, 9200, 0.92), USD, ALL)).toBe(92)
    // Conto in lek in un archivio in euro: salvato 1,03 invece di 0,0103.
    expect(soundRate(row('ALL', 150000, 154500, 1.03), ALL, EUR)).toBeCloseTo(0.0103, 10)
    // Tre decimali contro due: salvato 0,3 invece di 3.
    expect(soundRate(row('KWD', 1500, 450, 0.3), KWD, EUR)).toBe(3)
    // Saldo negativo.
    expect(soundRate(row('USD', -10000, -9200, 0.92), USD, ALL)).toBe(92)
    // Cambio mancante o nullo.
    expect(soundRate(row('USD', 10000, 9200, 0), USD, ALL)).toBe(92)
    expect(soundRate(row('USD', 10000, 9200, NaN), USD, ALL)).toBe(92)
    // Appena fuori dalla tolleranza: 9.500 L non sono 100 $ a 92.
    expect(soundRate(row('USD', 10000, 9500, 92), USD, ALL)).toBe(95)
    // Controvalore di una sola unità minima: 0,01 $ = 1 L, salvato con cambio 1 invece di 100.
    expect(soundRate(row('USD', 1, 1, 1), USD, ALL)).toBe(100)
  })

  it('rifacendo il conto col cambio giusto si ritrova il controvalore, non cento volte tanto', () => {
    const bad = row('USD', 10000, 9200, 0.92)
    // Quello che succedeva modificando il saldo: 100,00 $ × 0,92 = 92 lek invece di 9.200.
    expect(convertMinor(bad.amount, USD, ALL, bad.rate)).toBe(92)
    expect(convertMinor(bad.amount, USD, ALL, soundRate(bad, USD, ALL))).toBe(9200)
    // E cambiando valuta principale (lek → euro a 0,0103): 94,76 €, non 0,95 €.
    expect(convertMinor(bad.amount, USD, EUR, bad.rate * 0.0103)).toBe(95)
    expect(convertMinor(bad.amount, USD, EUR, soundRate(bad, USD, ALL) * 0.0103)).toBe(9476)
  })

  it('senza importi da cui ricavarlo resta quello salvato', () => {
    expect(soundRate(row('USD', 0, 0, 92), USD, ALL)).toBe(92)
    // Importo così piccolo che il controvalore arrotonda a zero: 1 L a 0,004 fa 0,4 centesimi.
    expect(convertMinor(1, ALL, EUR, 0.004)).toBe(0)
    expect(soundRate(row('ALL', 1, 0, 0.004), ALL, EUR)).toBe(0.004)
    // Dati arrivati da fuori senza un cambio: zero, non un valore che manda in errore chi lo usa.
    expect(soundRate(row('USD', 500, 0, undefined as unknown as number), USD, ALL)).toBe(0)
  })

  it('come testo: poche cifre, niente code dei calcoli', () => {
    expect(rateText(92)).toBe('92')
    expect(rateText(0.0103)).toBe('0.0103')
    expect(rateText(89.35357952000001)).toBe('89.35357952')
    expect(rateText(0.9212350959046138)).toBe('0.9212350959')
  })
})

describe('movimenti dopo il cambio della valuta principale', () => {
  const tx = (extra: Partial<Transaction>): Transaction => ({ id: 't', kind: 'expense', amount: 0, currency: 'ALL', rate: 1, mainAmount: 0, date: 0, accountId: 'acc-main', note: '', source: 'manual', ...extra })
  // Da lek a euro: 1 lek = 0,0103 euro.
  const X = 0.0103

  it('saldo iniziale di un conto in dollari col cambio sbagliato delle versioni precedenti', () => {
    const before = tx({ kind: 'opening', amount: 10000, currency: 'USD', rate: 0.92, mainAmount: 9200 })
    const after = rebaseTransaction(before, USD, ALL, EUR, X)
    // 100,00 $ = 9.200 L = 94,76 € (col cambio salvato sarebbero 0,95 €).
    expect(after).toMatchObject({ amount: 10000, currency: 'USD', mainAmount: 9476 })
    expect(after.rate).toBeCloseTo(0.9476, 10)
  })

  it('movimento nella vecchia valuta principale: stesso importo, controvalore col cambio dato', () => {
    expect(rebaseTransaction(tx({ amount: 1500, mainAmount: 1500 }), ALL, ALL, EUR, X)).toMatchObject({ amount: 1500, currency: 'ALL', mainAmount: 1545, rate: X })
  })

  it('saldo negativo: si arrotonda il valore, poi si rimette il segno', () => {
    // 150 L a 0,0103 fanno 1,545 €: arrotondato a 1,55, col meno davanti.
    expect(rebaseTransaction(tx({ kind: 'opening', amount: -150, mainAmount: -150 }), ALL, ALL, EUR, X).mainAmount).toBe(-155)
    // Nell'altro verso: -1,50 € a 97 fanno -145,5 lek, cioè -146.
    expect(rebaseTransaction(tx({ kind: 'opening', amount: -150, currency: 'EUR', mainAmount: -150 }), EUR, EUR, ALL, 97).mainAmount).toBe(-146)
  })

  it('movimento già nella nuova valuta principale: il controvalore è l’importo', () => {
    expect(rebaseTransaction(tx({ amount: 2000, currency: 'EUR', rate: 97, mainAmount: 1940 }), EUR, ALL, EUR, X)).toMatchObject({ amount: 2000, currency: 'EUR', mainAmount: 2000, rate: 1 })
  })

  it('movimento in una terza valuta col cambio giusto: si usa quello salvato, non quello ricavato dagli importi', () => {
    // 1,50 € a 97 = 146 L (145,5 arrotondato). Da lek a dollari a 0,0095: 1,50 × 0,9215 = 1,38 $.
    // Ricavando il cambio dagli importi (97,33) verrebbe 1,39 $.
    const after = rebaseTransaction(tx({ amount: 150, currency: 'EUR', rate: 97, mainAmount: 146 }), EUR, ALL, USD, 0.0095)
    expect(after.mainAmount).toBe(138)
    expect(after.rate).toBeCloseTo(0.9215, 10)
  })

  it('messi da parte e ripresi: restano scritti com’erano, cambia solo il controvalore', () => {
    // 10.000 L messi da parte valgono 103,00 €; 2.000 L ripresi ne valgono 20,60.
    expect(rebaseTransaction(tx({ kind: 'save', amount: 10000, mainAmount: 10000, goalId: 'g1' }), ALL, ALL, EUR, X)).toMatchObject({ currency: 'ALL', amount: 10000, mainAmount: 10300, rate: X })
    expect(rebaseTransaction(tx({ kind: 'release', amount: 2000, mainAmount: 2000, goalId: 'g1' }), ALL, ALL, EUR, X)).toMatchObject({ currency: 'ALL', amount: 2000, mainAmount: 2060, rate: X })
  })

  it('andata e ritorno (euro → lek → euro): si ritrovano le cifre scritte, al centesimo', () => {
    // 1.000,00 € messi da parte e 1.000,00 € spesi dallo stesso gomitolo: devono restare pari.
    const save = tx({ kind: 'save', amount: 100000, currency: 'EUR', mainAmount: 100000, goalId: 'g1' })
    const spent = tx({ kind: 'expense', amount: 100000, currency: 'EUR', mainAmount: 100000, goalId: 'g1' })
    const there = [save, spent].map((t) => rebaseTransaction(t, EUR, EUR, ALL, 97))
    expect(there.map((t) => t.mainAmount)).toEqual([97000, 97000])
    // Al ritorno il cambio scritto a mano non è l'inverso esatto (1/97 = 0,010309…): non deve contare.
    const back = there.map((t) => rebaseTransaction(t, EUR, ALL, EUR, X))
    expect(back[0]).toMatchObject({ currency: 'EUR', amount: 100000, mainAmount: 100000, rate: 1 })
    expect(back[1]).toMatchObject({ currency: 'EUR', amount: 100000, mainAmount: 100000, rate: 1 })
    // Anche con importi che in lek si arrotondano: 1,50 € → 146 L → 1,50 €.
    const small = rebaseTransaction(rebaseTransaction(tx({ kind: 'save', amount: 150, currency: 'EUR', mainAmount: 150 }), EUR, EUR, ALL, 97), EUR, ALL, EUR, X)
    expect(small).toMatchObject({ amount: 150, mainAmount: 150 })
  })

  it('messo da parte rimasto in una valuta che non è né la vecchia né la nuova principale', () => {
    // Scritto in euro (1.000,00 €), archivio poi passato ai lek (97.000 L), ora ai dollari a 0,0095: 921,50 $.
    const after = rebaseTransaction(tx({ kind: 'save', amount: 100000, currency: 'EUR', rate: 97, mainAmount: 97000 }), EUR, ALL, USD, 0.0095)
    expect(after).toMatchObject({ currency: 'EUR', amount: 100000, mainAmount: 92150 })
  })

  it('importo zero: resta zero', () => {
    expect(rebaseTransaction(tx({ amount: 0, mainAmount: 0 }), ALL, ALL, EUR, X).mainAmount).toBe(0)
  })
})

describe('saldo iniziale salvato nel database', () => {
  const account = (id: string, currency: string, extra: Partial<Account> = {}): Account => ({ id, name: id, currency, initialBalance: 0, initialMain: 0, order: 5, archived: false, ...extra })

  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('il cambio è quello indicato da chi salva', async () => {
    const usd = account('acc-usd', 'USD')
    await db.accounts.put(usd)
    // Cifre in cui il cambio non coincide col rapporto tra le unità minime (che darebbe 0,92): 100,00 $ = 9.200 L.
    const saved = await saveOpening(usd, 10000, 9200, { rate: 92, date: 1000 })
    expect(saved).toMatchObject({ id: 'opening-acc-usd', kind: 'opening', amount: 10000, mainAmount: 9200, rate: 92, date: 1000, currency: 'USD' })
    // Modificandolo restano data e nota, cambia il resto.
    await db.transactions.update('opening-acc-usd', { note: 'Dal vecchio conto' })
    const again = await saveOpening(usd, 20000, 18600, { rate: 93, date: 9999 })
    expect(again).toMatchObject({ amount: 20000, mainAmount: 18600, rate: 93, date: 1000, note: 'Dal vecchio conto' })
    // Con importo zero il saldo iniziale viene tolto.
    expect(await saveOpening(usd, 0, 0, { rate: 93 })).toBeUndefined()
    expect(await db.transactions.get('opening-acc-usd')).toBeUndefined()
  })

  it('saldi iniziali delle versioni precedenti: il cambio si ricava dalle cifre vere, anche con decimali diversi', async () => {
    // Archivio in lek con un conto in dollari (100,00 $ = 9.200 L) e uno in lek.
    await db.settings.put({ id: 'main', mainCurrency: 'ALL' })
    await db.accounts.bulkPut([account('acc-usd', 'USD', { initialBalance: 10000, initialMain: 9200 }), account('acc-lek', 'ALL', { initialBalance: 70000, initialMain: 70000 })])
    await migrateInitialBalances()
    expect(await db.transactions.get('opening-acc-usd')).toMatchObject({ amount: 10000, mainAmount: 9200, rate: 92, currency: 'USD' })
    expect(await db.transactions.get('opening-acc-lek')).toMatchObject({ amount: 70000, mainAmount: 70000, rate: 1, currency: 'ALL' })
    expect(await db.accounts.get('acc-usd')).toMatchObject({ initialBalance: 0, initialMain: 0 })
  })

  it('nel CSV esce il cambio vero, non quello sbagliato salvato dalle versioni precedenti', async () => {
    setLang('en')
    await db.settings.put({ id: 'main', mainCurrency: 'ALL' })
    await db.accounts.put(account('acc-usd', 'USD'))
    await db.transactions.put({ id: 'opening-acc-usd', kind: 'opening', amount: 10000, currency: 'USD', rate: 0.92, mainAmount: 9200, date: 1000, accountId: 'acc-usd', note: '', source: 'manual' })
    await exportCsv()
    const content = vi.mocked(download).mock.calls.at(-1)![1]
    const cells = content
      .split('\r\n')
      .find((line) => line.includes('USD'))!
      .split(',')
    const at = cells.indexOf('USD')
    // Importo, valuta, cambio, controvalore: 100,00 $ a 92 = 9.200 L.
    expect(cells.slice(at - 1, at + 3)).toEqual(['100.00', 'USD', '92', '9200'])
  })

  it('lo stesso nell’altro verso: archivio in euro, conto in lek', async () => {
    await db.accounts.put(account('acc-lek', 'ALL', { initialBalance: 150000, initialMain: 154500 }))
    await migrateInitialBalances()
    const opening = (await db.transactions.get('opening-acc-lek')) as Transaction
    expect(opening.rate).toBeCloseTo(0.0103, 10)
    // Col cambio salvato il controvalore si ritrova.
    expect(convertMinor(opening.amount, ALL, EUR, opening.rate)).toBe(opening.mainAmount)
  })
})

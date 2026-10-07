import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Currency, Transaction } from '../db'
import { setLang } from '../i18n'
import { convertMinor, fetchRate, rateText, soundRate } from '../money'
import { dayEnd, dayKey, gotRate, lastRate, leaveRate, needsFetch, NO_RATES, originOf, proposeRate, rateInput, rateKey, rateView, readRate, settle, typeRate, type RateContext, type RateFacts, type RateSource } from '../rate'
import { rateShown } from '../RateField'
import { ALL, EUR, tx } from './helpers'

const USD: Currency = { code: 'USD', symbol: '$', decimals: 2 }
const day = (d: number, h = 12) => new Date(2026, 9, d, h).getTime()
/** Movimento in euro in un archivio in lek: 10,00 € al cambio dato. */
const eur = (date: number, rate: number, extra: Partial<Transaction> = {}) => tx('expense', 1000, date, { rate, mainAmount: convertMinor(1000, EUR, ALL, rate), ...extra })

describe('cambio scritto a mano', () => {
  for (const lang of ['it', 'en'] as const) {
    it(`un solo separatore è sempre il decimale (${lang})`, () => {
      setLang(lang)
      expect(readRate('97')).toBe(97)
      expect(readRate('97,35')).toBe(97.35)
      expect(readRate('97.35')).toBe(97.35)
      expect(readRate('0,0103')).toBe(0.0103)
      // A differenza degli importi (readTyped), tre cifre dopo il separatore non sono migliaia.
      expect(readRate('1.085')).toBe(1.085)
      expect(readRate('1,085')).toBe(1.085)
      expect(readRate('25.000')).toBe(25)
      expect(readRate(',5')).toBe(0.5)
      expect(readRate('5,')).toBe(5)
      expect(readRate(' 97,35 ')).toBe(97.35)
    })

    it(`punto e virgola insieme: l'ultimo è il decimale, l'altro raggruppa (${lang})`, () => {
      setLang(lang)
      expect(readRate('1.234,5')).toBe(1234.5)
      expect(readRate('1,234.5')).toBe(1234.5)
      expect(readRate('1.234,567')).toBe(1234.567)
      expect(readRate('1.234.567')).toBe(1234567)
      expect(readRate('1,234,567')).toBe(1234567)
      expect(readRate('1 234,5')).toBe(1234.5)
      expect(readRate("1'234.5")).toBe(1234.5)
    })

    it(`quello che non è un cambio non passa (${lang})`, () => {
      setLang(lang)
      for (const bad of ['', ' ', ',', '.', '-5', '−5', '+5', '1e5', '1e-7', 'Infinity', 'NaN', '0x10', '97 L', 'abc', '12,3,4', '1..2', '1.2.3', '12.34,5', '1.234,5,6', '1,2345.6', '0.001.5'])
        expect(readRate(bad), bad).toBeNull()
    })
  }

  it('mentre si scrive: zero non è ancora un cambio', () => {
    for (const partial of ['0', '0,', '0,0', '0.000']) expect(readRate(partial), partial).toBeNull()
    expect(readRate('0,01')).toBe(0.01)
  })
})

describe('cambio da mostrare nel campo', () => {
  beforeEach(() => setLang('it'))

  it('separatore della lingua, niente code dei calcoli', () => {
    expect(rateInput(97.35)).toBe('97,35')
    expect(rateInput(92)).toBe('92')
    expect(rateInput(0.0103)).toBe('0,0103')
    expect(rateInput(89.35357952000001)).toBe('89,35357952')
    expect(rateInput(123456.789)).toBe('123456,789')
    setLang('en')
    expect(rateInput(97.35)).toBe('97.35')
  })

  it('numeri piccolissimi: mai la notazione esponenziale', () => {
    expect(String(9.5e-7)).toBe('9.5e-7')
    expect(rateText(9.5e-7)).toBe('0.00000095')
    expect(rateInput(9.5e-7)).toBe('0,00000095')
    expect(rateInput(1e-7)).toBe('0,0000001')
    expect(rateInput(1.2345678912e-7)).toBe('0,0000001234567891')
  })

  it('niente da mostrare: campo vuoto', () => {
    for (const none of [0, -3, NaN, Infinity]) expect(rateInput(none)).toBe('')
  })

  it('andata e ritorno: quello che si mostra si rilegge uguale, in tutte e due le lingue', () => {
    for (const lang of ['it', 'en'] as const) {
      setLang(lang)
      for (const x of [92, 97.35, 0.0103, 1.0853, 0.9212350959046138, 89.24000000000001, 0.0000551, 9.5e-7, 1e-7, 16345.5, 1 / 3, 123456789.123])
        expect(readRate(rateInput(x)), `${lang} ${x}`).toBe(Number(rateText(x)))
    }
  })

  it('cambi scaricati: non si tagliano più a sei decimali', () => {
    // Quello che faceva toFixed(6): 0,2% in meno, e zero sotto mezzo milionesimo.
    expect(String(Number((0.0000551).toFixed(6)))).toBe('0.000055')
    expect(String(Number((1e-7).toFixed(6)))).toBe('0')
    expect(rateInput(0.0000551)).toBe('0,0000551')
    // I cambi normali non cambiano.
    for (const r of [1.0853, 0.92, 97.35, 16345.5]) expect(rateText(r)).toBe(String(Number(r.toFixed(6))))
  })
})

describe('cambio mostrato sulla pillola', () => {
  it('poche cifre, decimale della lingua, mai le migliaia: riscritto com’è si rilegge uguale', () => {
    setLang('it')
    expect(rateShown(97.35)).toBe('97,35')
    expect(rateShown(0.0103)).toBe('0,0103')
    expect(rateShown(97.123456789)).toBe('97,1235')
    // Con le migliaia sarebbe "1.600", che nel campo vale uno virgola sei.
    expect(rateShown(1600)).toBe('1600')
    expect(rateShown(25000.5)).toBe('25000,5')
    setLang('en')
    expect(rateShown(1600)).toBe('1600')
    expect(rateShown(97.35)).toBe('97.35')
    for (const lang of ['it', 'en'] as const) {
      setLang(lang)
      for (const x of [97.35, 1600, 1612, 25000.5, 0.0103, 163.42]) expect(readRate(rateShown(x)), `${lang} ${x}`).toBe(x)
    }
  })
})

describe('giorno del movimento', () => {
  it('il giorno locale di un istante, e la sua fine', () => {
    expect(dayKey(new Date(2026, 9, 7, 0, 5).getTime())).toBe('2026-10-07')
    expect(dayKey(new Date(2026, 9, 7, 23, 55).getTime())).toBe('2026-10-07')
    expect(dayKey(new Date(2026, 0, 3, 12).getTime())).toBe('2026-01-03')
    expect(dayEnd('2026-10-07')).toBe(new Date(2026, 9, 7, 23, 59, 59).getTime())
    expect(dayKey(dayEnd('2026-10-07'))).toBe('2026-10-07')
  })
})

describe('ultimo cambio usato per una valuta', () => {
  it('niente movimenti in quella valuta: nessun cambio', () => {
    expect(lastRate([], EUR, ALL, day(7))).toBeNull()
    expect(lastRate([tx('expense', 1000, day(1), { currency: 'USD', rate: 92, mainAmount: 920 })], EUR, ALL, day(7))).toBeNull()
    // La valuta principale non ha un cambio.
    expect(lastRate([tx('expense', 1000, day(1), { currency: 'ALL' })], ALL, ALL, day(7))).toBeNull()
  })

  it('il più vicino nel tempo, con la data del movimento da cui viene; a pari distanza il più recente', () => {
    expect(lastRate([eur(day(1), 96), eur(day(5), 97.5)], EUR, ALL, day(7))).toEqual({ rate: 97.5, at: day(5) })
    // Movimento retrodatato: il cambio di allora, non l'ultimo.
    expect(lastRate([eur(day(1), 96), eur(day(20), 99)], EUR, ALL, day(3))).toEqual({ rate: 96, at: day(1) })
    expect(lastRate([eur(day(3), 96), eur(day(11), 99)], EUR, ALL, day(7))).toEqual({ rate: 99, at: day(11) })
    expect(lastRate([eur(day(11), 99), eur(day(3), 96)], EUR, ALL, day(7))).toEqual({ rate: 99, at: day(11) })
  })

  it('le scadenze generate dalle serie ripetono il cambio della serie: contano solo se non c’è altro', () => {
    // Serie nata il 1 settembre a 100: la scadenza del 6 ottobre ripete quel cambio.
    const born = eur(new Date(2026, 8, 1, 12).getTime(), 100, { recurringId: 'r1' })
    const due = eur(day(6), 100, { recurringId: 'r1' })
    expect(lastRate([born, eur(day(2), 96), due], EUR, ALL, day(7))).toEqual({ rate: 96, at: day(2) })
    expect(lastRate([due, eur(day(2), 96), born], EUR, ALL, day(7))).toEqual({ rate: 96, at: day(2) })
    // Senza altro vale anche quella, la più vicina.
    expect(lastRate([born, due], EUR, ALL, day(7))).toEqual({ rate: 100, at: born.date })
  })

  it('la prima di una serie è il movimento scritto a mano quel giorno: conta come gli altri', () => {
    // 12 gennaio: spesa singola a 103. 1 ottobre: affitto con "Ripeti", cambio scritto a mano 98,2.
    const january = eur(new Date(2026, 0, 12, 12).getTime(), 103)
    const rent = eur(day(1), 98.2, { recurringId: 'r1' })
    expect(lastRate([january, rent], EUR, ALL, day(7))).toEqual({ rate: 98.2, at: day(1) })
    // La scadenza di novembre, generata, non scavalca niente; quella scritta a mano resta la più vicina.
    const november = eur(new Date(2026, 10, 1, 12).getTime(), 98.2, { recurringId: 'r1' })
    expect(lastRate([january, rent, november], EUR, ALL, day(7))).toEqual({ rate: 98.2, at: day(1) })
    expect(lastRate([january, november], EUR, ALL, new Date(2026, 10, 2).getTime())?.at).toBe(november.date)
  })

  it('il cambio è quello vero del movimento, e uno inservibile si salta', () => {
    // Saldo iniziale delle versioni precedenti: 100,00 € = 9.700 L salvato con 0,97.
    expect(lastRate([tx('opening', 10000, day(1), { rate: 0.97, mainAmount: 9700 })], EUR, ALL, day(7))?.rate).toBe(97)
    expect(lastRate([tx('expense', 500, day(1), { rate: 0, mainAmount: 0 }), tx('expense', 500, day(2), { rate: undefined as unknown as number, mainAmount: 0 })], EUR, ALL, day(7))).toBeNull()
  })
})

describe('movimento in modifica', () => {
  it('giorno e cambio vero, solo se è scritto nella valuta che si sta guardando', () => {
    expect(originOf(null, EUR, ALL)).toBeNull()
    expect(originOf(undefined, EUR, ALL)).toBeNull()
    expect(originOf(eur(day(5), 97.35), EUR, ALL)).toEqual({ day: '2026-10-05', rate: 97.35 })
    // Il giorno è quello locale, come quello scelto nel foglio: a mezzanotte e mezza e alle undici e mezza di sera.
    expect(originOf(eur(day(5, 0) + 30 * 60_000, 97), EUR, ALL)?.day).toBe('2026-10-05')
    expect(originOf(eur(day(5, 23) + 30 * 60_000, 97), EUR, ALL)?.day).toBe('2026-10-05')
    // Altra valuta scelta nel foglio, o valuta principale (i gomitoli): non c'è un cambio suo.
    expect(originOf(eur(day(5), 97.35), USD, ALL)).toBeNull()
    expect(originOf(tx('expense', 1500, day(5), { currency: 'ALL' }), ALL, ALL)).toBeNull()
    // Saldo iniziale delle versioni precedenti: 100,00 $ = 9.200 L salvato con 0,92.
    expect(originOf(tx('opening', 10000, day(5), { currency: 'USD', rate: 0.92, mainAmount: 9200 }), USD, ALL)?.rate).toBe(92)
  })
})

describe('quello che il campo mostra', () => {
  beforeEach(() => setLang('it'))
  const LAST = { rate: 97, at: day(2) }
  const ctx = (extra: Partial<RateContext> = {}): RateContext => ({ from: 'EUR', to: 'ALL', day: '2026-10-07', origin: null, last: null, ...extra })
  const got = (f: RateFacts, c: RateContext, value: number | null) => gotRate(f, rateKey(c), value)

  it('valuta principale: niente campo, cambio 1, niente da chiedere', () => {
    const c = ctx({ from: 'ALL' })
    expect(rateView(NO_RATES, c)).toMatchObject({ foreign: false, value: 1, text: '', pending: false })
    expect(needsFetch(NO_RATES, c)).toBe(false)
    expect(typeRate(NO_RATES, c, '5')).toBe(NO_RATES)
  })

  it('movimento nuovo, cambio che non si scarica mai (lek): subito l’ultimo usato, e resta', () => {
    const c = ctx({ last: LAST })
    expect(rateView(NO_RATES, c)).toEqual({ foreign: true, text: '97', value: 97, source: 'last', proposal: { value: 97, source: 'last' }, at: day(2), pending: true })
    expect(needsFetch(NO_RATES, c)).toBe(true)
    const answered = got(NO_RATES, c, null)
    expect(rateView(answered, c)).toMatchObject({ text: '97', value: 97, source: 'last', pending: false })
    expect(needsFetch(answered, c)).toBe(false)
  })

  it('nessun cambio da nessuna parte: vuoto, da scrivere', () => {
    const c = ctx()
    expect(rateView(NO_RATES, c)).toMatchObject({ text: '', value: null, source: 'none', proposal: null, pending: true })
    const view = rateView(got(NO_RATES, c, null), c)
    expect(view).toMatchObject({ text: '', value: null, source: 'none', pending: false })
    expect(settle(2000, EUR, ALL, view)).toBeNull()
  })

  it('con la rete: il cambio del giorno prende il posto dell’ultimo usato', () => {
    const c = ctx({ from: 'USD', last: { rate: 92, at: day(1) } })
    const view = rateView(got(NO_RATES, c, 92.37), c)
    expect(view).toMatchObject({ text: '92,37', value: 92.37, source: 'day', at: null, pending: false })
    expect(settle(10000, USD, ALL, view)).toEqual({ rate: 92.37, mainAmount: 9237 })
    // Risposte che non sono un cambio valgono come nessuna risposta.
    for (const junk of [0, -1, NaN, Infinity]) expect(rateView(got(NO_RATES, c, junk), c)).toMatchObject({ text: '92', source: 'last', pending: false })
  })

  it('un cambio arrivato non si perde per una risposta mancata dopo (richieste doppie)', () => {
    const c = ctx({ from: 'USD' })
    const once = got(NO_RATES, c, 92.37)
    expect(got(once, c, null)).toBe(once)
    expect(got(got(NO_RATES, c, null), c, 92.37).fetched[rateKey(c)]).toBe(92.37)
  })

  it('un cambio scritto a mano non viene mai sostituito, né dalla risposta né cambiando giorno', () => {
    const c = ctx({ last: LAST })
    const typed = typeRate(NO_RATES, c, '97,4')
    expect(rateView(typed, c)).toMatchObject({ text: '97,4', value: 97.4, source: 'typed', pending: false })
    // Scritto a mano: non si chiede nemmeno quello del giorno.
    expect(needsFetch(typed, c)).toBe(false)
    // Una risposta partita prima arriva lo stesso: resta quello scritto.
    const late = got(typed, c, 97.9)
    expect(rateView(late, c)).toMatchObject({ text: '97,4', value: 97.4, source: 'typed', proposal: { value: 97.9, source: 'day' } })
    expect(settle(2000, EUR, ALL, rateView(late, c))).toEqual({ rate: 97.4, mainAmount: 1948 })
    const other = ctx({ last: LAST, day: '2026-10-01' })
    expect(rateView(late, other)).toMatchObject({ text: '97,4', source: 'typed' })
    expect(needsFetch(late, other)).toBe(false)
  })

  it('risposta arrivata tardi per un’altra valuta: finisce al suo posto, non in questa', () => {
    const eurCtx = ctx({ last: LAST })
    const usdCtx = ctx({ from: 'USD' })
    const late = got(NO_RATES, usdCtx, 92.37)
    expect(rateView(late, eurCtx)).toMatchObject({ text: '97', source: 'last', pending: true })
    // Tornando al dollaro è già lì, senza chiederlo di nuovo.
    expect(rateView(late, usdCtx)).toMatchObject({ text: '92,37', source: 'day', pending: false })
    // E vale solo per quel giorno.
    expect(needsFetch(late, ctx({ from: 'USD', day: '2026-10-06' }))).toBe(true)
  })

  it('cambiando valuta non resta il cambio di prima, nemmeno se il nuovo non si trova', () => {
    const facts = got(typeRate(NO_RATES, ctx({ last: LAST }), '97,4'), ctx(), null)
    const usd = ctx({ from: 'USD' })
    // Quello scritto per l'euro non ferma la richiesta per il dollaro.
    expect(needsFetch(facts, usd)).toBe(true)
    expect(rateView(got(facts, usd, null), usd)).toMatchObject({ text: '', value: null, source: 'none' })
    expect(settle(10000, USD, ALL, rateView(got(facts, usd, null), usd))).toBeNull()
  })

  it('valuta estera → principale → di nuovo estera: si ritrova quello scritto per quella valuta', () => {
    const typed = typeRate(NO_RATES, ctx(), '97,4')
    expect(rateView(typed, ctx({ from: 'ALL' }))).toMatchObject({ foreign: false, value: 1 })
    expect(rateView(typed, ctx())).toMatchObject({ text: '97,4', source: 'typed' })
    expect(rateView(typed, ctx({ from: 'USD' }))).toMatchObject({ text: '', source: 'none' })
  })

  it('campo svuotato: resta vuoto mentre si scrive ma vale il cambio proposto; lasciandolo torna a mostrarlo', () => {
    const c = ctx({ last: LAST })
    const cleared = typeRate(NO_RATES, c, '')
    expect(rateView(cleared, c)).toMatchObject({ text: '', value: 97, source: 'last', proposal: { value: 97, source: 'last' } })
    // Non è scritto a mano: il cambio del giorno si chiede.
    expect(needsFetch(cleared, c)).toBe(true)
    expect(settle(2000, EUR, ALL, rateView(cleared, c))).toEqual({ rate: 97, mainAmount: 1940 })
    expect(rateView(leaveRate(cleared), c)).toMatchObject({ text: '97', value: 97, source: 'last' })
    // Senza niente da proporre resta da scrivere.
    expect(rateView(typeRate(NO_RATES, ctx(), '  '), ctx())).toMatchObject({ text: '', value: null, source: 'none' })
  })

  it('lasciando il campo si tolgono solo quelli vuoti, di ogni valuta', () => {
    const facts = typeRate(typeRate(typeRate(NO_RATES, ctx(), '97,4'), ctx({ from: 'USD' }), ''), ctx({ from: 'GBP' }), ' ')
    expect(leaveRate(facts).typed).toEqual({ 'EUR>ALL': '97,4' })
    const kept = typeRate(NO_RATES, ctx(), '97,4')
    expect(leaveRate(kept)).toBe(kept)
    expect(leaveRate(NO_RATES)).toBe(NO_RATES)
  })

  it('il testo scritto resta com’è stato scritto, tasto dopo tasto', () => {
    const c = ctx({ last: LAST })
    // Rimetterlo in bella copia mentre si scrive mangerebbe la virgola appena battuta.
    for (const text of ['97,', '97,0', '97,40', '1,0', '097', '97.5']) expect(rateView(typeRate(NO_RATES, c, text), c).text).toBe(text)
  })

  it('testo che non è un cambio: nessun valore, non quello proposto', () => {
    const c = ctx({ last: LAST })
    for (const text of ['abc', '0', '97,5,3', '-97']) {
      const view = rateView(typeRate(NO_RATES, c, text), c)
      expect(view, text).toMatchObject({ text, value: null, source: 'typed' })
      expect(settle(2000, EUR, ALL, view), text).toBeNull()
    }
  })

  describe('in modifica', () => {
    const origin = { day: '2026-10-05', rate: 97 }
    const edit = (extra: Partial<RateContext> = {}) => ctx({ day: '2026-10-05', origin, last: { rate: 98, at: day(6) }, ...extra })

    it('con valuta e giorno del movimento vale il suo cambio e non si chiede niente', () => {
      expect(rateView(NO_RATES, edit())).toMatchObject({ text: '97', value: 97, source: 'own', pending: false })
      expect(needsFetch(NO_RATES, edit())).toBe(false)
      // Anche se una risposta per quel giorno ci fosse, non lo tocca: modificare la nota non rivaluta il movimento.
      expect(rateView(got(NO_RATES, edit(), 97.9), edit())).toMatchObject({ text: '97', source: 'own' })
    })

    it('cambiando giorno si propone quello scaricato; tornando indietro si rimette il suo', () => {
      const moved = edit({ day: '2026-10-06' })
      expect(needsFetch(NO_RATES, moved)).toBe(true)
      // Finché non arriva resta il suo.
      expect(rateView(NO_RATES, moved)).toMatchObject({ text: '97', source: 'own', pending: true })
      const fetched = got(NO_RATES, moved, 97.9)
      expect(rateView(fetched, moved)).toMatchObject({ text: '97,9', value: 97.9, source: 'day' })
      expect(rateView(fetched, edit())).toMatchObject({ text: '97', value: 97, source: 'own', pending: false })
    })

    it('giorno cambiato e cambio non scaricabile: resta il suo, non quello di un altro movimento', () => {
      const moved = edit({ day: '2026-10-06' })
      expect(rateView(got(NO_RATES, moved, null), moved)).toMatchObject({ text: '97', value: 97, source: 'own', pending: false })
    })

    it('altra valuta e ritorno: di nuovo il suo', () => {
      const usd = edit({ from: 'USD', origin: null, last: { rate: 92, at: day(1) } })
      expect(rateView(NO_RATES, usd)).toMatchObject({ text: '92', source: 'last', pending: true })
      expect(rateView(got(NO_RATES, usd, null), edit())).toMatchObject({ text: '97', source: 'own' })
    })

    it('scritto a mano in modifica: resta quello, anche cambiando giorno e tornando', () => {
      const typed = typeRate(NO_RATES, edit(), '98')
      for (const c of [edit(), edit({ day: '2026-10-06' }), edit()]) expect(rateView(typed, c)).toMatchObject({ text: '98', value: 98, source: 'typed' })
    })

    it('movimento senza un cambio che si possa usare: come uno nuovo, mai "0" nel campo', () => {
      for (const rate of [0, NaN, -3]) {
        const c = edit({ origin: { day: '2026-10-05', rate } })
        expect(needsFetch(NO_RATES, c)).toBe(true)
        expect(rateView(NO_RATES, c)).toMatchObject({ text: '98', source: 'last' })
        expect(rateView(NO_RATES, edit({ origin: { day: '2026-10-05', rate }, last: null }))).toMatchObject({ text: '', value: null, source: 'none' })
        expect(proposeRate(NO_RATES, edit({ origin: { day: '2026-10-05', rate }, last: null }))).toBeNull()
      }
    })
  })
})

describe('cambio e controvalore da salvare', () => {
  const v = (value: number | null, source: RateSource = 'typed') => ({ value, source })

  it('valuta principale: cambio 1, controvalore uguale all’importo', () => {
    expect(settle(1500, ALL, ALL, v(1, 'none'))).toEqual({ rate: 1, mainAmount: 1500 })
    expect(settle(-1500, ALL, ALL, v(7))).toEqual({ rate: 1, mainAmount: -1500 })
  })

  it('in valuta: importo per cambio, col segno a parte; senza cambio niente', () => {
    expect(settle(2000, EUR, ALL, v(97.35, 'last'))).toEqual({ rate: 97.35, mainAmount: 1947 })
    // -1,50 € a 97 fanno -145,5: 146 col meno davanti, non -145.
    expect(settle(-150, EUR, ALL, v(97))).toEqual({ rate: 97, mainAmount: -146 })
    for (const none of [null, 0, NaN, -2, Infinity]) expect(settle(2000, EUR, ALL, v(none))).toBeNull()
  })

  it('in modifica, niente di toccato: cambio e controvalore restano al centesimo', () => {
    // Saldo iniziale spostato da un import delle versioni precedenti: 100,00 $ a 92 con 9.230 L (rifatto: 9.200).
    const shifted = { amount: 10000, currency: 'USD', rate: 92, mainAmount: 9230 }
    expect(settle(10000, USD, ALL, v(soundRate(shifted, USD, ALL), 'own'), shifted)).toEqual({ rate: 92, mainAmount: 9230 })
    // Movimento in dollari dopo un cambio della valuta principale (0,92 × 97): il cambio ha più cifre di quelle
    // che il campo mostra, e rifatto da quel testo il controvalore perderebbe un lek.
    const rate = 0.92 * 97
    const rebased = { amount: 36250, currency: 'USD', rate, mainAmount: convertMinor(36250, USD, ALL, rate) }
    expect(convertMinor(36250, USD, ALL, readRate(rateInput(rate))!)).not.toBe(rebased.mainAmount)
    expect(settle(36250, USD, ALL, v(soundRate(rebased, USD, ALL), 'own'), rebased)).toEqual({ rate, mainAmount: rebased.mainAmount })
    // Conto in rosso.
    const red = { amount: -10000, currency: 'USD', rate: 92, mainAmount: -9230 }
    expect(settle(-10000, USD, ALL, v(92, 'own'), red)).toEqual({ rate: 92, mainAmount: -9230 })
  })

  it('in modifica, toccato importo, cambio, segno o valuta: si rifà il conto', () => {
    const shifted = { amount: 10000, currency: 'USD', rate: 92, mainAmount: 9230 }
    expect(settle(20000, USD, ALL, v(92, 'own'), shifted)).toEqual({ rate: 92, mainAmount: 18400 })
    expect(settle(-10000, USD, ALL, v(92, 'own'), shifted)).toEqual({ rate: 92, mainAmount: -9200 })
    expect(settle(10000, EUR, ALL, v(92, 'own'), shifted)).toEqual({ rate: 92, mainAmount: 9200 })
    // Cambio scritto a mano, anche uguale a quello di prima, o arrivato dal servizio per un altro giorno.
    expect(settle(10000, USD, ALL, v(92, 'typed'), shifted)).toEqual({ rate: 92, mainAmount: 9200 })
    expect(settle(10000, USD, ALL, v(93, 'typed'), shifted)).toEqual({ rate: 93, mainAmount: 9300 })
    expect(settle(10000, USD, ALL, v(92.37, 'day'), shifted)).toEqual({ rate: 92.37, mainAmount: 9237 })
    // Movimento senza un cambio suo (arrivato da fuori con controvalore zero): con l'ultimo usato il conto si fa.
    expect(settle(2000, EUR, ALL, v(97, 'last'), { amount: 2000, currency: 'EUR', mainAmount: 0 })).toEqual({ rate: 97, mainAmount: 1940 })
  })

  it('saldo iniziale delle versioni precedenti (0,92 invece di 92): si corregge il cambio, non il controvalore', () => {
    const old = tx('opening', 10000, day(5), { currency: 'USD', rate: 0.92, mainAmount: 9200 })
    const view = rateView(NO_RATES, { from: 'USD', to: 'ALL', day: '2026-10-05', origin: originOf(old, USD, ALL), last: null })
    expect(view).toMatchObject({ value: 92, source: 'own' })
    expect(settle(10000, USD, ALL, view, old)).toEqual({ rate: 92, mainAmount: 9200 })
  })

  it('aprire un movimento in valuta e salvarlo senza toccare soldi né giorno non lo cambia, con o senza rete', () => {
    setLang('it')
    // 20,00 € registrati a 97,35 (cambio scritto a mano quel giorno): 1.947 L.
    const saved = tx('expense', 2000, day(5), { rate: 97.35, mainAmount: 1947 })
    const c: RateContext = { from: 'EUR', to: 'ALL', day: dayKey(saved.date), origin: originOf(saved, EUR, ALL), last: lastRate([eur(day(6), 99), saved], EUR, ALL, dayEnd(dayKey(saved.date))) }
    for (const facts of [NO_RATES, gotRate(NO_RATES, rateKey(c), 98.2), gotRate(NO_RATES, rateKey(c), null)]) {
      expect(needsFetch(facts, c)).toBe(false)
      expect(settle(saved.amount, EUR, ALL, rateView(facts, c), saved)).toEqual({ rate: 97.35, mainAmount: 1947 })
    }
  })
})

describe('cambio che il servizio non pubblica', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('coppia non pubblicata, risposta senza la valuta o rete assente: nessun cambio, mai un errore', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"message":"not found"}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchRate('EUR', 'ALL', new Date('2026-10-07'))).toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.frankfurter.dev/v1/2026-10-07?from=EUR&to=ALL')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rates: {} }), { status: 200 })))
    expect(await fetchRate('EUR', 'ALL', new Date('2026-10-07'))).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await fetchRate('USD', 'EUR', new Date('2026-10-07'))).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rates: { EUR: 0.9212 } }), { status: 200 })))
    expect(await fetchRate('USD', 'EUR', new Date('2026-10-07'))).toBe(0.9212)
  })

  it('rete che non risponde: dopo il limite di tempo vale come nessun cambio', async () => {
    // Una richiesta che non finisce mai, se non quando viene interrotta.
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')))))
    vi.stubGlobal('fetch', hang)
    const started = Date.now()
    expect(await fetchRate('USD', 'EUR', new Date('2026-10-07'), 40)).toBeNull()
    expect(Date.now() - started).toBeLessThan(4000)
    expect(hang).toHaveBeenCalledTimes(1)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { guessCurrency } from '../currencyGuess'
import { setLang } from '../i18n'
import { parseTyped, readTyped } from '../money'

describe('importi scritti a mano', () => {
  beforeEach(() => setLang('it'))

  it('valute senza decimali: i gruppi di tre cifre sono sempre migliaia', () => {
    // Lek: "150.000" sono centocinquantamila, in qualunque lingua sia l'interfaccia.
    expect(readTyped('150.000', 0)).toBe(150000)
    expect(readTyped('150,000', 0)).toBe(150000)
    expect(readTyped('1.500', 0)).toBe(1500)
    expect(readTyped('270 948', 0)).toBe(270948)
    setLang('en')
    expect(readTyped('150.000', 0)).toBe(150000)
    expect(readTyped('1.500', 0)).toBe(1500)
    expect(readTyped('1,234,567', 0)).toBe(1234567)
  })

  it('con i decimali, un separatore seguito da tre cifre lo decide la lingua', () => {
    expect(readTyped('1.500', 2)).toBe(150000)
    expect(readTyped('1,500', 2)).toBe(150)
    setLang('en')
    expect(readTyped('1,500', 2)).toBe(150000)
    expect(readTyped('1.500', 2)).toBe(150)
  })

  it('punto e virgola insieme: l’ultimo è il decimale, in ogni lingua', () => {
    expect(readTyped('1.234,56', 2)).toBe(123456)
    expect(readTyped('1,234.56', 2)).toBe(123456)
    setLang('en')
    expect(readTyped('1.234,56', 2)).toBe(123456)
    expect(readTyped('1,234.56', 2)).toBe(123456)
  })

  it('simboli e sigle attaccati al numero non danno fastidio', () => {
    expect(readTyped('€1500', 2)).toBe(150000)
    expect(readTyped('1500 €', 2)).toBe(150000)
    expect(readTyped('1.500 L', 0)).toBe(1500)
    expect(readTyped('1250,50 EUR', 2)).toBe(125050)
  })

  it('numeri negativi, anche col meno tipografico o dopo il simbolo', () => {
    expect(readTyped('-12,50', 2)).toBe(-1250)
    expect(readTyped('−200', 2)).toBe(-20000)
    expect(readTyped('-€5', 2)).toBe(-500)
    expect(readTyped('€ -5', 2)).toBe(-500)
  })

  it('quello che non è un numero è null, non zero', () => {
    for (const bad of ['', '   ', 'abc', '-', '12,3,4', '1..2', '1.23.456', '1.2345,6,7', '€']) expect(readTyped(bad, 2)).toBeNull()
    expect(readTyped('0', 2)).toBe(0)
    // Una virgola in sospeso mentre si scrive non è un errore.
    expect(readTyped('12,', 2)).toBe(1200)
  })

  it('separatore in testa: ",50" è mezzo, non cinquanta', () => {
    expect(readTyped(',50', 2)).toBe(50)
    expect(readTyped('-,5', 2)).toBe(-50)
    expect(readTyped('€ ,75', 2)).toBe(75)
    setLang('en')
    expect(readTyped('.5', 2)).toBe(50)
    expect(readTyped('-.25', 2)).toBe(-25)
    // Il punto di una sigla non è un separatore decimale.
    expect(readTyped('Fr. 20', 2)).toBe(2000)
    expect(readTyped('L. 1500', 0)).toBe(1500)
    // Dopo un simbolo scritto in lettere, invece, lo è.
    expect(readTyped('CHF .50', 2)).toBe(50)
    expect(readTyped('EUR,50', 2)).toBe(50)
    expect(readTyped('US$.50', 2)).toBe(50)
    // Le migliaia non cominciano con zero.
    expect(readTyped('0,500', 2)).toBe(50)
    expect(readTyped('0.500', 3)).toBe(500)
    setLang('it')
    expect(readTyped('0.500', 2)).toBe(50)
    expect(readTyped('0,500', 3)).toBe(500)
    expect(readTyped('1.500', 2)).toBe(150000)
    // Nelle valute senza decimali, o con altro dopo, non è un numero leggibile.
    expect(readTyped(',50', 0)).toBeNull()
    expect(readTyped(',5,0', 2)).toBeNull()
  })

  it('parseTyped resta tollerante: illeggibile vale zero', () => {
    expect(parseTyped('abc', 2)).toBe(0)
    expect(parseTyped('', 2)).toBe(0)
    expect(parseTyped('2417,60', 2)).toBe(241760)
  })
})

describe('valuta proposta al primo avvio', () => {
  it('il fuso orario vince sulla lingua (italiano in Albania → lek)', () => {
    expect(guessCurrency(['it-IT', 'en'], 'Europe/Tirane')).toBe('ALL')
    expect(guessCurrency(['en-US'], 'Europe/London')).toBe('GBP')
  })

  it('dalla lingua quando il fuso non dice niente', () => {
    expect(guessCurrency(['it'], 'Europe/Rome')).toBe('EUR')
    expect(guessCurrency(['sq'], 'UTC')).toBe('ALL')
    expect(guessCurrency(['de-CH'], 'UTC')).toBe('CHF')
    expect(guessCurrency(['en-GB'], 'UTC')).toBe('GBP')
    expect(guessCurrency(['en-US'], 'America/New_York')).toBe('USD')
    expect(guessCurrency(['fr-FR'], 'Europe/Paris')).toBe('EUR')
  })

  it('"en" da solo non decide: passa alla lingua successiva', () => {
    expect(guessCurrency(['en', 'it-IT'], 'UTC')).toBe('EUR')
    expect(guessCurrency(['en', 'en-GB'], 'UTC')).toBe('GBP')
  })

  it('senza indizi o con lingue non valide resta sull’euro', () => {
    expect(guessCurrency([], 'UTC')).toBe('EUR')
    expect(guessCurrency(['en'], 'UTC')).toBe('EUR')
    expect(guessCurrency(['ja-JP'], 'Asia/Tokyo')).toBe('EUR')
    expect(guessCurrency(['@@@'], 'UTC')).toBe('EUR')
  })
})

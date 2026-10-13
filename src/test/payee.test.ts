import { describe, expect, it } from 'vitest'
import { payeeLabel, payeeOf } from '../payee'

const key = (note: string) => payeeOf(note)?.key ?? null

describe('esercente scritto nella nota', () => {
  it('stessa chiave per lo stesso esercente scritto in modi diversi', () => {
    expect(key('FARMACIA ROSSI CENTRO 1')).toBe('farmacia rossi centro')
    expect(key('Farmacia Rossi Centro 2 SHPK')).toBe('farmacia rossi centro')
    expect(key('Telefoni Nord')).toBe('telefoni nord')
    expect(key('TELEFONI NORD 000123456')).toBe('telefoni nord')
    expect(key('Caffè Roma')).toBe(key('CAFFE ROMA'))
    expect(key('PAYPAL *DL SRL · 280.00 EUR')).toBe('paypal dl')
  })

  it('della nota conta solo la parte prima della coda con l’importo in valuta; il nome resta com’è scritto', () => {
    expect(payeeOf('NOVA DIGITAL B · 285.03 EUR')).toEqual({ key: 'nova digital b', name: 'NOVA DIGITAL B' })
    expect(payeeOf('  Mercato rionale  ')).toEqual({ key: 'mercato rionale', name: 'Mercato rionale' })
  })

  it('mesi e anni in coda spariscono: l’affitto di ogni mese è la stessa voce', () => {
    expect(key('Affitto mese di novembre')).toBe('affitto')
    expect(key('Affitto mese di dicembre 2025')).toBe('affitto')
    expect(key('Paga shtator 2026')).toBe('paga')
    expect(key('Contanti dal 28/09 al 13/10')).toBe('contanti')
    // In testa alla nota un mese è un nome come un altro.
    expect(key('March Hotel')).toBe('march hotel')
  })

  it('esercenti diversi restano diversi: niente accorpamenti a intuito', () => {
    expect(key('FARMACIA ROSSI MERCATO SHPK')).not.toBe(key('FARMACIA ROSSI CENTRO 1'))
    expect(key('PAYPAL *BOTTEGA879')).not.toBe(key('PAYPAL *DL SRL'))
    expect(key('GRAN BAZAR CENTRO')).toBe('gran bazar centro')
  })

  it('una nota vuota, o fatta solo di numeri, date e sigle, non nomina nessuno', () => {
    expect(payeeOf('')).toBeNull()
    expect(payeeOf('   ')).toBeNull()
    expect(payeeOf('2026')).toBeNull()
    expect(payeeOf('12/03/2026 14:30')).toBeNull()
    expect(payeeOf('SRL')).toBeNull()
    // Nemmeno una nota fatta solo di segni.
    expect(payeeOf('?')).toBeNull()
    expect(payeeOf('...')).toBeNull()
    expect(payeeOf('- · 12.00 EUR')).toBeNull()
  })

  it('il nome di un gruppo: la scrittura più frequente, o la parte in comune se cambiano numeri e mesi', () => {
    expect(payeeLabel(['Telefoni Nord', 'Telefoni Nord'])).toBe('Telefoni Nord')
    expect(payeeLabel(['FARMACIA ROSSI CENTRO 1', 'FARMACIA ROSSI CENTRO 2', 'FARMACIA ROSSI CENTRO 1'])).toBe('FARMACIA ROSSI CENTRO')
    expect(payeeLabel(['Affitto mese di novembre', 'Affitto mese di dicembre'])).toBe('Affitto')
    expect(payeeLabel(['SPAR 1', 'SPAR 2'])).toBe('SPAR')
    expect(payeeLabel(['Caffè Roma', 'CAFFE ROMA', 'CAFFE ROMA'])).toBe('CAFFE ROMA')
    expect(payeeLabel([])).toBe('')
  })

  it('quando la parte che cambia sta prima del nome, il nome non si perde', () => {
    const pos = ['PAGAMENTO POS DEL 12/03 BAR SOLE', 'PAGAMENTO POS DEL 15/03 BAR SOLE']
    expect(new Set(pos.map(key)).size).toBe(1)
    expect(payeeLabel(pos)).toBe('PAGAMENTO POS DEL BAR SOLE')
    // Due negozi diversi con lo stesso inizio restano due nomi diversi.
    expect(payeeLabel(['PAGAMENTO POS DEL 13/03 FORNO LUNA', 'PAGAMENTO POS DEL 20/03 FORNO LUNA'])).toBe('PAGAMENTO POS DEL FORNO LUNA')
    expect(payeeLabel(['Ricarica 10 Telefoni Nord', 'Ricarica 20 Telefoni Nord'])).toBe('Ricarica Telefoni Nord')
  })
})

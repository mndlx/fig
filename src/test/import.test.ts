import { describe, expect, it } from 'vitest'
import { detectDecimal, guessColumns, parseAmount, parseCsv, parseDate } from '../csv'

/** Legge un estratto come fa l'import: righe, colonne indovinate, prima riga di dati interpretata. */
function read(text: string) {
  const rows = parseCsv(text)
  const g = guessColumns(rows)
  const header = rows[g.headerRow]
  const body = rows.slice(g.headerRow + 1)
  const decimal = detectDecimal(body.flatMap((r) => [r[g.amountCol] ?? '', g.creditCol >= 0 ? (r[g.creditCol] ?? '') : '']))
  const value = (r: string[]) => {
    if (g.creditCol >= 0) {
      const debit = parseAmount(r[g.amountCol] ?? '', decimal)
      const credit = parseAmount(r[g.creditCol] ?? '', decimal)
      return credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null
    }
    return parseAmount(r[g.amountCol] ?? '', decimal)
  }
  return {
    g,
    cols: { date: header[g.dateCol], desc: header[g.descCol], amount: header[g.amountCol], credit: g.creditCol >= 0 ? header[g.creditCol] : null },
    values: body.map(value),
    dates: body.map((r) => parseDate(r[g.dateCol] ?? '')?.getDate() ?? null),
  }
}

describe('import CSV: estratti conto reali', () => {
  it('banca italiana con righe di riepilogo, Dare/Avere e saldo', () => {
    const r = read(
      [
        'Conto corrente;IT60X0542811101000000123456',
        'Intestatario;ROSSI ANNA',
        'Saldo contabile;1.234,56',
        '',
        'Data contabile;Data valuta;Descrizione;Dare;Avere;Saldo',
        '28/09/2026;28/09/2026;PAGAMENTO POS ESSELUNGA MILANO;45,30;;1.189,26',
        '27/09/2026;27/09/2026;BONIFICO A VOSTRO FAVORE STIPENDIO;;1.850,00;3.039,26',
        '26/09/2026;25/09/2026;ADDEBITO SDD ENEL ENERGIA;89,00;;2.950,26',
      ].join('\n'),
    )
    expect(r.cols).toEqual({ date: 'Data contabile', desc: 'Descrizione', amount: 'Dare', credit: 'Avere' })
    expect(r.values).toEqual([-45.3, 1850, -89])
    expect(r.dates).toEqual([28, 27, 26])
  })

  it('colonna unica con segno: non scambia il saldo per l’importo', () => {
    const r = read(
      [
        'Data,Operazione,Dettagli,Saldo,Importo',
        '28/09/2026,Pagamento carta,"BAR ROMA, MILANO","1.189,26","-3,50"',
        '27/09/2026,Bonifico,Stipendio settembre,"1.192,76","1.850,00"',
      ].join('\n'),
    )
    expect(r.cols.amount).toBe('Importo')
    // Tra 'Operazione' (generica) e 'Dettagli' (il negozio) vale la colonna con i contenuti più vari.
    expect(r.cols.desc).toBe('Dettagli')
    expect(r.values).toEqual([-3.5, 1850])
  })

  it('senza nome per l’importo: sceglie la colonna dei movimenti, non il saldo', () => {
    const r = read(
      [
        'Data;Causale;Movimento;Saldo',
        '28/09/2026;POS FARMACIA;-18,00;1.171,26',
        '27/09/2026;PRELIEVO BANCOMAT;-100,00;1.189,26',
        '26/09/2026;ACCREDITO;250,00;1.289,26',
      ].join('\n'),
    )
    expect(r.cols.amount).toBe('Movimento')
    expect(r.values).toEqual([-18, -100, 250])
  })

  it('formato inglese con migliaia e data ISO', () => {
    const r = read(
      [
        'Date,Description,Amount,Balance',
        '2026-09-28,CARD PAYMENT TESCO,-45.30,"1,189.26"',
        '2026-09-27,SALARY ACME LTD,"1,850.00","3,039.26"',
      ].join('\n'),
    )
    expect(r.cols).toEqual({ date: 'Date', desc: 'Description', amount: 'Amount', credit: null })
    expect(r.values).toEqual([-45.3, 1850])
  })

  it('banca albanese: Debi / Kredi / Balanca, date coi punti', () => {
    const r = read(
      [
        'Data;Përshkrimi;Debi;Kredi;Balanca',
        '30.09.2026;BLERJE POS CONAD TIRANE;1,140.00;;265,576.00',
        '30.09.2026;TERHEQJE ATM;10,000.00;;255,576.00',
        '29.09.2026;PAGA SHTATOR;;185,000.00;440,576.00',
      ].join('\n'),
    )
    expect(r.cols).toEqual({ date: 'Data', desc: 'Përshkrimi', amount: 'Debi', credit: 'Kredi' })
    expect(r.values).toEqual([-1140, -10000, 185000])
    expect(r.dates).toEqual([30, 30, 29])
  })

  it('intestazioni inglesi Debit / Credit', () => {
    const r = read(['Transaction Date,Details,Debit,Credit,Balance', '28/09/2026,COFFEE,3.50,,100.00', '27/09/2026,REFUND,,20.00,103.50'].join('\n'))
    expect(r.cols).toEqual({ date: 'Transaction Date', desc: 'Details', amount: 'Debit', credit: 'Credit' })
    expect(r.values).toEqual([-3.5, 20])
  })
})

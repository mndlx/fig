/** Lettura e scrittura CSV, con le particolarità degli estratti conto italiani. */

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n')
  const counts = [';', ',', '\t'].map((d) => ({ d, n: sample.split(d).length }))
  counts.sort((a, b) => b.n - a.n)
  return counts[0].d
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(cell.trim())
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell.trim())
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

/** Data in formato gg/mm/aaaa, gg-mm-aa, gg.mm.aaaa o aaaa-mm-gg, con ora facoltativa. */
export function parseDate(value: string): Date | null {
  const v = value.trim()
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)
  if (m) return build(+m[1], +m[2], +m[3], m[4], m[5])
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return build(year, +m[2], +m[1], m[4], m[5])
  }
  return null

  function build(y: number, mo: number, d: number, h?: string, mi?: string): Date | null {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    return new Date(y, mo - 1, d, h ? +h : 12, mi ? +mi : 0)
  }
}

/**
 * Importo come numero con segno: gestisce "1.234,56", "1,234.56", "-12,50",
 * "12,50-", "(12,50)", simboli di valuta e spazi.
 */
/**
 * Separatore decimale di una colonna di importi, deciso da tutte le righe:
 * conta i valori che finiscono con ",12" o ".12". Undefined se non si capisce.
 */
export function detectDecimal(values: string[]): ',' | '.' | undefined {
  let comma = 0
  let dot = 0
  for (const v of values) {
    const s = v.trim()
    if (/,\d{1,2}\s*-?\)?$/.test(s)) comma++
    else if (/\.\d{1,2}\s*-?\)?$/.test(s)) dot++
  }
  if (comma === 0 && dot === 0) return undefined
  return comma >= dot ? ',' : '.'
}

export function parseAmount(value: string, decimal?: ',' | '.'): number | null {
  let v = value.trim().replace(/[€$£\s]|EUR|USD|GBP|CHF/gi, '')
  if (!v) return null
  let negative = false
  if (/^\(.*\)$/.test(v)) {
    negative = true
    v = v.slice(1, -1)
  }
  if (v.endsWith('-')) {
    negative = true
    v = v.slice(0, -1)
  }
  if (v.startsWith('-')) {
    negative = !negative
    v = v.slice(1)
  } else if (v.startsWith('+')) v = v.slice(1)

  const lastComma = v.lastIndexOf(',')
  const lastDot = v.lastIndexOf('.')
  if (decimal) {
    // Formato noto dalla colonna: l'altro separatore è quello delle migliaia.
    v = decimal === ',' ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '')
  } else if (lastComma >= 0 && lastDot >= 0) {
    // Il separatore che compare per ultimo è quello dei decimali.
    v = lastComma > lastDot ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '')
  } else if (lastComma >= 0) {
    // Una sola virgola: decimali all'italiana. Più virgole a gruppi di tre: migliaia all'inglese.
    v = /^\d{1,3}(,\d{3}){2,}$/.test(v) ? v.replace(/,/g, '') : v.replace(',', '.')
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(v)) {
    v = v.replace(/\./g, '')
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

export interface ColumnGuess {
  headerRow: number
  dateCol: number
  descCol: number
  amountCol: number
  creditCol: number
}

/** Trova la riga d'intestazione (le banche spesso mettono righe di riepilogo prima) e indovina le colonne. */
export function guessColumns(rows: string[][]): ColumnGuess {
  let headerRow = 0
  for (let i = 0; i < Math.min(rows.length - 1, 40); i++) {
    const r = rows[i]
    const next = rows[i + 1]
    if (r.length >= 3 && r.length === next.length && !r.some((c) => parseDate(c)) && next.some((c) => parseDate(c))) {
      headerRow = i
      break
    }
  }
  const header = rows[headerRow].map((h) => h.toLowerCase())
  const body = rows.slice(headerRow + 1, headerRow + 30)
  const find = (re: RegExp) => header.findIndex((h) => re.test(h))

  let dateCol = find(/data\s*(contabile|operazione)?$|^data|date/)
  if (dateCol < 0) {
    const scores = header.map((_, c) => body.filter((r) => parseDate(r[c] ?? '')).length)
    dateCol = scores.indexOf(Math.max(...scores))
  }
  const debit = find(/dare|uscit|addebit|debit/)
  const credit = find(/avere|entrat|accredit|credit/)
  let amountCol = find(/importo|amount|ammontare|valore/)
  let creditCol = -1
  if (debit >= 0 && credit >= 0) {
    amountCol = debit
    creditCol = credit
  }
  if (amountCol < 0) {
    const scores = header.map((_, c) => (c === dateCol ? -1 : body.filter((r) => parseAmount(r[c] ?? '') !== null).length))
    amountCol = scores.indexOf(Math.max(...scores))
  }
  let descCol = find(/descri|causale|operazione|dettagl|beneficiar|esercente|merchant/)
  if (descCol < 0 || descCol === dateCol) {
    const lengths = header.map((_, c) =>
      c === dateCol || c === amountCol || c === creditCol ? -1 : body.reduce((sum, r) => sum + (r[c]?.length ?? 0), 0),
    )
    descCol = lengths.indexOf(Math.max(...lengths))
  }
  return { headerRow, dateCol, descCol, amountCol, creditCol }
}

function escapeCell(value: string, delimiter: string): string {
  // Testi che iniziano con = + - @ verrebbero eseguiti da Excel come formule: li rendo testo semplice.
  // I numeri negativi ("-12,50") restano numeri.
  if (/^[=+\-@\t\r]/.test(value) && !/^-?[\d.,]+$/.test(value)) value = `'${value}`
  return /["\n\r]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value
}

/** CSV con ; e BOM, che Excel in italiano apre direttamente. */
export function toCsv(rows: (string | number)[][], delimiter = ';'): string {
  return '﻿' + rows.map((r) => r.map((c) => escapeCell(String(c), delimiter)).join(delimiter)).join('\r\n')
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

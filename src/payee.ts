/**
 * Dalla nota di un movimento all'esercente: a chi sono andati i soldi.
 * Le note arrivano dalla banca ("FARMACIA ROSSI CENTRO 2", "NOVA DIGITAL B · 285.03 EUR") o sono scritte a mano
 * ("Affitto mese di novembre"): qui si toglie quello che cambia da una volta all'altra (numeri di negozio, mesi,
 * sigle societarie) così le spese fatte nello stesso posto finiscono insieme. Solo regole fisse e prudenti:
 * due note che restano diverse dopo averle pulite sono due esercenti, anche se si somigliano.
 */

export interface Payee {
  /** Chiave per raggruppare: minuscola, senza accenti né parti variabili. */
  key: string
  /** Nome da mostrare: la nota così com'è scritta, senza la coda dopo " · ". */
  name: string
}

/** Sigle societarie: non distinguono un esercente dall'altro. */
const COMPANY = new Set(['shpk', 'sh.p.k', 'sh.p.k.', 'srl', 's.r.l', 's.r.l.', 'srls', 'spa', 's.p.a', 's.p.a.', 'sas', 'snc', 'ltd', 'llc', 'inc', 'gmbh', 'sa', 'pf', 'doo', 'd.o.o', 'd.o.o.'])
/** Mesi in italiano, inglese e albanese: "Affitto mese di novembre" e "Affitto mese di dicembre" sono la stessa voce. */
const MONTHS = new Set(
  (
    'gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre ' +
    'january february march april may june july august september october november december ' +
    'janar shkurt mars prill maj qershor korrik gusht shtator tetor nentor dhjetor'
  ).split(' '),
)
/** Parole di collegamento che restano appese in fondo dopo aver tolto mesi e numeri. */
const TRAILING = new Set(['di', 'del', 'della', 'dei', 'de', 'il', 'la', 'lo', 'mese', 'dal', 'al', 'da', 'a', 'fino', 'of', 'for', 'the', 'from', 'to', 'n', 'nr', 'no'])

/** Minuscole e senza accenti: "Caffè" e "CAFFE" sono la stessa parola. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Numeri di negozio, d'ordine o di carta, date e orari: parti che cambiano da una volta all'altra. */
const isNumber = (w: string) => /^[#x*]*\d[\d.,/:x*-]*$/i.test(w) || (w.match(/\d/g)?.length ?? 0) >= 5

/** Le parole di una nota che dicono chi è: senza numeri, sigle societarie, mesi (dopo la prima parola) e code di collegamento. */
function nameWords(name: string): string[] {
  const words = name
    .replace(/[*/,;:()[\]"]+/g, ' ')
    .split(/\s+/)
    // I mesi si tolgono solo dopo la prima parola: un nome che comincia così ("March Hotel") resta intero.
    .filter((w, i) => w && !isNumber(w) && !COMPANY.has(fold(w)) && !(i > 0 && MONTHS.has(fold(w))))
  while (words.length > 1 && TRAILING.has(fold(words[words.length - 1]))) words.pop()
  return words
}

/** Le note si ripetono (lo stesso negozio cento volte): il conto si fa una volta per nota. */
const seen = new Map<string, Payee | null>()

/**
 * L'esercente scritto in una nota, o null se la nota non ne nomina uno (vuota, o fatta solo di numeri, date o segni).
 * Di una nota con una coda dopo " · " (per esempio l'importo in valuta) conta solo la prima parte.
 */
export function payeeOf(note: string): Payee | null {
  const known = seen.get(note)
  if (known !== undefined) return known
  const name = note.split(' · ')[0].trim()
  const key = nameWords(name).map(fold).join(' ')
  // Una nota come "?" o "..." non nomina nessuno.
  const payee = /[\p{L}\p{N}]/u.test(key) ? { key, name } : null
  if (seen.size >= 20_000) seen.clear()
  seen.set(note, payee)
  return payee
}

/**
 * Nome da mostrare per un gruppo di note con la stessa chiave: quella scritta più spesso; se differiscono
 * (numeri di negozio, mesi) resta la parte iniziale che hanno in comune, senza parole di collegamento in coda.
 * Quando la parte che cambia sta prima del nome ("PAGAMENTO POS DEL 12/03 BAR SOLE") l'inizio in comune non basta
 * a dire chi è: allora si mostra la scrittura più frequente, tolte solo le parti che cambiano.
 */
export function payeeLabel(names: string[]): string {
  if (names.length === 0) return ''
  const count = new Map<string, number>()
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1)
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  if (count.size === 1) return top
  // Le parole iniziali comuni a tutte le scritture, prese dalla più frequente.
  const base = top.split(/\s+/)
  const split = [...count.keys()].map((n) => n.split(/\s+/))
  let shared = 0
  while (shared < base.length && split.every((w) => w.length > shared && fold(w[shared]) === fold(base[shared]))) shared++
  const words = base.slice(0, shared)
  while (words.length > 1 && (TRAILING.has(fold(words[words.length - 1])) || isNumber(words[words.length - 1]))) words.pop()
  const whole = nameWords(top)
  if (words.length === 0 || nameWords(words.join(' ')).length < whole.length) return whole.length > 0 ? whole.join(' ') : top
  return words.join(' ')
}

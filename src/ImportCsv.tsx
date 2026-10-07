import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { detectDecimal, guessColumns, parseAmount, parseCsv, parseDate } from './csv'
import { placeholderOnly, type AppData } from './data'
import { db, openingId, type Category, type ImportProfile, type Rule, type Transaction } from './db'
import { IconLeft } from './icons'
import { dayStart, matchExisting, openingForHistory, shiftedOpening, suggest, type ExistingMatch, type RowKind } from './importLogic'
import { builtinName, dateFmt, t, tn } from './i18n'
import { convertMinor, fetchRate, formatMoney } from './money'
import { rateInput } from './rate'
import { ADJUST_CATEGORIES } from './Reconcile'

interface Props {
  data: AppData
  onDone: () => void
}

interface Mapping {
  dateCol: number
  descCol: number
  amountCol: number
  creditCol: number
  /** Colonna unica in cui le uscite sono scritte come numeri positivi. */
  invert: boolean
}

/** Da dove viene la scelta di categoria di una riga. */
type Origin = 'manual' | 'rule' | 'hint' | 'default'

interface Item {
  index: number
  date: Date
  desc: string
  kind: RowKind
  amount: number
  /** Id di categoria, oppure "acc:<conto>" per un giroconto con un altro conto. */
  choice: string
  origin: Origin
  existing?: ExistingMatch
  /** Precedente al saldo iniziale del conto. */
  early: boolean
}

const TRANSFER = 'acc:'

const STOPWORDS = new Set(
  'pagamento pagam carta pos addebito accredito bonifico bonif sepa direct debit sdd del della dei presso operazione op favore ordine vostro vs ns per con data ora rif cod eur euro mastercard visa maestro contactless apple google pay effettuato disposizione payment card purchase transfer from the and ref direct'.split(
    ' ',
  ),
)

/**
 * Parola chiave proposta per una regola: la prima parola "significativa" della descrizione
 * (es. "esselunga"), o le prime due se la prima è troppo corta per essere distintiva.
 */
function keywordOf(desc: string): string {
  const words = desc
    .toLowerCase()
    .replace(/[^a-zà-ù\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  return words.slice(0, words[0]?.length >= 5 ? 1 : 2).join(' ')
}

function cleanDesc(desc: string): string {
  return desc.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** Testo del file: UTF-8, UTF-16 (alcuni export di Excel) o Windows-1252 (molte banche). */
function decode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer)
  const text = new TextDecoder('utf-8').decode(buffer)
  return text.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : text
}

/** Un file Excel vero (xlsx = zip, xls = documento OLE) non è leggibile come CSV. */
function isSpreadsheet(file: File, buffer: ArrayBuffer): boolean {
  const b = new Uint8Array(buffer.slice(0, 4))
  return /\.xlsx?$/i.test(file.name) || (b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf)
}

export function ImportCsv({ data, onDone }: Props) {
  const { accounts, categories, currencies, mainCurrency, transactions } = data
  const savedRules = useLiveQuery(() => db.rules.toArray(), []) ?? []
  const profiles = useLiveQuery(() => db.importProfiles.toArray(), []) ?? []
  const fileRef = useRef<HTMLInputElement>(null)

  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<string[][] | null>(null)
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [profile, setProfile] = useState<ImportProfile | null>(null)
  const [accountId, setAccountId] = useState(accounts.find((a) => !a.archived)?.id ?? '')
  const [overrides, setOverrides] = useState<Record<number, string>>({})
  const [included, setIncluded] = useState<Record<number, boolean>>({})
  const [pendingRules, setPendingRules] = useState<Rule[]>([])
  const [showCols, setShowCols] = useState(false)
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState<{ count: number; batch: string; prevOpening: Transaction | null; movedTo: number | null } | null>(null)

  const account = accounts.find((a) => a.id === accountId)
  const currency = currencies.find((c) => c.code === account?.currency) ?? mainCurrency
  const foreign = currency.code !== mainCurrency.code
  const opening = transactions.find((x) => x.id === openingId(accountId))
  // Conti con cui si può fare un giroconto dall'import: stessa valuta, così l'importo è lo stesso sui due lati.
  const targets = accounts.filter((a) => !a.archived && a.id !== accountId && a.currency === currency.code)
  const cashAccount = targets.find((a) => a.key === 'cash' || /contanti|cash|portafogli|wallet/i.test(a.name))

  useEffect(() => {
    if (!foreign) return
    fetchRate(currency.code, mainCurrency.code, new Date()).then((r) => {
      if (r !== null) setRate(rateInput(r))
    })
  }, [foreign, currency.code, mainCurrency.code])

  async function load(file: File) {
    setError('')
    setNotice('')
    const buffer = await file.arrayBuffer()
    if (isSpreadsheet(file, buffer)) return setError(t('imp.excel'))
    const parsed = parseCsv(decode(buffer))
    if (parsed.length < 2) return setError(t('imp.emptyFile'))
    const guess = guessColumns(parsed)
    const signature = parsed[guess.headerRow].join('|').toLowerCase()
    const known = profiles.find((p) => p.signature === signature) ?? null
    setFileName(file.name)
    setRows(parsed)
    setHeaderRow(guess.headerRow)
    setProfile(known)
    setMapping(
      known
        ? { dateCol: known.dateCol, descCol: known.descCol, amountCol: known.amountCol, creditCol: known.creditCol, invert: known.invert ?? false }
        : { ...guess, invert: false },
    )
    if (known && accounts.some((a) => a.id === known.accountId && !a.archived)) setAccountId(known.accountId)
    setOverrides({})
    setIncluded({})
    setPendingRules([])
    setShowCols(false)
  }

  function changeAccount(id: string) {
    setAccountId(id)
    // Le scelte fatte valevano per l'altro conto (doppioni, saldo iniziale, giroconti).
    setIncluded({})
    setOverrides((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => !v.startsWith(TRANSFER))))
  }

  const header = rows?.[headerRow] ?? []
  const allRules = [...pendingRules, ...savedRules]
  // "Commissioni" nasce al primo uso (come nell'allineamento del saldo): finché non c'è la si propone lo stesso.
  const feeCategory = ADJUST_CATEGORIES.expense
  const allCats: Category[] = categories.some((c) => c.id === feeCategory.id) ? categories : [...categories, feeCategory]
  const catsOf = (kind: RowKind) => allCats.filter((c) => c.kind === kind && !c.archived).sort((a, b) => a.order - b.order)
  const fallback = (kind: RowKind) => catsOf(kind).find((c) => c.key === 'other' || c.key === 'otherIncome')?.id ?? catsOf(kind)[0]?.id ?? ''

  const preview = useMemo(() => {
    if (!rows || !mapping) return { items: [] as Item[], skipped: 0 }
    const body = rows.slice(headerRow + 1)
    // Formato dei decimali deciso sull'intera colonna, così "1,500" all'inglese non diventa 1,5.
    const decimal = detectDecimal(body.flatMap((r) => [r[mapping.amountCol] ?? '', mapping.creditCol >= 0 ? (r[mapping.creditCol] ?? '') : '']))
    const parsed: { index: number; date: Date; desc: string; kind: RowKind; amount: number }[] = []
    let skipped = 0
    body.forEach((r, i) => {
      const date = parseDate(r[mapping.dateCol] ?? '')
      let value: number | null
      if (mapping.creditCol >= 0) {
        const debit = parseAmount(r[mapping.amountCol] ?? '', decimal)
        const credit = parseAmount(r[mapping.creditCol] ?? '', decimal)
        value = credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null
      } else {
        value = parseAmount(r[mapping.amountCol] ?? '', decimal)
        if (value !== null && mapping.invert) value = -value
      }
      if (!date || value === null || value === 0) {
        skipped++
        return
      }
      parsed.push({ index: i, date, desc: cleanDesc(r[mapping.descCol] ?? ''), kind: value < 0 ? 'expense' : 'income', amount: Math.round(Math.abs(value) * 10 ** currency.decimals) })
    })

    const matches = matchExisting(
      parsed.map((p) => ({ index: p.index, date: p.date.getTime(), kind: p.kind, amount: p.amount })),
      transactions,
      accountId,
      currency.code,
      mainCurrency.code,
    )
    const limit = opening ? dayStart(opening.date) : null
    const items: Item[] = parsed.map((p) => {
      const lower = p.desc.toLowerCase()
      const rule = allRules.find((ru) => ru.match && lower.includes(ru.match.toLowerCase()) && allCats.find((c) => c.id === ru.categoryId)?.kind === p.kind)
      let choice = overrides[p.index]
      let origin: Origin = 'manual'
      if (!choice && rule) {
        choice = rule.categoryId
        origin = 'rule'
      }
      if (!choice) {
        // Indizi nella descrizione della banca: una categoria predefinita, o i contanti per i prelievi.
        const hint = suggest(p.desc, p.kind)
        const hinted = !hint
          ? ''
          : 'cash' in hint
            ? cashAccount
              ? TRANSFER + cashAccount.id
              : ''
            : (allCats.find((c) => c.key === hint.category && c.kind === p.kind && !c.archived)?.id ?? '')
        if (hinted) {
          choice = hinted
          origin = 'hint'
        }
      }
      if (!choice) {
        choice = fallback(p.kind)
        origin = 'default'
      }
      return { ...p, choice, origin, existing: matches.get(p.index), early: limit !== null && p.date.getTime() < limit }
    })
    return { items, skipped }
  }, [rows, mapping, headerRow, accountId, overrides, pendingRules, savedRules, categories, transactions, currency.code, currency.decimals, opening?.date, cashAccount?.id])

  // Di base si importa solo ciò che è nuovo: fuori i movimenti già in FIG e quelli già compresi nel saldo iniziale.
  const isIncluded = (item: Item) => included[item.index] ?? (!item.existing && !item.early)
  const chosen = preview.items.filter(isIncluded)
  const count = chosen.length
  const isTransfer = (item: Item) => item.choice.startsWith(TRANSFER)
  const spent = chosen.filter((i) => i.kind === 'expense' && !isTransfer(i))
  const earned = chosen.filter((i) => i.kind === 'income' && !isTransfer(i))
  const moved = chosen.filter(isTransfer)
  const sum = (list: Item[]) => list.reduce((s, i) => s + i.amount, 0)
  const leftOutExisting = preview.items.filter((i) => i.existing && !isIncluded(i)).length
  const earlyItems = preview.items.filter((i) => i.early && !i.existing)
  const earlyIncluded = earlyItems.filter(isIncluded)
  const colsOpen = showCols || preview.items.length === 0

  const thisYear = new Date().getFullYear()
  const day = (d: Date | number) => {
    const date = new Date(d)
    return dateFmt(date.getFullYear() === thisYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
  }
  const times = preview.items.map((i) => i.date.getTime())

  function setMany(list: Item[], value: boolean) {
    setIncluded((s) => ({ ...s, ...Object.fromEntries(list.map((i) => [i.index, value])) }))
  }

  function changeChoice(index: number, desc: string, choice: string) {
    setOverrides((o) => ({ ...o, [index]: choice }))
    // Una categoria scelta a mano diventa una regola per le righe simili; un giroconto no.
    const match = keywordOf(desc)
    if (!match || choice.startsWith(TRANSFER)) return
    setPendingRules((list) => {
      const existing = list.find((r) => r.match === match)
      if (existing) return list.map((r) => (r === existing ? { ...r, categoryId: choice } : r))
      return [{ id: crypto.randomUUID(), match, categoryId: choice }, ...list]
    })
  }

  async function confirm() {
    if (!mapping || !account) return
    // Archivio dell'account non ancora scaricato: i conti a schermo sono quelli predefiniti.
    if (placeholderOnly(data)) return setError(t('sync.archivePending'))
    const rateValue = foreign ? Number(rate.replace(',', '.')) : 1
    if (!(rateValue > 0)) return setError(t('err.rate', { from: currency.code, to: mainCurrency.code }))
    const batch = crypto.randomUUID()
    const txs: Transaction[] = chosen.map((item) => {
      const base = {
        id: crypto.randomUUID(),
        amount: item.amount,
        currency: currency.code,
        rate: rateValue,
        mainAmount: foreign ? convertMinor(item.amount, currency, mainCurrency, rateValue) : item.amount,
        date: item.date.getTime(),
        note: item.desc,
        source: 'import' as const,
        importId: batch,
      }
      if (isTransfer(item)) {
        const other = item.choice.slice(TRANSFER.length)
        // Uscita dal conto = giroconto verso l'altro; entrata = giroconto dall'altro.
        return item.kind === 'expense'
          ? { ...base, kind: 'transfer' as const, accountId: account.id, toAccountId: other }
          : { ...base, kind: 'transfer' as const, accountId: other, toAccountId: account.id }
      }
      return { ...base, kind: item.kind, categoryId: item.choice || undefined, accountId: account.id }
    })

    // Storico precedente al saldo iniziale: il saldo iniziale si sposta indietro, il saldo di oggi non cambia.
    const shift = opening ? openingForHistory(opening, chosen.map((i) => ({ date: i.date.getTime(), kind: i.kind, amount: i.amount }))) : null
    const newOpening: Transaction | null = opening && shift ? shiftedOpening(opening, shift, currency, mainCurrency, rateValue) : null

    const usesFee = txs.some((x) => x.categoryId === feeCategory.id) && !categories.some((c) => c.id === feeCategory.id)
    await db.transaction('rw', db.transactions, db.rules, db.importProfiles, db.categories, async () => {
      if (usesFee) await db.categories.put(feeCategory)
      await db.transactions.bulkAdd(txs)
      if (newOpening) await db.transactions.put(newOpening)
      const rules = pendingRules.filter((r) => r.match.trim())
      if (rules.length) await db.rules.bulkPut(rules)
      await db.importProfiles.put({
        id: profile?.id ?? crypto.randomUUID(),
        name: profile?.name ?? fileName.replace(/\.[^.]+$/, ''),
        signature: header.join('|').toLowerCase(),
        dateCol: mapping.dateCol,
        descCol: mapping.descCol,
        amountCol: mapping.amountCol,
        creditCol: mapping.creditCol,
        invert: mapping.invert,
        accountId: account.id,
      })
    })
    setError('')
    setDone({ count: txs.length, batch, prevOpening: newOpening ? (opening ?? null) : null, movedTo: shift?.date ?? null })
  }

  /** Toglie i movimenti dell'ultima importazione e rimette il saldo iniziale com'era. */
  async function undo() {
    if (!done) return
    const keys = await db.transactions.filter((x) => x.importId === done.batch).primaryKeys()
    await db.transaction('rw', db.transactions, async () => {
      await db.transactions.bulkDelete(keys)
      if (done.prevOpening) await db.transactions.put(done.prevOpening)
    })
    setDone(null)
    setIncluded({})
    setNotice(t('imp.undone'))
  }

  const colSelect = (label: string, key: 'dateCol' | 'descCol' | 'amountCol' | 'creditCol', optional = false) => (
    <label className="field">
      {label}
      <select value={mapping?.[key] ?? -1} onChange={(e) => setMapping((m) => (m ? { ...m, [key]: Number(e.target.value) } : m))}>
        {optional && <option value={-1}>{t('imp.noCredit')}</option>}
        {header.map((h, i) => (
          <option key={i} value={i}>
            {h || t('imp.column', { n: i + 1 })}
          </option>
        ))}
      </select>
    </label>
  )
  const colName = (i: number) => header[i] || t('imp.column', { n: i + 1 })

  return (
    <>
      <header className="bar">
        <button className="icon-btn" aria-label={t('common.back')} onClick={onDone}>
          <IconLeft />
        </button>
        <span style={{ fontWeight: 500 }}>{t('imp.title')}</span>
        <span style={{ width: 36 }} />
      </header>

      {done !== null ? (
        <div className="card">
          <p className="empty-title" style={{ margin: '0 0 6px' }}>
            {tn('imp.done', done.count)}
          </p>
          {done.movedTo !== null && <p style={{ margin: '0 0 8px' }}>{t('imp.doneOpening', { date: day(done.movedTo) })}</p>}
          <p className="muted small" style={{ margin: '0 0 14px' }}>
            {t('imp.doneNote')}
          </p>
          <div className="form-actions">
            <button className="secondary import-undo" onClick={undo}>
              {t('imp.undo')}
            </button>
            <button className="primary" onClick={onDone}>
              {t('common.done')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card form">
            {!rows && <p style={{ margin: 0 }}>{t('imp.intro')}</p>}
            {rows && (
              <p className="import-file">
                <strong>{fileName}</strong>
                {times.length > 0 && (
                  <span className="muted small">{t('imp.fileInfo', { n: preview.items.length, from: day(Math.min(...times)), to: day(Math.max(...times)) })}</span>
                )}
              </p>
            )}
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className={rows ? 'secondary' : 'primary'} onClick={() => fileRef.current?.click()}>
                {rows ? t('imp.pickOther') : t('imp.pick')}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void load(f)
              }}
            />
            {error && <p className="error">{error}</p>}
            {notice && <p className="note-box" style={{ margin: 0 }}>{notice}</p>}
          </div>

          {rows && mapping && (
            <>
              <div className="card form" style={{ marginTop: 12 }}>
                <div className="form-row">
                  <label className="field">
                    {t('imp.into')}
                    <select value={accountId} onChange={(e) => changeAccount(e.target.value)}>
                      {accounts
                        .filter((a) => !a.archived)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {builtinName(a, 'acc')} ({a.currency})
                          </option>
                        ))}
                    </select>
                  </label>
                  {foreign && (
                    <label className="field">
                      1 {currency.code} = ? {mainCurrency.code}
                      <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                    </label>
                  )}
                </div>
                <p className="import-cols">
                  <span className="muted">
                    {t('imp.colsSummary', {
                      cols: [colName(mapping.dateCol), colName(mapping.descCol), mapping.creditCol >= 0 ? `${colName(mapping.amountCol)} / ${colName(mapping.creditCol)}` : colName(mapping.amountCol)].join(' · '),
                    })}
                  </span>{' '}
                  {preview.items.length > 0 && (
                    <button className="link-btn inline" onClick={() => setShowCols((v) => !v)} aria-expanded={colsOpen}>
                      {colsOpen ? t('imp.colsHide') : t('imp.colsEdit')}
                    </button>
                  )}
                  {profile && <span className="badge">{t('imp.known', { name: profile.name })}</span>}
                </p>
                {colsOpen && (
                  <>
                    <div className="form-row">
                      {colSelect(t('imp.date'), 'dateCol')}
                      {colSelect(t('imp.desc'), 'descCol')}
                    </div>
                    <div className="form-row">
                      {colSelect(mapping.creditCol >= 0 ? t('imp.debit') : t('imp.amount'), 'amountCol')}
                      {colSelect(t('imp.credit'), 'creditCol', true)}
                    </div>
                    {mapping.creditCol < 0 && (
                      <label className="import-invert">
                        <input type="checkbox" checked={mapping.invert} onChange={(e) => setMapping((m) => (m ? { ...m, invert: e.target.checked } : m))} />
                        {t('imp.invert')}
                      </label>
                    )}
                  </>
                )}
              </div>

              {preview.items.length === 0 ? (
                <p className="note-box">{t('imp.noRows')}</p>
              ) : (
                <>
                  <section className="card import-summary">
                    <span className="stat-label">{t('imp.summary')}</span>
                    <span className="import-count">
                      {count}
                      <span className="muted"> / {preview.items.length}</span>
                    </span>
                    <div className="import-chips">
                      {spent.length > 0 && <span>{t('imp.sumOut', { n: spent.length, amount: formatMoney(-sum(spent), currency) })}</span>}
                      {earned.length > 0 && <span className="in">{t('imp.sumIn', { n: earned.length, amount: formatMoney(sum(earned), currency, { sign: true }) })}</span>}
                      {moved.length > 0 && <span>{t('imp.sumTransfer', { n: moved.length })}</span>}
                    </div>
                    {(leftOutExisting > 0 || preview.skipped > 0) && (
                      <p className="muted small" style={{ margin: 0 }}>
                        {[leftOutExisting > 0 ? t('imp.exDup', { n: leftOutExisting }) : '', preview.skipped > 0 ? t('imp.exSkipped', { n: preview.skipped }) : ''].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {earlyItems.length > 0 && opening && (
                      <div className="import-early">
                        <p>
                          {earlyIncluded.length > 0
                            ? t('imp.earlyOn', {
                                n: earlyIncluded.length,
                                date: day(Math.min(...earlyIncluded.map((i) => i.date.getTime()))),
                              })
                            : t('imp.earlyNote', { n: earlyItems.length, date: day(opening.date) })}
                        </p>
                        <button className="secondary slim" onClick={() => setMany(earlyItems, earlyIncluded.length === 0)}>
                          {earlyIncluded.length > 0 ? t('imp.earlyExclude') : t('imp.earlyInclude')}
                        </button>
                      </div>
                    )}
                    <div className="import-select">
                      <span className="muted small">{t('imp.select')}</span>
                      <button className="link-btn inline" onClick={() => setIncluded({})}>
                        {t('imp.selectNew')}
                      </button>
                      <button className="link-btn inline" onClick={() => setMany(preview.items, true)}>
                        {t('imp.selectAll')}
                      </button>
                      <button className="link-btn inline" onClick={() => setMany(preview.items, false)}>
                        {t('imp.selectNone')}
                      </button>
                    </div>
                  </section>

                  <div className="card" style={{ marginTop: 12 }}>
                    <div className="import-table">
                      {preview.items.map((item) => {
                        const on = isIncluded(item)
                        return (
                          <div key={item.index} className={`import-row${on ? '' : ' off'}`}>
                            <label className="import-main">
                              <input type="checkbox" checked={on} onChange={(e) => setIncluded((s) => ({ ...s, [item.index]: e.target.checked }))} />
                              <span className="import-text">
                                <span className="import-meta">
                                  <span className="muted">{day(item.date)}</span>
                                  {item.existing && <span className="badge">{item.existing.exact ? t('imp.dup') : t('imp.near', { date: day(item.existing.date) })}</span>}
                                  {item.early && !item.existing && <span className="badge">{t('imp.early')}</span>}
                                  <span className={`import-amount${item.kind === 'income' ? ' positive' : ''}`}>
                                    {formatMoney(item.kind === 'expense' ? -item.amount : item.amount, currency, { sign: true })}
                                  </span>
                                </span>
                                <span className="import-desc">{item.desc || '—'}</span>
                              </span>
                            </label>
                            {on && (
                              <div className="import-choice">
                                <select value={item.choice} onChange={(e) => changeChoice(item.index, item.desc, e.target.value)} aria-label={t('csv.category')}>
                                  <optgroup label={t('imp.catGroup')}>
                                    {catsOf(item.kind).map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {builtinName(c, 'cat')}
                                      </option>
                                    ))}
                                  </optgroup>
                                  {targets.length > 0 && (
                                    <optgroup label={t('imp.transferGroup')}>
                                      {targets.map((a) => (
                                        <option key={a.id} value={TRANSFER + a.id}>
                                          {t(item.kind === 'expense' ? 'imp.transferTo' : 'imp.transferFrom', { name: builtinName(a, 'acc') })}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                </select>
                                {item.origin === 'rule' && <span className="badge">{t('imp.rule')}</span>}
                                {item.origin === 'hint' && <span className="badge">{t('imp.hint')}</span>}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {pendingRules.length > 0 && (
                    <>
                      <p className="section-title">{t('imp.newRules')}</p>
                      <div className="list">
                        {pendingRules.map((r) => {
                          const c = allCats.find((x) => x.id === r.categoryId)
                          return (
                            <div key={r.id} className="list-row">
                              <span className="small muted">{t('imp.contains')}</span>
                              <input
                                className="input"
                                style={{ flex: 1, minWidth: 0, padding: '6px 10px', fontSize: 14 }}
                                value={r.match}
                                aria-label={t('imp.contains')}
                                onChange={(e) => setPendingRules((l) => l.map((x) => (x.id === r.id ? { ...x, match: e.target.value } : x)))}
                              />
                              <span className="small">→ {c ? builtinName(c, 'cat') : ''}</span>
                              <button className="tiny-btn" aria-label={t('imp.removeRule')} onClick={() => setPendingRules((l) => l.filter((x) => x.id !== r.id))}>
                                ✕
                              </button>
                            </div>
                          )
                        })}
                      </div>
                      <p className="note-box">{t('imp.rulesNote')}</p>
                    </>
                  )}

                  <div className="import-bar">
                    <button className="primary wide import-go" onClick={confirm} disabled={count === 0}>
                      {tn('imp.button', count)}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}

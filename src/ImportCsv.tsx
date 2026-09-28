import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { guessColumns, parseAmount, parseCsv, parseDate } from './csv'
import type { AppData } from './data'
import { db, type Category, type ImportProfile, type Rule, type Transaction } from './db'
import { IconLeft } from './icons'
import { builtinName, dateFmt, t, tn } from './i18n'
import { convertMinor, fetchRate, formatMoney } from './money'

interface Props {
  data: AppData
  onDone: () => void
}

interface Mapping {
  dateCol: number
  descCol: number
  amountCol: number
  creditCol: number
}

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

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
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
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<number | null>(null)

  const account = accounts.find((a) => a.id === accountId)
  const currency = currencies.find((c) => c.code === account?.currency) ?? mainCurrency
  const foreign = currency.code !== mainCurrency.code

  useEffect(() => {
    if (!foreign) return
    fetchRate(currency.code, mainCurrency.code, new Date()).then((r) => {
      if (r !== null) setRate(String(Number(r.toFixed(6))))
    })
  }, [foreign, currency.code, mainCurrency.code])

  async function load(file: File) {
    setError('')
    const buffer = await file.arrayBuffer()
    // Molte banche esportano in Windows-1252: se l'UTF-8 produce caratteri non validi, si riprova.
    let text = new TextDecoder('utf-8').decode(buffer)
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buffer)
    const parsed = parseCsv(text)
    if (parsed.length < 2) return setError(t('imp.emptyFile'))
    const guess = guessColumns(parsed)
    const signature = parsed[guess.headerRow].join('|').toLowerCase()
    const known = profiles.find((p) => p.signature === signature) ?? null
    setFileName(file.name)
    setRows(parsed)
    setHeaderRow(guess.headerRow)
    setProfile(known)
    setMapping(known ? { dateCol: known.dateCol, descCol: known.descCol, amountCol: known.amountCol, creditCol: known.creditCol } : guess)
    if (known && accounts.some((a) => a.id === known.accountId)) setAccountId(known.accountId)
    setOverrides({})
    setIncluded({})
    setPendingRules([])
  }

  const header = rows?.[headerRow] ?? []
  const allRules = [...pendingRules, ...savedRules]
  const catsOf = (kind: Category['kind']) => categories.filter((c) => c.kind === kind && !c.archived)
  const fallback = (kind: Category['kind']) =>
    catsOf(kind).find((c) => c.key === 'other' || c.key === 'otherIncome')?.id ?? catsOf(kind)[0]?.id ?? ''

  const preview = useMemo(() => {
    if (!rows || !mapping) return { items: [], skipped: 0 }
    const existing = new Set(
      transactions.filter((t) => t.accountId === accountId).map((t) => `${dayKey(t.date)}|${t.kind}|${t.amount}`),
    )
    const items: { index: number; date: Date; desc: string; kind: 'expense' | 'income'; amount: number; categoryId: string; ruled: boolean; dup: boolean }[] = []
    let skipped = 0
    rows.slice(headerRow + 1).forEach((r, i) => {
      const date = parseDate(r[mapping.dateCol] ?? '')
      let value: number | null
      if (mapping.creditCol >= 0) {
        const debit = parseAmount(r[mapping.amountCol] ?? '')
        const credit = parseAmount(r[mapping.creditCol] ?? '')
        value = credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null
      } else value = parseAmount(r[mapping.amountCol] ?? '')
      if (!date || value === null || value === 0) {
        skipped++
        return
      }
      const kind = value < 0 ? 'expense' : 'income'
      const amount = Math.round(Math.abs(value) * 10 ** currency.decimals)
      const desc = cleanDesc(r[mapping.descCol] ?? '')
      const lower = desc.toLowerCase()
      const rule = allRules.find((ru) => ru.match && lower.includes(ru.match.toLowerCase()) && categories.find((c) => c.id === ru.categoryId)?.kind === kind)
      const categoryId = overrides[i] ?? rule?.categoryId ?? fallback(kind)
      const dup = existing.has(`${dayKey(date.getTime())}|${kind}|${amount}`)
      items.push({ index: i, date, desc, kind, amount, categoryId, ruled: !overrides[i] && !!rule, dup })
    })
    return { items, skipped }
  },[rows, mapping, headerRow, accountId, overrides, pendingRules, savedRules, categories, transactions, currency.decimals])

  const isIncluded = (item: { index: number; dup: boolean }) => included[item.index] ?? !item.dup
  const count = preview.items.filter(isIncluded).length

  function changeCategory(index: number, desc: string, categoryId: string) {
    setOverrides((o) => ({ ...o, [index]: categoryId }))
    const match = keywordOf(desc)
    if (!match) return
    setPendingRules((list) => {
      const existing = list.find((r) => r.match === match)
      if (existing) return list.map((r) => (r === existing ? { ...r, categoryId } : r))
      return [{ id: crypto.randomUUID(), match, categoryId }, ...list]
    })
  }

  async function confirm() {
    if (!mapping || !account) return
    const rateValue = foreign ? Number(rate.replace(',', '.')) : 1
    if (!(rateValue > 0)) return setError(t('err.rate', { from: currency.code, to: mainCurrency.code }))
    const batch = crypto.randomUUID()
    const txs: Transaction[] = preview.items.filter(isIncluded).map((item) => ({
      id: crypto.randomUUID(),
      kind: item.kind,
      amount: item.amount,
      currency: currency.code,
      rate: rateValue,
      mainAmount: foreign ? convertMinor(item.amount, currency, mainCurrency, rateValue) : item.amount,
      date: item.date.getTime(),
      categoryId: item.categoryId || undefined,
      accountId: account.id,
      note: item.desc,
      source: 'import',
      importId: batch,
    }))
    await db.transaction('rw', db.transactions, db.rules, db.importProfiles, async () => {
      await db.transactions.bulkAdd(txs)
      const rules = pendingRules.filter((r) => r.match.trim())
      if (rules.length) await db.rules.bulkPut(rules)
      await db.importProfiles.put({
        id: profile?.id ?? crypto.randomUUID(),
        name: profile?.name ?? fileName.replace(/\.[^.]+$/, ''),
        signature: header.join('|').toLowerCase(),
        ...mapping,
        accountId: account.id,
      })
    })
    setDone(txs.length)
  }

  const colSelect = (label: string, key: keyof Mapping, optional = false) => (
    <label className="field">
      {label}
      <select
        value={mapping?.[key] ?? -1}
        onChange={(e) => setMapping((m) => (m ? { ...m, [key]: Number(e.target.value) } : m))}
      >
        {optional && <option value={-1}>{t('imp.noCredit')}</option>}
        {header.map((h, i) => (
          <option key={i} value={i}>
            {h || t('imp.column', { n: i + 1 })}
          </option>
        ))}
      </select>
    </label>
  )

  const rowDate = dateFmt({ day: '2-digit', month: '2-digit', year: '2-digit' })

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
            {tn('imp.done', done)}
          </p>
          <p className="muted small" style={{ margin: '0 0 14px' }}>
            {t('imp.doneNote')}
          </p>
          <button className="primary" onClick={onDone}>
            {t('common.done')}
          </button>
        </div>
      ) : (
        <>
          <div className="card form">
            <p style={{ margin: 0 }}>
              {t('imp.intro')}
            </p>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="primary" onClick={() => fileRef.current?.click()}>
                {rows ? t('imp.pickOther') : t('imp.pick')}
              </button>
              {fileName && <span className="muted small" style={{ alignSelf: 'center' }}>{fileName}</span>}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) load(f)
              }}
            />
            {error && <p className="error">{error}</p>}
          </div>

          {rows && mapping && (
            <>
              <p className="section-title">{t('imp.columns')} {profile && <span className="badge">{t('imp.known', { name: profile.name })}</span>}</p>
              <div className="card form">
                <div className="form-row">
                  {colSelect(t('imp.date'), 'dateCol')}
                  {colSelect(t('imp.desc'), 'descCol')}
                </div>
                <div className="form-row">
                  {colSelect(mapping.creditCol >= 0 ? t('imp.debit') : t('imp.amount'), 'amountCol')}
                  {colSelect(t('imp.credit'), 'creditCol', true)}
                </div>
                <div className="form-row">
                  <label className="field">
                    {t('common.account')}
                    <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
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
              </div>

              {pendingRules.length > 0 && (
                <>
                  <p className="section-title">{t('imp.newRules')}</p>
                  <div className="list">
                    {pendingRules.map((r) => (
                      <div key={r.id} className="list-row">
                        <span className="small muted">{t('imp.contains')}</span>
                        <input
                          className="input"
                          style={{ flex: 1, padding: '6px 10px', fontSize: 14 }}
                          value={r.match}
                          onChange={(e) => setPendingRules((l) => l.map((x) => (x.id === r.id ? { ...x, match: e.target.value } : x)))}
                        />
                        <span className="small">→ {(() => { const c = categories.find((x) => x.id === r.categoryId); return c ? builtinName(c, 'cat') : '' })()}</span>
                        <button className="tiny-btn" aria-label={t('imp.removeRule')} onClick={() => setPendingRules((l) => l.filter((x) => x.id !== r.id))}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="note-box">{t('imp.rulesNote')}</p>
                </>
              )}

              <p className="section-title">
                {t('imp.preview', { n: preview.items.length })}{preview.skipped > 0 && t('imp.skipped', { n: preview.skipped })}
              </p>
              <div className="card">
                <div className="import-table">
                  {preview.items.map((item) => (
                    <div key={item.index} className={`import-row${item.dup ? ' dup' : ''}`}>
                      <input
                        type="checkbox"
                        checked={isIncluded(item)}
                        onChange={(e) => setIncluded((s) => ({ ...s, [item.index]: e.target.checked }))}
                        aria-label={t('imp.include')}
                      />
                      <span className="import-desc">
                        <span className="muted small">{rowDate.format(item.date)}</span> {item.desc || '—'}
                        {item.dup && <span className="badge">{t('imp.dup')}</span>}
                        {item.ruled && <span className="badge">{t('imp.rule')}</span>}
                      </span>
                      <span className={`legend-value${item.kind === 'income' ? ' positive' : ''}`}>
                        {formatMoney(item.kind === 'expense' ? -item.amount : item.amount, currency, { sign: true })}
                      </span>
                      <select value={item.categoryId} onChange={(e) => changeCategory(item.index, item.desc, e.target.value)} aria-label={t('csv.category')}>
                        {catsOf(item.kind).map((c) => (
                          <option key={c.id} value={c.id}>
                            {builtinName(c, 'cat')}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="form-actions" style={{ margin: '14px 0' }}>
                <button className="primary" onClick={confirm} disabled={count === 0}>
                  {tn('imp.button', count)}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

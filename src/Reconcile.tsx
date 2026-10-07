import { IconCheck, IconWallet, IconX } from '@tabler/icons-react'
import { ACCOUNT_KEY, remember } from './AddSheet'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { CategoryIcon } from './catIcons'
import { accountBalance, placeholderOnly, type AppData } from './data'
import { db, type Account, type Category, type Transaction } from './db'
import { builtinName, decimalSep, t } from './i18n'
import { convertMinor, fetchRate, formatMoney, fromMinor, readTyped, soundRate } from './money'
import { hasOpening, openingFromBalance, saveOpening } from './opening'

/** Categorie predefinite per gli allineamenti: create al primo uso sui database che non le hanno ancora. */
export const ADJUST_CATEGORIES: Record<'expense' | 'income', Category> = {
  expense: { id: 'cat-fees', name: '', key: 'fees', icon: 'bank', kind: 'expense', color: '#6E6A86', order: 11.5, archived: false },
  income: { id: 'cat-adjustIn', name: '', key: 'adjustIn', icon: 'bank', kind: 'income', color: '#6E8A86', order: 99, archived: false },
}

interface Props {
  data: AppData
  account: Account
  onClose: () => void
  onSaved?: (tx: Transaction) => void
}

/**
 * Allineamento di un conto: si scrive il saldo reale (quello della banca o del portafoglio)
 * e la differenza con FIG diventa un movimento, di solito commissioni addebitate in automatico.
 * Se il conto non ha mai avuto un saldo iniziale la differenza è proprio quello: non un'entrata
 * né un'uscita, ma il punto di partenza che mancava.
 */
export function Reconcile({ data, account: initialAccount, onClose, onSaved }: Props) {
  const { currencies, mainCurrency, categories, transactions } = data
  const activeAccounts = data.accounts.filter((a) => !a.archived)
  const [accountId, setAccountId] = useState(initialAccount.id)
  const account = data.accounts.find((a) => a.id === accountId) ?? initialAccount
  const currency = currencies.find((c) => c.code === account.currency) ?? mainCurrency
  const foreign = currency.code !== mainCurrency.code
  const current = accountBalance(account, data)
  // Senza saldo iniziale il conto parte da zero: la differenza col saldo reale è il saldo iniziale che manca.
  const noOpening = !hasOpening(account.id, transactions)
  // Se però il conto ha già dei movimenti (magari è partito davvero da zero) la differenza può anche essere
  // una commissione di oggi: si propone la lettura più probabile e la si lascia cambiare.
  const hasHistory = transactions.some((tx) => tx.kind !== 'opening' && (tx.accountId === account.id || tx.toAccountId === account.id))
  const [asStart, setAsStart] = useState<boolean | null>(null)
  // Di partenza si propone il saldo iniziale se il conto è vuoto o in negativo, o se la domanda sui saldi
  // di partenza è ancora aperta (nessuna risposta e nessun saldo iniziale altrove); altrimenti la differenza di oggi.
  const unanswered = data.setup !== 'done' && !transactions.some((tx) => tx.kind === 'opening')
  const starting = noOpening && (asStart ?? (!hasHistory || current < 0 || unanswered))
  const [input, setInput] = useState('')

  function pickAccount(id: string) {
    setAccountId(id)
    remember.set(ACCOUNT_KEY, id)
    setInput('')
    setError('')
    setAsStart(null)
    // Altra valuta: finché non arriva il suo cambio non si salva con quello di prima.
    const next = data.accounts.find((a) => a.id === id)
    if (next && next.currency !== mainCurrency.code && next.currency !== currency.code) setRate(null)
  }
  const [rate, setRate] = useState<number | null>(foreign ? null : 1)
  useEffect(() => {
    if (!foreign) setRate(1)
  }, [foreign])
  const [picked, setPicked] = useState<Record<'expense' | 'income', string>>({ expense: ADJUST_CATEGORIES.expense.id, income: ADJUST_CATEGORIES.income.id })
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [allCats, setAllCats] = useState(false)

  // Testo illeggibile ("abc", "12,3,4") non è zero: non si registra niente finché non è un numero.
  const real = input.trim() ? readTyped(input, currency.decimals) : null
  // Senza ancora una cifra ("-", ",") si sta solo cominciando a scrivere: non è un errore.
  const unreadable = real === null && /\d/.test(input)
  const diff = real === null ? 0 : real - current
  const kind: 'expense' | 'income' = diff < 0 ? 'expense' : 'income'

  // Categorie proposte: quella degli allineamenti (anche se non esiste ancora) più le altre del tipo giusto.
  const options = useMemo(() => {
    const own = categories.filter((c) => c.kind === kind && !c.archived).sort((a, b) => a.order - b.order)
    const adjust = own.find((c) => c.id === ADJUST_CATEGORIES[kind].id) ?? ADJUST_CATEGORIES[kind]
    return [adjust, ...own.filter((c) => c.id !== adjust.id)]
  }, [categories, kind])

  useEffect(() => {
    if (!foreign) return
    let cancelled = false
    fetchRate(currency.code, mainCurrency.code, new Date()).then((r) => {
      if (cancelled) return
      if (r !== null) return setRate(r)
      // Senza rete: l'ultimo cambio usato per questa valuta.
      const last = transactions.filter((tx) => tx.currency === currency.code && tx.rate > 0).sort((a, b) => b.date - a.date)[0]
      setRate(last ? soundRate(last, currency, mainCurrency) : null)
    })
    return () => {
      cancelled = true
    }
  }, [foreign, currency.code, mainCurrency.code, transactions])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save() {
    if (real === null) return setError(t('align.errBalance'))
    if (diff === 0) return onClose()
    // Archivio dell'account non ancora scaricato: il saldo "in FIG" qui sopra è quello dei dati predefiniti.
    if (placeholderOnly(data)) return setError(t('sync.archivePending'))
    if (!(rate && rate > 0)) return setError(t('err.rate', { from: currency.code, to: mainCurrency.code }))
    if (starting) {
      // Datato prima del movimento più vecchio del conto, così sul ramo sta alla base e il saldo di oggi torna.
      const o = openingFromBalance(account, real, transactions, currency, mainCurrency, rate)
      const opening = await saveOpening(account, o.amount, o.mainAmount, { rate, date: o.date })
      navigator.vibrate?.(8)
      if (opening) onSaved?.(opening)
      return onClose()
    }
    const categoryId = picked[kind]
    const adjust = ADJUST_CATEGORIES[kind]
    if (categoryId === adjust.id && !categories.some((c) => c.id === adjust.id)) await db.categories.put(adjust)
    const amount = Math.abs(diff)
    const tx: Transaction = {
      id: crypto.randomUUID(),
      kind,
      amount,
      currency: currency.code,
      rate,
      mainAmount: foreign ? convertMinor(amount, currency, mainCurrency, rate) : amount,
      date: Date.now(),
      categoryId,
      accountId: account.id,
      note: note.trim() || t('align.defaultNote'),
      source: 'adjust',
    }
    await db.transactions.put(tx)
    navigator.vibrate?.(8)
    onSaved?.(tx)
    onClose()
  }

  const name = builtinName(account, 'acc')
  // Differenza registrata come movimento di oggi: cosa diventa, in che categoria, con che nota.
  const adjustFields = (
    <>
      <p className="rec-diff">
        {t(kind === 'expense' ? 'align.willExpense' : 'align.willIncome', { amount: formatMoney(Math.abs(diff), currency) })}
      </p>
      <div className="field">
        {t('align.category')}
        <div className="chips">
          {(allCats ? options : options.filter((c, i) => i < 4 || c.id === picked[kind])).map((c) => (
            <button
              key={c.id}
              className={`chip rec-chip${picked[kind] === c.id ? ' current' : ''}`}
              style={{ '--c': c.color } as CSSProperties}
              onClick={() => setPicked((p) => ({ ...p, [kind]: c.id }))}
            >
              <CategoryIcon name={c.icon} size={16} />
              {builtinName(c, 'cat')}
            </button>
          ))}
          {!allCats && options.length > 4 && (
            <button className="chip ghost rec-chip" onClick={() => setAllCats(true)}>
              {t('align.moreCats')}
            </button>
          )}
        </div>
      </div>
      <label className="field">
        {t('add.addNote')}
        <input className="input" value={note} placeholder={t('align.defaultNote')} onChange={(e) => setNote(e.target.value)} />
      </label>
    </>
  )
  return createPortal(
    <div className="backdrop calc-backdrop" onClick={(e) => (e.stopPropagation(), onClose())}>
      <div className="sheet reconcile" role="dialog" aria-label={t('align.title', { name })} onClick={(e) => e.stopPropagation()}>
        <div className="calc-head">
          <span className="calc-title">{t('align.title', { name })}</span>
          <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <IconX size={20} />
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {t(starting ? 'align.introStart' : 'align.intro')}
        </p>
        {activeAccounts.length > 1 && (
          <div className="ctx-row align-accounts" role="radiogroup" aria-label={t('align.account')}>
            {activeAccounts.map((a) => (
              <button key={a.id} role="radio" aria-checked={a.id === account.id} className={`ctx${a.id === account.id ? ' on' : ''}`} onClick={() => pickAccount(a.id)}>
                <IconWallet size={15} />
                {builtinName(a, 'acc')}
              </button>
            ))}
          </div>
        )}

        <div className="rec-compare">
          <div>
            <span className="stat-label">{t('align.inFig')}</span>
            <span className={`rec-value${current < 0 ? ' negative' : ''}`}>{formatMoney(current, currency)}</span>
          </div>
          <label>
            <span className="stat-label">{t('align.real')}</span>
            <input
              className="input rec-input"
              inputMode="decimal"
              autoFocus
              key={account.id}
              value={input}
              placeholder={fromMinor(current, currency.decimals).toFixed(currency.decimals).replace('.', decimalSep())}
              aria-invalid={unreadable}
              onChange={(e) => (setInput(e.target.value), setError(''))}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </label>
        </div>

        {real !== null &&
          (diff === 0 ? (
            <p className="rec-ok">
              <IconCheck size={16} /> {t('align.aligned')}
            </p>
          ) : (
            <>
              {noOpening && hasHistory && (
                <div className="ctx-row align-kind" role="group" aria-label={t('align.whichLabel')}>
                  <button className={`ctx${starting ? ' on' : ''}`} aria-pressed={starting} onClick={() => setAsStart(true)}>
                    {t('align.asStart')}
                  </button>
                  <button className={`ctx${starting ? '' : ' on'}`} aria-pressed={!starting} onClick={() => setAsStart(false)}>
                    {t('align.asAdjust')}
                  </button>
                </div>
              )}
              {starting ? <p className="rec-diff">{t('align.willStart', { amount: formatMoney(diff, currency) })}</p> : adjustFields}
            </>
          ))}


        {(error || unreadable) && (
          <p className="error" role="alert">
            {error || t('align.errBalance')}
          </p>
        )}
        <button className="save-btn" disabled={real === null} onClick={save}>
          {real !== null && diff === 0 ? t('common.done') : t(starting ? 'align.saveStart' : 'align.save')}
        </button>
      </div>
    </div>,
    document.body,
  )
}

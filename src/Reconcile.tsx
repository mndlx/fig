import { IconCheck, IconX } from '@tabler/icons-react'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { CategoryIcon } from './catIcons'
import { accountBalance, type AppData } from './data'
import { db, type Account, type Category, type Transaction } from './db'
import { builtinName, numberToInput, t } from './i18n'
import { convertMinor, fetchRate, formatMoney, fromMinor, parseTyped } from './money'

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
 */
export function Reconcile({ data, account, onClose, onSaved }: Props) {
  const { currencies, mainCurrency, categories, transactions } = data
  const currency = currencies.find((c) => c.code === account.currency) ?? mainCurrency
  const foreign = currency.code !== mainCurrency.code
  const current = accountBalance(account, data)
  const [input, setInput] = useState('')
  const [rate, setRate] = useState<number | null>(foreign ? null : 1)
  const [picked, setPicked] = useState<Record<'expense' | 'income', string>>({ expense: ADJUST_CATEGORIES.expense.id, income: ADJUST_CATEGORIES.income.id })
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [allCats, setAllCats] = useState(false)

  const parsed = input.trim() ? parseTyped(input, currency.decimals) : NaN
  const real = Number.isFinite(parsed) ? parsed : null
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
      setRate(last?.rate ?? null)
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
    if (!(rate && rate > 0)) return setError(t('err.rate', { from: currency.code, to: mainCurrency.code }))
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
          {t('align.intro')}
        </p>

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
              value={input}
              placeholder={numberToInput(fromMinor(current, currency.decimals)) || '0'}
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
          ))}

        {error && <p className="error">{error}</p>}
        <button className="save-btn" disabled={real === null} onClick={save}>
          {real !== null && diff === 0 ? t('common.done') : t('align.save')}
        </button>
      </div>
    </div>,
    document.body,
  )
}

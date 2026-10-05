import { IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { accountBalance, type AppData } from './data'
import type { Currency } from './db'
import { knownCurrency, saveStartingBalances, setFirstRunCurrency, setSetup, validCurrencyCode } from './firstRun'
import { builtinName, decimalSep, t } from './i18n'
import { formatMoney, readTyped } from './money'
import { hasOpening } from './opening'

/**
 * Conti che avevano una valuta diversa dalla principale quando il riquadro li ha visti: restano fuori dai
 * cambi di valuta fatti da qui. Sta fuori dal componente perché il riquadro si smonta a ogni cambio di scheda.
 */
const keepCurrency = new Set<string>()

interface Props {
  data: AppData
  /** Senza account: i dati restano solo sul dispositivo. */
  local: boolean
  /** Disponibile di adesso, per mostrare come cambia mentre si scrive. */
  available: number
  /** Presente quando il riquadro è stato riaperto a mano dopo "Più tardi": lo richiude senza decidere. */
  onClose?: () => void
  /** "Più tardi" o "Non mi serve": il riquadro sta per sparire. */
  onDismissed?: () => void
  /** Saldi salvati: gli id creati e la risposta di prima, per "Annulla". */
  onSaved: (ids: string[], previous: AppData['setup']) => void
}

/**
 * L'unica domanda del primo avvio: in che valuta e da quanto si parte. Si può rimandare e
 * riprendere, e finché non c'è niente da convertire la valuta si cambia qui con un tocco.
 */
export function SetupCard({ data, local, available, onClose, onDismissed, onSaved }: Props) {
  const cur = data.mainCurrency
  const accounts = data.accounts.filter((a) => !a.archived && a.currency === cur.code && !hasOpening(a.id, data.transactions))
  // La valuta si sceglie qui solo finché non esiste niente espresso in quella di prima.
  const canPickCurrency = data.transactions.length === 0 && data.goals.length === 0 && data.recurring.length === 0
  const hasMovements = data.transactions.some((tx) => accounts.some((a) => tx.accountId === a.id || tx.toAccountId === a.id))

  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [other, setOther] = useState(false)
  const [custom, setCustom] = useState({ code: '', symbol: '', decimals: 2, touched: false })
  const [curError, setCurError] = useState('')
  const cardRef = useRef<HTMLElement>(null)
  const otherRef = useRef<HTMLButtonElement>(null)
  const resumed = !!onClose
  for (const a of data.accounts) if (a.currency !== cur.code) keepCurrency.add(a.id)

  // Riaperto a mano: si porta in vista e ci si può scrivere subito. Al primo avvio no, la tastiera coprirebbe la pagina.
  useEffect(() => {
    if (!resumed) return
    cardRef.current?.scrollIntoView({ block: 'start' })
    cardRef.current?.querySelector<HTMLInputElement>('.onb-amount input')?.focus()
  }, [resumed])

  const example = cur.decimals === 0 ? '150000' : `1250${decimalSep()}50`
  const focusField = (id?: string) => id && cardRef.current?.querySelector<HTMLInputElement>(`#onb-${CSS.escape(id)}`)?.focus()

  // Disponibile come diventerebbe con le cifre leggibili scritte finora.
  const typed = accounts.map((a) => ({ account: a, value: (values[a.id] ?? '').trim() ? readTyped(values[a.id], cur.decimals) : null }))
  const filled = typed.filter((x) => x.value !== null)
  const preview = filled.reduce((sum, x) => sum + (x.value as number) - accountBalance(x.account, data), available)

  async function pickCurrency(next: Currency) {
    if (busy) return
    setCurError('')
    setOther(false)
    if (next.code === cur.code) return
    setBusy(true)
    try {
      // Rifiutato se nel frattempo è arrivato qualcosa da convertire (un movimento da un altro dispositivo).
      if (!(await setFirstRunCurrency(next, keepCurrency))) setCurError(t('onb.curLocked'))
    } catch {
      setCurError(t('onb.errSave'))
    } finally {
      setBusy(false)
    }
  }

  function changeCode(text: string) {
    const code = text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
    setCurError('')
    setCustom((c) => {
      // Simbolo e decimali noti al browser, finché non li si corregge a mano.
      const known = c.touched ? null : knownCurrency(code)
      return known ? { ...c, code, symbol: known.symbol, decimals: known.decimals } : { ...c, code }
    })
  }

  async function applyCustom() {
    const code = custom.code.trim().toUpperCase()
    if (!validCurrencyCode(code)) return setCurError(t('curForm.codeErr'))
    await pickCurrency(data.currencies.find((c) => c.code === code) ?? { code, symbol: custom.symbol.trim() || code, decimals: custom.decimals })
    // I campi della valuta a mano spariscono: il fuoco torna sul pulsante che li aveva aperti.
    otherRef.current?.focus()
  }

  // Invio nei campi della valuta conferma la valuta, non tutto il riquadro.
  const customEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    void applyCustom()
  }

  function toggleSign(id: string) {
    setValues((v) => {
      const now = (v[id] ?? '').trim()
      return { ...v, [id]: /^[-−]/.test(now) ? now.slice(1) : `-${now}` }
    })
    setErrors((e) => ({ ...e, [id]: '' }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const nextErrors: Record<string, string> = {}
    const balances: Record<string, number> = {}
    for (const a of accounts) {
      const raw = (values[a.id] ?? '').trim()
      if (!raw) continue
      const value = readTyped(raw, cur.decimals)
      if (value === null) nextErrors[a.id] = t('onb.errAmount', { example })
      else balances[a.id] = value
    }
    setErrors(nextErrors)
    const firstBad = accounts.find((a) => nextErrors[a.id])
    if (firstBad) return focusField(firstBad.id)
    if (Object.keys(balances).length === 0) {
      setFormError(t(resumed ? 'onb.errEmptyResumed' : 'onb.errEmpty'))
      return focusField(accounts[0]?.id)
    }
    setFormError('')
    setBusy(true)
    try {
      const previous = data.setup
      onSaved(await saveStartingBalances(balances), previous)
    } catch {
      setFormError(t('onb.errSave'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card onboarding" aria-labelledby="onb-title" ref={cardRef}>
      <div className="onb-head">
        <h2 id="onb-title" className="empty-title">
          {t('onb.title')}
        </h2>
        {onClose && (
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <IconX size={20} />
          </button>
        )}
      </div>
      <p className="muted small onb-body">{t('onb.body')}</p>

      <form className="form" onSubmit={submit} noValidate>
        {canPickCurrency ? (
          <div className="field">
            <span id="onb-cur-label">{t('common.currency')}</span>
            {/* Pulsanti a due stati in un gruppo con nome: si scorrono con Tab e si attivano con Invio o Spazio. */}
            <div className="ctx-row onb-currencies" role="group" aria-labelledby="onb-cur-label">
              {data.currencies.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  aria-pressed={c.code === cur.code && !other}
                  className={`ctx${c.code === cur.code && !other ? ' on' : ''}`}
                  disabled={busy}
                  onClick={() => void pickCurrency(c)}
                >
                  {c.code}
                  {c.symbol !== c.code && <span className="muted">{c.symbol}</span>}
                </button>
              ))}
              <button ref={otherRef} type="button" aria-expanded={other} className={`ctx${other ? ' on' : ''}`} onClick={() => (setOther((v) => !v), setCurError(''))}>
                {t('onb.otherCurrency')}
              </button>
            </div>
            {other && (
              <div className="onb-custom">
                <label className="field">
                  {t('curForm.code')}
                  <input value={custom.code} autoFocus maxLength={3} autoCapitalize="characters" autoComplete="off" placeholder="JPY" onChange={(e) => changeCode(e.target.value)} onKeyDown={customEnter} />
                </label>
                <label className="field">
                  {t('curForm.symbol')}
                  <input
                    value={custom.symbol}
                    maxLength={4}
                    autoComplete="off"
                    placeholder="¥"
                    onChange={(e) => setCustom((c) => ({ ...c, symbol: e.target.value, touched: true }))}
                    onKeyDown={customEnter}
                  />
                </label>
                <label className="field">
                  {t('curForm.decimals')}
                  <select value={custom.decimals} onChange={(e) => setCustom((c) => ({ ...c, decimals: Number(e.target.value), touched: true }))}>
                    <option value={0}>0</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
                <button type="button" className="secondary" disabled={busy} onClick={() => void applyCustom()}>
                  {t('onb.useCurrency')}
                </button>
              </div>
            )}
            {curError && (
              <span className="error" role="alert">
                {curError}
              </span>
            )}
          </div>
        ) : (
          <p className="muted small onb-fixed">{t('onb.currencyFixed', { code: cur.code })}</p>
        )}

        {accounts.map((a, i) => {
          const name = builtinName(a, 'acc')
          const negative = /^\s*[-−]/.test(values[a.id] ?? '')
          return (
            <div key={a.id} className="field">
              <label htmlFor={`onb-${a.id}`}>{name}</label>
              <div className="onb-amount">
                <input
                  id={`onb-${a.id}`}
                  inputMode={cur.decimals === 0 ? 'numeric' : 'decimal'}
                  autoComplete="off"
                  enterKeyHint={i === accounts.length - 1 ? 'done' : 'next'}
                  placeholder={formatMoney(0, cur)}
                  value={values[a.id] ?? ''}
                  aria-invalid={!!errors[a.id]}
                  aria-describedby={errors[a.id] ? `onb-err-${a.id}` : undefined}
                  // Invio (o "Avanti" sulla tastiera del telefono) passa al conto dopo; solo dall'ultimo salva.
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || i === accounts.length - 1) return
                    e.preventDefault()
                    focusField(accounts[i + 1].id)
                  }}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [a.id]: e.target.value }))
                    setErrors((er) => ({ ...er, [a.id]: '' }))
                    setFormError('')
                  }}
                />
                {/* Il tastierino numerico dei telefoni non ha il meno: un conto in rosso si segna da qui. */}
                <button type="button" className="onb-sign" aria-pressed={negative} aria-label={t('onb.negative', { name })} title={t('onb.negative', { name })} onClick={() => toggleSign(a.id)}>
                  ±
                </button>
              </div>
              {errors[a.id] && (
                <span id={`onb-err-${a.id}`} className="error" role="alert">
                  {errors[a.id]}
                </span>
              )}
            </div>
          )
        })}

        {hasMovements && <p className="muted small onb-note">{t('onb.hasMovements')}</p>}
        <p className="onb-preview" aria-live="polite">
          {filled.length > 0 && t('onb.preview', { amount: formatMoney(preview, cur) })}
        </p>
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={async () => {
              try {
                await setSetup(resumed ? 'done' : 'later')
                onDismissed?.()
              } catch {
                setFormError(t('onb.errSave'))
              }
            }}
          >
            {t(resumed ? 'onb.dismiss' : 'onb.later')}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
        <p className="muted small onb-privacy">
          {local ? (
            t('onb.privacyLocal')
          ) : (
            <>
              {t('onb.privacyAccount')} <a href="/privacy.html">{t('welcome.privacy')}</a>
            </>
          )}
        </p>
      </form>
    </section>
  )
}

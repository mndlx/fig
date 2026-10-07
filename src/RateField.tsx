import { IconCheck } from '@tabler/icons-react'
import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { Currency } from './db'
import { dateFmt, decimalSep, locale, t } from './i18n'
import { convertMinor, formatMoney } from './money'
import { dayEnd, rateInput, type RateView } from './rate'

/**
 * Un cambio da leggere, non da modificare: poche cifre, col decimale della lingua ("1 € = 97,35 L").
 * Senza separatore delle migliaia: nel campo un solo separatore è sempre il decimale (readRate), e chi riscrivesse
 * "1.600" come lo vede qui salverebbe un cambio mille volte più piccolo.
 */
export function rateShown(rate: number): string {
  return rate.toLocaleString(locale(), { maximumSignificantDigits: 6, useGrouping: false })
}

/**
 * Riga sotto l'etichetta del campo: l'errore, se il cambio è stato chiesto e manca; altrimenti da dove viene
 * il cambio proposto, o quanto vale l'importo con quello scritto a mano (così un errore di scala si vede subito).
 */
export function rateHint(view: RateView, ctx: { bad: boolean; from: Currency; main: Currency; amount: number; day: string }): string {
  const { from, main } = ctx
  if (ctx.bad) return view.text.trim() ? t('rate.bad', { example: `97${decimalSep()}5` }) : t('err.rate', { from: from.code, to: main.code })
  const date = (ts: number) => dateFmt({ day: 'numeric', month: 'short' }).format(ts)
  switch (view.source) {
    case 'typed':
      return view.value !== null && ctx.amount > 0 ? `${formatMoney(ctx.amount, from)} ≈ ${formatMoney(convertMinor(ctx.amount, from, main, view.value), main)}` : ''
    case 'own':
      return t('rate.own')
    case 'day':
      return t('rate.day', { date: date(dayEnd(ctx.day)) })
    case 'last':
      return view.at !== null ? t('rate.last', { date: date(view.at) }) : ''
    default:
      return t(view.pending ? 'rate.pending' : 'rate.none')
  }
}

interface Props {
  id: string
  from: string
  to: string
  value: string
  /** Cambio proposto, mostrato come segnaposto quando il campo è vuoto. */
  placeholder: number | null
  /** Riga sotto l'etichetta: da dove viene il cambio, l'anteprima, oppure l'errore. */
  hint: string
  invalid: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  onChange: (text: string) => void
  /** Il campo perde il fuoco. */
  onLeave: () => void
  onEnter: () => void
  /** Dove il campo si apre e si chiude (foglio "+"): pulsante "Fatto" accanto. */
  onDone?: () => void
  onEscape?: () => void
}

/** Campo "Cambio 1 EUR = ? ALL": etichetta e riga di spiegazione a sinistra, numero a destra. */
export function RateField({ id, from, to, value, placeholder, hint, invalid, inputRef, autoFocus, onChange, onLeave, onEnter, onDone, onEscape }: Props) {
  const own = useRef<HTMLInputElement | null>(null)
  const ref = inputRef ?? own
  // Ultimo testo scritto dall'utente: se il valore è un altro, è cambiato da solo.
  const typed = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    // È arrivato il cambio del giorno mentre il campo ha il fuoco e non è stato toccato: il testo nuovo resta
    // tutto selezionato, così scrivendo lo si sostituisce invece di accodargli le cifre.
    if (el && document.activeElement === el && value !== typed.current) el.select()
  }, [value])
  return (
    <div className="rate-field">
      <div className="rate-text">
        <label className="rate-label" htmlFor={id}>
          {t('accForm.rate', { from, to })}
        </label>
        <p id={`${id}-hint`} className={`rate-hint${invalid ? ' bad' : ''}`} role="status">
          {hint}
        </p>
      </div>
      <div className="rate-entry">
        <input
          ref={ref}
          id={id}
          className="input rate-input"
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder !== null ? rateInput(placeholder) : '?'}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint`}
          onChange={(e) => ((typed.current = e.target.value), onChange(e.target.value))}
          // Il cambio proposto si sostituisce scrivendo, senza doverlo prima cancellare.
          onFocus={(e) => e.currentTarget.select()}
          onBlur={onLeave}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== 'Escape') return
            // Senza questo, se il fuoco passa a un pulsante mentre il tasto è giù, Invio lo preme subito.
            e.preventDefault()
            if (e.key === 'Enter') onEnter()
            else onEscape?.()
          }}
        />
        {onDone && (
          <button className="icon-btn" aria-label={t('common.done')} onClick={onDone}>
            <IconCheck size={20} />
          </button>
        )}
      </div>
    </div>
  )
}

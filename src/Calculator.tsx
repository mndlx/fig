import { IconBackspace, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { decimalSep, locale, t } from './i18n'

type Op = '+' | '−' | '×' | '÷'

interface State {
  /** Numero sul display: quello che si sta scrivendo o l'ultimo risultato. */
  entry: string
  /** Primo operando in attesa dell'operazione. */
  acc: number | null
  op: Op | null
  /** Riga sopra il display con il calcolo in corso ("12 + 5 ="). */
  expr: string
  /** Il display mostra un risultato: la prossima cifra ricomincia da capo. */
  fresh: boolean
  /** Ultima operazione, per ripeterla premendo di nuovo "=". */
  repeat: { op: Op; value: number } | null
  error: boolean
}

const START: State = { entry: '0', acc: null, op: null, expr: '', fresh: false, repeat: null, error: false }

/** Arrotonda gli errori della virgola mobile (0,1 + 0,2) a 12 cifre significative. */
function clean(n: number): number {
  return Number(n.toPrecision(12))
}

function apply(a: number, op: Op, b: number): number {
  switch (op) {
    case '+':
      return clean(a + b)
    case '−':
      return clean(a - b)
    case '×':
      return clean(a * b)
    case '÷':
      return b === 0 ? NaN : clean(a / b)
  }
}

function show(n: number): string {
  if (!Number.isFinite(n)) return ''
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 10 }).format(n)
}

/** Numero in scrittura con i separatori della lingua, senza perdere zeri finali o la virgola appena digitata. */
function showEntry(entry: string): string {
  const negative = entry.startsWith('-')
  const [int, dec] = entry.replace('-', '').split('.')
  const grouped = new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(int))
  return (negative ? '−' : '') + grouped + (dec !== undefined ? decimalSep() + dec : '')
}

function reduce(s: State, key: string): State {
  if (s.error && key !== 'C' && key !== 'CE') return s
  const value = Number(s.entry)
  const withResult = (n: number, expr: string, extra: Partial<State> = {}): State =>
    Number.isFinite(n) ? { ...s, entry: String(n), expr, fresh: true, ...extra } : { ...START, entry: '0', expr, error: true }

  if (/^[0-9]$/.test(key)) {
    if (s.fresh || s.entry === '0') return { ...s, entry: key, fresh: false, expr: s.op ? s.expr : '' }
    if (s.entry.replace(/[-.]/g, '').length >= 16) return s
    return { ...s, entry: s.entry + key }
  }
  switch (key) {
    case '.':
      if (s.fresh) return { ...s, entry: '0.', fresh: false, expr: s.op ? s.expr : '' }
      return s.entry.includes('.') ? s : { ...s, entry: s.entry + '.' }
    case '⌫':
      if (s.fresh) return { ...s, expr: s.op ? s.expr : '' }
      return { ...s, entry: s.entry.length > 1 && s.entry !== '-0' ? s.entry.slice(0, -1).replace(/^-$/, '0') : '0' }
    case 'CE':
      return s.error ? START : { ...s, entry: '0', fresh: false }
    case 'C':
      return START
    case '±':
      if (value === 0) return s
      return { ...s, entry: s.entry.startsWith('-') ? s.entry.slice(1) : '-' + s.entry }
    case '%': {
      // Come su Windows: con + e − è la percentuale del primo numero, con × e ÷ diventa una frazione.
      const n = s.acc !== null && (s.op === '+' || s.op === '−') ? clean((s.acc * value) / 100) : clean(value / 100)
      return { ...s, entry: String(n), fresh: true }
    }
    case '1/x':
      return value === 0 ? { ...START, error: true, expr: `1/(${show(value)})` } : withResult(clean(1 / value), s.op ? s.expr : `1/(${show(value)})`)
    case 'x²':
      return withResult(clean(value * value), s.op ? s.expr : `sqr(${show(value)})`)
    case '√x':
      return value < 0 ? { ...START, error: true, expr: `√(${show(value)})` } : withResult(clean(Math.sqrt(value)), s.op ? s.expr : `√(${show(value)})`)
    case '+':
    case '−':
    case '×':
    case '÷': {
      const op = key as Op
      // Operazioni in fila si calcolano da sinistra a destra, come la calcolatrice standard di Windows.
      if (s.acc !== null && s.op && !s.fresh) {
        const n = apply(s.acc, s.op, value)
        if (!Number.isFinite(n)) return { ...START, error: true, expr: `${show(s.acc)} ${s.op} ${show(value)}` }
        return { ...s, acc: n, op, entry: String(n), expr: `${show(n)} ${op}`, fresh: true, repeat: null }
      }
      return { ...s, acc: value, op, expr: `${show(value)} ${op}`, fresh: true, repeat: null }
    }
    case '=': {
      if (s.acc !== null && s.op) {
        const n = apply(s.acc, s.op, value)
        return withResult(n, `${show(s.acc)} ${s.op} ${show(value)} =`, { acc: null, op: null, repeat: { op: s.op, value } })
      }
      if (s.repeat) {
        const n = apply(value, s.repeat.op, s.repeat.value)
        return withResult(n, `${show(value)} ${s.repeat.op} ${show(s.repeat.value)} =`)
      }
      return { ...s, expr: `${show(value)} =`, fresh: true }
    }
  }
  return s
}

const KEYS: { key: string; kind?: 'fn' | 'op' | 'eq' }[] = [
  { key: '%', kind: 'fn' },
  { key: 'CE', kind: 'fn' },
  { key: 'C', kind: 'fn' },
  { key: '⌫', kind: 'fn' },
  { key: '1/x', kind: 'fn' },
  { key: 'x²', kind: 'fn' },
  { key: '√x', kind: 'fn' },
  { key: '÷', kind: 'op' },
  { key: '7' },
  { key: '8' },
  { key: '9' },
  { key: '×', kind: 'op' },
  { key: '4' },
  { key: '5' },
  { key: '6' },
  { key: '−', kind: 'op' },
  { key: '1' },
  { key: '2' },
  { key: '3' },
  { key: '+', kind: 'op' },
  { key: '±' },
  { key: '0' },
  { key: '.' },
  { key: '=', kind: 'eq' },
]

const KEYBOARD: Record<string, string> = {
  '+': '+',
  '-': '−',
  '*': '×',
  x: '×',
  '/': '÷',
  Enter: '=',
  '=': '=',
  Backspace: '⌫',
  Delete: 'CE',
  Escape: 'C',
  '%': '%',
  ',': '.',
  '.': '.',
}

interface Props {
  /** Valore di partenza (per esempio l'importo già scritto). */
  initial?: number
  onClose: () => void
  /** Se presente, il risultato si può usare come importo. */
  onUse?: (value: number) => void
  useLabel?: string
}

/** Calcolatrice standard, sullo stile di quella di Windows, da usare dentro l'app. */
export function Calculator({ initial, onClose, onUse, useLabel }: Props) {
  const [state, setState] = useState<State>(() => (initial ? { ...START, entry: String(initial), fresh: true } : START))
  const press = useCallback((key: string) => setState((s) => reduce(s, key)), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const key = /^[0-9]$/.test(e.key) ? e.key : KEYBOARD[e.key]
      if (!key) return
      e.preventDefault()
      if (key === 'C' && e.key === 'Escape' && state.entry === '0' && state.acc === null) return onClose()
      press(key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, onClose, state.entry, state.acc])

  const value = Number(state.entry)
  const canUse = !state.error && Number.isFinite(value) && value > 0

  // Portale sul body: la calcolatrice si apre anche da dentro l'inserimento, che ha già il suo sfondo.
  return createPortal(
    <div className="backdrop calc-backdrop" onClick={(e) => (e.stopPropagation(), onClose())}>
      <div className="sheet calc" role="dialog" aria-label={t('calc.title')} onClick={(e) => e.stopPropagation()}>
        <div className="calc-head">
          <span className="calc-title">{t('calc.title')}</span>
          <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <IconX size={20} />
          </button>
        </div>
        <div className="calc-display" aria-live="polite">
          <span className="calc-expr">{state.expr || ' '}</span>
          <span className="calc-value">{state.error ? t('calc.error') : state.fresh ? show(value) : showEntry(state.entry)}</span>
        </div>
        <div className="calc-keys">
          {KEYS.map(({ key, kind }) => (
            <button
              key={key}
              className={`calc-key${kind ? ` ${kind}` : ''}`}
              disabled={state.error && key !== 'C' && key !== 'CE'}
              aria-label={key === '⌫' ? 'Backspace' : key === '.' ? decimalSep() : key}
              onClick={() => press(key)}
            >
              {key === '⌫' ? <IconBackspace size={20} stroke={1.6} /> : key === '.' ? decimalSep() : key === '±' ? '+/−' : key}
            </button>
          ))}
        </div>
        {onUse && (
          <button className="save-btn" disabled={!canUse} onClick={() => onUse(value)}>
            {useLabel ?? t('calc.use')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}

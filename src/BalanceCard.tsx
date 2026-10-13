import { useEffect, useMemo, useRef, useState } from 'react'
import { BalanceLine } from './charts'
import type { Transaction } from './db'
import { t, type Key } from './i18n'
import {
  explainLeg,
  MIN_DAYS_FOR_EXTREMES,
  monthStart,
  nextDay,
  sliceByDate,
  type DayMove,
  type DayPoint,
  type Leg,
  type LegGroup,
  type LineMark,
  type MonthEnvelope,
  type Saving,
  type Scope,
  type SpendContext,
  type Swing,
  type Swings,
} from './stats'
import { HowTo, tn, TxRow, type TrendFormat } from './trend'

/** Tutto quello che il riquadro del saldo mostra, già calcolato: cambia coi dati, col periodo e col saldo guardato. */
export interface BalanceModel {
  points: DayPoint[]
  env: MonthEnvelope[]
  /** Le salite e le discese della linea, col "solito" degli ultimi dodici mesi. */
  swings: Swings
  /** Per ogni giorno della serie, la posizione del suo tratto nella lista. */
  dayOf: Int32Array
  /** I giorni dove il dito si ferma da solo. */
  stops: number[]
  /** Per ogni giorno, cosa ha mosso di più il saldo. */
  moves: DayMove[]
  marks: LineMark[]
  /** I movimenti in ordine di data. */
  sorted: Transaction[]
  ctx: SpendContext
  /** Quanto c'è negli obiettivi oggi. */
  inGoals: number
  hasStart: boolean
  /** Si sono mai usati gli obiettivi: allora ha senso scegliere tra totale e disponibile. */
  goalsEver: boolean
}

interface Props {
  model: BalanceModel
  fmt: TrendFormat
  /** Il simbolo della valuta, per la riga sotto la tabella. */
  symbol: string
  scope: Scope
  onScope: (scope: Scope) => void
  now: number
  saving: Saving
  onOpen: (tx: Transaction) => void
  /** Apre un mese nella scheda "Mese" (primo istante del mese). */
  onOpenMonth: (month: number) => void
}

/** Quante salite e discese si vedono in "Tutti" prima di "Mostra altri", e quante se ne aggiungono ogni volta. */
const FIRST_ROWS = 12
const MORE_ROWS = 24
/** Quanti movimenti di un tratto si vedono prima di "Mostra tutti". */
const MOVERS = 8

/**
 * "Andamento del saldo": la linea giorno per giorno, divisa in salite e discese. Ogni tratto ha il suo perché:
 * toccando la linea (o coi due pulsanti ‹ ›) si legge di quanto è salita o scesa, tra quali giorni e per quali
 * movimenti; sotto, l'elenco di tutti i tratti con le stesse parole. I conti stanno in stats.ts.
 * Il giorno scelto vive qui dentro: scorrere la linea ridisegna solo questo riquadro.
 */
export function BalanceCard({ model, fmt, symbol, scope, onScope, now, saving, onOpen, onOpenMonth }: Props) {
  const { points, swings, dayOf, stops, moves, marks } = model
  const { money, bare, num, monthShort, monthYear, dayShort, dayLong, dayFull, catName, txName } = fmt
  const list = swings.list
  // Il giorno scelto (mezzanotte locale), o null: allora si parla di oggi.
  const [day, setDay] = useState<number | null>(null)
  const [filter, setFilter] = useState<'big' | 'all'>('big')
  const [shown, setShown] = useState(FIRST_ROWS)
  const [openLeg, setOpenLeg] = useState<number | null>(null)
  const [allMovers, setAllMovers] = useState(false)
  // Il tratto da portare a schermo dopo "Vedi i movimenti".
  const reveal = useRef<number | null>(null)

  const last = points.length - 1
  const indexOf = useMemo(() => new Map(points.map((p, i) => [p.day, i])), [points])
  const selected = day !== null ? (indexOf.get(day) ?? null) : null
  const at = selected ?? last
  const position = list.length > 0 ? dayOf[at] : -1
  const swing = position >= 0 ? list[position] : null
  const sameYear = (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear()

  // La spiegazione di un tratto si calcola la prima volta che serve, sui soli movimenti dei suoi giorni, e si tiene.
  const legs = useMemo(() => new Map<number, Leg>(), [model])
  const legOf = (s: Swing): Leg => {
    let leg = legs.get(s.id)
    if (!leg) {
      const start = s.from.day === s.to.day ? s.from.day : nextDay(s.from.day)
      leg = explainLeg(sliceByDate(model.sorted, start, nextDay(s.to.day)), s.from, s.to, s.dir === 'up' ? 'high' : 'low', model.ctx, { now, scope })
      legs.set(s.id, leg)
    }
    return leg
  }

  // ——— Le parole ———
  // Le commissioni col nome che ha la categoria adesso (si può rinominare); i contanti solo se lo sono davvero.
  const feesName = catName(model.ctx.categories.find((c) => c.key === 'fees')?.id)
  const groupName = (g: LegGroup) =>
    g.kind === 'payee' ? g.name : g.kind === 'fees' ? feesName : g.kind === 'adjust' ? t('trend.ev.adjust') : g.kind === 'opaque' ? t(g.cash ? 'trend.opaque' : 'trend.opaqueOther') : catName(g.key || undefined)
  const item = (name: string, amount: number) => t('trend.ev.item', { name, amount: money(amount) })
  const groupItem = (g: LegGroup) => (g.count > 1 ? t('trend.ev.itemN', { name: groupName(g), n: g.count, amount: money(g.total) }) : item(groupName(g), g.total))
  const usualOf = (s: Swing) => (s.dir === 'up' ? swings.usualUp : swings.usualDown)
  /** Tra quali giorni: date da sole, mai attaccate a un articolo ("dal 8" in italiano è sbagliato). */
  const rangeText = (s: Swing): string => {
    if (s.days <= 1) return dayLong(s.to.day)
    const from = sameYear(s.from.day, s.to.day) ? dayShort(s.from.day) : dayLong(s.from.day)
    return s.open === 'running' ? t('trend.sw.toToday', { from }) : t('trend.sw.range', { from, to: dayLong(s.to.day) })
  }
  /** Da cosa è fatto un tratto, in breve: i movimenti se sono pochi, altrimenti i gruppi più pesanti. */
  const causes = (s: Swing, leg: Leg): string[] => {
    if (leg.movers.length === 1 || (s.dir === 'up' && leg.movers.length <= 3)) return leg.movers.map((tx) => item(txName(tx), tx.mainAmount))
    if (s.dir === 'down' && leg.single) return [item(txName(leg.single), leg.single.mainAmount)]
    return leg.top.map((g) => item(groupName(g), g.total))
  }
  /** Le due righe del perché, sopra il grafico: pezzi corti in fila. */
  const whyText = (s: Swing, leg: Leg): string => {
    const parts: string[] = []
    if (s.open === 'running') parts.push(t('trend.sw.running'))
    if (s.open === 'start') parts.push(t('trend.sw.first'))
    const usual = usualOf(s)
    if (usual !== null && s.versus === 'more') parts.push(t('trend.sw.more', { amount: money(s.amount - usual) }))
    if (usual !== null && s.versus === 'less') parts.push(t('trend.sw.less', { amount: money(usual - s.amount) }))
    if (s.versus === 'same') parts.push(t('trend.sw.same'))
    parts.push(...causes(s, leg))
    if (scope === 'available' && leg.saved > 0) parts.push(t('trend.sw.savedBit', { amount: money(leg.saved) }))
    if (scope === 'available' && leg.saved < 0) parts.push(t('trend.sw.releasedBit', { amount: money(-leg.saved) }))
    return parts.join(' · ')
  }
  /** La stessa cosa per esteso, nella riga dell'elenco. */
  const rowText = (s: Swing, leg: Leg): string => {
    const parts = [tn(s.dir === 'up' ? 'trend.sw.rowUp' : 'trend.sw.rowDown', Math.max(1, s.days), { amount: money(s.amount), date: dayLong(s.from.day), value: money(s.from.value) })]
    if (s.open === 'running') parts.push(t('trend.sw.runningLong'))
    if (s.open === 'start') parts.push(t('trend.sw.firstLong'))
    const usual = usualOf(s)
    if (usual !== null && s.versus === 'more') parts.push(t('trend.sw.moreLong', { amount: money(s.amount - usual) }))
    if (usual !== null && s.versus === 'less') parts.push(t('trend.sw.lessLong', { amount: money(usual - s.amount) }))
    if (s.versus === 'same') parts.push(t('trend.sw.sameLong'))
    const came = leg.in + leg.adjustIn
    if (s.dir === 'up') {
      if (leg.movers.length === 1) parts.push(t('trend.sw.inOne', { name: txName(leg.movers[0]), amount: money(leg.movers[0].mainAmount) }))
      else if (leg.movers.length > 0 && leg.movers.length <= 3) parts.push(t('trend.sw.inFew', { list: leg.movers.map((tx) => item(txName(tx), tx.mainAmount)).join(' · ') }))
      else if (leg.top.length > 0) parts.push(t('trend.ev.topIn', { list: leg.top.map(groupItem).join(' · ') }))
      if (leg.out > 0 && leg.out >= 0.1 * came) parts.push(t('trend.sw.alsoOut', { amount: money(leg.out) }))
    } else {
      if (leg.movers.length === 1) parts.push(t('trend.sw.outOne', { name: txName(leg.movers[0]), amount: money(leg.movers[0].mainAmount) }))
      else if (leg.single) parts.push(t('trend.ev.single', { name: txName(leg.single), amount: money(leg.single.mainAmount) }))
      else if (leg.top.length > 0) parts.push(t('trend.ev.topOut', { list: leg.top.map(groupItem).join(' · ') }))
      if (came > 0 && came >= 0.1 * leg.out) parts.push(t('trend.sw.alsoIn', { amount: money(came) }))
    }
    if (scope === 'available' && leg.saved > 0) parts.push(t('trend.ev.saved', { amount: money(leg.saved) }))
    if (scope === 'available' && leg.saved < 0) parts.push(t('trend.ev.released', { amount: money(-leg.saved) }))
    return parts.join(' ')
  }
  const short = points.length < MIN_DAYS_FOR_EXTREMES
  const rowTitle = (s: Swing): string =>
    s.open === 'running'
      ? t('trend.ev.today')
      : !short && s.toIndex === swings.highIndex
        ? t('trend.ev.max')
        : !short && s.toIndex === swings.lowIndex
          ? t('trend.ev.min')
          : t(s.dir === 'up' ? 'trend.ev.high' : 'trend.ev.low')

  // ——— Sopra il grafico: il tratto, il perché, il giorno ———
  const move = moves[at]
  const dayText =
    points[at].delta === 0 && move.count === 0
      ? t('trend.bal.noChange')
      : `${t('trend.bal.change', { amount: money(points[at].delta, true) })}${move.top ? ` · ${move.count > 1 ? tn('trend.bal.others', move.count - 1, { name: txName(move.top) }) : txName(move.top)}` : ''}`
  const legNow = swing ? legOf(swing) : null
  const go = (to: number) => {
    const next = list[to]
    if (next) setDay(next.to.day)
  }

  // ——— L'elenco ———
  const filledAt = useMemo(() => new Set(marks.filter((mark) => mark.filled).map((mark) => mark.index)), [marks])
  const big = useMemo(() => list.filter((s) => filledAt.has(s.toIndex)).reverse(), [list, filledAt])
  // Con poche salite e discese l'elenco è uno solo; con tante si parte dalle più grandi.
  const canFilter = big.length > 0 && list.length > 8
  const all = filter === 'all' || !canFilter
  const rows = useMemo(() => (all ? [...list].reverse() : big), [all, list, big])
  const visible = all ? rows.slice(0, shown) : rows

  /** Apre un tratto nell'elenco, coi suoi movimenti, e lo porta a schermo. */
  function showSwing(s: Swing) {
    setFilter('all')
    setShown((n) => Math.max(n, list.length - list.indexOf(s)))
    setOpenLeg(s.id)
    setAllMovers(false)
    reveal.current = s.id
  }
  useEffect(() => {
    const id = reveal.current
    if (id === null) return
    reveal.current = null
    document.getElementById(`swing-${id}`)?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  })

  const usualLine =
    swings.usualUp !== null && swings.usualDown !== null
      ? t('trend.sw.usual', { up: money(swings.usualUp), down: money(swings.usualDown) })
      : swings.usualUp !== null
        ? t('trend.sw.usualUp', { up: money(swings.usualUp) })
        : swings.usualDown !== null
          ? t('trend.sw.usualDown', { down: money(swings.usualDown) })
          : null
  const hollowDrawn = marks.some((mark) => !mark.filled)

  return (
    <section className="card balance">
      <div className="card-head stack">
        <h2 className="card-title">{t('trend.bal.title')}</h2>
        {model.goalsEver && (
          <div className="switch compact" role="group" aria-label={t('trend.bal.scope')}>
            {(['total', 'available'] as const).map((s) => (
              <button key={s} className={scope === s ? 'on' : ''} aria-pressed={scope === s} onClick={() => onScope(s)}>
                {t(`trend.bal.scope.${s}` as Key)}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="bal-now">
        <span className="stat-label">{t('trend.bal.today')}</span>
        <span className="bal-value">{money(points[last].value)}</span>
        {scope === 'total' && model.inGoals > 0 && <span className="stat-extra">{t('trend.bal.inGoals', { amount: money(model.inGoals) })}</span>}
      </p>
      {saving.cushion !== null && (
        <p className="keep-sub">
          {t('trend.bal.cushion', { amount: money(saving.cushion) })}
          {saving.cushionBefore !== null && saving.cushion !== saving.cushionBefore && ` (${t('trend.bal.cushionDelta', { amount: money(saving.cushion - saving.cushionBefore, true) })})`}
          {saving.runway !== null && saving.runway > 0 && ` · ${saving.runway === 1 ? t('trend.bal.runway.one') : t('trend.bal.runway', { n: num(saving.runway) })}`}
        </p>
      )}

      {/* Sei righe, sempre: mentre il dito scorre il grafico non deve muoversi sotto di lui. */}
      <div className="readout swing">
        <span className="readout-leg" aria-live="polite">
          {swing ? t(swing.dir === 'up' ? 'trend.sw.up' : 'trend.sw.down', { amount: money(swing.amount) }) : t('trend.sw.flat')}
        </span>
        <span className="readout-when">{swing ? rangeText(swing) : ''}</span>
        <span className="pager">
          <button aria-label={t('trend.sw.prev')} disabled={position <= 0} onClick={() => go(position - 1)}>
            ‹
          </button>
          <button aria-label={t('trend.sw.next')} disabled={position < 0 || position >= list.length - 1} onClick={() => go(position + 1)}>
            ›
          </button>
        </span>
        <span className="readout-why">{swing && legNow ? whyText(swing, legNow) : ''}</span>
        <span className="readout-day">
          {dayFull(points[at].day)} · {money(points[at].value)}
        </span>
        <span className="readout-move">{dayText}</span>
      </div>
      <BalanceLine
        points={points}
        marks={marks}
        swings={list}
        swing={selected !== null ? position : -1}
        stops={stops}
        runningFrom={monthStart(now)}
        selected={selected}
        onSelect={(index) => setDay(index === null ? null : points[index].day)}
        label={t('trend.bal.chart')}
        valueText={(i) => {
          const s = list.length > 0 && dayOf[i] >= 0 ? list[dayOf[i]] : null
          return `${dayLong(points[i].day)}: ${money(points[i].value)}.${s ? ` ${t(s.dir === 'up' ? 'trend.sw.up' : 'trend.sw.down', { amount: money(s.amount) })}, ${rangeText(s)}.` : ''}`
        }}
        todayLabel={t('trend.bal.today').toLowerCase()}
        axis={fmt.axisLabels}
        amount={money}
        month={monthShort}
      />
      {marks.length > 0 && (
        <p className="chart-legend">
          <span className="lg">
            <span className="ev-mark" aria-hidden="true" />
            {t('trend.lg.high')}
          </span>
          <span className="lg low">
            <span className="ev-mark" aria-hidden="true" />
            {t('trend.lg.low')}
          </span>
          <span>
            {t('trend.lg.full')}
            {hollowDrawn && <span className="lg-hollow"> {t('trend.lg.hollow')}</span>}
          </span>
        </p>
      )}
      <div className="chart-links">
        {swing && legNow && legNow.movers.length > 0 ? (
          <button className="link-btn" onClick={() => showSwing(swing)}>
            {t('trend.ev.show', { n: legNow.movers.length })}
          </button>
        ) : (
          <span />
        )}
        <button className="link-btn" style={{ visibility: day === null ? 'hidden' : 'visible' }} onClick={() => setDay(null)}>
          {t('trend.sw.backToday')}
        </button>
      </div>
      <p className="chart-note">{t('trend.bal.note')}</p>
      <HowTo items={[t(scope === 'total' ? 'trend.bal.what' : 'trend.bal.whatAvailable'), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => t(`trend.how.bal.${i}` as Key))]} />
      {!model.hasStart && <p className="hint left">{t('trend.bal.noStart')}</p>}

      <h3 className="sub-title">{t('trend.ev.title')}</h3>
      {list.length === 0 ? (
        <p className="muted small">{t(short ? 'trend.bal.short' : 'trend.ev.none')}</p>
      ) : (
        <>
          {usualLine && <p className="keep-sub">{usualLine}</p>}
          {canFilter && (
            <div className="switch compact ev-filter" role="group" aria-label={t('trend.sw.filter')}>
              <button className={!all ? 'on' : ''} aria-pressed={!all} onClick={() => setFilter('big')}>
                {t('trend.sw.big', { n: big.length })}
              </button>
              <button className={all ? 'on' : ''} aria-pressed={all} onClick={() => setFilter('all')}>
                {t('trend.sw.all', { n: list.length })}
              </button>
            </div>
          )}
          <ul className="ev-list">
            {visible.map((s) => {
              const leg = legOf(s)
              const open = openLeg === s.id
              const on = selected !== null && swing === s
              return (
                <li key={s.id} id={`swing-${s.id}`} className={`ev ${s.dir === 'up' ? 'high' : 'low'}${on ? ' on' : ''}`}>
                  <button className="ev-head" aria-pressed={on} title={t('trend.sw.select')} onClick={() => setDay(s.to.day)}>
                    <span className={`ev-mark${s.open === 'running' && !filledAt.has(s.toIndex) ? ' today' : filledAt.has(s.toIndex) ? '' : ' hollow'}`} aria-hidden="true" />
                    <span className="ev-title">
                      {rowTitle(s)}
                      <span className="muted"> · {dayLong(s.to.day)}</span>
                    </span>
                    <span className="legend-value">{money(s.to.value)}</span>
                  </button>
                  <p className="ev-text">{rowText(s, leg)}</p>
                  {leg.movers.length > 0 && (
                    <button
                      className="link-btn"
                      aria-expanded={open}
                      onClick={() => {
                        setOpenLeg(open ? null : s.id)
                        setAllMovers(false)
                      }}
                    >
                      {t('trend.ev.show', { n: leg.movers.length })}
                    </button>
                  )}
                  {open && (
                    <div className="cat-tx flat">
                      {(allMovers ? leg.movers : leg.movers.slice(0, MOVERS)).map((tx) => (
                        <TxRow key={tx.id} tx={tx} fmt={fmt} onOpen={onOpen} />
                      ))}
                      {leg.movers.length > MOVERS && (
                        <button className="link-btn" onClick={() => setAllMovers((v) => !v)}>
                          {allMovers ? t('trend.spend.less') : t('trend.sw.showAll', { n: leg.movers.length })}
                        </button>
                      )}
                      <button className="link-btn" onClick={() => onOpenMonth(monthStart(s.to.day))}>
                        {t('trend.keep.open', { month: monthYear(s.to.day) })}
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {all && rows.length > shown && (
            <button className="link-btn center" onClick={() => setShown((n) => n + MORE_ROWS)}>
              {t('trend.sw.showMore', { n: Math.min(MORE_ROWS, rows.length - shown) })}
            </button>
          )}
        </>
      )}

      <details className="twin">
        <summary>{t('trend.bal.months')}</summary>
        <div className="twin-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('trend.col.month')}</th>
                <th scope="col">{t('trend.col.low')}</th>
                <th scope="col">{t('trend.col.high')}</th>
                <th scope="col">{t('trend.col.end')}</th>
              </tr>
            </thead>
            <tbody>
              {[...model.env].reverse().map((e) => (
                <tr key={e.month}>
                  <th scope="row">
                    <button className="link-btn" onClick={() => onOpenMonth(e.month)}>
                      {monthYear(e.month)}
                    </button>
                  </th>
                  <td>
                    {bare(e.low.value)} <span className="muted">({new Date(e.low.day).getDate()})</span>
                  </td>
                  <td>
                    {bare(e.high.value)} <span className="muted">({new Date(e.high.day).getDate()})</span>
                  </td>
                  <td>{bare(e.end.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint left">{t('trend.table.days', { symbol })}</p>
      </details>
    </section>
  )
}

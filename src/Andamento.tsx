import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { remember } from './AddSheet'
import { BalanceCard, type BalanceModel } from './BalanceCard'
import { CategoryIcon } from './catIcons'
import { MiniBars, NetBars, type NetBar } from './charts'
import { goalBalances, type AppData } from './data'
import type { Transaction } from './db'
import { t, type Key } from './i18n'
import { payeeLabel, payeeOf } from './payee'
import {
  availablePresets,
  balanceSeries,
  byDate,
  dayMoves,
  dayStart,
  findSwings,
  fullMonths,
  idleStep,
  levers,
  median,
  MIN_MONTHS_FOR_LEVERS,
  monthEnvelope,
  monthFlows,
  monthStart,
  opaqueWallets,
  periodMonths,
  previousMonths,
  rowTransactions,
  savingSummary,
  spendingBreakdown,
  spendingIn,
  swingMarks,
  swingOfDay,
  swingStops,
  type Lever,
  type Preset,
  type Scope,
  type SpendRow,
} from './stats'
import { HowTo, tn, trendFormat, TxRow } from './trend'

interface Props {
  data: AppData
  /** Il selettore tra andamento, mese e anno: sta sotto il titolo, come nelle altre due viste. */
  modeSwitch: ReactNode
  onOpen: (tx: Transaction) => void
  /** Apre un mese nella scheda "Mese" (primo istante del mese). */
  onOpenMonth: (month: number) => void
  /** Apre l'inserimento di una spesa, pagata dal conto indicato (il portafoglio dei contanti). */
  onAddExpense: (accountId: string) => void
  /** Mette da parte una cifra in un obiettivo; chi riceve decide se farne prima creare uno. */
  onSetAside: (amount: number) => void
}

const PERIOD_KEY = 'fig-stats-period'
/** Quante righe si vedono prima di "Mostra tutte". */
const ROWS = 6
const ROW_TX = 20

const readPreset = (): Preset | null => {
  const v = remember.get(PERIOD_KEY)
  return v === 'all' ? 'all' : v === '3' ? 3 : v === '6' ? 6 : v === '12' ? 12 : null
}

/**
 * "Andamento": le statistiche di lungo periodo. Quanto resta ogni mese, come si muove il saldo e perché,
 * dove vanno i soldi, da dove cominciare per metterne da parte. I conti stanno in stats.ts.
 */
export function Andamento({ data, modeSwitch, onOpen, onOpenMonth, onAddExpense, onSetAside }: Props) {
  const { transactions, categories, accounts, goals, mainCurrency } = data
  const [wanted, setWanted] = useState<Preset | null>(readPreset)
  const [scope, setScope] = useState<Scope>('total')
  const [barMonth, setBarMonth] = useState<number | null>(null)
  const [group, setGroup] = useState<'category' | 'payee'>('category')
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [allRows, setAllRows] = useState(false)
  const [allTx, setAllTx] = useState(false)
  const spendRef = useRef<HTMLElement>(null)
  // La riga da portare a schermo dopo che un suggerimento l'ha aperta.
  const reveal = useRef<string | null>(null)
  // Ogni tocco di un suggerimento è un cambiamento suo: così la riga va a schermo sempre, e solo allora.
  const [revealTick, setRevealTick] = useState(0)

  const now = Date.now()
  const today = dayStart(now)
  const fmt = useMemo(() => trendFormat(mainCurrency, categories), [mainCurrency, categories])
  const { unit, money, bare, compact, monthLong, monthShort, monthYear, catName } = fmt

  const m = useMemo(() => {
    const sorted = byDate(transactions)
    const full = fullMonths(sorted, now)
    const options = availablePresets(full)
    const preset: Preset = wanted !== null && options.includes(wanted) ? wanted : options.includes(12) ? 12 : 'all'
    const months = periodMonths(full, preset)
    const prev = previousMonths(full, months)
    const base = accounts.reduce((sum, a) => sum + a.initialMain, 0)
    const firstTx = sorted.find((tx) => tx.kind !== 'opening' && tx.date <= now)
    // La linea parte dal primo mese del periodo; con "tutto" (o senza mesi interi) dal primo movimento.
    const from = months.length > 0 && preset !== 'all' ? months[0] : (firstTx?.date ?? now)
    const wallets = months.length > 0 ? opaqueWallets(sorted, accounts, months[0], monthStart(months[months.length - 1], 1), now) : new Set<string>()
    const ctx = { categories, wallets }
    const points = balanceSeries(sorted, { from, now, scope, base })
    const env = monthEnvelope(points)
    const flows = monthFlows(sorted, months, now)
    const running = monthFlows(sorted, [monthStart(now)], now)[0]
    const lows = months.map((month) => env.find((e) => e.month === month)?.low.value).filter((v): v is number => v !== undefined)
    const spending = spendingBreakdown(sorted, months, prev, now, ctx)
    // I soldi mai toccati e il "solito" delle salite e discese non dipendono dal periodo che si sta guardando:
    // si misurano sempre sugli ultimi dodici mesi interi (tutti, se sono meno), più quello in corso.
    const year = periodMonths(full, full && full.count >= 12 ? 12 : 'all')
    const yearWallets = year.length > 0 ? opaqueWallets(sorted, accounts, year[0], monthStart(year[year.length - 1], 1), now) : new Set<string>()
    const yearTypical = median(monthFlows(sorted, year, now).map((flow) => flow.out))
    const yearFrom = year.length > 0 ? year[0] : (firstTx?.date ?? now)
    const usual = findSwings(dayStart(yearFrom) === points[0].day ? points : balanceSeries(sorted, { from: yearFrom, now, scope, base }))
    const swings = findSwings(points, { usual: { up: usual.usualUp, down: usual.usualDown } })
    const inGoals = [...goalBalances(sorted.filter((tx) => tx.date <= now)).values()].reduce((sum, v) => sum + v, 0)
    const balance: BalanceModel = {
      points,
      env,
      swings,
      dayOf: swingOfDay(swings.list, points.length),
      stops: swingStops(swings.list),
      moves: dayMoves(sorted, points, { now, scope }),
      marks: swingMarks(points, swings),
      sorted,
      ctx,
      inGoals,
      hasStart: base !== 0 || sorted.some((tx) => tx.kind === 'opening'),
      goalsEver: sorted.some((tx) => tx.kind === 'save' || tx.kind === 'release' || (tx.kind === 'expense' && !!tx.goalId)),
    }
    return {
      options,
      preset,
      months,
      ctx,
      balance,
      flows,
      running,
      spending,
      spend: spendingIn(sorted, months, now),
      saving: savingSummary(flows, lows.length === months.length ? lows : []),
      prevKept: prev ? monthFlows(sorted, prev, now).reduce((sum, flow) => sum + flow.net, 0) : null,
      tips: levers(sorted, months, now, ctx, unit, spending),
      idle: idleStep(sorted, { now, base, typicalMonth: yearTypical, wallets: yearWallets }),
      hasMoves: !!firstTx,
    }
    // `now` cambia a ogni disegno e non è tra le dipendenze: i conti si rifanno quando cambiano i dati, il giorno o le scelte.
  }, [transactions, accounts, categories, today, wanted, scope, unit])

  const { months, saving, spending } = m
  const n = months.length
  const hasGoal = goals.some((g) => !g.archived)

  function choose(preset: Preset) {
    setWanted(preset)
    remember.set(PERIOD_KEY, String(preset))
    setBarMonth(null)
    setOpenRow(null)
    setAllRows(false)
    setAllTx(false)
  }

  /** Porta al riquadro "Dove vanno i soldi" e apre una riga: è lì che un suggerimento mostra da dove viene. */
  function showRow(by: 'category' | 'payee', key: string) {
    if (by !== 'payee') setGroup('category')
    setOpenRow(key)
    setAllRows(true)
    setAllTx(false)
    reveal.current = key
    setRevealTick((n) => n + 1)
  }
  const calm = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  const rowId = (key: string) => `spend-${key.replace(/[^a-z0-9]+/gi, '-')}`
  // Dopo il disegno: la riga aperta da un suggerimento va a schermo (può essere in fondo alla lista) e prende il fuoco.
  useEffect(() => {
    const key = reveal.current
    if (!key) return
    reveal.current = null
    const row = document.getElementById(rowId(key))
    if (!row) return
    row.scrollIntoView({ block: 'start', behavior: calm() })
    row.querySelector('button')?.focus({ preventScroll: true })
  }, [revealTick])

  const title = n === 0 ? t('trend.titleNone') : tn('trend.title', n)
  /** Il portafoglio dei contanti "cieco" su cui segnare una spesa, se c'è ed è ancora in uso. */
  const cashWallet = accounts.find((a) => !a.archived && m.ctx.wallets.has(a.id))?.id
  const periodLabel = (p: Preset) => t(`trend.p.${p}` as Key)

  // ——— Riquadro 1: quanto ti resta ———
  const bars: NetBar[] = [...m.flows.map((f) => ({ month: f.month, net: f.net })), { month: m.running.month, net: m.running.net, running: true }]
  // Il mese scelto vale solo finché è tra le colonne: cambiato il periodo o i dati, si torna all'ultimo mese intero.
  const pickedBar = barMonth !== null && bars.some((b) => b.month === barMonth) ? barMonth : null
  const picked = pickedBar ?? (n > 0 ? months[n - 1] : m.running.month)
  const pickedFlow = picked === m.running.month ? m.running : m.flows.find((f) => f.month === picked)!
  const income = m.flows.reduce((s, f) => s + f.in, 0)
  const adjustIn = m.flows.reduce((s, f) => s + f.adjustIn, 0)
  const rateText =
    income === 0
      ? t('trend.keep.noIncome')
      : saving.kept < 0
        ? t('trend.keep.over', { amount: money(-saving.kept) })
        : saving.rate === null
          ? null
          : saving.rate < 0.01
            ? t('trend.keep.rateLow')
            : t('trend.keep.rate', { pct: Math.round(saving.rate * 100) })
  const shareOf = (share: number) => `${Math.max(1, Math.round(share * 100))}%`
  const opaqueName = t(spending.opaque.cash ? 'trend.opaque' : 'trend.opaqueOther')
  const monthText = (month: number, flow: { net: number }) =>
    month === m.running.month
      ? t('trend.keep.running', { month: monthLong(month) })
      : flow.net < 0
        ? t('trend.keep.monthOver', { month: monthLong(month), amount: money(-flow.net) })
        : t('trend.keep.month', { month: monthLong(month), amount: money(flow.net, true) })
  const topThree = [
    ...(spending.opaque.separate ? [{ name: opaqueName, share: spending.opaque.share }] : []),
    ...spending.categories.map((r) => ({ name: catName(r.id), share: r.share })),
  ]
    .sort((a, b) => b.share - a.share)
    .slice(0, 3)

  const keepCard = n > 0 && (
    <section className="card keep">
      <h2 className="card-title">{t('trend.keep.title')}</h2>
      <p className={`keep-hero ${saving.kept < 0 ? 'negative' : 'positive'}`}>{money(saving.kept, true)}</p>
      <p className="keep-sub">
        {tn('trend.keep.in', n)}
        {rateText && ` · ${rateText}`}
      </p>
      {n >= 3 && (
        <p className="keep-sub">
          {t('trend.keep.typical', { amount: money(saving.typical, true) })} · {saving.positive === 1 ? t('trend.keep.positive.one', { n }) : t('trend.keep.positive', { pos: saving.positive, n })}
        </p>
      )}
      {m.prevKept !== null && <p className="keep-sub muted">{t('trend.keep.prev', { n, amount: money(m.prevKept, true) })}</p>}
      {n >= 3 && saving.kept < 0 && saving.typical > 0 && <p className="keep-note">{t('trend.keep.mixedDown')}</p>}
      {n >= 3 && saving.kept > 0 && saving.typical < 0 && <p className="keep-note">{t('trend.keep.mixedUp')}</p>}
      {adjustIn > 0 && <p className="keep-note">{t('trend.keep.adjust', { amount: money(adjustIn) })}</p>}
      {topThree.length > 0 && (
        <button className="keep-top" onClick={() => spendRef.current?.scrollIntoView({ block: 'start', behavior: calm() })}>
          {t('trend.keep.top', { list: topThree.map((x) => `${x.name} ${shareOf(x.share)}`).join(', ') })}
        </button>
      )}

      <div className="readout" aria-live="polite">
        <span className="readout-main">{monthText(picked, pickedFlow)}</span>
        <span className="readout-sub">
          <span>{t('trend.keep.flows', { in: money(pickedFlow.in), out: money(pickedFlow.out) })}</span>
          {pickedFlow.adjustIn > 0 && <span>{t('trend.keep.flowsAdjust', { amount: money(pickedFlow.adjustIn, true) })}</span>}
          <button className="link-btn" onClick={() => onOpenMonth(picked)}>
            {t('trend.keep.open', { month: monthShort(picked) })}
          </button>
        </span>
      </div>
      <NetBars
        bars={bars}
        selected={pickedBar}
        onSelect={setBarMonth}
        label={t('trend.keep.chart')}
        aria={(bar) => monthText(bar.month, bar)}
        amount={(v) => (v > 0 ? '+' : '') + compact(v)}
        month={monthShort}
      />
      <p className="chart-note">{t('trend.keep.note')}</p>
      <HowTo items={[1, 2, 3, 4, 5, 6, 7].map((i) => t(`trend.how.keep.${i}` as Key))} />

      {m.idle && (
        <div className="next-step">
          <p>{t('trend.idle', { amount: money(m.idle.amount), floor: money(m.idle.floor), left: money(m.idle.left) })}</p>
          <button className="primary" onClick={() => onSetAside(m.idle!.amount)}>
            {hasGoal ? t('trend.idle.cta', { amount: money(m.idle.amount) }) : t('trend.idle.newGoal')}
          </button>
        </div>
      )}

      <details className="twin">
        <summary>{t('trend.keep.table')}</summary>
        <div className="twin-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('trend.col.month')}</th>
                <th scope="col">{t('trend.col.in')}</th>
                <th scope="col">{t('trend.col.out')}</th>
                <th scope="col">{t('trend.col.kept')}</th>
              </tr>
            </thead>
            <tbody>
              {[...m.flows].reverse().map((f) => (
                <tr key={f.month}>
                  <th scope="row">
                    <button className="link-btn" onClick={() => onOpenMonth(f.month)}>
                      {monthYear(f.month)}
                    </button>
                  </th>
                  <td>{bare(f.in)}</td>
                  <td>{bare(f.out)}</td>
                  <td className={f.net < 0 ? 'negative' : ''}>{bare(f.net, true)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('trend.row.total')}</th>
                <td>{bare(income)}</td>
                <td>{bare(m.flows.reduce((s, f) => s + f.out, 0))}</td>
                <td className={saving.kept < 0 ? 'negative' : ''}>{bare(saving.kept, true)}</td>
              </tr>
              {n >= 3 && (
                <tr>
                  <th scope="row">{t('trend.row.typical')}</th>
                  <td>{bare(median(m.flows.map((f) => f.in)))}</td>
                  <td>{bare(median(m.flows.map((f) => f.out)))}</td>
                  <td className={saving.typical < 0 ? 'negative' : ''}>{bare(saving.typical, true)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
        <p className="hint left">
          {t('trend.table.unit', { symbol: mainCurrency.symbol })}
          {n >= 3 && ` ${t('trend.table.typical')}`}
        </p>
      </details>
    </section>
  )

  // ——— Riquadro 2: andamento del saldo (BalanceCard.tsx) ———
  // Cambiando periodo o saldo guardato il riquadro riparte da oggi, senza niente di scelto.
  const balanceCard = m.hasMoves && (
    <BalanceCard key={`${m.preset}:${scope}`} model={m.balance} fmt={fmt} symbol={mainCurrency.symbol} scope={scope} onScope={setScope} now={now} saving={saving} onOpen={onOpen} onOpenMonth={onOpenMonth} />
  )

  // ——— Riquadro 3: dove vanno i soldi ———
  const payeesUseful = spending.payeeCoverage >= 0.3 && spending.payees.length >= 5
  const by = payeesUseful ? group : 'category'
  const rows = by === 'category' ? spending.categories : spending.payees
  const topTotal = Math.max(1, spending.opaque.separate ? spending.opaque.total : 0, rows[0]?.total ?? 0)
  const rowKey = (row: SpendRow) => `${by}:${row.id}`

  function detail(key: string, kind: 'category' | 'payee' | 'opaque', byMonth: number[], lumpy: SpendRow['lumpy'], color: string) {
    const txs = openTxs
    const peak = byMonth.reduce((b, v, i) => (v > byMonth[b] ? i : b), 0)
    // Dentro una categoria: a chi sono andati i soldi, quando le note lo dicono.
    const inside = new Map<string, { key: string; names: string[]; amounts: number[]; total: number }>()
    if (kind === 'category') {
      for (const tx of txs) {
        const p = payeeOf(tx.note)
        if (!p) continue
        const g = inside.get(p.key) ?? { key: p.key, names: [], amounts: [], total: 0 }
        g.names.push(p.name)
        g.amounts.push(tx.mainAmount)
        g.total += tx.mainAmount
        inside.set(p.key, g)
      }
    }
    const who = [...inside.values()].sort((a, b) => b.total - a.total).slice(0, 5)
    return (
      <div className="cat-tx" id={`${rowId(key)}-detail`}>
        {n > 1 && <MiniBars values={byMonth} color={color} ends={[monthShort(months[0], true), monthShort(months[n - 1], true)]} />}
        {n > 1 && (
          <p className="cat-tx-foot">
            {lumpy ? t('trend.spend.lumpy', { pct: Math.round(lumpy.share * 100), month: monthLong(lumpy.month) }) : t('trend.spend.peak', { month: monthLong(months[peak]), amount: money(byMonth[peak]) })}
          </p>
        )}
        {who.length > 1 && (
          <>
            <p className="cat-tx-head">{t('trend.spend.inside')}</p>
            {who.map((g) => (
              <div key={g.key} className="cat-tx-row plain who">
                <span className="grow">
                  {payeeLabel(g.names)}
                  <span className="spend-sub">{tn('trend.spend.times', g.amounts.length, { amount: money(median(g.amounts)) })}</span>
                </span>
                <span className="legend-value">{money(g.total)}</span>
              </div>
            ))}
          </>
        )}
        <p className="cat-tx-head">{t('trend.spend.all', { n: txs.length })}</p>
        {(allTx ? txs : txs.slice(0, ROW_TX)).map((tx) => (
          <TxRow key={tx.id} tx={tx} fmt={fmt} onOpen={onOpen} />
        ))}
        {txs.length > ROW_TX && (
          <button className="link-btn" onClick={() => setAllTx((v) => !v)}>
            {allTx ? t('trend.spend.less') : t('trend.spend.showAll', { n: txs.length })}
          </button>
        )}
        {kind === 'opaque' && spending.opaque.cash && cashWallet && (
          <button className="secondary wide" onClick={() => onAddExpense(cashWallet)}>
            {t('trend.spend.cashCta')}
          </button>
        )}
      </div>
    )
  }

  const toggle = (key: string) => {
    setOpenRow(openRow === key ? null : key)
    setAllTx(false)
  }
  // I movimenti della riga aperta: si cercano una volta, non a ogni ridisegno (scorrere il grafico ridisegna tutto).
  const openTxs = useMemo(() => {
    if (!openRow) return []
    const [kind, ...rest] = openRow === 'opaque' ? ['opaque'] : openRow.split(':')
    return rowTransactions(m.spend, spending.opaque.separate, kind as 'category' | 'payee' | 'opaque', rest.join(':'), m.ctx).sort((a, b) => b.date - a.date)
  }, [openRow, m.spend, m.ctx, spending.opaque.separate])
  const compared = rows.some((row) => row.deltaPct !== null)

  const shownRows = allRows ? rows : rows.slice(0, ROWS)
  // Le spese senza dettaglio stanno al loro posto tra le altre righe, per peso: "dalla più pesante" vale per tutte
  // (in fondo a quelle a schermo, se sono tutte più pesanti).
  const opaquePos = spending.opaque.separate ? shownRows.filter((row) => row.total > spending.opaque.total).length : 0
  const renderRow = (row: SpendRow) => {
    const key = rowKey(row)
    const open = openRow === key
    const cat = fmt.category(by === 'category' ? row.id : (row.categoryId ?? ''))
    const color = cat?.color ?? 'var(--muted)'
    return (
      <div key={key} className={`legend-item${open ? ' open' : ''}`} id={rowId(key)}>
        <button className="legend-row spend-row" aria-expanded={open} aria-controls={open ? `${rowId(key)}-detail` : undefined} onClick={() => toggle(key)}>
          <span className="row-icon" style={{ '--c': color } as CSSProperties}>
            <CategoryIcon name={cat?.icon} size={16} />
          </span>
          <span className="legend-name">
            {by === 'category' ? catName(row.id || undefined) : row.name}
            <span className="legend-share">{shareOf(row.share)}</span>
            {row.deltaPct !== null && (
              <span className={`delta ${row.deltaPct > 0 ? 'up' : 'down'}`}>
                {row.deltaPct > 0 ? '▲' : '▼'} {Math.abs(row.deltaPct)}%
              </span>
            )}
            {row.deltaPct === null && row.isNew && <span className="delta new">{t('weave.new')}</span>}
            <span className="spend-sub">{tn('trend.spend.times', row.count, { amount: money(row.median) })}</span>
          </span>
          <span className="legend-value">{money(row.total)}</span>
          <span className="legend-bar">
            <span style={{ width: `${(row.total / topTotal) * 100}%`, background: color }} />
          </span>
        </button>
        {open && detail(key, by, row.byMonth, row.lumpy, color)}
      </div>
    )
  }

  const spendCard = n > 0 && (
    <section className="card spend" ref={spendRef}>
      <div className="card-head stack">
        <h2 className="card-title">{t('trend.spend.title')}</h2>
        {payeesUseful && (
          <div className="switch compact" role="group" aria-label={t('trend.spend.group')}>
            {(['category', 'payee'] as const).map((g) => (
              <button
                key={g}
                className={by === g ? 'on' : ''}
                aria-pressed={by === g}
                onClick={() => {
                  setGroup(g)
                  setOpenRow(null)
                  setAllRows(false)
                }}
              >
                {t(g === 'category' ? 'trend.spend.cats' : 'trend.spend.payees')}
              </button>
            ))}
          </div>
        )}
      </div>
      {spending.total === 0 ? (
        <p className="muted small">{t('trend.spend.none')}</p>
      ) : (
        <>
          <p className="keep-sub">{tn('trend.spend.total', n, { total: money(spending.total), avg: money(spending.perMonth) })}</p>
          {compared && <p className="keep-sub muted">{t('trend.spend.vsPrev', { n })}</p>}
          <p className="chart-note top">{t('trend.spend.note')}</p>
          <div className="legend">
            {shownRows.slice(0, opaquePos).map(renderRow)}
            {spending.opaque.separate && (
              <div className={`legend-item${openRow === 'opaque' ? ' open' : ''}`} id={rowId('opaque')}>
                <button className="legend-row spend-row" aria-expanded={openRow === 'opaque'} aria-controls={openRow === 'opaque' ? `${rowId('opaque')}-detail` : undefined} onClick={() => toggle('opaque')}>
                  <span className="row-icon" style={{ '--c': 'var(--muted)' } as CSSProperties}>
                    <CategoryIcon name="dots" size={16} />
                  </span>
                  <span className="legend-name">
                    {opaqueName}
                    <span className="legend-share">{shareOf(spending.opaque.share)}</span>
                    <span className="spend-sub">{tn('trend.spend.opaqueSub', spending.opaque.count)}</span>
                  </span>
                  <span className="legend-value">{money(spending.opaque.total)}</span>
                  <span className="legend-bar">
                    <span className="hatched" style={{ width: `${(spending.opaque.total / topTotal) * 100}%` }} />
                  </span>
                </button>
                {openRow === 'opaque' && detail('opaque', 'opaque', spending.opaque.byMonth, null, 'var(--muted)')}
              </div>
            )}
            {shownRows.slice(opaquePos).map(renderRow)}
          </div>
          {rows.length > ROWS && (
            <button className="link-btn center" onClick={() => setAllRows((v) => !v)}>
              {allRows ? t('trend.spend.less') : t('trend.spend.showAll', { n: rows.length })}
            </button>
          )}
          <HowTo items={[1, 2, 3, 4, 5, 6, 7].map((i) => t(`trend.how.spend.${i}` as Key))} />
        </>
      )}
    </section>
  )

  // ——— Riquadro 4: da dove cominciare ———
  const tipText = (tip: Lever): string => {
    if (tip.kind === 'cash') return t(tip.cash ? 'trend.tip.cash' : 'trend.tip.blind', { pct: Math.round(tip.share * 100), amount: money(tip.perMonth) })
    if (tip.kind === 'rise') {
      const name = catName(tip.categoryId || undefined)
      if (tip.base > 0) return t('trend.tip.rise', { name, recent: money(tip.recent), base: money(tip.base), excess: money(tip.excess) })
      // Mediana zero non vuol dire "mai vista": se prima c'era, ogni tanto, lo si dice.
      return tip.before > 0 ? t('trend.tip.riseSome', { name, recent: money(tip.recent), before: money(tip.before), n: tip.beforeMonths }) : t('trend.tip.riseNew', { name, recent: money(tip.recent) })
    }
    const name = tip.name || catName(tip.categoryId)
    return tip.half !== null ? t('trend.tip.fees', { name, count: tip.count, n: tip.months, total: money(tip.total), half: money(tip.half) }) : t('trend.tip.feesPlain', { name, count: tip.count, n: tip.months, total: money(tip.total) })
  }
  const tipsCard = n > 0 && (
    <section className="card insights tips">
      <h2 className="card-title">{t('trend.tips.title')}</h2>
      {n < MIN_MONTHS_FOR_LEVERS ? (
        <p className="muted small">{t('trend.tips.few', { n })}</p>
      ) : m.tips.length === 0 ? (
        <p className="muted small">{t('trend.tips.none')}</p>
      ) : (
        <ul>
          {m.tips.map((tip) => (
            <li key={tip.kind} className={tip.kind === 'rise' ? 'up' : ''}>
              <button className="tip" onClick={() => (tip.kind === 'cash' ? showRow('category', 'opaque') : showRow('category', `category:${tip.categoryId}`))}>
                {tipText(tip)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {n >= MIN_MONTHS_FOR_LEVERS && <p className="hint left">{t('trend.tips.foot')}</p>}
    </section>
  )

  return (
    <>
      <h1 className="screen-title">{title}</h1>
      {modeSwitch}
      {n > 0 && <p className="muted small period-range">{n === 1 ? t('trend.range.one', { from: monthLong(months[0]) }) : t('trend.range', { from: monthYear(months[0]), to: monthYear(months[n - 1]) })}</p>}
      {m.options.length > 1 && (
        <div className="switch period" role="group" aria-label={t('trend.period')}>
          {m.options.map((p) => (
            <button key={p} className={m.preset === p ? 'on' : ''} aria-pressed={m.preset === p} onClick={() => choose(p)}>
              {periodLabel(p)}
            </button>
          ))}
        </div>
      )}
      {n === 0 && (
        <section className="card empty-weave">
          <p className="empty-title">{t('trend.empty.title')}</p>
          <p className="muted small">{t('trend.empty.body')}</p>
        </section>
      )}
      {keepCard}
      {balanceCard}
      {spendCard}
      {tipsCard}
    </>
  )
}

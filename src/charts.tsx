import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { monthLabels, nearestIndex, placeMarks, snapToStop, touchReach, yAxis, type DayPoint, type LineMark, type Swing } from './stats'

/**
 * I grafici della scheda "Andamento", disegnati a mano in SVG: la linea del saldo, le colonne di quanto resta ogni mese,
 * le colonnine di una categoria. Un'unità del disegno è un pixel dello schermo (la larghezza si misura), così il testo
 * non si deforma. I colori sono quelli del tema; il testo usa i colori del testo, mai quello della serie.
 * Ogni valore che si legge toccando il grafico si trova anche nella lista o nella tabella lì sotto.
 */

/** Larghezza in pixel di un elemento, aggiornata quando cambia. Finché non è misurata vale `fallback`. */
export function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const w = Math.floor(el.getBoundingClientRect().width)
      if (w > 0) setWidth(w)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

const r1 = (n: number) => Math.round(n * 10) / 10

type Anchor = 'start' | 'middle' | 'end'
/**
 * Le scritte dei mesi che ci stanno davvero sotto un grafico: quella che comincerebbe prima che finisca la precedente
 * si salta (la prima porta l'anno ed è più larga delle altre). L'anno si scrive rispetto all'ultima scritta messa,
 * così se salta un'etichetta con l'anno lo porta la successiva. La larghezza è stimata per eccesso, a 11 px.
 */
function fitMonthLabels(
  items: { month: number; x: number }[],
  text: (month: number, withYear: boolean) => string,
  anchorOf: (x: number, withYear: boolean) => Anchor,
): Map<number, { text: string; anchor: Anchor }> {
  const out = new Map<number, { text: string; anchor: Anchor }>()
  let end = -Infinity
  let lastYear: number | null = null
  for (const item of items) {
    const year = new Date(item.month).getFullYear()
    const withYear = year !== lastYear
    const label = text(item.month, withYear)
    const anchor = anchorOf(item.x, withYear)
    const w = label.length * 6.2
    const x0 = anchor === 'start' ? item.x : anchor === 'end' ? item.x - w : item.x - w / 2
    if (x0 < end + 2) continue
    out.set(item.month, { text: label, anchor })
    end = x0 + w
    lastYear = year
  }
  return out
}

interface BalanceLineProps {
  points: DayPoint[]
  /** I segni della linea in ordine d'importanza (swingMarks): pieni il massimo, il minimo e i tratti da guardare, vuoti gli altri. */
  marks: LineMark[]
  /** Le salite e le discese, una dopo l'altra. */
  swings: Swing[]
  /** Il tratto scelto (posizione nella lista), o -1: si disegna più spesso, coi suoi gradini. */
  swing: number
  /** I giorni dove il dito si ferma da solo: gli arrivi dei tratti e i loro gradini. */
  stops: number[]
  /** Primo giorno del mese in corso: da lì la linea è più leggera, perché quel mese non è finito. */
  runningFrom: number
  /** Giorno scelto (posizione nella serie), o null. */
  selected: number | null
  onSelect: (index: number | null) => void
  /** Etichetta per chi non vede il grafico, e testo del giorno scelto. */
  label: string
  valueText: (index: number) => string
  todayLabel: string
  /** Le scritte corte dell'asse ("200 mila"), una per tacca: l'unità e i decimali si scelgono guardandole tutte insieme. */
  axis: (ticks: number[], step: number) => string[]
  amount: (value: number) => string
  /** Nome corto del mese; con l'anno quando serve ("gen ’26"). */
  month: (day: number, withYear: boolean) => string
  /** Giorno e mese corti ("3 ott"): l'inizio della linea, quando sotto non c'è nessun mese scritto. */
  day: (day: number) => string
}

/** Larghezza a occhio di una scritta a 12 px, per sapere dove non mettere altro. */
const textWidth = (text: string) => text.length * 6.7

/**
 * La linea del saldo giorno per giorno. Ogni punto dove smette di salire ha un tondo, ogni punto dove smette di scendere
 * un rombo: pieni e colorati il massimo, il minimo e i tratti più grandi del solito, vuoti gli altri (se c'è posto).
 * Si scorre col dito, col mouse o con le frecce; il dito si ferma da solo sugli arrivi e sui giorni che pesano.
 * Ordine del disegno, da sotto a sopra: griglia e assi, fascia del tratto scelto, linea, tratto scelto, riga del giorno
 * scelto, segni vuoti, segni pieni e cifre, gradini, arrivo del tratto scelto, oggi, punto del giorno scelto.
 */
export function BalanceLine({ points, marks, swings, swing, stops, runningFrom, selected, onSelect, label, valueText, todayLabel, axis, amount, month, day }: BalanceLineProps) {
  const [ref, width] = useWidth<HTMLDivElement>(311)
  const height = 212
  const n = points.length
  const last = n - 1
  const values = points.map((p) => p.value)
  const { lo, hi, step, ticks } = yAxis(Math.min(...values), Math.max(...values))
  const tickLabels = axis(ticks, step)
  const left = Math.ceil(Math.max(...tickLabels.map((text) => text.length)) * 6.2) + 8
  const top = 24
  // Sotto il minimo del periodo va la sua cifra: se il minimo sta in fondo all'asse si lascia più posto sotto,
  // invece di scriverla sopra, dove passa la linea.
  const lowest = marks.find((mark) => mark.label && mark.kind === 'low')
  const tight = lowest !== undefined && top + (1 - (points[lowest.index].value - lo) / (hi - lo)) * (height - top - 22) + 21 > height - 22
  const pad = { top, right: 12, bottom: tight ? 38 : 22, left }
  const plotW = Math.max(1, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom

  const geo = useMemo(() => {
    const x = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2)
    const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH
    const split = points.findIndex((p) => p.day >= runningFrom)
    const d = (from: number, to: number) => points.slice(from, to + 1).map((p, k) => `${k ? 'L' : 'M'}${r1(x(from + k))} ${r1(y(p.value))}`).join('')
    const cut = split < 0 ? n - 1 : Math.max(0, split - 1)
    // Una tacca per ogni primo del mese; le scritte a passo regolare, con l'anno quando cambia.
    const starts = points.map((p, i) => ({ day: p.day, i })).filter((p) => new Date(p.day).getDate() === 1)
    const labelled = new Map(monthLabels(starts.map((s) => s.day), n > 1 ? (plotW * 30.44) / (n - 1) : plotW, 30, 46).map((l) => [l.month, l.withYear]))
    const months = starts.map((s) => ({ x: x(s.i), day: s.day, withYear: labelled.get(s.day) }))
    return { x, y, d, solid: d(0, cut), light: cut < n - 1 ? d(cut, n - 1) : '', months }
  }, [points, n, runningFrom, lo, hi, plotW, plotH, pad.left, pad.top])

  const anchor = (px: number): 'start' | 'end' | 'middle' => (px < pad.left + 40 ? 'start' : px > width - 44 ? 'end' : 'middle')
  const drawn = useMemo(() => {
    // I segni vuoti si disegnano solo se ogni dente della linea ha il suo posto; poi, nell'ordine d'importanza,
    // un segno che finirebbe addosso a uno già messo si salta.
    const roomy = plotW / Math.max(1, Math.ceil(swings.length / 2)) >= 14
    const placed = placeMarks(
      marks.filter((mark) => mark.filled || roomy).map((mark) => ({ ...mark, x: geo.x(mark.index), y: geo.y(points[mark.index].value) })),
      12,
    )
    // Le due cifre scritte: sopra il massimo, sotto il minimo. Un segno vuoto non ci finisce dentro.
    const figures = placed
      .filter((mark) => mark.label)
      .map((mark) => {
        const text = amount(points[mark.index].value)
        const w = textWidth(text)
        const side = anchor(mark.x)
        const x0 = side === 'start' ? mark.x : side === 'end' ? mark.x - w : mark.x - w / 2
        const ty = mark.kind === 'high' ? mark.y - 10 : mark.y + 19
        return { mark, text, side, ty, box: { x0: x0 - 6, x1: x0 + w + 6, y0: ty - 16, y1: ty + 8 } }
      })
    const inFigure = (px: number, py: number) => figures.some((f) => px >= f.box.x0 && px <= f.box.x1 && py >= f.box.y0 && py <= f.box.y1)
    const onFigure = (x0: number, x1: number, y0: number, y1: number) => figures.some((f) => x0 <= f.box.x1 && x1 >= f.box.x0 && y0 <= f.box.y1 && y1 >= f.box.y0)
    return { marks: placed.filter((mark) => mark.filled || !inFigure(mark.x, mark.y)), figures, onFigure }
    // `amount` e `anchor` cambiano a ogni disegno ma dicono sempre la stessa cosa per gli stessi dati.
  }, [marks, swings.length, geo, points, plotW, width])

  // "oggi" si scrive sopra il punto più alto dell'ultimo pezzo di linea, e solo se non finisce su una cifra.
  const today = useMemo(() => {
    const x = geo.x(last)
    let peak = geo.y(points[last].value)
    for (let i = last; i >= 0 && x - geo.x(i) <= 34; i--) peak = Math.min(peak, geo.y(points[i].value))
    const y = Math.max(10, peak - 9)
    return { x, y, free: !drawn.onFigure(x - todayLabel.length * 6.2, x, y - 10, y + 2) }
  }, [geo, points, last, drawn, todayLabel])
  const monthTexts = fitMonthLabels(
    geo.months.filter((mo) => mo.withYear !== undefined && mo.x <= pad.left + plotW - 12).map((mo) => ({ month: mo.day, x: mo.x })),
    month,
    (x) => (x < pad.left + 16 ? 'start' : 'middle'),
  )

  const chosen = swing >= 0 && swing < swings.length ? swings[swing] : null
  const arrival = chosen ? (marks.find((mark) => mark.index === chosen.toIndex) ?? null) : null

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = nearestIndex(n, box.width, event.clientX - box.left)
    // Il dito copre più giorni: si ferma sull'arrivo o sul gradino più vicino, se è a portata. Il mouse è più preciso.
    onSelect(snapToStop(stops, index, touchReach(n, plotW, swings.length, event.pointerType === 'mouse' ? 1 : 2.5)))
  }
  // Col dito il browser manda pointerdown prima di sapere se si sta scorrendo la pagina: il giorno si sceglie solo
  // quando il gesto è del grafico (un tocco, o uno scorrimento in orizzontale).
  const touch = useRef<{ x: number; y: number; scrub: boolean } | null>(null)
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = selected ?? last
    const one = event.shiftKey ? 7 : 1
    // Come ogni cursore: destra, su e pagina su vanno avanti; sinistra, giù e pagina giù tornano indietro.
    const to =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? at - one
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? at + one
          : event.key === 'PageDown'
            ? at - 30
            : event.key === 'PageUp'
              ? at + 30
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? last
                  : null
    if (event.key === 'Escape') return onSelect(null)
    if (to === null) return
    event.preventDefault()
    onSelect(Math.min(last, Math.max(0, to)))
  }

  /** Un tondo o un rombo: pieno e colorato, oppure vuoto col colore della linea su un fondo che la stacca. */
  const shape = (kind: 'low' | 'high', filled: boolean, cx: number, cy: number, grow = 0) => {
    if (filled) {
      const half = 4.5 + grow
      return kind === 'high' ? (
        <circle className="mark high" cx={r1(cx)} cy={r1(cy)} r={5 + grow} />
      ) : (
        <rect className="mark low" x={r1(cx - half)} y={r1(cy - half)} width={half * 2} height={half * 2} transform={`rotate(45 ${r1(cx)} ${r1(cy)})`} />
      )
    }
    const half = 3.25 + grow
    return kind === 'high' ? (
      <>
        <circle className="mark-disc" cx={r1(cx)} cy={r1(cy)} r={6 + grow} />
        <circle className="mark hollow" cx={r1(cx)} cy={r1(cy)} r={4 + grow} />
      </>
    ) : (
      <>
        <rect className="mark-disc" x={r1(cx - half - 2)} y={r1(cy - half - 2)} width={(half + 2) * 2} height={(half + 2) * 2} transform={`rotate(45 ${r1(cx)} ${r1(cy)})`} />
        <rect className="mark hollow" x={r1(cx - half)} y={r1(cy - half)} width={half * 2} height={half * 2} transform={`rotate(45 ${r1(cx)} ${r1(cy)})`} />
      </>
    )
  }

  return (
    <div
      ref={ref}
      className="chart balance-line"
      data-hollow={drawn.marks.some((mark) => !mark.filled) ? '1' : '0'}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={selected ?? last}
      aria-valuetext={valueText(selected ?? last)}
      onKeyDown={onKey}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {ticks.map((tick, i) => (
          <g key={tick}>
            <line className={tick === 0 ? 'grid zero' : 'grid'} x1={pad.left} x2={width - pad.right} y1={r1(geo.y(tick))} y2={r1(geo.y(tick))} />
            <text className="tick" x={pad.left - 6} y={r1(geo.y(tick)) + 4} textAnchor="end">
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {geo.months.map((mo) => (
          <g key={mo.day}>
            <line className="grid" x1={r1(mo.x)} x2={r1(mo.x)} y1={height - pad.bottom} y2={height - pad.bottom + 4} />
            {monthTexts.has(mo.day) && (
              <text className="tick" x={r1(mo.x)} y={height - 5} textAnchor={monthTexts.get(mo.day)!.anchor}>
                {monthTexts.get(mo.day)!.text}
              </text>
            )}
          </g>
        ))}
        {monthTexts.size === 0 && (
          // Meno di un mese di storia, senza un primo del mese in mezzo: sotto la linea almeno il giorno da cui parte.
          <text className="tick" x={r1(geo.x(0))} y={height - 5} textAnchor={n > 1 ? 'start' : 'middle'}>
            {day(points[0].day)}
          </text>
        )}
        {chosen && (
          // Una fascia dietro il tratto scelto: una salita di un giorno è larga meno di un pixel, così si trova lo stesso.
          <rect
            className="leg-band"
            x={r1(Math.min(geo.x(chosen.fromIndex), (geo.x(chosen.fromIndex) + geo.x(chosen.toIndex)) / 2 - 3))}
            y={pad.top - 6}
            width={r1(Math.max(6, geo.x(chosen.toIndex) - geo.x(chosen.fromIndex)))}
            height={height - pad.bottom - pad.top + 6}
          />
        )}
        <path className="line" d={geo.solid} />
        {geo.light && <path className="line running" d={geo.light} />}
        {chosen && <path className="line leg-on" d={geo.d(chosen.fromIndex, chosen.toIndex)} />}
        {selected !== null && <line className="cross" x1={r1(geo.x(selected))} x2={r1(geo.x(selected))} y1={pad.top - 6} y2={height - pad.bottom} />}
        {drawn.marks
          .filter((mark) => !mark.filled && mark.index !== chosen?.toIndex)
          .map((mark) => (
            <g key={`o${mark.index}`}>{shape(mark.kind, false, mark.x, mark.y)}</g>
          ))}
        {drawn.marks
          .filter((mark) => mark.filled && mark.index !== chosen?.toIndex)
          .map((mark) => (
            <g key={`f${mark.index}`}>{shape(mark.kind, true, mark.x, mark.y)}</g>
          ))}
        {drawn.figures.map((f) => (
          <text key={`t${f.mark.index}`} className="mark-label halo" x={r1(f.mark.x)} y={r1(f.ty)} textAnchor={f.side}>
            {f.text}
          </text>
        ))}
        {chosen &&
          chosen.steps
            .filter((i) => Math.abs(geo.x(i) - geo.x(chosen.toIndex)) >= 6 || Math.abs(geo.y(points[i].value) - geo.y(chosen.to.value)) >= 10)
            .map((i) => <rect key={`s${i}`} className="step" x={r1(geo.x(i) - 5)} y={r1(geo.y(points[i].value) - 1.5)} width={10} height={3} rx={1} />)}
        {chosen && arrival && chosen.toIndex !== last && shape(arrival.kind, arrival.filled, geo.x(arrival.index), geo.y(points[arrival.index].value), 1)}
        {chosen && !arrival && chosen.toIndex !== last && shape(chosen.dir === 'up' ? 'high' : 'low', false, geo.x(chosen.toIndex), geo.y(chosen.to.value), 1)}
        {!drawn.marks.some((mark) => mark.index === last && mark.filled) && <circle className="mark today" cx={r1(today.x)} cy={r1(geo.y(points[last].value))} r={4} />}
        {today.free && (
          <text className="tick halo" x={r1(today.x)} y={r1(today.y)} textAnchor="end">
            {todayLabel}
          </text>
        )}
        {selected !== null && <circle className="cross-dot" cx={r1(geo.x(selected))} cy={r1(geo.y(points[selected].value))} r={4.5} />}
        <rect
          className="hit"
          x={pad.left}
          y={0}
          width={plotW}
          height={height - pad.bottom}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId)
            if (event.pointerType === 'mouse') pick(event)
            else touch.current = { x: event.clientX, y: event.clientY, scrub: false }
          }}
          onPointerMove={(event) => {
            if (event.pointerType === 'mouse') return pick(event)
            const start = touch.current
            if (!start || event.buttons === 0) return
            const dx = Math.abs(event.clientX - start.x)
            if (!start.scrub && (dx < 6 || dx <= Math.abs(event.clientY - start.y))) return
            start.scrub = true
            pick(event)
          }}
          onPointerUp={(event) => {
            if (touch.current && !touch.current.scrub) pick(event)
            touch.current = null
          }}
          onPointerCancel={() => {
            touch.current = null
          }}
        />
      </svg>
    </div>
  )
}

export interface NetBar {
  month: number
  net: number
  /** Mese in corso: disegnato solo col contorno, non entra nei conti. */
  running?: boolean
}

interface NetBarsProps {
  bars: NetBar[]
  selected: number | null
  onSelect: (month: number) => void
  label: string
  aria: (bar: NetBar) => string
  /** Cifra corta per le due etichette (il mese migliore e il peggiore). */
  amount: (value: number) => string
  month: (day: number, withYear: boolean) => string
}

/** Quanto è rimasto ogni mese: una colonna per mese, sopra lo zero se è avanzato qualcosa, sotto se si è speso di più. */
export function NetBars({ bars, selected, onSelect, label, aria, amount, month }: NetBarsProps) {
  const [ref, width] = useWidth<HTMLDivElement>(311)
  const height = 164
  const pad = { top: 18, bottom: 34 }
  const plotH = height - pad.top - pad.bottom
  const pitch = width / Math.max(1, bars.length)
  const barW = Math.min(24, Math.max(3, pitch - 6))
  const full = bars.filter((b) => !b.running)
  // La scala la fanno i mesi finiti: quello in corso (magari con l'affitto pagato e lo stipendio non ancora arrivato)
  // non deve schiacciare gli altri. Se i mesi finiti sono tutti a zero la fa lui, altrimenti non si vedrebbe niente.
  const nets = (full.some((b) => b.net !== 0) ? full : bars).map((b) => b.net)
  const lo0 = Math.min(0, ...nets)
  const hi0 = Math.max(0, ...nets)
  // Il mese in corso fuori scala deve restare una colonna: gli si lascia un 15% della scala dalla sua parte, non di più;
  // oltre si ferma al bordo, tratteggiato.
  const run = bars.find((b) => b.running)
  const room = 0.15 * (hi0 - lo0 || 1)
  const lo = run && run.net < lo0 ? Math.max(run.net, lo0 - room) : lo0
  const hi = run && run.net > hi0 ? Math.min(run.net, hi0 + room) : hi0
  const span = hi - lo || 1
  const y = (v: number) => pad.top + ((hi - Math.min(hi, Math.max(lo, v))) / span) * plotH
  const zero = y(0)
  const best = full.reduce<NetBar | null>((b, x) => (x.net > 0 && (!b || x.net > b.net) ? x : b), null)
  const worst = full.reduce<NetBar | null>((b, x) => (x.net < 0 && (!b || x.net < b.net) ? x : b), null)
  const regular = new Set(monthLabels(bars.map((b) => b.month), pitch, 24, 42).map((l) => l.month))
  const labels = fitMonthLabels(
    bars.map((b, i) => ({ month: b.month, x: pitch * (i + 0.5) })).filter((b) => regular.has(b.month)),
    month,
    (x, withYear) => (withYear && x < 22 ? 'start' : withYear && x > width - 22 ? 'end' : 'middle'),
  )

  return (
    <div ref={ref} className="chart net-bars" role="group" aria-label={label}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <line className="grid zero" x1={0} x2={width} y1={r1(zero)} y2={r1(zero)} />
        {bars.map((bar, i) => {
          const cx = pitch * (i + 0.5)
          // Anche un mese rimasto di poco sopra o sotto lo zero si deve vedere: almeno un pixel e mezzo, dalla sua parte.
          const h = Math.max(bar.net === 0 ? 0 : 1.5, Math.abs(y(bar.net) - zero))
          const top = bar.net >= 0 ? zero - h : zero
          const cut = bar.net > hi || bar.net < lo
          const r = Math.min(4, barW / 2, h)
          const x0 = cx - barW / 2
          // Arrotondata solo dalla parte del valore, dritta sulla linea dello zero.
          const d =
            bar.net >= 0
              ? `M${r1(x0)} ${r1(zero)}V${r1(top + r)}Q${r1(x0)} ${r1(top)} ${r1(x0 + r)} ${r1(top)}H${r1(x0 + barW - r)}Q${r1(x0 + barW)} ${r1(top)} ${r1(x0 + barW)} ${r1(top + r)}V${r1(zero)}Z`
              : `M${r1(x0)} ${r1(zero)}V${r1(top + h - r)}Q${r1(x0)} ${r1(top + h)} ${r1(x0 + r)} ${r1(top + h)}H${r1(x0 + barW - r)}Q${r1(x0 + barW)} ${r1(top + h)} ${r1(x0 + barW)} ${r1(top + h - r)}V${r1(zero)}Z`
          const labelled = bar === best || bar === worst
          const monthText = labels.get(bar.month)
          return (
            <g key={bar.month} className={`nb${bar.running ? ' running' : bar.net < 0 ? ' down' : ' up'}${cut ? ' cut' : ''}${selected !== null && selected !== bar.month ? ' dim' : ''}`}>
              {bar.net !== 0 && <path d={d} aria-hidden="true" />}
              {labelled && (
                <text className="mark-label" x={r1(Math.min(width - 2, Math.max(2, cx)))} y={r1(bar.net >= 0 ? top - 5 : top + h + 13)} textAnchor={cx < 30 ? 'start' : cx > width - 30 ? 'end' : 'middle'} aria-hidden="true">
                  {amount(bar.net)}
                </text>
              )}
              {monthText && (
                <text className="tick" x={r1(cx)} y={height - 5} textAnchor={monthText.anchor} aria-hidden="true">
                  {monthText.text}
                </text>
              )}
              <rect
                className="hit"
                x={r1(pitch * i)}
                y={0}
                width={r1(pitch)}
                height={height}
                role="button"
                tabIndex={0}
                aria-label={aria(bar)}
                aria-pressed={selected === bar.month}
                onClick={() => onSelect(bar.month)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(bar.month)
                }}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/**
 * Le colonnine di una voce mese per mese: solo per colpo d'occhio, i numeri stanno nella lista sotto.
 * `ends` sono il primo e l'ultimo mese, scritti ai due capi: senza, non si sa da che parte si legge.
 */
export function MiniBars({ values, color, ends }: { values: number[]; color: string; ends?: [string, string] }) {
  const [ref, width] = useWidth<HTMLDivElement>(260)
  const height = 40
  const max = Math.max(1, ...values)
  const pitch = width / Math.max(1, values.length)
  const barW = Math.min(16, Math.max(2, pitch - 3))
  return (
    <div ref={ref} className="chart mini-bars" aria-hidden="true">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <line className="grid zero" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
        {values.map((v, i) => {
          const h = v > 0 ? Math.max(1.5, (v / max) * (height - 4)) : 0
          const r = Math.min(3, barW / 2, h)
          const x0 = pitch * (i + 0.5) - barW / 2
          const top = height - h
          return v > 0 ? (
            <path
              key={i}
              fill={color}
              opacity={v === max ? 1 : 0.55}
              d={`M${r1(x0)} ${height}V${r1(top + r)}Q${r1(x0)} ${r1(top)} ${r1(x0 + r)} ${r1(top)}H${r1(x0 + barW - r)}Q${r1(x0 + barW)} ${r1(top)} ${r1(x0 + barW)} ${r1(top + r)}V${height}Z`}
            />
          ) : null
        })}
      </svg>
      {ends && (
        <div className="mini-ends">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
    </div>
  )
}

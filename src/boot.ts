/**
 * La schermata d'avvio disegnata da index.html: il fichetto che rimbalza sopra lo sfondo dell'app.
 * Continua lo splash del sistema e resta finché c'è qualcosa da mostrare al suo posto; qui la si aggiorna e la si toglie.
 */
const boot = () => document.getElementById('boot')

/** Aperta dalla scorciatoia "Nuovo movimento" (?add=1): si vuole scrivere subito, niente attese per il rimbalzo. */
const urgent = new URLSearchParams(location.search).has('add')

/** Vero finché la schermata d'avvio è ancora a schermo (e non sta già uscendo). */
export function bootShowing(): boolean {
  const el = boot()
  return !!el && !el.dataset.leaving
}

/** Una riga sotto il fichetto, per le attese che durano (per esempio lo scaricamento dei dati dell'account). */
export function bootNote(text: string) {
  const note = document.getElementById('boot-note')
  if (note) note.textContent = text
}

/** Punti del salto, da 0 a 1, in cui il fichetto stacca da terra e in cui la tocca di nuovo (vedi @keyframes fig-bounce in index.html). */
const TAKEOFF = 0.12
const LANDING = 0.78

/**
 * Quanti millisecondi aspettare prima di togliere la schermata d'avvio, perché l'app compaia alla fine di un rimbalzo
 * e non a mezz'aria. `elapsed` è il tempo dall'inizio dell'animazione (negativo durante il piccolo ritardo iniziale),
 * `duration` la durata di un salto. Al primo salto lo si lascia finire: è lui lo splash. Dal secondo in poi,
 * se il fichetto è a terra si esce subito.
 */
export function landingWait(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 0
  if (elapsed < 0) return -elapsed + duration * LANDING
  const phase = (elapsed % duration) / duration
  if (phase >= LANDING || (elapsed >= duration && phase < TAKEOFF)) return 0
  return (LANDING - phase) * duration
}

/** Toglie la schermata d'avvio, aspettando se serve che il fichetto atterri. Con le animazioni ridotte esce subito. */
export function bootDone() {
  const el = boot()
  if (!el || el.dataset.leaving) return
  el.dataset.leaving = '1'
  const leave = () => {
    el.classList.add('out')
    window.setTimeout(() => el.remove(), 260)
  }
  const jump = urgent ? undefined : el.querySelector('.boot-fig')?.getAnimations?.()[0]
  const timing = jump?.effect?.getComputedTiming()
  const wait = jump && typeof timing?.duration === 'number' ? landingWait(Number(jump.currentTime ?? 0) - (timing.delay ?? 0), timing.duration) : 0
  if (wait > 0) window.setTimeout(leave, Math.min(wait, 1200))
  else leave()
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootDone, bootNote, bootShowing, landingWait } from '../boot'

describe('schermata d’avvio', () => {
  // Un salto dura 900 ms: stacca al 12% (108 ms) e tocca terra al 78% (702 ms).
  it('al primo salto si aspetta che finisca, anche se l’app è pronta prima', () => {
    expect(landingWait(-100, 900)).toBeCloseTo(802)
    expect(landingWait(0, 900)).toBeCloseTo(702)
    expect(landingWait(50, 900)).toBeCloseTo(652)
    expect(landingWait(400, 900)).toBeCloseTo(302)
  })

  it('una volta a terra si esce subito', () => {
    expect(landingWait(702, 900)).toBe(0)
    expect(landingWait(880, 900)).toBe(0)
    // Dal secondo salto in poi anche prima dello stacco.
    expect(landingWait(900, 900)).toBe(0)
    expect(landingWait(950, 900)).toBe(0)
  })

  it('a mezz’aria si aspetta l’atterraggio, mai più di un salto', () => {
    expect(landingWait(900 + 400, 900)).toBeCloseTo(302)
    expect(landingWait(9 * 900 + 110, 900)).toBeCloseTo(592)
    for (let t = -100; t < 3_000; t += 37) expect(landingWait(t, 900)).toBeLessThanOrEqual(802)
  })

  it('senza animazione non si aspetta', () => {
    expect(landingWait(300, 0)).toBe(0)
    expect(landingWait(300, Number.NaN)).toBe(0)
  })

  describe('nella pagina', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="boot"><div class="boot-stage"><svg class="boot-fig"></svg></div><p id="boot-note"></p></div><div id="root"></div>'
    })

    it('la riga d’attesa si scrive sotto il fichetto', () => {
      bootNote('Scaricamento dei tuoi dati…')
      expect(document.getElementById('boot-note')!.textContent).toBe('Scaricamento dei tuoi dati…')
    })

    it('esce una volta sola, e dopo la dissolvenza sparisce dalla pagina', () => {
      vi.useFakeTimers()
      expect(bootShowing()).toBe(true)
      bootDone()
      // Senza animazione (come con le animazioni ridotte) esce subito.
      expect(bootShowing()).toBe(false)
      expect(document.getElementById('boot')!.classList.contains('out')).toBe(true)
      bootDone()
      vi.advanceTimersByTime(300)
      expect(document.getElementById('boot')).toBeNull()
      // Chiamarla ancora, a schermata già tolta, non fa niente.
      bootDone()
      bootNote('…')
      expect(bootShowing()).toBe(false)
      vi.useRealTimers()
    })
  })
})

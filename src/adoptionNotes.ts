/**
 * Messaggi lasciati per dopo un ricaricamento della pagina o un passaggio dalla pagina di accesso:
 * l'esito della scelta del primo accesso (dati aggiunti all'account, sostituiti, oppure uscita).
 * Stanno nella memoria della scheda: valgono una volta sola e non riguardano le altre finestre.
 */

/** Messaggio breve da mostrare all'arrivo (chiave di traduzione). */
export const ADOPT_TOAST = 'fig-adopt-toast'
/** Promemoria che resta dopo un'unione, finché non lo si chiude. */
export const ADOPT_MERGED = 'fig-adopt-merged'

export function noteForNextPage(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* memoria non disponibile: salta solo il messaggio di conferma */
  }
}

/** Legge e toglie un messaggio lasciato per questa pagina. */
export function takeNote(key: string): string | null {
  try {
    const value = sessionStorage.getItem(key)
    if (value !== null) sessionStorage.removeItem(key)
    return value
  } catch {
    return null
  }
}

import type { ReactNode } from 'react'
import mascot from './mascot.svg?raw'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** Mese: un ramo con due foglie. */
export const IconBranch = () => (
  <Icon>
    <path d="M12 21c0-5 .5-9 3-13 1-1.6 2.3-2.8 4-4" />
    <path d="M13.2 13.5C10 13.8 7.5 12 6.5 9.2c3-.5 5.6.8 6.7 4.3z" />
    <path d="M15.4 8.4c1.9-2.6 4.4-3 5.6-2.5-.8 2.3-3 3.7-5.6 2.5z" />
  </Icon>
)
/** Statistiche: un albero, la chioma come riepilogo del mese. */
export const IconTree = () => (
  <Icon>
    <path d="M12 21v-7M12 17l-3-2.5M12 15.5l3-2" />
    <path d="M7.5 14.5A4.5 4.5 0 0 1 6 6.5a6 6 0 0 1 11.5-.5 4.5 4.5 0 0 1-1 8.5z" />
  </Icon>
)
/** Obiettivi: un fico. */
export const IconFigOutline = () => (
  // La stessa sagoma del fichetto dell'icona (src/mascot.svg), a tratto come le altre icone.
  <Icon>
    <path d="M10.6 6.3C10.1 9.4 4 11.1 4 16.2c0 3.4 3.4 5.6 8 5.6s8-2.2 8-5.6c0-5.1-6.1-6.8-6.6-9.9z" />
    <path d="M11.9 6.2 11.5 3.1M12.6 5c.9-2 3.6-2.7 5.7-1.6-1 2-3.6 2.6-5.7 1.6z" />
  </Icon>
)
export const IconPlus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
export const IconGear = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
)
export const IconLeft = () => (
  <Icon>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
)
export const IconRight = () => (
  <Icon>
    <path d="M9 6l6 6-6 6" />
  </Icon>
)
export const IconClose = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)
export const IconUp = () => (
  <Icon>
    <path d="M6 15l6-6 6 6" />
  </Icon>
)
export const IconDown = () => (
  <Icon>
    <path d="M6 9l6 6 6-6" />
  </Icon>
)
/** Il disegno ritagliato sul fichetto, senza il margine che serve all'icona: per quando è piccolo, accanto al nome. */
const mascotTight = mascot.replace('viewBox="0 0 512 512"', 'viewBox="61 56 390 390"')

/**
 * Il fichetto col suo viso, lo stesso dell'icona dell'app e della schermata d'avvio. Grande nelle schermate dove c'è
 * spazio; `small` accanto al nome "fig", in alto: così il logo dentro l'app e l'icona sul telefono sono la stessa cosa.
 */
export const Mascot = ({ small = false }: { small?: boolean }) => (
  <span className={small ? 'mascot small' : 'mascot'} aria-hidden="true" dangerouslySetInnerHTML={{ __html: small ? mascotTight : mascot }} />
)

import type { ReactNode } from 'react'

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
  <Icon>
    <path d="M12 6.5c4.2 0 6.6 5 6.2 9.4C17.8 19.6 15 21 12 21s-5.8-1.4-6.2-5.1C5.4 11.5 7.8 6.5 12 6.5z" />
    <path d="M12 6.5 12.6 3.5M12.6 4.2c1.4-1.5 3.6-1.6 4.7-.6-1.3 1.4-3.3 1.6-4.7.6z" />
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
export const IconFig = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M12 4.5c-.8 0-1.2.8-1.2 1.5v1C7.8 7.8 5.5 10.8 5.5 14.2c0 3.5 2.8 6.3 6.5 6.3s6.5-2.8 6.5-6.3c0-3.4-2.3-6.4-5.3-7.2V6c0-.7-.4-1.5-1.2-1.5z" fill="currentColor" />
    <path d="M12.4 6.2c1.5-1.6 3.9-1.7 5.1-.5-1.5 1.3-3.6 1.3-5.1.5z" fill="var(--leaf)" />
  </svg>
)

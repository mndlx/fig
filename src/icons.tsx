import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const IconThread = () => (
  <Icon>
    <path d="M12 3c3 3-3 6 0 9s-3 6 0 9" />
    <circle cx="12" cy="8" r="1.6" fill="currentColor" />
    <circle cx="12" cy="16" r="1.6" fill="currentColor" />
  </Icon>
)
export const IconLoom = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M9.5 4v16M14.5 4v16M4 12h16" />
  </Icon>
)
export const IconYarn = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="M6 7.5c3 1 6 4 7 10M9 4.5c3 2 6 6 6.5 11M5 12c2.5 0 5.5 2 7 6" />
    <path d="M16 16c1.5 1 2.5 2 4 2.5" />
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

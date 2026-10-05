/**
 * Valuta più probabile per chi apre FIG la prima volta, tra quelle predefinite.
 * Serve solo come punto di partenza: la si conferma o si cambia nel riquadro iniziale.
 */

const EURO = new Set('AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK'.split(' '))
const BY_REGION: Record<string, string> = { AL: 'ALL', US: 'USD', PR: 'USD', GB: 'GBP', IM: 'GBP', JE: 'GBP', GG: 'GBP', CH: 'CHF', LI: 'CHF' }
// Il fuso orario dice dove si è anche quando la lingua del telefono è un'altra (italiano in Albania).
const BY_ZONE: Record<string, string> = { 'Europe/Tirane': 'ALL', 'Europe/Zurich': 'CHF', 'Europe/Vaduz': 'CHF', 'Europe/London': 'GBP' }

export function guessCurrency(languages?: readonly string[], timeZone?: string): string {
  try {
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    if (zone && BY_ZONE[zone]) return BY_ZONE[zone]
    const tags = languages ?? (typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [])
    for (const tag of tags) {
      if (!tag) continue
      const loc = new Intl.Locale(tag)
      // "en" da solo non dice il paese: si passa alla lingua successiva invece di tirare a indovinare.
      const region = loc.region ?? (loc.language === 'en' ? undefined : loc.maximize().region)
      if (!region) continue
      if (BY_REGION[region]) return BY_REGION[region]
      if (EURO.has(region)) return 'EUR'
      // La prima lingua con un paese riconoscibile decide: una lingua secondaria non conta.
      break
    }
  } catch {
    // Intl.Locale assente o lingua non valida: si resta sull'euro.
  }
  return 'EUR'
}

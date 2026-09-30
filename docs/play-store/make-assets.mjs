import { Resvg } from '@resvg/resvg-js'
import fs from 'node:fs'

// Uso, dalla radice del repository: npm install --no-save @resvg/resvg-js && node docs/play-store/make-assets.mjs
const pub = 'public/'
const store = 'docs/play-store/'
fs.mkdirSync(pub + 'icons', { recursive: true })
fs.mkdirSync(store, { recursive: true })

// Il fico del logo, disegnato in un riquadro 64×64.
const fig = `
  <path d="M32 12c-2 0-3 2-3 4v3c-8 2-14 10-14 19 0 9 7 16 17 16s17-7 17-16c0-9-6-17-14-19v-3c0-2-1-4-3-4z" fill="#7B4B6A"/>
  <path d="M33 16c4-4 10-4 13-1-4 3-9 3-13 1z" fill="#7A9E7E"/>
  <circle cx="27" cy="38" r="1.6" fill="#E8C8B0"/><circle cx="33" cy="42" r="1.6" fill="#E8C8B0"/><circle cx="37" cy="35" r="1.6" fill="#E8C8B0"/><circle cx="30" cy="46" r="1.6" fill="#E8C8B0"/>`

const svg = {
  // Icona normale: angoli arrotondati come la favicon.
  any: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2B2320"/>${fig}</svg>`,
  // Maskable: sfondo pieno, fico dentro la zona sicura (cerchio dell'80%).
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2B2320"/><g transform="translate(32 33) scale(0.72) translate(-32 -33)">${fig}</g></svg>`,
  // Icona del Play Store: quadrata piena, Google applica la sua maschera.
  store: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2B2320"/><g transform="translate(32 33) scale(0.82) translate(-32 -33)">${fig}</g></svg>`,
  feature: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 500">
    <rect width="1024" height="500" fill="#F4EFE6"/>
    <path d="M110 500 C 150 380 120 300 170 190 C 200 120 250 80 300 60" stroke="#8A6A4A" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M168 260 C 120 250 95 220 90 190 C 130 190 160 215 168 260Z" fill="#8C7FB8"/>
    <path d="M200 160 C 240 130 280 130 300 145 C 270 175 235 180 200 160Z" fill="#7B4B6A"/>
    <path d="M262 82 C 250 45 262 20 282 8 C 292 40 284 65 262 82Z" fill="#D9A441"/>
    <g transform="translate(63 274) scale(2.2)">${fig}</g>
    <text x="470" y="245" font-family="Georgia, serif" font-size="120" fill="#5B2A45">fig</text>
    <text x="474" y="310" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#4A3D45">Il tuo budget, un ramo alla volta</text>
  </svg>`,
}

const render = (s, width, out) => {
  const png = new Resvg(s, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng()
  fs.writeFileSync(out, png)
  console.log(out, png.length)
}
render(svg.any, 192, pub + 'icons/icon-192.png')
render(svg.any, 512, pub + 'icons/icon-512.png')
render(svg.maskable, 512, pub + 'icons/icon-maskable-512.png')
render(svg.maskable, 180, pub + 'icons/apple-touch-icon.png')
render(svg.store, 512, store + 'icon-512.png')
render(svg.feature, 1024, store + 'feature-graphic-1024x500.png')

// Icone e immagini di avvio di FIG, tutte dallo stesso disegno: src/mascot.svg.
// Si lancia a mano quando cambia il disegno; i file generati stanno nel repository. Dalla radice del repository:
//   npm install --no-save @resvg/resvg-js && node scripts/icons.mjs
// Scrive: public/favicon.svg, public/icons/*.png, public/splash/*.png, il blocco dei <link> di avvio in index.html
// e le immagini per la scheda del Play Store in docs/play-store/.
import { Resvg } from '@resvg/resvg-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (...p) => path.join(root, ...p)

/** Gli stessi colori di fondo dell'app (--bg in src/styles.css), di index.html e del manifest: lo splash non deve fare gradini. */
const BG = { light: '#f3eee6', dark: '#141118' }

const source = fs.readFileSync(at('src/mascot.svg'), 'utf8')
const drawing = source.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1]
if (!drawing || !/viewBox="0 0 512 512"/.test(source)) throw new Error('src/mascot.svg: serve un <svg viewBox="0 0 512 512">')
/** Il disegno senza commenti né spazi inutili, per i file che viaggiano col sito. */
const compact = drawing.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()

const round = (n) => Math.round(n * 100) / 100
/** Il riquadro del disegno visto con uno zoom di `scale` attorno al centro: più di 1 avvicina, meno di 1 lascia margine. */
const zoom = (scale) => [256 - 256 / scale, 256 - 256 / scale, 512 / scale, 512 / scale].map(round).join(' ')
/** Il fichetto dentro un riquadro `size`, ingrandito di `scale` attorno al centro. */
const fig = (x, y, size, scale = 1) => `<svg x="${round(x)}" y="${round(y)}" width="${size}" height="${size}" viewBox="${zoom(scale)}">${compact}</svg>`
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
const png = (markup, width, file) => {
  const data = new Resvg(markup, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } }).render().asPng()
  fs.mkdirSync(path.dirname(at(file)), { recursive: true })
  fs.writeFileSync(at(file), data)
  return data.length
}

let bytes = 0
let files = 0
const write = (markup, width, file) => {
  bytes += png(markup, width, file)
  files++
}

// ——— Icone ———
// "any": solo il fichetto, senza fondo (computer, scorciatoie, e lo splash dell'app del Play Store).
const any = svg(512, 512, fig(0, 0, 512, 1.2))
// "maskable": è quella che Android usa sia sulla schermata del telefono sia per lo splash (Chrome la preferisce sempre).
// Fondo pieno fino ai bordi e uguale al background_color del manifest: così nello splash la sagoma del ritaglio sparisce
// e resta solo il fichetto. Tutto il disegno, foglia compresa, sta nel cerchio centrale del 60%: lo splash ne mostra
// solo i due terzi centrali, e ogni telefono ritaglia a modo suo.
const maskable = svg(512, 512, `<rect width="512" height="512" fill="${BG.light}"/>${fig(0, 0, 512, 0.72)}`)
// "monochrome": solo la sagoma (conta la trasparenza, non il colore), con occhi e sorriso forati. Android la usa per le
// icone a tema e per l'icona delle notifiche.
/** Gli elementi del disegno con una certa classe (vedi le classi fig-* in src/mascot.svg). */
const parts = (name) => compact.match(new RegExp(String.raw`<(\w+) class="${name}"(?:[^>]*/>|[^>]*>[\s\S]*?</\1>)`, 'g')) ?? []
const black = (markup) => markup.replace(/(fill|stroke)="#[0-9a-f]+"/gi, '$1="#000000"')
const eyes = parts('fig-eyes').join('')
const smile = parts('fig-smile').join('')
if (!eyes || !smile) throw new Error('src/mascot.svg: mancano le classi fig-eyes e fig-smile per l’icona monocromatica')
// Sagoma: corpo, picciolo e foglia. Fori: gli occhi (senza il riflesso) e il sorriso.
const outline = black([eyes, smile, ...parts('fig-cheek'), ...parts('fig-shine')].reduce((all, part) => all.replace(part, ''), compact))
const holes = black(parts('fig-glint').reduce((all, part) => all.replace(part, ''), eyes) + smile)
const monochrome = svg(
  512,
  512,
  `<mask id="holes"><rect x="-512" y="-512" width="1536" height="1536" fill="#ffffff"/><svg width="512" height="512" viewBox="${zoom(0.72)}">${holes}</svg></mask><g mask="url(#holes)"><svg width="512" height="512" viewBox="${zoom(0.72)}">${outline}</svg></g>`,
)
// iPhone: niente trasparenza (diventerebbe nera); gli angoli li arrotonda il sistema.
const apple = svg(512, 512, `<rect width="512" height="512" fill="${BG.light}"/>${fig(0, 0, 512, 0.98)}`)

fs.writeFileSync(at('public/favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${zoom(1.2)}">${compact}</svg>\n`)
write(any, 192, 'public/icons/fig-192.png')
write(any, 512, 'public/icons/fig-512.png')
write(maskable, 192, 'public/icons/fig-maskable-192.png')
write(maskable, 512, 'public/icons/fig-maskable-512.png')
write(monochrome, 512, 'public/icons/fig-mono-512.png')
write(apple, 180, 'public/icons/apple-touch-icon.png')

// ——— Immagini di avvio per iPhone e iPad ———
// iOS non costruisce lo splash dal manifest: vuole un'immagine grande esattamente quanto lo schermo, una per formato.
// Lato corto e lato lungo in punti, e densità. Il fichetto è grande quanto quello della schermata d'avvio di index.html
// (.boot-stage, BOOT_FIG punti) e sta nello stesso punto: tra l'immagine e la pagina non si muove niente.
const BOOT_FIG = 208
const SCREENS = [
  // iPhone
  [375, 667, 2],
  [414, 736, 3],
  [375, 812, 3],
  [414, 896, 2],
  [414, 896, 3],
  [390, 844, 3],
  [428, 926, 3],
  [393, 852, 3],
  [430, 932, 3],
  [402, 874, 3],
  [440, 956, 3],
  [420, 912, 3],
  // iPad
  [744, 1133, 2],
  [768, 1024, 2],
  [810, 1080, 2],
  [820, 1180, 2],
  [834, 1112, 2],
  [834, 1194, 2],
  [834, 1210, 2],
  [1024, 1366, 2],
  [1032, 1376, 2],
]
const links = []
for (const [short, long, ratio] of SCREENS) {
  // Sui telefoni l'app è solo in verticale; un iPad può partire anche in orizzontale.
  const orientations = short >= 700 ? ['portrait', 'landscape'] : ['portrait']
  for (const orientation of orientations) {
    const [w, h] = orientation === 'portrait' ? [short, long] : [long, short]
    for (const theme of ['light', 'dark']) {
      const file = `splash/${w * ratio}x${h * ratio}-${theme}.png`
      const body = `<rect width="${w}" height="${h}" fill="${BG[theme]}"/>${fig((w - BOOT_FIG) / 2, (h - BOOT_FIG) / 2, BOOT_FIG)}`
      write(svg(w, h, body), w * ratio, `public/${file}`)
      const media = [
        'screen',
        `(device-width: ${short}px)`,
        `(device-height: ${long}px)`,
        `(-webkit-device-pixel-ratio: ${ratio})`,
        `(orientation: ${orientation})`,
        `(prefers-color-scheme: ${theme})`,
      ].join(' and ')
      links.push(`<link rel="apple-touch-startup-image" media="${media}" href="/${file}" />`)
    }
  }
}
// index.html: i collegamenti alle immagini di avvio e il fichetto della schermata d'avvio, ognuno tra i suoi segnaposto.
let html = fs.readFileSync(at('index.html'), 'utf8')
const inject = (name, lines) => {
  const start = html.match(new RegExp(`^( *)<!-- ${name}:start[^\\n]*-->`, 'm'))
  const end = html.indexOf(`<!-- ${name}:end -->`)
  if (!start || end < 0) throw new Error(`index.html: mancano i segnaposto ${name}:start / ${name}:end`)
  const pad = start[1]
  html = html.slice(0, start.index + start[0].length) + '\n' + lines.map((l) => pad + l + '\n').join('') + pad + html.slice(end)
}
inject('splash', links)
inject('fig', [`<svg class="boot-fig" viewBox="0 0 512 512" aria-hidden="true">${compact}</svg>`])
fs.writeFileSync(at('index.html'), html)

// ——— Play Store ———
write(svg(512, 512, `<rect width="512" height="512" fill="${BG.light}"/>${fig(0, 0, 512, 0.92)}`), 512, 'docs/play-store/icon-512.png')
write(
  svg(
    1024,
    500,
    `<rect width="1024" height="500" fill="${BG.light}"/>
    <path d="M110 500 C 150 380 120 300 170 190 C 200 120 250 80 300 60" stroke="#8a6a4a" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M168 260 C 120 250 95 220 90 190 C 130 190 160 215 168 260Z" fill="#8C7FB8"/>
    <path d="M200 160 C 240 130 280 130 300 145 C 270 175 235 180 200 160Z" fill="#7a3d67"/>
    <path d="M262 82 C 250 45 262 20 282 8 C 292 40 284 65 262 82Z" fill="#D9A441"/>
    ${fig(40, 250, 230)}
    <text x="470" y="245" font-family="Georgia, serif" font-size="120" fill="#5e2b4f">fig</text>
    <text x="474" y="310" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#4a3d45">Il tuo budget, un ramo alla volta</text>`,
  ),
  1024,
  'docs/play-store/feature-graphic-1024x500.png',
)

console.log(`${files} immagini, ${Math.round(bytes / 1024)} KB · ${links.length} immagini di avvio collegate in index.html`)

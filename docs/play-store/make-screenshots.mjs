import { chromium } from 'playwright'
import fs from 'node:fs'

// Uso, dalla radice del repository, con server di prova (AUTH_DISABLED=1, porta 8790) e Vite su 5197 avviati:
//   npm install --no-save playwright && node docs/play-store/make-screenshots.mjs
// Usa Microsoft Edge installato sul PC. Genera screenshot 1080×1920 in italiano e inglese con dati di esempio.
const OUT = 'docs/play-store/screenshots/'
fs.mkdirSync(OUT, { recursive: true })
const URL = 'http://localhost:5197/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Dati di esempio: un mese credibile, obiettivi in stati diversi.
function seed(lang) {
  const L = (it, en) => (lang === 'it' ? it : en)
  const d = (day, h, m = 0) => new Date(2026, 8, day, h, m).getTime()
  const T = (id, kind, amt, date, extra = {}) => ({ id, kind, amount: amt, currency: 'EUR', rate: 1, mainAmount: amt, date, accountId: 'acc-main', note: '', source: 'manual', ...extra })
  const txs = [
    T('opening-acc-main', 'opening', 340000, new Date(2026, 6, 1, 8).getTime()),
    T('opening-acc-cash', 'opening', 12000, new Date(2026, 6, 1, 8).getTime(), { accountId: 'acc-cash' }),
    T('rent', 'expense', 65000, d(1, 9), { categoryId: 'cat-home', note: L('Affitto', 'Rent'), recurringId: 'r-rent' }),
    T('sal', 'income', 185000, d(27, 9), { categoryId: 'cat-salary' }),
    T('e1', 'expense', 5240, d(30, 12, 10), { categoryId: 'cat-groceries' }),
    T('e2', 'expense', 350, d(30, 8, 5), { categoryId: 'cat-coffee', accountId: 'acc-cash', note: L('Bar Roma', 'Corner café') }),
    T('e3', 'expense', 1450, d(30, 13, 20), { categoryId: 'cat-lunch' }),
    T('e4', 'expense', 8900, d(29, 11), { categoryId: 'cat-bills', note: L('Luce e gas', 'Electricity and gas') }),
    T('e5', 'expense', 3300, d(29, 21), { categoryId: 'cat-goingOut', note: L('Cinema e cena', 'Cinema and dinner') }),
    T('e6', 'expense', 1299, d(28, 9), { categoryId: 'cat-subscriptions', note: L('Musica', 'Music'), recurringId: 'r-music' }),
    T('e7', 'expense', 2500, d(26, 18), { categoryId: 'cat-transport', note: L('Benzina', 'Fuel') }),
    T('e8', 'expense', 4630, d(24, 17), { categoryId: 'cat-groceries' }),
    T('e9', 'expense', 900, d(22, 13), { categoryId: 'cat-lunch' }),
    T('e10', 'expense', 3990, d(19, 16), { categoryId: 'cat-clothes' }),
    T('e11', 'expense', 2200, d(15, 20), { categoryId: 'cat-goingOut' }),
    T('e12', 'expense', 3810, d(12, 18), { categoryId: 'cat-groceries' }),
    T('e13', 'expense', 1800, d(9, 10), { categoryId: 'cat-health', note: L('Farmacia', 'Pharmacy') }),
    T('e14', 'expense', 3100, d(5, 18), { categoryId: 'cat-groceries' }),
    T('e15', 'expense', 9000, d(20, 18), { categoryId: 'cat-goingOut', goalId: 'g1', note: L('Volo per Lisbona', 'Flight to Lisbon') }),
    T('s1', 'save', 25000, d(2, 9), { goalId: 'g1' }),
    T('s1b', 'save', 20000, d(28, 9), { goalId: 'g1' }),
    T('s2', 'save', 60000, new Date(2026, 7, 3, 9).getTime(), { goalId: 'g2' }),
    T('s3', 'save', 12000, d(10, 9), { goalId: 'g3' }),
    T('s4', 'save', 50000, new Date(2026, 6, 4, 9).getTime(), { goalId: 'g4' }),
    T('s5', 'save', 10000, d(4, 9), { goalId: 'g4' }),
  ]
  const goals = [
    { id: 'g1', name: L('Vacanza a Lisbona', 'Trip to Lisbon'), target: 120000, deadline: new Date(2027, 5, 30, 23, 59).getTime(), color: '#2F6F73', order: 1, archived: false },
    { id: 'g2', name: L('Telefono nuovo', 'New phone'), target: 60000, color: '#7B4B6A', order: 2, archived: false },
    { id: 'g3', name: L('Regali di Natale', 'Christmas gifts'), target: 40000, deadline: new Date(2026, 11, 20, 23, 59).getTime(), color: '#C8553D', order: 3, archived: false },
    { id: 'g4', name: L('Fondo imprevisti', 'Rainy-day fund'), target: 300000, color: '#D9A441', order: 4, archived: false },
  ]
  return new Promise((res, rej) => {
    const q = indexedDB.open('fig')
    q.onsuccess = () => {
      const tx = q.result.transaction(['transactions', 'goals', 'settings', 'accounts'], 'readwrite')
      // La valuta di partenza dell'app viene stimata dal computer (fuso e lingua): qui la si fissa in euro,
      // come gli importi di esempio, e il riquadro iniziale risulta già completato.
      tx.objectStore('settings').put({ id: 'main', mainCurrency: 'EUR', setup: 'done' })
      tx.objectStore('accounts').put({ id: 'acc-main', name: '', key: 'main', currency: 'EUR', initialBalance: 0, initialMain: 0, order: 0, archived: false })
      tx.objectStore('accounts').put({ id: 'acc-cash', name: '', key: 'cash', currency: 'EUR', initialBalance: 0, initialMain: 0, order: 1, archived: false })
      for (const t of txs) tx.objectStore('transactions').put(t)
      for (const g of goals) tx.objectStore('goals').put(g)
      tx.oncomplete = () => (q.result.close(), res())
      tx.onerror = () => rej(tx.error)
    }
  })
}

const browser = await chromium.launch({ channel: 'msedge' })
for (const lang of ['it', 'en']) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light', locale: lang === 'it' ? 'it-IT' : 'en-GB' })
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.evaluate((l) => {
    localStorage.clear()
    localStorage.setItem('fig-lang', l)
  }, lang)
  // L'app ricarica la pagina quando il suo database viene cancellato da fuori: la chiamata può interrompersi a metà.
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('fig'); q.onsuccess = q.onerror = q.onblocked = () => r() })).catch(() => {})
  await wait(500)
  await page.reload()
  await wait(3000)
  await page.evaluate(seed, lang)
  await page.reload()
  await wait(2500)
  const shot = async (name) => {
    await wait(700)
    await page.screenshot({ path: `${OUT}${lang}-${name}.png` })
    console.log(lang, name)
  }
  const tab = (i) => page.locator('.dock-tab').nth(i).click()

  // 1. Mese: disponibile e ramo.
  await shot('1-mese')
  await page.evaluate(() => { document.querySelector('.thread')?.scrollIntoView(); window.scrollBy(0, -8) })
  await shot('2-ramo')
  await page.evaluate(() => window.scrollTo(0, 0))
  // 3. Inserimento.
  await page.locator('.dock-add').click()
  await shot('3-inserimento')
  await page.keyboard.press('Escape')
  await wait(400)
  // 4. Obiettivi e un obiettivo maturo.
  await tab(1)
  await shot('4-obiettivi')
  await page.locator('.goal-row').nth(1).locator('.goal-row-main').click()
  await shot('5-raccolta')
  await page.locator('header.bar .icon-btn').first().click()
  await wait(300)
  // 6. Statistiche.
  await tab(2)
  await shot('6-statistiche')
  await ctx.close()
}
await browser.close()

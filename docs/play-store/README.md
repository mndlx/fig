# FIG sul Play Store

FIG va sul Play Store come **Trusted Web Activity** (TWA): un'app Android leggera che apre https://fig.vlabstudio.net a schermo intero, senza barra del browser. Gli aggiornamenti dell'app web arrivano subito anche lì; lo Store va aggiornato solo se cambiano icona, nome o pacchetto.

Le regole di Google cambiano spesso: prima di ogni passo controlla la pagina ufficiale indicata.

## Cosa è già pronto

- Manifest completo (`public/manifest.webmanifest`): nome, icone PNG 192/512, icona *maskable*, categoria finanza, scorciatoia "Nuovo movimento".
- Service worker: l'app si apre anche offline.
- Pagine pubbliche: [privacy](https://fig.vlabstudio.net/privacy.html) e [eliminazione account](https://fig.vlabstudio.net/delete-account.html).
- Eliminazione dell'account dall'app (Impostazioni → Elimina account).
- Uso senza account, **spento finché non lo attivi**: al lancio aggiungi `LOCAL_MODE=1` in `/opt/fig/.env` e riavvia il container (o chiedimelo). Testi della scheda e privacy lo danno per attivo.
- `/.well-known/assetlinks.json`: il server lo genera da `ANDROID_PACKAGE` e `ANDROID_CERT_SHA256` in `/opt/fig/.env` (vedi passo 4).
- Grafiche: `icon-512.png` (icona dello Store) e `feature-graphic-1024x500.png`; si rigenerano con `make-assets.mjs`.

## Passi (da fare tu)

### 1. Account sviluppatore

Registrati su [Play Console](https://play.google.com/console) (25 $ una tantum, verifica dell'identità). I nuovi account personali devono fare un **test chiuso con almeno 12 tester per 14 giorni** prima di poter pubblicare in produzione: tienine conto nei tempi ([regole attuali](https://support.google.com/googleplay/android-developer/answer/14151465)).

### 2. Creare il pacchetto Android con Bubblewrap

Serve Java 17 (già installato). Bubblewrap scarica da solo l'Android SDK.

```bash
npm install -g @bubblewrap/cli
mkdir fig-android && cd fig-android
bubblewrap init --manifest=https://fig.vlabstudio.net/manifest.webmanifest
```

Risposte consigliate:

| Domanda | Risposta |
|---|---|
| Domain | `fig.vlabstudio.net` |
| Application ID (package) | `net.vlabstudio.fig` (non si può più cambiare dopo la pubblicazione) |
| App name / Launcher name | `FIG` |
| Display mode | `standalone` |
| Status bar color / Splash color | `#F4EFE6` |
| Icon / Maskable icon | quelle proposte dal manifest |
| Signing key | crea una chiave nuova |

**La chiave di firma è tua**: scegli tu le password e conserva il file `.keystore` e le password in un posto sicuro (password manager + copia di backup). Senza la chiave non puoi più aggiornare l'app. Non va nel repository.

```bash
bubblewrap build
```

Produce `app-release-bundle.aab` (da caricare sullo Store) e `app-release-signed.apk` (da provare sul telefono).

### 3. Caricare sul Play Console

1. Crea l'app: nome **FIG**, lingua predefinita italiano, *App*, *Gratuita*.
2. Test → Test chiuso → crea un canale, carica l'`.aab`, aggiungi i tester (lista di email Google).
3. Accetta la **Firma dell'app di Google Play** (Play App Signing).

### 4. Collegare il sito all'app

Play Console → la tua app → Configurazione → **Integrità dell'app** → Firma dell'app: copia l'impronta **SHA-256** della chiave di firma dell'app (quella di Google) e anche quella della chiave di caricamento (la tua). Poi mandamele (non sono segrete) e le metto in `/opt/fig/.env`:

```
ANDROID_PACKAGE=net.vlabstudio.fig
ANDROID_CERT_SHA256=AA:BB:...,CC:DD:...
```

Verifica: https://fig.vlabstudio.net/.well-known/assetlinks.json deve mostrare il pacchetto e le impronte. Se manca, l'app si apre con la barra dell'indirizzo in alto.

### 5. Scheda dello Store

Testi pronti qui sotto; grafiche in questa cartella; screenshot in `screenshots/`.

- Categoria: **Finanza**. Tag: budget, spese.
- Email di contatto: delucamariano068@gmail.com
- Privacy: https://fig.vlabstudio.net/privacy.html
- Eliminazione account: https://fig.vlabstudio.net/delete-account.html
- Pubblico di destinazione: **18+** (evita gli obblighi delle app per minori).
- Pubblicità: **no**.

## Testi della scheda

### Italiano

**Nome:** FIG · budget personale

**Descrizione breve (max 80):**
Entrate, uscite e obiettivi che maturano come fichi. Anche senza account.

**Descrizione completa:**

FIG è il budget personale che si legge a colpo d'occhio.

Ogni mese è un ramo: le uscite sono foglie colorate per categoria, le entrate sono gemme. In alto vedi sempre quanto hai davvero a disposizione, quanti giorni mancano a fine mese e una previsione onesta di come ci arriverai.

• Inserimento in due tocchi: scegli la categoria, scrivi l'importo, fatto. Calcolatrice integrata.
• Obiettivi che maturano: una vacanza, un regalo, un fondo per gli imprevisti. Ogni obiettivo è un fico che si riempie man mano che metti da parte, con quanto serve al mese per arrivare in tempo.
• Spese ricorrenti: affitto, bollette e abbonamenti si aggiungono da soli.
• Statistiche chiare: dove sono andati i soldi, le spese di tutti i giorni, i costi fissi, il confronto con il mese scorso.
• Più conti e più valute, con cambio automatico.
• Allineamento del saldo: commissioni o differenze con la banca si sistemano in un attimo.
• Import CSV dalla tua banca ed export in CSV o backup.
• Tema chiaro e scuro, italiano e inglese.

Privacy prima di tutto: puoi usare FIG senza account, con i dati solo sul telefono. Se vuoi usarla su più dispositivi, accedi e i dati vengono sincronizzati su un server in Italia. Niente pubblicità, niente tracciamento, nessuna vendita di dati. Puoi esportare o eliminare tutto quando vuoi.

FIG non si collega alla tua banca e non dà consigli finanziari: ti aiuta a vedere con chiarezza dove vanno i tuoi soldi.

### English

**Name:** FIG · personal budget

**Short description (max 80):**
Income, expenses and goals that ripen like figs. No account needed.

**Full description:**

FIG is a personal budget you can read at a glance.

Each month is a branch: expenses are leaves coloured by category, income is a bud. At the top you always see what you really have available, how many days are left and an honest forecast of how the month will end.

• Add a transaction in two taps: pick the category, type the amount, done. Built-in calculator.
• Goals that ripen: a trip, a gift, a rainy-day fund. Each goal is a fig that fills up as you put money aside, with how much you need each month to get there on time.
• Recurring payments: rent, bills and subscriptions add themselves.
• Clear stats: where the money went, everyday spending, fixed costs, comparison with last month.
• Multiple accounts and currencies, with automatic exchange rates.
• Balance alignment: fees or differences with your bank, fixed in a moment.
• CSV import from your bank, CSV export and backups.
• Light and dark theme, English and Italian.

Privacy first: use FIG without an account and your data stays on your phone. If you want it on several devices, sign in and your data syncs to a server in Italy. No ads, no tracking, no selling data. Export or delete everything whenever you like.

FIG doesn't connect to your bank and doesn't give financial advice: it helps you see clearly where your money goes.

## Modulo "Sicurezza dei dati" (bozza)

Da ricontrollare al momento della compilazione, voce per voce.

| Domanda | Risposta |
|---|---|
| L'app raccoglie o condivide dati utente? | Sì (solo per chi usa l'account) |
| Dati crittografati in transito? | Sì (HTTPS) |
| Gli utenti possono chiedere l'eliminazione? | Sì, dall'app e da https://fig.vlabstudio.net/delete-account.html |
| Informazioni personali → Nome, Indirizzo email | Raccolti, non condivisi. Scopo: gestione dell'account. Facoltativi (l'app funziona senza account) |
| Informazioni finanziarie → Altre informazioni finanziarie | Raccolte, non condivise. Scopo: funzionalità dell'app. Facoltative |
| Attività nell'app, identificatori del dispositivo, posizione, contatti | Non raccolti |
| Dati condivisi con terze parti | Nessuno. Il servizio dei tassi di cambio riceve solo valute e data |
| Pubblicità / analisi | No |

**Dichiarazione delle funzionalità finanziarie:** FIG non offre conti, pagamenti, prestiti, investimenti né criptovalute e non si collega alle banche; è uno strumento di budget personale. Scegli la voce che corrisponde (probabilmente "nessuna delle funzionalità elencate") e, se c'è una casella libera, descrivila così.

**Classificazione dei contenuti:** questionario IARC; nessun contenuto violento, sessuale, gioco d'azzardo o acquisti. Risultato atteso: PEGI 3 / Everyone.

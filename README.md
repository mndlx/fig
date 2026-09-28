# FIG

Personal income and expense tracker. The month is a thread: income makes it thicker, expenses make it thinner. English and Italian.

App di entrate e uscite personale. Il mese è un filo: si ingrossa con le entrate, si assottiglia con le uscite. Inglese e italiano.

Live: https://fig.vlabstudio.net

## Cosa fa

- **Il filo**: il mese come un filo che si ingrossa con le entrate e si assottiglia con le uscite. Ogni conto parte da un nodo "Saldo iniziale" modificabile; le scadenze ricorrenti in arrivo compaiono attenuate.
- **Inserimento in due passi**: prima la categoria (o il gomitolo, o il conto), poi l'importo. Valute con cambio BCE, nota, data, "paga da un gomitolo", ripetizione settimanale, mensile o annuale.
- **La trama**: riepilogo del mese (speso, entrato, messo da parte, avanzato), calendario delle spese quotidiane, categorie con variazioni significative, spese fisse; vista anno.
- **Gomitoli**: obiettivi di risparmio con scadenza facoltativa. Stato "in linea / in ritardo" calcolato sul ritmo degli ultimi tre mesi, accantonamento automatico, spesa dal gomitolo senza toccare il disponibile.
- **Impostazioni**: lingua, account e sincronizzazione, categorie con icone, conti, valute, ricorrenti, import CSV degli estratti conto, export e backup.

## Come è fatta

```
Browser (React + Vite, PWA)          Server (Node + Express)          Keycloak
  IndexedDB (Dexie) ── coda ──►  POST /api/sync  ── SQLite            identity.vlabstudio.net
        ▲                          verifica JWT ◄──── chiavi JWKS ─── realm virtual-systems
        └──── modifiche da altri dispositivi ◄──┘                     client "fig"
```

- **Local-first**: l'app scrive sempre nel database del browser e funziona anche offline. Ogni modifica va in una coda e viene inviata al server; il server risponde con ciò che è cambiato sugli altri dispositivi (vince l'ultima scrittura).
- **Accesso**: lo gestisce il server (backend for frontend). `/auth/login` porta a Keycloak (authorization code + PKCE, client confidenziale con secret), `/auth/callback` crea una sessione e il browser riceve solo un cookie HttpOnly. Nessun token nel JavaScript.
- **Database**: SQLite (`better-sqlite3`), un record JSON per ogni oggetto dell'app e utente, con un numero di revisione per la sincronizzazione.
- **Lingue**: `src/i18n.ts`. L'app segue la lingua del dispositivo e si cambia in Impostazioni. Ogni chiave deve esistere in entrambe le lingue, altrimenti la build fallisce.

## Sviluppo

```bash
npm install
npm --prefix server install
```

In due terminali:

```bash
npm --prefix server run dev
```

```bash
npm run dev
```

Il frontend (http://localhost:5174, porta registrata su Keycloak) inoltra `/api` e `/auth` al server (porta 8787).

### Configurazione (.env)

Tutta la configurazione sta nel server; il frontend non ne ha. Copia `server/.env.example` in:

- `server/.env` per lo sviluppo, con `PUBLIC_URL=http://localhost:5174`
- `/opt/fig/.env` sulla VPS, con `PUBLIC_URL=https://fig.vlabstudio.net`

In entrambi va compilato `OIDC_CLIENT_SECRET` (Keycloak → realm virtual-systems → Clients → fig → Credentials). I file `.env` non vanno mai nel repository.

Per lavorare senza login: `AUTH_DISABLED=1` in `server/.env`.

## Pubblicazione

Un'unica immagine Docker con frontend compilato, API e SQLite (volume `fig-data`).

```bash
bash scripts/deploy.sh
```

Copia i file del repository su `root@31.14.134.70:/opt/fig` e lancia `docker compose up -d --build`. Il container ascolta solo su `127.0.0.1:8096`; nginx sull'host gestisce HTTPS per `fig.vlabstudio.net` (certificato Let's Encrypt via certbot).

In Keycloak, client `fig` (Client authentication: On):

- Valid redirect URIs: `https://fig.vlabstudio.net/auth/callback`, `http://localhost:5174/auth/callback`
- Valid post logout redirect URIs: `https://fig.vlabstudio.net/`, `http://localhost:5174/`

## Struttura

| Percorso | Cosa contiene |
|---|---|
| `src/App.tsx` | Struttura, calcoli del mese, card principale |
| `src/ThreadView.tsx` | Il filo |
| `src/AddSheet.tsx` | Inserimento di uscite, entrate, gomitoli e giroconti |
| `src/Trama.tsx` | La trama (analisi del mese e dell'anno) |
| `src/Goals.tsx` | Gomitoli (obiettivi di risparmio) |
| `src/Settings.tsx` | Impostazioni, account, lingua |
| `src/ImportCsv.tsx`, `src/csv.ts` | Import degli estratti conto |
| `src/db.ts`, `src/data.ts` | Database locale e lettura dei dati |
| `src/sync.ts`, `src/auth.ts` | Sincronizzazione e accesso |
| `src/i18n.ts` | Traduzioni inglese e italiano |
| `server/src` | API, verifica dei token, SQLite |
| `docs/` | Concept e ricerche di mercato |

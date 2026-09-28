# FIG

Personal income and expense tracker. The month is a thread: income makes it thicker, expenses make it thinner. English and Italian.

App di entrate e uscite personale. Il mese è un filo: si ingrossa con le entrate, si assottiglia con le uscite. Inglese e italiano.

Live: https://fig.vlabstudio.net

## Come è fatta

```
Browser (React + Vite, PWA)          Server (Node + Express)          Keycloak
  IndexedDB (Dexie) ── coda ──►  POST /api/sync  ── SQLite            identity.vlabstudio.net
        ▲                          verifica JWT ◄──── chiavi JWKS ─── realm virtual-systems
        └──── modifiche da altri dispositivi ◄──┘                     client "fig"
```

- **Local-first**: l'app scrive sempre nel database del browser e funziona anche offline. Ogni modifica va in una coda e viene inviata al server; il server risponde con ciò che è cambiato sugli altri dispositivi (vince l'ultima scrittura).
- **Accesso**: Keycloak con authorization code + PKCE (`keycloak-js`). Il server accetta solo token del realm `virtual-systems` emessi per il client `fig`.
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

Il frontend (http://localhost:5173) inoltra `/api` al server (porta 8787). Il server legge `server/.env` (vedi `server/.env.example`).

Per lavorare senza login: `AUTH_DISABLED=1` in `server/.env` e `VITE_AUTH_DISABLED=1` per Vite.

## Pubblicazione

Un'unica immagine Docker con frontend compilato, API e SQLite (volume `fig-data`).

```bash
bash scripts/deploy.sh
```

Copia i file del repository su `root@31.14.134.70:/opt/fig` e lancia `docker compose up -d --build`. Il container ascolta solo su `127.0.0.1:8096`; nginx sull'host gestisce HTTPS per `fig.vlabstudio.net` (certificato Let's Encrypt via certbot).

In Keycloak, client `fig`: tra i Valid redirect URIs servono `https://fig.vlabstudio.net/*` e, per lo sviluppo, `http://localhost:5173/*`; tra i Web origins `https://fig.vlabstudio.net` e `http://localhost:5173`.

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

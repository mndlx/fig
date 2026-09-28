# FIG: concept

> Stato al 28/09/2026: prima versione completa nella cartella `fig/` (filo, inserimento, trama, gomitoli, impostazioni, import CSV, backup). Il nome dell'app è FIG; "il filo" resta la metafora visiva.

## Gomitoli (obiettivi di risparmio)

- Un gomitolo è un obiettivo: nome, cifra e scadenza facoltative, colore.
- **Metti da parte**: i soldi escono dal disponibile e si avvolgono nel gomitolo (il filo si assottiglia). Restano fisicamente sul conto: è un accantonamento.
- **Spendi da qui**: una spesa pagata dal gomitolo è una spesa vera (compare nella trama) ma non tocca il disponibile.
- **Riprendi**: i soldi tornano nel disponibile.
- Con una scadenza, l'app indica quanto serve al mese per arrivarci.

App personale per tenere traccia di entrate e uscite. Uso: una sola persona (io), da telefono e all'occorrenza da PC. Stesse funzioni di base di un tracker come Monefy, ma con un'interfaccia originale costruita sul nome: il filo.

## Principi

- **Inserire una spesa in 3 secondi.** Scrivi l'importo, tocchi la categoria, fatto. Tutto il resto è facoltativo.
- **Vedere i soldi come un filo che si consuma.** Niente torta: il mese è un filo che si assottiglia a ogni spesa e si ingrossa a ogni entrata.
- **I dati sono miei.** Nessun collegamento alla banca, nessun servizio esterno obbligatorio, esportazione sempre possibile.

## Idea di interfaccia

### Il filo (schermata principale)
- In alto la domanda che conta: **quanto mi resta** fino alla prossima entrata ricorrente (es. lo stipendio), o fino a fine periodo se non c'è.
- Sotto, il mese è un **filo verticale**. Ogni movimento è un **nodo** colorato come la sua categoria, grande in proporzione all'importo. Lo spessore del filo è il saldo disponibile in quel momento: dopo l'affitto il filo si assottiglia visibilmente.
- La parte finale è **tratteggiata**: la previsione di fine mese in base al ritmo di spesa attuale.
- Scorrendo si va indietro nel tempo; toccando un nodo si apre il movimento.
- Un unico pulsante **+** in basso.

### Annoda (inserimento)
- Si parte dall'**importo**, con un tastierino grande. Il segno decide il tipo (uscita di default, un tocco per passare a entrata o trasferimento).
- Sotto, **3-4 categorie suggerite** in base alle abitudini: ora del giorno, giorno della settimana, ultime usate ("Di solito a quest'ora: Pranzo, Caffè"). Le altre dietro "Altro".
- **Toccare la categoria salva**: nessun pulsante di conferma.
- Conto, data, nota e valuta sono in una riga compatta già precompilata; si toccano solo se servono.

### La trama (analisi)
- Il mese come **tessuto**: una griglia a calendario (settimane × giorni) dove ogni giorno è una piccola striscia di fili colorati, uno per ogni spesa.
- Sotto, la legenda con le categorie e una barra per importo.
- **Toccando una categoria** si evidenzia solo il suo filo nel tessuto: si vede subito se ristoranti e svago si concentrano nei weekend.
- Vista anno: 12 piccoli tessuti affiancati.

### Stile visivo
- Fondo chiaro caldo tipo carta, testo color inchiostro; in modalità scura fondo blu notte.
- Cifre importanti in un carattere serif elegante, interfaccia in un sans pulito.
- Colori delle categorie come matasse di lana: toni pieni ma non fluo, scelti da una palette fissa che resta leggibile sia in chiaro sia in scuro.
- Animazioni brevi e fisiche: il nodo che scende sul filo quando salvi, il filo che si assottiglia.

## Fuori dalla prima versione

- Tutta la parte fiscale e normativa (detrazioni, fondo pensione, tasse).
- Collegamento automatico alla banca (open banking).
- Più utenti, condivisione, versione commerciale.

## Funzioni della prima versione

### 1. Movimenti
- Tre tipi: **uscita**, **entrata**, **trasferimento** tra conti (es. da conto corrente a contanti; non conta come spesa).
- Campi: importo, tipo, categoria, conto, data (oggi di default), nota facoltativa.
- Modifica ed eliminazione di un movimento.
- Ricerca per nota o importo, filtro per categoria e conto.

### 2. Categorie (personalizzabili)
- Categorie separate per uscite ed entrate, ognuna con nome, icona e colore.
- Posso crearle, rinominarle, riordinarle e archiviarle (le archiviate spariscono dall'inserimento ma restano nello storico).
- Set iniziale proposto, modificabile:
  - Uscite: Spesa alimentare, Casa, Bollette, Trasporti, Auto, Ristoranti, Salute, Abbigliamento, Svago, Abbonamenti, Regali, Altro
  - Entrate: Stipendio, Extra, Rimborsi, Altro
- Sottocategorie: da decidere (vedi domande aperte).

### 3. Conti
- Più conti (es. Conto corrente, Carta, Contanti, Risparmi), ognuno con saldo iniziale.
- Saldo di ogni conto calcolato dai movimenti; saldo totale in alto.

### 4. Schermate principali
- **Il filo**, **Annoda** e **La trama**, come descritte in "Idea di interfaccia".
- Selettore del periodo: settimana, **mese** (predefinito), anno, intervallo personalizzato.

### 4b. Valute
- **Valuta principale** scelta nelle impostazioni (es. EUR): tutti i totali e i grafici sono espressi in quella.
- **Ogni conto ha la sua valuta** (es. un conto in USD, contanti in GBP durante un viaggio).
- Si può anche inserire un singolo movimento in un'altra valuta: l'app salva l'importo originale e il controvalore nella valuta principale.
- **Cambio**: preso in automatico dai tassi della BCE del giorno del movimento, quando c'è connessione; sempre modificabile a mano (es. per usare il cambio reale della carta).
- Posso aggiungere valute personalizzate (codice, simbolo, decimali).

### 5. Elenco movimenti
- Lista cronologica raggruppata per giorno, con totale giornaliero.
- Stessi filtri del periodo della schermata principale.

### 6. Import CSV dall'estratto conto
- Carico il file CSV esportato dall'home banking.
- Gestione dei formati italiani: separatore `;`, virgola decimale (`1.234,56`), date `gg/mm/aaaa`, importi con segno o colonne Dare/Avere separate.
- Mappatura delle colonne la prima volta (data, descrizione, importo), salvata come profilo per banca così non va rifatta.
- Anteprima prima di confermare: per ogni riga scelgo o confermo la categoria.
- **Regole automatiche**: "se la descrizione contiene ESSELUNGA → Spesa alimentare". Le regole si creano dall'anteprima e si applicano agli import successivi.
- **Anti-duplicati**: segnala le righe già presenti (stessa data, importo e descrizione) o già inserite a mano.

### 7. Backup
- Esportazione di tutti i dati in CSV (per Excel) e in JSON (backup completo).
- Ripristino da JSON.

## Seconda versione (idee, non ora)

- Budget mensile per categoria con barra di avanzamento e avviso quando lo superi.
- Movimenti ricorrenti (affitto, abbonamenti, stipendio) generati in automatico.
- Grafico dell'andamento mese per mese e confronto con il mese precedente.
- Obiettivi di risparmio.
- Tag liberi (es. "vacanza Sicilia") trasversali alle categorie.

## Come è fatta (proposta tecnica)

- **Web app installabile (PWA)**: si apre dal browser del telefono, si aggiunge alla home e funziona come un'app, anche offline. Nessun App Store.
- **Interfaccia**: React + TypeScript + Vite, pensata prima per lo schermo del telefono.
- **Dati**: salvati nel browser del telefono (IndexedDB) nella prima versione. Nessun server, costo zero.
- **Pubblicazione**: hosting statico gratuito (es. Vercel o GitHub Pages).
- **Importi** salvati in centesimi (numeri interi) per evitare errori di arrotondamento.

### Modello dati

| Entità | Campi principali |
|---|---|
| Valuta | codice, simbolo, decimali, principale (sì/no) |
| Conto | id, nome, valuta, saldo iniziale, colore, archiviato |
| Categoria | id, nome, tipo (entrata/uscita), icona, colore, ordine, archiviata, categoria padre (se sottocategorie) |
| Movimento | id, tipo, importo in centesimi, valuta, cambio, controvalore nella valuta principale, data e ora, categoria, conto, conto di destinazione (solo trasferimenti), nota, origine (manuale/import), id import |
| Regola | id, testo da cercare, categoria |
| Profilo import | id, nome banca, mappatura colonne, separatore, formato data |

## Domande aperte

1. **Telefono e PC insieme?** Con i dati salvati solo nel browser, telefono e PC hanno archivi separati. Opzioni: (a) uso solo il telefono e dal PC faccio import/backup; (b) aggiungo un piccolo database online con login (es. Supabase, gratuito a questi volumi) per avere gli stessi dati ovunque.
2. **Sottocategorie** (es. Casa → Affitto, Manutenzione): servono subito o bastano le categorie?
3. **Da quale banca** esporti il CSV? Con un file di esempio (anche con dati finti) preparo il profilo di import già pronto.

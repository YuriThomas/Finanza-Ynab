# Finanza Personale

App di finanza personale (stile YNAB) in React + Vite: dashboard con report multipli (patrimonio netto e composizione, entrate/uscite, spese per categoria, entrate per fonte, risparmio ed età del denaro), budget mensile con obiettivi per categoria, movimenti, conti e categorie.

I dati (conti, movimenti, categorie, budget) sono salvati **nel cloud su Supabase**, in una riga per utente autenticato — non in `localStorage`. Accedendo da un altro dispositivo con le stesse credenziali si ritrovano gli stessi dati. Nel browser locale restano solo un paio di preferenze non sensibili (l'ultima email usata per il login, e se la modalità privacy è attiva).

### Funzionalità principali

- **Dashboard**: patrimonio netto nel tempo + composizione per tipo di conto, entrate vs uscite mensili, spese per categoria, entrate per fonte, tasso di risparmio ed età del denaro. Filtri per periodo (1M/3M/6M/1A/YTD/Tutto/Personalizzato) e per conto.
- **Budget mensile**: assegna importi alle categorie con calcolo di "Pronto per assegnare" e riporto dei saldi al mese successivo (i saldi positivi si riportano, quelli negativi si chiudono e riducono il pronto per assegnare). Su smartphone l'assegnazione avviene con un tastierino a comparsa (Auto-Assegna, Sposta fondi, Dettagli storico).
- **Obiettivi per categoria**: mensile, settimanale, annuale o personalizzato con scadenza, dalla pagina di dettaglio di ogni categoria (raggiungibile toccando/cliccando il suo nome nel Budget).
- **Sposta fondi**: schermata dedicata con ricerca per spostare denaro tra categorie o verso/da "Pronto per assegnare".
- **Movimenti, Conti, Categorie**: gestione completa con filtri, categorie raggruppabili, categorie nascondibili (restano nello storico ma escono dal budget attivo).
- **Modalità privacy**: icona a occhio per oscurare i valori di patrimonio (sidebar, dashboard, conti) quando si condivide lo schermo.
- **Tema chiaro/scuro**, navigazione a barra inferiore su smartphone e barra laterale su desktop.

## Struttura del progetto

```
├── index.html              punto di ingresso HTML per Vite
├── vite.config.js          config Vite (contiene il `base` path per GitHub Pages)
├── package.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx             monta <App /> nel DOM
    ├── App.jsx              tutta l'app: stato, logica, calcoli, chiamate a Supabase e JSX
    └── index.css            stili globali, font, animazioni
```

Tutta la logica (autenticazione, store dati, calcoli dei report, gestione modali, ecc.) e il markup vivono in `src/App.jsx` come un unico componente React a classe. Le dipendenze runtime sono `react`, `react-dom` e `@supabase/supabase-js`.

## Supabase: configurazione necessaria

L'app richiede un progetto Supabase con:

1. **Autenticazione email/password** attiva (Authentication → Providers → Email). Non c'è un flusso di registrazione nell'app: gli utenti vanno creati da Supabase (Authentication → Users → Add user) o invitati via email.
2. Una tabella `user_finance_store` con almeno queste colonne:

   | colonna      | tipo        | note                              |
   |--------------|-------------|------------------------------------|
   | `user_id`    | `uuid`      | chiave, riferimento a `auth.users` |
   | `data`       | `jsonb`     | l'intero stato dell'app dell'utente |
   | `updated_at` | `timestamptz` | aggiornato ad ogni salvataggio    |

3. **Row Level Security (RLS) attiva** sulla tabella, con policy che permettono a ogni utente autenticato di leggere e scrivere **solo** la riga con `user_id = auth.uid()`. Senza RLS configurata correttamente, un utente potrebbe leggere o sovrascrivere i dati di un altro.

Al primo accesso di un utente senza righe esistenti, l'app crea automaticamente i dati demo iniziali (conti, categorie e movimenti di esempio) e li salva sulla sua riga.

### Variabili d'ambiente

L'app legge due variabili d'ambiente Vite (devono essere disponibili **al momento della build**, non solo a runtime):

```
VITE_SUPABASE_URL=https://<tuo-progetto>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<chiave-pubblica-anon>
```

Per lo sviluppo locale, crea un file `.env` nella radice del progetto con queste due righe (il file è normalmente escluso da Git). Per la build in CI (GitHub Actions), vanno aggiunte come **secrets** del repository — vedi sotto.

## Sviluppo locale

Richiede [Node.js](https://nodejs.org/) 18 o superiore.

```
npm install
npm run dev
```

Apri l'indirizzo mostrato in console (di norma `http://localhost:5173`). Senza un file `.env` con le variabili Supabase valide, il login non funzionerà.

## Build di produzione

```
npm run build
```

Genera i file statici in `dist/`. Per verificarli localmente prima del deploy:

```
npm run preview
```

## Deploy su GitHub Pages

Prima di tutto, verifica il valore di `base` in `vite.config.js`:

- Se il sito verrà pubblicato come project page, cioè all'indirizzo `https://<tuo-utente>.github.io/<nome-repo>/`, imposta:

  ```
  base: '/<nome-repo>/'
  ```

  (è già preimpostato su `/Finanza-Ynab/` — cambialo se il tuo repository si chiama diversamente).

- Se il sito verrà pubblicato come user/organization page, cioè il repository si chiama esattamente `<tuo-utente>.github.io` e il sito vive alla radice del dominio, imposta:

  ```
  base: '/'
  ```

Un `base` sbagliato è la causa più comune di una pagina bianca dopo il deploy: il browser cerca i file JS/CSS nel posto sbagliato.

### Opzione A — Deploy automatico con GitHub Actions (consigliata)

Il progetto include già `.github/workflows/deploy.yml`: ogni push sul branch `main` builda l'app e la pubblica automaticamente su GitHub Pages.

1. Crea un nuovo repository su GitHub e caricaci questo progetto (via `git push` o trascinando i file dall'interfaccia web).
2. Nel repository, vai su **Settings → Secrets and variables → Actions** e aggiungi due secrets:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`

   (senza questi, la build in CI produce un sito che non riesce a fare login). Se il workflow non li passa già come variabili d'ambiente allo step di build, aggiungi in `deploy.yml`, allo step `npm run build`, un blocco `env:` che li legga da `${{ secrets.VITE_SUPABASE_URL }}` e `${{ secrets.VITE_SUPABASE_PUBLISHABLE_KEY }}`.
3. Nel repository, vai su **Settings → Pages**.
4. Alla voce **Source**, seleziona **GitHub Actions** (non "Deploy from a branch").
5. Fai un push sul branch `main` (o lancia manualmente il workflow da Actions → Deploy to GitHub Pages → Run workflow).
6. Dopo un paio di minuti il sito sarà live all'indirizzo mostrato in Settings → Pages.

Da questo momento, ogni volta che modifichi il codice e fai push su `main`, il sito si aggiorna automaticamente.

### Opzione B — Deploy manuale con `gh-pages`

Alternativa se preferisci non usare GitHub Actions:

```
npm run deploy
```

Questo comando (pacchetto `gh-pages`, già incluso nelle devDependencies) builda il progetto — leggendo le variabili `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` dal tuo `.env` locale — e pubblica il contenuto di `dist/` sul branch `gh-pages` del repository. Dopo il primo deploy, vai su **Settings → Pages** e imposta come sorgente il branch `gh-pages` (cartella `/root`).

## Note

- I dati finanziari **non** sono in `localStorage`: vivono su Supabase, in `user_finance_store`, una riga JSON per utente. Nel browser restano solo l'ultima email usata per il login (se si sceglie "ricordami") e la preferenza per la modalità privacy — nessun dato finanziario.
- Il pulsante "Azzera tutte le assegnazioni" (nella pagina Budget) azzera solo gli importi assegnati alle categorie, in tutti i mesi: non tocca conti, movimenti o categorie.
- I font (Hanken Grotesk, JetBrains Mono) sono caricati da Google Fonts in `src/index.css`. Se preferisci non dipendere da una CDN esterna, puoi scaricare i file `.woff2` e sostituire la riga `@import` con delle regole `@font-face` locali.
- Se il login sembra non funzionare dopo il deploy, controlla prima le variabili d'ambiente Supabase (punto più comune di errore) e poi le policy RLS sulla tabella `user_finance_store`.

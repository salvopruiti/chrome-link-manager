# Link Manager

Estensione Chrome Manifest V3 per salvare link in un database locale dell'estensione e promuoverli nei preferiti di Chrome.

## Funzioni principali

- Shift+Click su un link: il link viene salvato nel database locale invece di essere aperto.
- Deduplica URL: ignora sempre il frammento `#...` e può ignorare parametri query configurabili per dominio.
- Mini barra comprimibile in pagina: lista dei link salvati, apertura, rimozione, apertura casuale, salvataggio di tutte le schede aperte.
- Popup dell'estensione: ricerca rapida dei link salvati con apertura in nuova scheda, rimozione e promozione ai preferiti.
- Promozione ai preferiti di Chrome: un pulsante sposta il link dal database locale alla cartella preferiti configurata.
- Accesso con magic link Supabase e sincronizzazione manuale del database link tra dispositivi.

## Struttura

- `manifest.json`: configurazione estensione MV3.
- `src/background.js`: storage, normalizzazione URL, integrazione con bookmarks e tabs.
- `src/supabase-config.js`: configurazione interna del progetto Supabase usato da auth e sync.
- `src/auth-callback.html` + `src/auth-callback.js`: callback del magic link per completare la sessione Supabase.
- `src/content.js`: intercettazione Shift+Click e mini barra in pagina.
- `src/popup.html` + `src/popup.js`: popup dell'azione con ricerca rapida nei link salvati.
- `src/options.html` + `src/options.js`: configurazione cartella preferiti, regole query per sito, login magic link e sync manuale.
- `src/options.html` + `src/options.js`: configurazione cartella preferiti, regole query per sito e credenziali Supabase.

## Installazione locale

1. Apri `chrome://extensions`.
2. Abilita `Developer mode`.
3. Clicca `Load unpacked`.
4. Seleziona la cartella del progetto.

## Uso

1. Apri la pagina opzioni dell'estensione e imposta il nome della cartella preferiti.
2. Clicca `Crea/Trova cartella` per memorizzare la cartella sulla barra dei preferiti.
3. Inserisci la tua email nella sezione `Account e Sync` e invia il magic link.
4. Apri il link ricevuto via email per completare l'accesso.
5. Usa `Sincronizza ora` per allineare il database locale con Supabase.
6. Naviga su un sito e usa Shift+Click su un link per salvarlo.
7. Apri la mini barra in basso a destra per gestire i link.
8. Clicca l'icona dell'estensione per cercare rapidamente un link salvato dal popup.

## Note tecniche

- I dati vengono salvati in `chrome.storage.local`.
- Le impostazioni utente vengono salvate in `chrome.storage.sync`, mentre `bookmarkFolderId`, la sessione auth e il database dei link restano locali.
- Per il magic link devi aggiungere `chrome-extension://<EXTENSION_ID>/src/auth-callback.html` tra i redirect URL consentiti nelle impostazioni Auth di Supabase.
- Lo schema iniziale Supabase per la tabella `links` e le policy RLS e in `supabase/schema.sql`.
- Se una cartella preferiti configurata viene eliminata, l'estensione ne crea una nuova alla successiva promozione.
- Le regole wildcard supportano il formato `*.dominio.tld`.

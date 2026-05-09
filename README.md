# Link Manager

Estensione Chrome Manifest V3 per salvare link in un database locale dell'estensione e promuoverli nei preferiti di Chrome.

## Funzioni principali

- Shift+Click su un link: il link viene salvato nel database locale invece di essere aperto.
- Deduplica URL: ignora sempre il frammento `#...` e può ignorare parametri query configurabili per dominio.
- Mini barra comprimibile in pagina: lista dei link salvati, apertura, rimozione, apertura casuale, salvataggio di tutte le schede aperte.
- Promozione ai preferiti di Chrome: un pulsante sposta il link dal database locale alla cartella preferiti configurata.

## Struttura

- `manifest.json`: configurazione estensione MV3.
- `src/background.js`: storage, normalizzazione URL, integrazione con bookmarks e tabs.
- `src/content.js`: intercettazione Shift+Click e mini barra in pagina.
- `src/options.html` + `src/options.js`: configurazione cartella preferiti e regole query per sito.

## Installazione locale

1. Apri `chrome://extensions`.
2. Abilita `Developer mode`.
3. Clicca `Load unpacked`.
4. Seleziona la cartella del progetto.

## Uso

1. Apri la pagina opzioni dell'estensione e imposta il nome della cartella preferiti.
2. Clicca `Crea/Trova cartella` per memorizzare la cartella sulla barra dei preferiti.
3. Naviga su un sito e usa Shift+Click su un link per salvarlo.
4. Apri la mini barra in basso a destra per gestire i link.

## Note tecniche

- I dati vengono salvati in `chrome.storage.local`.
- Se una cartella preferiti configurata viene eliminata, l'estensione ne crea una nuova alla successiva promozione.
- Le regole wildcard supportano il formato `*.dominio.tld`.

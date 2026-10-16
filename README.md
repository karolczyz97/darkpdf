# DarkPDF

Minimalny czytnik PDF: dwie strony obok siebie, tryb ciemny, kalkulator z boku.
Działa jako strona na GitHub Pages (https://karolczyz97.github.io/darkpdf/), także offline.

## Praca lokalna

Kalkulator pochodzi z repo [calc](https://github.com/karolczyz97/calc) – sklonuj je obok, tak jak na GitHub Pages:

```
…/darkpdf
…/calc
```

```
npm ci        # zależności narzędzi i dokładne wersje z package-lock.json
npm start     # http://localhost:8080/darkpdf/ (i /calc/)
npm test      # testy jednostkowe i test prawdziwej przeglądarki (Node 22.13+)
npm run lint
npm run test:unit
npm run test:browser
```

Test przeglądarkowy używa osobnego, tymczasowego profilu. Chrome/Edge jest wykrywany na Windows,
Chromium/Chrome również na Linux/macOS; inną lokalizację wskaż przez `CHROME_PATH`.

## Pliki

| Plik | Co robi |
|---|---|
| `viewer.js` | stan dokumentu, renderowanie stron i koordynacja modułów |
| `layout.js` | czysta geometria: rozkładówki i skala strony (testowana) |
| `library.js` | ostatnio otwierane pliki (IndexedDB) i zakładki |
| `doc-loader.js` | otwieranie i anulowanie dokumentów, hasła, ekran startowy |
| `doc-url.js` | wspólny zapis i odczyt adresów PDF |
| `extension-loader.js` | pobieranie przez wtyczkę, identyfikatory i timeouty |
| `calc-panel.js` | panel kalkulatora i rozdzielacz |
| `util.js` | ustawienia w localStorage, pamięć LRU |
| `sw.js` | pamięć podręczna do pracy offline |
| `lib/pdfjs` | pdf.js 4.10.38 (bez zmian) |

Po wdrożeniu nie trzeba podbijać numerów `?v=` – `sw.js` zawsze sprawdza na serwerze, czy plik się zmienił.
Przy wolnej sieci po dwóch sekundach korzysta z cache, jeśli zapisano daną odpowiedź.
Workery czytnika i kalkulatora usuwają tylko własne stare cache.

Motyw Gemini używa wspólnych kolorów i promieni z `theme.css` oraz lokalnego Google Sans Flex
(polskie znaki, licencja SIL OFL w `fonts/OFL.txt`). Font jest zapisywany także do pracy offline.
Tło paneli, ich zewnętrzne zaokrąglenia i dopasowanie odwróconego PDF-a do tła są niezależne od stylu kontrolek.

Lokalne PDF-y są identyfikowane przez SHA-256 zawartości. Dawne wpisy oparte na nazwie i rozmiarze
są migrowane wraz z ustawieniami i zakładkami tylko po potwierdzeniu zgodności zawartości.
Zapis i usuwanie nadmiarowych wpisów historii odbywają się w jednej transakcji.
Powrót na ekran główny natychmiast anuluje otwieranie i zastępuje bieżący adres adresem startowym.
Escape działa także podczas otwierania pierwszego dokumentu. Odczyty z historii i zakładek
należą do tego samego żądania otwarcia, więc spóźniony wynik nie przywraca opuszczonego dokumentu.

## Komunikacja z wtyczką

Czytnik wysyła `{ source: 'zen-page', type: 'load', url, requestId }`.
Wtyczka powinna zwrócić ten sam `requestId` w każdym komunikacie `progress`, `data` i `error`:

```js
window.postMessage({ source: 'zen-ext', type: 'data', requestId, buffer }, location.origin);
```

Pobrania są wykonywane kolejno. Brak pierwszej odpowiedzi kończy próbę po trzech sekundach;
każdy komunikat postępu odnawia trzydziestosekundowy limit bezczynności.
Anulowanie usuwa odbiornik i timeout. Dawna wtyczka bez `requestId` nadal obsługuje zwykłe pobranie,
ale po anulowaniu lub timeoutcie trzeba odświeżyć czytnik, aby ponownie użyć starego protokołu.
Chroni to przed przyjęciem spóźnionych danych innego dokumentu. Kod wtyczki nie znajduje się w tym repo.

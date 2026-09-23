# DarkPDF

Minimalny czytnik PDF: dwie strony obok siebie, tryb ciemny, przycinanie marginesów, kalkulator z boku.
Działa jako strona na GitHub Pages (https://karolczyz97.github.io/darkpdf/), także offline.

## Praca lokalna

Kalkulator pochodzi z repo [calc](https://github.com/karolczyz97/calc) – sklonuj je obok, tak jak na GitHub Pages:

```
…/darkpdf
…/calc
```

```
npm start     # http://localhost:8080/darkpdf/ (i /calc/)
npm test      # testy geometrii czytnika (Node 20+)
```

## Pliki

| Plik | Co robi |
|---|---|
| `viewer.js` | stan dokumentu, renderowanie stron, otwieranie plików, menu, klawisze i gesty |
| `layout.js` | czysta geometria: rozkładówki, skala, wspólne przycięcie marginesów (testowana) |
| `crop.js` | wykrywanie marginesów na miniaturach stron |
| `library.js` | ostatnio otwierane pliki (IndexedDB) i zakładki |
| `calc-panel.js` | panel kalkulatora i rozdzielacz |
| `util.js` | ustawienia w localStorage, pamięć LRU |
| `sw.js` | pamięć podręczna do pracy offline |
| `lib/pdfjs` | pdf.js 4.10.38 (bez zmian) |

Po wdrożeniu nie trzeba podbijać numerów `?v=` – `sw.js` zawsze sprawdza na serwerze, czy plik się zmienił.

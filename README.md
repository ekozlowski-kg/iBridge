# EZD – iBridge 0.6.2 — wersja testowa

## Powiadomienia w samym iBridge

W Ustawieniach otwórz „Zaloguj do EZD”, zaloguj się w oknie iBridge i włącz powiadomienia. Aplikacja sprawdza folder Nowe oraz istniejący strumień powiadomień EZD co 60 sekund. Po zamknięciu okna iBridge pozostaje w pasku menu. Brave ani inna zewnętrzna przeglądarka nie są potrzebne.

Pierwszy kompletny odczyt tworzy cichy stan początkowy. Kolejne odczyty porównują identyfikatory koszulek i daty przekazania oraz identyfikatory zdarzeń. Konto, zastępstwo, jednostka i stanowisko są rozdzielane; zmiana kontekstu wymaga wybrania „Użyj bieżącego konta”. Alerty nie otwierają automatycznie pism ani nie odrzucają powiadomień w EZD. Sesja w osobnej partycji aplikacji nie jest kopiowana z przeglądarki. Po wygaśnięciu sesji trzeba ponownie zalogować się do EZD w iBridge.

Kontrakt odczytu ustalono na podstawie `foldery.controller.js`, szablonu `FolderPism.aspx` i `powiadomienia.controllers.js` z instalacji KG PSP 3.136.31.31. Nie jest to obietnica zgodności z innymi wersjami EZD. Testy automatyczne korzystają z odpowiedzi syntetycznych. Odbiór działania po zalogowaniu do rzeczywistego serwera pozostaje do wykonania; szczegóły: `docs/POWIADOMIENIA.txt`.

Aplikacja macOS do edycji i automatycznej synchronizacji dokumentów EZD PUW.
Okno statusu ma **340 × 360 px**. Szczegóły, sprawy i historia otwierają większy
widok dopiero na żądanie. Wywołanie edycji z EZD otwiera tylko edytor.

## Zmiany w 0.6.1

- Wysyłanie każdego stabilnego zapisu w tle, kolejka per sesja i kontrola pliku
  co 5 sekund. Po błędach przejściowych ponowienia po 5, 15, 30 i co 60 sekund.
- Microsoft Word: obserwacja konkretnego dokumentu przez Apple Events. Dopiero
  po zaobserwowaniu otwarcia i dwóch odczytach bez dokumentu sesja może zostać
  zakończona. Odmowa Automatyzacji i inne edytory korzystają z awaryjnej akcji
  „Zakończ edycję” w pasku menu; wysyłanie pozostaje automatyczne.
- Końcowe opróżnienie kolejki, sprawdzenie zawartości i oddzielne zakończenie
  sesji. Potwierdzonego pliku nie wysyłamy ponownie z powodu błędu zakończenia.
- Poprawione równoczesne importy i serializowane, spójne bajtowo wersje plików.
- Sprawy → dokumenty po identyfikatorach EZD; wcześniejsze otwarcia są w historii.
  Nigdy nie łączymy różnych dokumentów wyłącznie po nazwie pliku.
- Restart rozróżnia historyczne potwierdzenie wysłania od aktywnej sesji.
  Tokeny EZD nie są utrwalane. Pliki i niewysłane zmiany pozostają lokalnie.
- Ostrzeżenie przed wyjściem z niewysłanymi zmianami lub otwartymi sesjami.
- Sprawdzanie stabilnych GitHub Releases przy starcie i raz dziennie; ręczna
  kontrola w ustawieniach. Pobranie wydania otwiera stronę GitHub.

## Pełna lista konta EZD — potrzebna odrębna integracja

Sprawdzony kontrakt `EzdProxy.svc?wsdl` zawiera operacje dodatku, m.in.
`AddInSprawdzDane`, `AddInDownloadFile`, `AddInUploadFile` i
`AddInZakonczSesje`. Nie zawiera listowania wszystkich spraw i dokumentów
użytkownika. Do tej funkcji potrzebne są dokumentacja właściwego API EZD PUW,
adres usługi i odpowiednio ograniczone uprawnienia od administratora.

Interfejs jawnie oznacza ten brak. Lista „Otwierane z EZD w iBridge” to historia
dokumentów rzeczywiście otrzymanych z EZD, a nie pełna lista konta. Przycisk
konta otwiera serwer EZD w osobnym oknie iBridge. Nie pobieramy haseł ani cookies
przeglądarki i nie udajemy pełnej listy na podstawie lokalnych plików.

## Uruchomienie i testy źródeł

Wymagany Node.js 22 lub nowszy; testy można uruchomić bez konta EZD i certyfikatu.

```sh
npm install
npm test
npm start
```

Testy używają atrap SOAP/Word i syntetycznych plików. Nie modyfikują dokumentów
na serwerze. Akceptacja end-to-end na rzeczywistym EZD wymaga osobno uzgodnionego
dokumentu testowego; nie jest zastąpiona testami jednostkowymi.

## Paczka macOS Apple Silicon

Testową paczkę 0.6.2 można przygotować z lokalnie zainstalowanego iBridge 0.6.1:

```sh
python3 scripts/package-local-inbox.py \
  --runtime '/Applications/EZD - iBridge.app' \
  --output ./artifacts
```

Skrypt tworzy osobny ZIP, zachowuje istniejący runtime i moduł podpisu,
podpisuje kopię ad-hoc oraz weryfikuje `codesign --verify --deep --strict`.
Nie zmienia zainstalowanego egzemplarza. Oryginalna ścieżka pakowania pozostaje
dostępna: paczka 0.6.1 była tworzona z przeanalizowanego runtime 0.6.0. Potrzebny jest
oryginalny ZIP o SHA-256:

```
7b54108bb31cd597d378119ef4ac002c9c9f0d8b1da947321794814d5208e5fe
```

```sh
python3 scripts/package.py \
  --baseline '/sciezka/EZD-iBridge-0.6.0-macOS-arm64-testy-wewnetrzne.zip' \
  --output ./artifacts
```

Skrypt weryfikuje bazę, przenosi źródła JS/UI, aktualizuje metadane aplikacji
oraz Helperów, dodaje opis Automatyzacji, podpisuje ad-hoc i wykonuje
`codesign --verify --deep --strict`. Dołącza instrukcję testów i manifest SHA-256
źródeł oraz niezmienionego modułu podpisu.

Moduł Java/PKCS#11 i jego runtime pozostają binarnie niezmienione z 0.6.0.
Dostarczony materiał nie zawiera ich źródeł Java; repozytorium nie deklaruje
pełnej przebudowy tego modułu. Zmiany 0.6.2 dodają monitorowanie folderu i powiadomień.

**Wydanie testowe nie ma Apple Developer ID ani notaryzacji.** Gotowe binaria
nie są publikowane automatycznie przez CI. Nie ma automatycznej instalacji
aktualizacji. Publiczne repozytorium zawiera kod, testy i skrypt pakowania;
nie zawiera dokumentów, logów, stanu użytkownika, PIN-ów, tokenów ani runtime.

Instrukcja akceptacji: [docs/TESTY-WEWNETRZNE.txt](docs/TESTY-WEWNETRZNE.txt).

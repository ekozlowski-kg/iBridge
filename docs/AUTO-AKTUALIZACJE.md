# Automatyczne aktualizacje iBridge 0.6.3

## Działanie u użytkownika

Podpisany iBridge automatycznie sprawdza nową wersję po uruchomieniu i potem
raz dziennie. Pobiera ZIP w tle przez natywny `autoUpdater` Electron/Squirrel.Mac.
Natywny mechanizm weryfikuje podpis aplikacji. Aplikacja nie otwiera przeglądarki
i nie wymaga ręcznego kopiowania nowej wersji. Pobrana aktualizacja instaluje
się przy rzeczywistym zakończeniu procesu iBridge, np. przez „Zakończ” w pasku
menu. Zamknięcie okna pozostawia aplikację w tle, więc samo nie instaluje aktualizacji.

Można przyspieszyć instalację przyciskiem „Zainstaluj i uruchom ponownie”.
Aktywne sesje edycji, niezapisane na serwerze zmiany, pobieranie dokumentu
i trwające podpisywanie blokują ten restart. Jeżeli w międzyczasie pojawi się
nowa sesja, aplikacja ponownie odracza restart. Natywne `quitAndInstall()`
wywoływane jest dopiero po dotychczasowej procedurze opróżnienia kolejki,
zapisaniu stanu i zamknięciu usług. Automatyczne pobieranie nie zamyka dokumentów.

GitHub „latest” pomija wydania draft/prerelease. Kanały arm64 i x64 mają
oddzielne pliki. Nowa wersja musi mieć większy numer x.y.z. Dane aktualizacji
nie zawierają dokumentów, tokenów EZD ani danych konta użytkownika.

Po błędzie iBridge pozostaje w bieżącej wersji i ponawia próbę w tle przy
najbliższym godzinowym sprawdzeniu. W trakcie pobierania oraz po pobraniu
nie uruchamia drugiego równoległego pobierania.

## Jednorazowa migracja obecnych użytkowników

Obecna wersja 0.6.1 i testowa 0.6.2 mają wyłącznie podpis ad hoc, bez stałej
tożsamości wydawcy Apple. Nie potrafią same przejść na nowy kanał. Trzeba raz
zainstalować pierwszą wersję produkcyjną podpisaną Developer ID Application
i zaakceptowaną przez notaryzację Apple. Kolejne aktualizacje odbywają się
automatycznie, o ile są publikowane w tym kanale i podpisywane tą samą tożsamością.
Rotacja certyfikatu lub zmiana Team ID wymaga oddzielnie zweryfikowanej migracji.

W tej kopii źródeł `auto-update.json` ma `enabled: false`. Skrypt wydania
włącza tę opcję tylko wewnątrz kopii produkcyjnej. Przy starcie aplikacja
sprawdza podpis `codesign --verify --deep --strict`, obecność Developer ID
oraz zgodność Team ID z konfiguracją objętą tym podpisem. Bez tych warunków
interfejs jawnie informuje, że wymagana jest instalacja podpisanej wersji.
Nie ma obejścia weryfikacji podpisu, Gatekeepera ani ATS.

## Przygotowanie wydania przez opiekuna aplikacji

Wymagania: macOS, Node.js 22+, narzędzia Xcode, ważny certyfikat Developer ID
Application z kluczem prywatnym w Pęku kluczy, profil `notarytool` w Pęku kluczy
oraz zaufany runtime iBridge z modułem Java/PKCS#11 dla właściwej architektury.
Źródła Java tego modułu nie zostały dostarczone, więc korzystamy z dostarczonego
runtime; skrypt weryfikuje jego spójność podpisu i zachowuje oryginalny JAR.
Klucze prywatne i hasła nie są umieszczane w repozytorium lub paczce.

Zainstaluj zależności i uruchom testy:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

Zwiększ wersję w `package.json` i `dist/branding.js`. Zbuduj paczkę:

```sh
node scripts/release-mac.cjs \
  --runtime '/sciezka/EZD - iBridge.app' \
  --output ./artifacts/0.6.3 \
  --arch arm64 \
  --identity 'Developer ID Application: Nazwa (TEAMID1234)' \
  --team-id TEAMID1234 \
  --notary-profile ibridge-release
```

Skrypt kopiuje runtime do katalogu roboczego i nie zmienia oryginału. Wstawia
źródła oraz wersję, podpisuje za pomocą `@electron/osx-sign`, przeprowadza
notaryzację, dołącza ticket Apple i sprawdza `codesign`, `stapler` oraz `spctl`.
Wyjątek library validation dotyczy tylko runtime Java ładującego zewnętrzny
moduł PKCS#11; Electron zachowuje weryfikację bibliotek. Po produkcyjnym
podpisaniu trzeba potwierdzić podpisywanie dokumentów z używanym dostawcą karty.

Dopiero po przejściu kontroli powstają:

- `EZD-iBridge-0.6.3-darwin-arm64.zip`: aplikacja w katalogu głównym ZIP-a;
- `RELEASES-darwin-arm64.json`: natywny kanał z wersją, URL-em, SHA-256 i rozmiarem;
- plik `.sha256` i manifest `.build.json`.

Dla x64 potrzebny jest runtime Intel, łącznie z Java. Skrypt odrzuca niezgodne
architektury i nie zastępuje błędu podpisywania wydaniem ad hoc.

Przed publikacją wykonaj próbę aktualizacji pomiędzy dwiema podpisanymi wersjami
na osobnej kopii/Macu: pobranie w tle, zakończenie aplikacji i ponowny start,
odroczenie restartu przy edycji oraz podpisywaniu, zachowanie dokumentów i ustawień.
Powtórz odbiór podpisu PKCS#11 z testowym dokumentem. To osobne sprawdzenia od
testów modułowych, których natywne zdarzenia aktualizacji są atrapami.

Utwórz wydanie `v0.6.3` w `ekozlowski-kg/iBridge` z tego kodu i dołącz ZIP oraz
`RELEASES-darwin-arm64.json`. Dla obu architektur dodaj oba zestawy do tego samego
wydania. Sprawdź je jako draft i dopiero potem opublikuj jako stabilne/latest.
Wydanie bez pliku dla danej architektury nie stanowi dla niej poprawnego kanału.
Skrypt nie publikuje ani nie modyfikuje GitHuba. Sam push kodu nie wystarczy.

## Kopia testowa bez certyfikatu

```sh
node scripts/release-mac.cjs --test-build \
  --runtime '/sciezka/EZD - iBridge.app' --output ./artifacts/test
```

Powstaje ZIP z sufiksem `-test` i podpisem ad hoc. Nie powstaje kanał RELEASES,
autoaktualizacje pozostają wyłączone. Taka kopia służy do sprawdzenia interfejsu
i regresji; nie jest gotowym wdrożeniem automatycznych aktualizacji.

## Dokumentacja mechanizmu

- https://www.electronjs.org/docs/latest/api/auto-updater
- https://github.com/Squirrel/Squirrel.Mac#update-file-json-format
- https://github.com/electron/osx-sign

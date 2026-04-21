# OTH Moodle Scraper

Lädt automatisch alle konfigurierten Dateien (PDFs, Office-Dokumente, ZIPs, etc.) aus angegebenen Moodle-Kursen der OTH Regensburg herunter.  
Authentifizierung via Shibboleth/SSO.

## Struktur der heruntergeladenen Dateien

```
downloads/
└── Algorithmen und Datenstrukturen/
    ├── Woche 1 - Grundlagen/
    │   ├── Vorlesung_01.pdf
    │   └── Uebungsblatt_01.pdf
    └── Woche 2 - Sortierverfahren/
        └── Vorlesung_02.pdf
```

## Setup

### 1. Abhängigkeiten installieren

```bash
npm install
npx playwright install chromium
```

### 2. Zugangsdaten konfigurieren

```bash
cp .env.example .env
```

Dann `.env` bearbeiten:

```env
OTH_USER=dein-benutzername   # z.B. max.mustermann
OTH_PASS=dein-passwort
OUTPUT_DIR=./downloads        # Ausgabeordner (optional)
HEADLESS=true                 # false = Browser sichtbar (für Debugging)
COURSE_IDS=12345,67890        # Kommagetrennte Kurs-IDs für automatischen Lauf (optional)
ALLOWED_EXTENSIONS=.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip,.txt # Erlaubte Dateitypen (optional)
```

> ⚠️ Die `.env`-Datei **niemals** committen oder teilen.

### 3. Kurs-IDs ermitteln

Die Kurs-ID steht in der URL des Moodle-Kurses:  
`https://elearning.oth-regensburg.de/course/view.php?id=`**`12345`**

## Verwendung

```bash
# Einzelner Kurs (ID)
node scraper.mjs 12345

# Mehrere Kurse
node scraper.mjs 12345 67890 11111

# Vollständige URL ist auch möglich
node scraper.mjs "https://elearning.oth-regensburg.de/course/view.php?id=12345"

# Ohne Argumente (nutzt COURSE_IDS aus der .env - ideal für Cronjobs)
node scraper.mjs
```

## Session-Caching

Nach dem ersten erfolgreichen Login wird die Session in `.session-cookies.json`  
gespeichert. Beim nächsten Aufruf wird diese wiederverwendet – kein erneuter Login nötig,  
bis die Session abläuft.

## Debugging

Wenn der Shibboleth-Login nicht klappt (z.B. wegen unbekannter Feldnamen):

```env
HEADLESS=false
```

Damit öffnet sich ein sichtbares Browserfenster, in dem du den Login-Ablauf verfolgen kannst.

## Hinweise

- Bereits vorhandene Dateien werden übersprungen (kein Re-Download).
- Nur direkte Datei-Ressourcen (die den Endungen in `ALLOWED_EXTENSIONS` entsprechen) und Moodle-`mod/resource`-Links werden verarbeitet.
- Der Scraper respektiert die Seitenstruktur – pro Abschnitt ein Unterordner.
- Eignet sich hervorragend für die **Automatisierung via Cronjob**, wenn `COURSE_IDS` gesetzt ist.

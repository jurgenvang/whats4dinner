# whats4dinner op Cloudflare

Eén Worker die zowel de app serveert als de gegevens bewaart in een D1-database.
Alles past binnen het gratis plan: 100.000 verzoeken per dag, en D1 geeft 5 GB
opslag met 100.000 geschreven rijen per dag.

Wat er in de map zit:

```
public/index.html   de app zelf
src/index.js        de Worker: API + serveren van de app
wrangler.jsonc      configuratie (hier vul je het database-id in)
schema.sql          de tabel voor D1
```

---

## Route A — via GitHub (aanbevolen)

Cloudflare bouwt en publiceert dan bij elke push naar `main`.

### 1. Repo aanmaken en pushen

```bash
cd whats4dinner
git init
git add .
git commit -m "whats4dinner: eerste versie"
git branch -M main
git remote add origin git@github.com:JOUWNAAM/whats4dinner.git
git push -u origin main
```

Zet de repo op **private**. Niet omdat er wachtwoorden in staan — die komen er
straks apart in — maar het database-id en jullie recepten hoeven niet publiek.

### 2. Database aanmaken

In het Cloudflare-dashboard: **Storage & Databases → D1 → Create database**,
naam `weekmenu`. Kopieer daarna het **Database ID** van de overzichtspagina.

### 3. Id invullen en opnieuw pushen

Vervang in `wrangler.jsonc` de tekst `VUL-HIER-JE-DATABASE-ID-IN` door dat id.

```bash
git add wrangler.jsonc
git commit -m "Database-id ingevuld"
git push
```

### 4. Tabel aanmaken

In het dashboard bij je nieuwe database: tabblad **Console**. Plak de inhoud van
`schema.sql` en voer uit. Eén keer, en klaar.

### 5. Repo koppelen aan een Worker

**Workers & Pages → Create → Workers → Import a repository**. Kies je repo.
Cloudflare leest `wrangler.jsonc` en pikt de D1-binding en de statische bestanden
vanzelf op. Laat het build-commando leeg; het deploy-commando is `npx wrangler deploy`.

Na de eerste build krijg je een adres in de vorm
`https://whats4dinner.<jouw-subdomein>.workers.dev`.

### 6. Wachtwoord instellen

Bij de Worker: **Settings → Variables and Secrets → Add**, type **Secret**,
naam `MENU_KEY`, waarde een wachtwoord dat jullie samen gebruiken. Deploy daarna
opnieuw (of push een kleine wijziging) zodat de Worker het oppikt.

Sla je deze stap over, dan kan iedereen die de link kent meelezen en aanpassen.

### 7. Openen

Ga naar het adres uit stap 5. De app vraagt het wachtwoord, onthoudt het, en toont
rechtsboven de badge **gedeeld · live**.

Vanaf nu is elke wijziging een `git push`. Cloudflare bouwt en publiceert vanzelf,
en pull requests krijgen automatisch een preview-adres.

---

## Route B — rechtstreeks vanaf je computer

Zonder GitHub, alles via de CLI:

```bash
npx wrangler login
npx wrangler d1 create weekmenu          # kopieer het database_id
# vul dat id in wrangler.jsonc in
npx wrangler d1 execute weekmenu --remote --file=./schema.sql
npx wrangler secret put MENU_KEY
npx wrangler deploy
```

Let op `--remote` bij de vierde regel. Zonder die vlag maak je de tabel enkel
lokaal aan en krijg je na het publiceren een foutmelding.

## Lokaal uitproberen

```bash
npm install
echo 'MENU_KEY = "test"' > .dev.vars
npx wrangler d1 execute weekmenu --local --file=./schema.sql
npx wrangler dev
```

`.dev.vars` staat in `.gitignore` en komt dus niet in de repo terecht.

## Optioneel: ingrediënten laten voorstellen door Claude

In het receptformulier staat een knop die ingrediënten afleidt uit de naam van het
gerecht. Standaard gebruikt die een ingebouwde woordenlijst — gratis, meteen, maar
beperkt tot wat erin zit.

Wil je er echte suggesties van maken, voeg dan een tweede Secret toe bij je Worker:
naam `ANTHROPIC_API_KEY`, waarde een sleutel van platform.claude.com. De Worker roept
dan Claude aan; je sleutel blijft op de server en komt nooit in de browser terecht.

Zonder die sleutel blijft alles werken, alleen op de woordenlijst. Faalt de oproep om
welke reden ook, dan valt de app automatisch terug.

Het model staat op Haiku 4.5, het goedkoopste van de huidige lijn: $1 per miljoen
invoertokens en $5 per miljoen uitvoertokens. Eén suggestie kost ongeveer 500 tokens,
dus je praat over fracties van een cent per recept. Nieuwe accounts krijgen $5 aan
gratis krediet, wat voor dit gebruik jaren meegaat. Een ander model kies je met een
variabele `SUGGEST_MODEL`.

## Eigen domeinnaam

Heb je al een domein bij Cloudflare, dan kan je bij de Worker onder
**Settings → Domains & Routes** een adres toevoegen zoals `whats4dinner.jouwdomein.be`.

## Hoe het samenwerken werkt

De app kijkt elke 15 seconden of het revisienummer op de server veranderd is en
haalt dan de nieuwe versie op. Wijzigingen van iemand anders verschijnen dus
vanzelf op jouw scherm.

Bewaren gebeurt met dat revisienummer erbij. Passen jullie tegelijk iets aan, dan
wordt de tweede wijziging niet stilletjes overschreven: die krijgt een melding en
het scherm springt naar de laatste versie. Je verliest dan hooguit die ene
aanpassing in plaats van elkaars werk.

## Back-up

Op het tabblad Maaltijden staat **Back-up downloaden**: een JSON-bestand met jullie
eigen recepten en de planning. Handig om af en toe te bewaren, en om gegevens uit
een oudere versie van de app over te zetten.

## Als er iets misloopt

- **De badge blijft "enkel dit toestel"** — de app bereikt `/api/state` niet.
  Kijk bij de Worker onder *Logs*, en controleer of stap 3 en 4 gelukt zijn.
- **Foutmelding over de tabel** — stap 4 is niet uitgevoerd, of bij route B zonder
  `--remote`, waardoor de tabel alleen lokaal bestaat.
- **Het wachtwoord blijft terugkomen** — het opgeslagen wachtwoord klopt niet meer.
  Wis de sitegegevens in je browser, of open de app in een privévenster.
- **De build faalt op een ontbrekend database-id** — `wrangler.jsonc` is gepusht met
  de placeholder er nog in.

## Klein detail over het wachtwoord

Het wachtwoord beschermt de gegevens, niet de pagina zelf. Wie het adres kent, ziet
de app openen, maar krijgt zonder wachtwoord geen recepten of planning te zien.
Wil je ook de pagina afschermen, dan kan dat met Cloudflare Access (gratis tot
50 gebruikers) in het dashboard onder *Zero Trust*.

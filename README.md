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

## Installeren op de gsm

De app is een PWA: open het adres in Chrome of Safari en kies *Toevoegen aan
beginscherm*. Ze staat dan als icoon op je startscherm en de boodschappenlijst
blijft leesbaar zonder bereik in de winkel. Werkt alleen via https, dus op je
workers.dev-adres of je eigen domein — niet bij een lokaal geopend bestand.

De bestanden daarvoor (`manifest.webmanifest`, `sw.js`, `icoon.svg`) staan in
`public/` en worden mee gepubliceerd.

## Persoonlijke agenda's

De app kan de afspraken van Google Agenda naast elke dag tonen. De adressen zijn
geheim en horen daarom bij de Worker, niet in de app.

Haal per persoon het privéadres op: Google Agenda → instellingen van die ene agenda
→ *Privéadres in iCal-indeling*. Voeg dat toe als **Secret** bij de Worker, met een
naam die begint met `AGENDA_`:

```bash
npx wrangler secret put AGENDA_JURGEN
npx wrangler secret put AGENDA_SARAH
```

Het stuk na `AGENDA_` wordt de naam die de app toont. Een derde agenda toevoegen is
dus enkel een extra Secret; er hoeft niets aan de code te veranderen.

De Worker haalt ze op via `/api/agenda`, rekent de uren om naar Belgische tijd
(Google bewaart ze in UTC) en geeft alleen de afspraken van de laatste twee weken
en later terug. Herhalende afspraken worden niet uitgerekend: daarvan verschijnt
enkel de eerste.

Lekt een adres, genereer het dan opnieuw in Google Agenda en vervang het Secret.

### Fluitopdrachten

Afspraken die eindigen op `[Official]` of `[Official 2]` worden herkend als een
wedstrijd fluiten. Het startuur uit de agenda klopt, de duur niet: de app rekent
altijd 1u45, met 30 minuten vooraf en 30 minuten achteraf, plus de rit heen en
terug. Volgen er meer wedstrijden binnen drie uur na de vorige start, dan blijft
hij ter plaatse en telt de rit naar huis pas na de laatste. Valt zo'n reeks rond
etenstijd, dan vervalt het samen-uur en moet het gerecht op te warmen zijn.

### Reistijden berekenen (optioneel)

Zonder sleutel schat de app de reistijd op basis van de naam van de zaal. Wil je
echte rijtijden, maak dan een gratis account bij openrouteservice.org — 2.500
aanvragen per dag, geen kredietkaart — en zet de sleutel als Secret:

```bash
npx wrangler secret put ORS_KEY
```

De Worker zoekt elke zaal één keer op, berekent de rijtijden en bewaart ze in D1.
Een nieuw seizoen kost daardoor een handvol aanvragen. De berekende waarden gaan
voor op de schattingen en op wat je zelf bij ⋯ invulde.

### Vergaderavonden

In de app staat bij ⋯ een trefwoord, standaard `zonnebloem`. Elke afspraak met dat
woord in de titel maakt van die dag een vergaderavond, waarop de app enkel afhaal
voorstelt of iets dat meteen op tafel kan. De uren uit de agenda worden bewust
genegeerd — bij Sarah blijken die niet met de werkelijke vergadering overeen te
komen, het echte uur staat in de titel.

## Wedstrijdkalenders

De app haalt de wedstrijden op uit de kalenderfeeds van de basketbalbond. De browser
mag die zelf niet ophalen, dus de Worker doet dat via `/api/kalender`. Enkel adressen
op `wisseq.eu` worden doorgelaten, zodat je Worker geen open doorgeefluik wordt.

De links beheer je in de app bij ⋯ → Wedstrijdkalenders. Het ophalen gebeurt
vanzelf zodra de gegevens ouder zijn dan twaalf uur, en de knop *Wedstrijden
ophalen* forceert het. Het resultaat gaat mee in de database, dus wie de app
daarna opent, ziet dezelfde wedstrijden.

## Optioneel: ingrediënten laten voorstellen door Claude

In het receptformulier staat een knop die ingrediënten afleidt uit de naam van het
gerecht. Standaard gebruikt die een ingebouwde woordenlijst — gratis, meteen, maar
beperkt tot wat erin zit.

Wil je er echte suggesties van maken, voeg dan een tweede Secret toe bij je Worker:
naam `ANTHROPIC_API_KEY`, waarde een sleutel van platform.claude.com. De Worker roept
dan Claude aan; je sleutel blijft op de server en komt nooit in de browser terecht.

Zonder die sleutel blijft alles werken, alleen op de woordenlijst. Faalt de oproep om
welke reden ook, dan valt de app automatisch terug.

Er zit een rem op: standaard 40 suggesties per dag en 6 per minuut, geteld in de
database zodat herladen niet helpt. Aanpassen kan met de variabelen
`SUGGEST_PER_DAG` en `SUGGEST_PER_MINUUT`. Ook mislukte oproepen tellen mee — dat is
bewust, anders kan een verkeerde sleutel eindeloos blijven proberen.

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

- **Je sleutels zijn na een deploy verdwenen** — vrijwel zeker zijn ze als **Text**
  aangemaakt in plaats van als **Secret**. Wrangler wist bij elke deploy de gewone
  variabelen en zet ze terug zoals ze in `wrangler.jsonc` staan; secrets blijft hij
  af. Maak ze opnieuw aan via *Settings → Variables and Secrets → Add* en kies bij
  Type uitdrukkelijk **Secret**. In `wrangler.jsonc` staat bovendien `keep_vars: true`
  als vangnet, zodat ook gewone variabelen blijven staan.
  Zekerder alternatief, vanaf je eigen computer:

  ```bash
  npx wrangler secret put MENU_KEY
  npx wrangler secret put ANTHROPIC_API_KEY
  ```

  Die overleven elke git-deploy. Controleer daarna in de app met de knop
  *Claude-koppeling testen* op het tabblad Maaltijden.
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

# toem-web

A small web front end for registering Toem cards, meant for use on a phone.

Plain HTML, CSS and JavaScript. No build step, no dependencies, no framework —
copy the three files onto any static host.

## What it does

- Search Spotify for an album, pick it, and save it against a card number
- List registered cards and delete them

The card number is typed (or scanned — see below). Everything else is chosen
from search results, so no URIs are copied by hand.

## It holds no Spotify credentials

Spotify rejects unauthenticated `/v1/search`, and `client_credentials` is a
secret that must not ship in a browser. So the API proxies search at
`GET /spotify/search`, and this page only ever talks to the Toem API.

Requires a Toem API with that endpoint, and with `CORS_ORIGINS` including
wherever this page is served from — without it the browser's preflight fails
and nothing works.

## Scanning

The RFID reader is a USB HID device: it types the digits and sends Enter. So
scanning a card while the card-number field is focused fills it in and moves on,
with no special support needed. Phones have no reader, which is why the number
is also printed on each card.

Card numbers are stored zero-padded to 10 digits. The number printed on a card
may omit the leading zeros, so input is padded before use — typing `1221753`
finds `0001221753`.

## Running it

Any static server:

    python3 -m http.server 8080

Then open <http://127.0.0.1:8080>. On first load, enter the API address and your
API token — the same token the players use.

## The token is kept in localStorage

That is a deliberate trade for a personal tool: it keeps you signed in across
reloads, but anything that can run script on this page can read it. So every
value coming back from the API or Spotify is rendered with `textContent`, never
`innerHTML` — an album title is attacker-influenced data as far as this page is
concerned. Keep that property if you edit the rendering code.

Sign out clears the token.

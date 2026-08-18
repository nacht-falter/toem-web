"use strict";

/* Toem card registration.
 *
 * Talks only to the Toem API. It holds no Spotify credentials: album search is
 * proxied by GET /spotify/search, because Spotify rejects unauthenticated
 * search and client_credentials is a secret that must not ship in a browser.
 *
 * Sign-in is username and password so a password manager can fill it. The API
 * returns a session token, which is stored in localStorage. That session is
 * separate from the long-lived token the players use, so revoking it does not
 * mean reconfiguring every device.
 *
 * Storing it keeps you signed in, but means anything that can run script on
 * this page can read it. Hence every value that comes back from the API or
 * Spotify is written with textContent, never innerHTML - an album title is
 * attacker-influenced data as far as this page is concerned.
 */

/* Set in config.js (optional, not committed - it is per-deployment). With no
 * config the sign-in form asks for the address, so the page still works; it is
 * just one more thing to type the first time. */
const DEFAULT_API = (window.TOEM_CONFIG && window.TOEM_CONFIG.apiUrl) || "";
const RFID_LENGTH = 10;

const store = {
  get token() { return localStorage.getItem("toem.token"); },
  set token(v) { v ? localStorage.setItem("toem.token", v)
                   : localStorage.removeItem("toem.token"); },
  get api() { return localStorage.getItem("toem.api") || DEFAULT_API; },
  set api(v) { localStorage.setItem("toem.api", v.replace(/\/+$/, "")); },
};

const $ = (id) => document.getElementById(id);
let chosenAlbum = null;
// The resolved series when the card is a playlist of episodes. Kept apart
// from chosenAlbum so save() cannot confuse the two.
let chosenSeries = null;

/* --- API ---------------------------------------------------------------- */

async function api(path, options = {}) {
  const response = await fetch(store.api + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + store.token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    signOut("Session expired. Please sign in again.");
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    let detail = "HTTP " + response.status;
    try {
      const body = await response.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) { /* not JSON; keep the status */ }
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

/* --- card numbers -------------------------------------------------------- */

/* Stored keys are zero-padded to 10 digits, but the number printed on a card
 * may be written without them, so "1221753" has to find "0001221753". */
function normaliseRfid(raw) {
  const digits = (raw || "").trim().replace(/\s+/g, "");
  if (!/^\d+$/.test(digits)) return null;
  return digits.length >= RFID_LENGTH ? digits : digits.padStart(RFID_LENGTH, "0");
}

/* --- views --------------------------------------------------------------- */

function show(section) {
  $("login").hidden = section !== "login";
  $("app").hidden = section !== "app";
}

function setStatus(el, message, kind) {
  el.textContent = message;
  el.className = "status " + (kind || "");
  el.hidden = !message;
}

async function signOut(message) {
  // Revoke server-side too, so a stored session cannot be reused elsewhere.
  if (store.token) {
    try {
      await fetch(store.api + "/logout", {
        method: "POST",
        headers: { "Authorization": "Bearer " + store.token },
      });
    } catch (_) { /* offline: clearing locally is still worth doing */ }
  }
  store.token = null;
  show("login");
  $("password").value = "";
  if (message) {
    $("login-error").textContent = message;
    $("login-error").hidden = false;
  }
}

/* --- add a card ---------------------------------------------------------- */

async function checkExisting() {
  const note = $("rfid-note");
  const rfid = normaliseRfid($("rfid").value);
  note.hidden = true;

  if (!rfid) return;
  $("rfid").value = rfid;   // show the padded form actually used

  try {
    const existing = await api("/music/" + rfid);
    note.textContent = "Already used by: " + existing.title + " — saving replaces it.";
    note.hidden = false;
  } catch (_) {
    /* 404 is the normal case for a new card. */
  }
}

async function search() {
  const query = $("search").value.trim();
  const results = $("results");
  results.replaceChildren();
  if (!query) return;

  setStatus($("add-status"), "Searching…");
  try {
    const albums = await api("/spotify/search?limit=8&q=" + encodeURIComponent(query));
    setStatus($("add-status"), "");
    if (!albums.length) {
      setStatus($("add-status"), "Nothing found. Try different words.", "muted");
      return;
    }
    albums.forEach((album) => results.appendChild(resultRow(album)));
  } catch (error) {
    setStatus($("add-status"), "Search failed: " + error.message, "error");
  }
}

/* Built with createElement/textContent throughout: album names come from
 * Spotify and must never be interpolated as markup. */
function resultRow(album) {
  const li = document.createElement("li");
  li.className = "result";

  if (album.image) {
    const img = document.createElement("img");
    img.src = album.image;
    img.alt = "";
    img.width = 48;
    img.height = 48;
    li.appendChild(img);
  }

  const text = document.createElement("div");
  const name = document.createElement("p");
  name.className = "strong";
  name.textContent = album.name;
  const meta = document.createElement("p");
  meta.className = "muted small";
  meta.textContent = [album.artists,
                      album.total_tracks ? album.total_tracks + " tracks" : null,
                      (album.release_date || "").slice(0, 4) || null]
                     .filter(Boolean).join(" · ");
  text.append(name, meta);
  li.appendChild(text);

  li.addEventListener("click", () => choose(album));
  return li;
}

function cardKind() {
  return $("kind").value;
}

function switchKind() {
  const series = cardKind() === "spotify_series";
  $("album-picker").hidden = series;
  $("series-picker").hidden = !series;
  // Whichever selection was made no longer applies to what is being created.
  chosenAlbum = null;
  chosenSeries = null;
  $("chosen").hidden = true;
  $("results").replaceChildren();
  $("episodes").replaceChildren();
}

async function lookUpPlaylist() {
  const link = $("playlist").value.trim();
  if (!link) return;

  setStatus($("add-status"), "Looking up the playlist…");
  $("episodes").replaceChildren();
  try {
    const series = await api("/spotify/playlist?url=" + encodeURIComponent(link));
    if (!series.episodes.length) {
      setStatus($("add-status"),
        "That playlist has no album tracks in it.", "error");
      return;
    }
    showSeries(series);
    setStatus($("add-status"), "");
    $("add-status").hidden = true;
  } catch (error) {
    setStatus($("add-status"), "Could not read it: " + error.message, "error");
  }
}

function showSeries(series) {
  chosenSeries = series;

  // Listing every episode is the point: a mis-curated playlist is far cheaper
  // to catch here than after a child has met it.
  series.episodes.forEach((episode, index) => {
    const li = document.createElement("li");
    const line = document.createElement("p");
    line.textContent = (index + 1) + ". " + (episode.name || "(untitled)");
    const meta = document.createElement("p");
    meta.className = "muted small";
    meta.textContent = episode.tracks + (episode.tracks === 1 ? " track" : " tracks");
    li.append(line, meta);
    $("episodes").append(li);
  });

  $("chosen-title").textContent = series.name || "(untitled playlist)";
  $("chosen-meta").textContent =
    series.episodes.length + " episodes, starting with " +
    (series.episodes[0].name || "(untitled)");
  const img = $("chosen-image");
  if (series.episodes[0].image) {
    img.src = series.episodes[0].image; img.hidden = false;
  } else {
    img.hidden = true;
  }
  $("title").value = series.name || "";
  $("chosen").hidden = false;
  $("chosen").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function choose(album) {
  chosenAlbum = album;
  $("chosen-title").textContent = album.name;
  $("chosen-meta").textContent = album.artists;
  const img = $("chosen-image");
  if (album.image) { img.src = album.image; img.hidden = false; } else { img.hidden = true; }
  $("title").value = album.title || album.name;
  $("chosen").hidden = false;
  $("results").replaceChildren();
  $("chosen").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function save() {
  const rfid = normaliseRfid($("rfid").value);
  if (!rfid) {
    setStatus($("add-status"), "Enter the card number first.", "error");
    return;
  }
  const series = cardKind() === "spotify_series";
  const chosen = series ? chosenSeries : chosenAlbum;
  if (!chosen) {
    setStatus($("add-status"),
      series ? "Look up the playlist first." : "Choose an album first.",
      "error");
    return;
  }

  setStatus($("add-status"), "Saving…");
  try {
    await api("/music/upsert", {
      method: "POST",
      body: JSON.stringify({
        rfid: rfid,
        source: cardKind(),
        location: chosen.uri,
        title: $("title").value.trim() || chosen.title || chosen.name,
      }),
    });
    setStatus($("add-status"), "Saved. Players pick this up within a minute.", "ok");
    resetForm();
  } catch (error) {
    setStatus($("add-status"), "Could not save: " + error.message, "error");
  }
}

function resetForm() {
  chosenAlbum = null;
  chosenSeries = null;
  $("playlist").value = "";
  $("episodes").replaceChildren();
  $("rfid").value = "";
  $("search").value = "";
  $("title").value = "";
  $("chosen").hidden = true;
  $("rfid-note").hidden = true;
  $("results").replaceChildren();
}

/* --- list ---------------------------------------------------------------- */

async function loadCards() {
  const list = $("cards");
  list.replaceChildren();
  $("list-status").textContent = "Loading…";
  $("list-status").hidden = false;

  try {
    const cards = await api("/music");
    $("list-status").hidden = cards.length > 0;
    if (!cards.length) $("list-status").textContent = "No cards registered yet.";
    cards.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    cards.forEach((card) => list.appendChild(cardRow(card)));
  } catch (error) {
    $("list-status").textContent = "Could not load cards: " + error.message;
  }
}

function describeSource(source) {
  // The stored values are for the player, not for reading over breakfast.
  if (source === "spotify_series") return "series";
  if (source === "spotify") return "album";
  if (source === "local") return "local files";
  return source;
}

function cardRow(card) {
  const li = document.createElement("li");

  const text = document.createElement("div");
  const title = document.createElement("p");
  title.className = "strong";
  title.textContent = card.title || "(untitled)";
  const meta = document.createElement("p");
  meta.className = "muted small";
  meta.textContent = card.rfid + " · " + describeSource(card.source);
  text.append(title, meta);

  const remove = document.createElement("button");
  remove.className = "link danger";
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    if (!confirm("Delete “" + (card.title || card.rfid) + "”?")) return;
    try {
      await api("/music/" + card.rfid, { method: "DELETE" });
      loadCards();
    } catch (error) {
      alert("Could not delete: " + error.message);
    }
  });

  li.append(text, remove);
  return li;
}

/* --- wiring -------------------------------------------------------------- */

function selectTab(which) {
  const adding = which === "add";
  $("tab-add").classList.toggle("active", adding);
  $("tab-list").classList.toggle("active", !adding);
  $("view-add").hidden = !adding;
  $("view-list").hidden = adding;
  if (!adding) loadCards();
}

function start() {
  $("api-url").value = store.api;
  // Open the API address when there is nothing sensible to fall back on, or on
  // first run: leaving it collapsed makes it easy to sign in against the wrong
  // server, which fails as a confusing CORS error rather than a clear one.
  if (!localStorage.getItem("toem.api") || !store.api) {
    $("api-details").open = true;
    if (!DEFAULT_API) $("api-url").required = true;
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("login-error").hidden = true;
    const address = $("api-url").value.trim() || DEFAULT_API;
    if (!address) {
      $("login-error").textContent = "Set the API address first.";
      $("login-error").hidden = false;
      $("api-details").open = true;
      return;
    }
    store.api = address;

    try {
      const response = await fetch(store.api + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: $("username").value.trim(),
          password: $("password").value,
          label: "web",
        }),
      });
      if (!response.ok) {
        const detail = response.status === 401 ? "Wrong user or password."
                     : response.status === 429 ? "Too many attempts. Try again later."
                     : "Sign-in failed (HTTP " + response.status + ").";
        throw new Error(detail);
      }
      store.token = (await response.json()).token;
      $("password").value = "";
      show("app");
      selectTab("add");
    } catch (error) {
      $("login-error").textContent = error.message.startsWith("Wrong")
        || error.message.startsWith("Too many") || error.message.startsWith("Sign-in")
        ? error.message
        : "Could not reach the API: " + error.message;
      $("login-error").hidden = false;
    }
  });

  $("sign-out").addEventListener("click", () => signOut());
  $("tab-add").addEventListener("click", () => selectTab("add"));
  $("tab-list").addEventListener("click", () => selectTab("list"));
  $("search-btn").addEventListener("click", search);
  $("kind").addEventListener("change", switchKind);
  $("playlist-btn").addEventListener("click", lookUpPlaylist);
  $("playlist").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); lookUpPlaylist(); }
  });
  $("save").addEventListener("click", save);
  $("rfid").addEventListener("change", checkExisting);

  /* The reader is a USB HID device: it types the digits and sends Enter, so
   * scanning into either field submits it. */
  $("search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  $("rfid").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); checkExisting(); $("search").focus(); } });

  if (store.token) {
    show("app");
    selectTab("add");
  } else {
    show("login");
  }
}

document.addEventListener("DOMContentLoaded", start);

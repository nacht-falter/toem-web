"use strict";

/* Toem card registration.
 *
 * Talks only to the Toem API. It holds no Spotify credentials: album search is
 * proxied by GET /spotify/search, because Spotify rejects unauthenticated
 * search and client_credentials is a secret that must not ship in a browser.
 *
 * The API token lives in localStorage. That is a deliberate trade for a
 * personal tool: it keeps you signed in, but it means anything that can run
 * script on this page can read the token. Hence every value that comes back
 * from the API or Spotify is written with textContent, never innerHTML - an
 * album title is attacker-influenced data as far as this page is concerned.
 */

const DEFAULT_API = "https://toemapi.johannesbernet.com";
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
    signOut("That token was not accepted.");
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

function signOut(message) {
  store.token = null;
  show("login");
  $("token").value = "";
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
  if (!chosenAlbum) {
    setStatus($("add-status"), "Choose an album first.", "error");
    return;
  }

  setStatus($("add-status"), "Saving…");
  try {
    await api("/music/upsert", {
      method: "POST",
      body: JSON.stringify({
        rfid: rfid,
        source: "spotify",
        location: chosenAlbum.uri,
        title: $("title").value.trim() || chosenAlbum.title,
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

function cardRow(card) {
  const li = document.createElement("li");

  const text = document.createElement("div");
  const title = document.createElement("p");
  title.className = "strong";
  title.textContent = card.title || "(untitled)";
  const meta = document.createElement("p");
  meta.className = "muted small";
  meta.textContent = card.rfid + " · " + card.source;
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

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("login-error").hidden = true;
    store.api = $("api-url").value.trim() || DEFAULT_API;
    store.token = $("token").value.trim();
    try {
      await api("/music");          // cheapest call that proves the token works
      show("app");
      selectTab("add");
    } catch (error) {
      if (error.message !== "unauthorized") {
        $("login-error").textContent = "Could not reach the API: " + error.message;
        $("login-error").hidden = false;
      }
    }
  });

  $("sign-out").addEventListener("click", () => signOut());
  $("tab-add").addEventListener("click", () => selectTab("add"));
  $("tab-list").addEventListener("click", () => selectTab("list"));
  $("search-btn").addEventListener("click", search);
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

/* ============================================================
   POKERTISCH · game.js
   Modi: gegen Computer (1–5) oder online (bis 6, mehrspieler.js).
   Geld: Man nimmt Spielgeld vom Casino-Konto mit an den Tisch
   (einsatzAbbuchen) und bekommt beim Aufstehen den Stapel zurück
   (rundeAbschliessen). Offene Sitzung liegt in ba:poker:offen und
   wird beim nächsten Laden abgerechnet, falls die Seite einfach zu ging.
   Online führt der Browser des Tisch-Hosts Karten und Regeln; die
   anderen sehen nur ihre eigenen Karten und schicken nur Aktionen.
   ============================================================ */
import * as E from "./engine.js?v=20261024";
import { lade, speichere } from "./assets/storage.js";
import { stillEintragen, toplisteAnzeigen, bewegungReduziert } from "./assets/ui.js";
import {
  einsatzAbbuchen,
  rundeAbschliessen,
  kontostand,
  pleiteNeustart,
  walletHud,
  walletHudAktualisieren,
} from "./assets/wallet.js";
import { raumEroeffnen, raumBeitreten, CODE_MUSTER } from "./assets/mehrspieler.js";

const SPIEL = "poker";
const ZUG_ZEIT = 30000;
const HAND_PAUSE = 5000;
const MIN_BUYIN = 50;
const NAMEN = [
  "Alex",
  "Kim",
  "Sam",
  "Robin",
  "Jo",
  "Mika",
  "Noa",
  "Toni",
  "Charlie",
  "Luca",
  "Sascha",
  "Kai",
];
const $ = (id) => document.getElementById(id);
const zahl = (n) => Math.round(n).toLocaleString("de-DE");

let modus = "computer";
let gegner = 3;
let buyin = 500;
let rolle = null; // solo | host | gast
let st = null;
let ich = 0;
let sitzung = null; // {einsatz, stack}
let netz = null; // {rolle, raum | verbindung, code}
let zugBis = 0;
let zugTimer = null,
  botTimer = null,
  handTimer = null;
let gewertet = -1;
let gastWartet = false;
const gastSitz = new Map(); // platz -> sitz (Host)
const nachkauf = new Map(); // sitz -> betrag (Host, nach der Hand)
const ersatz = new Map(); // sitz -> neuer Stapel (Host, nach der Hand)
let tags = {},
  tagHand = -1,
  tagBoard = 0,
  tagLetzt = "";
let alteBoardLaenge = 0;

/* ---------- Geld ---------- */
function geldNehmen(betrag) {
  const b = Math.min(betrag, kontostand());
  if (b < MIN_BUYIN || !einsatzAbbuchen(b)) return 0;
  walletHudAktualisieren();
  return b;
}
function sitzungSpeichern() {
  speichere(SPIEL, "offen", sitzung);
}
function abrechnen(stack) {
  if (!sitzung) return 0;
  const s = Math.max(0, Math.round(stack));
  rundeAbschliessen(sitzung.einsatz, s);
  sitzung = null;
  speichere(SPIEL, "offen", null);
  walletHudAktualisieren();
  return s;
}
const laufend = () => st && !["ende", "pause"].includes(st.phase);
const meinPlatz = () => st?.spieler[ich];
/** Stapel inkl. Einsatz der laufenden Hand (wenn der Tisch schließt, gibt es den zurück). */
const stapelMitEinsatz = () =>
  (meinPlatz()?.stack ?? 0) + (laufend() ? (meinPlatz()?.gesamt ?? 0) : 0);

function pleiteHinweis() {
  if (kontostand() >= MIN_BUYIN) return;
  $("menue-info").textContent = `Dein Konto reicht nicht (mindestens ${MIN_BUYIN}). `;
  const k = document.createElement("button");
  k.type = "button";
  k.className = "knopf";
  k.textContent = "Neues Startgeld";
  k.addEventListener("click", () => {
    pleiteNeustart();
    walletHudAktualisieren();
    $("menue-info").textContent = "Neues Startgeld ist da.";
  });
  $("menue-info").append(k);
}

/* ---------- Ansicht ---------- */
function statusSetzen(text, art = "") {
  $("status").textContent = text;
  $("status").dataset.art = art;
}
function ansicht(tisch) {
  $("menue").hidden = tisch;
  $("buehne").hidden = !tisch;
  $("raumkopf").hidden = !tisch;
  $("raumcode-zeile").hidden = rolle !== "host" && rolle !== "gast";
  $("teilen").hidden = rolle !== "host";
}
function karteEl(k) {
  const d = document.createElement("div");
  d.className = "pk-karte";
  if (k === null || k === undefined) {
    d.classList.add("ruecken");
    d.setAttribute("aria-label", "verdeckte Karte");
    return d;
  }
  const f = E.farbe(k);
  if (f === 1 || f === 2) d.classList.add("rot");
  const r = document.createElement("span");
  r.className = "r";
  r.textContent = E.RANG_TEXT[E.rang(k)];
  const s = document.createElement("span");
  s.className = "f";
  s.textContent = E.FARBE[f];
  d.append(r, s);
  d.setAttribute("aria-label", E.karteText(k));
  return d;
}
const AKT_TEXT = { passen: "Passt", schieben: "Schiebt", mitgehen: "Geht mit", erhoehen: "Erhöht" };
const name = (j) => (j === ich ? "Du" : st.spieler[j].name);

function tagsPflegen() {
  if (st.handNr !== tagHand) {
    tags = {};
    tagHand = st.handNr;
    tagBoard = 0;
    tagLetzt = "";
  }
  if (st.board.length !== tagBoard) {
    for (const j in tags) if (tags[j] !== "Passt") delete tags[j];
    tagBoard = st.board.length;
  }
  const key = JSON.stringify([st.handNr, st.letzt, st.board.length]);
  if (st.letzt && key !== tagLetzt) {
    tagLetzt = key;
    const { platz, art, betrag } = st.letzt;
    tags[platz] = art === "erhoehen" ? `Erhöht auf ${zahl(betrag)}` : AKT_TEXT[art];
  }
}

function zeigen() {
  if (!st) return;
  tagsPflegen();
  const n = st.spieler.length;
  const ende = st.phase === "ende";
  const erg = ende ? st.ergebnis : null;
  // Plätze rund um den Tisch, du immer unten
  const plaetze = $("plaetze");
  const schmal = innerWidth < 640;
  plaetze.textContent = "";
  st.spieler.forEach((s, j) => {
    const k = (j - ich + n) % n;
    const w = ((90 + (k * 360) / n) * Math.PI) / 180;
    const box = document.createElement("div");
    box.className = "pk-platz";
    box.style.left = `${50 + (schmal ? 46 : 41) * Math.cos(w)}%`;
    box.style.top = `${50 + (schmal ? 41 : 40) * Math.sin(w)}%`;
    if (j === ich) box.classList.add("ich");
    if (j === st.dran) box.classList.add("dran");
    if (s.drin && s.raus) box.classList.add("raus");
    if (!s.sitzt) box.classList.add("weg");
    if (erg && erg.gewinn[j] > 0) box.classList.add("gewinn");
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = s.sitzt || j === ich ? name(j) : "frei";
    const sk = document.createElement("div");
    sk.className = "st";
    sk.textContent = zahl(s.stack);
    const kt = document.createElement("div");
    kt.className = "kt";
    const offen = erg?.showdown && s.drin && !s.raus;
    if (j !== ich && s.drin && !s.raus && s.karten)
      for (const c of s.karten) kt.append(karteEl(offen ? c : null));
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent =
      erg?.showdown && erg.hand[j]
        ? erg.hand[j]
        : s.allin && s.drin && !ende
          ? "All-in"
          : tags[j] || "";
    box.append(nm, sk);
    if (j !== ich) box.append(kt);
    box.append(tag);
    if (j === st.button && st.handNr) {
      const b = document.createElement("span");
      b.className = "pk-btn";
      b.textContent = "D";
      b.title = "Geber";
      box.append(b);
    }
    if (j === st.dran && zugBis > Date.now()) {
      const z = document.createElement("span");
      z.className = "pk-zeit";
      const rest = zugBis - Date.now();
      z.style.transform = `scaleX(${rest / ZUG_ZEIT})`;
      box.append(z);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          z.style.transition = `transform ${rest}ms linear`;
          z.style.transform = "scaleX(0)";
        }),
      );
    }
    plaetze.append(box);
    const chipBetrag = erg ? erg.gewinn[j] : s.einsatz;
    if (chipBetrag > 0) {
      const c = document.createElement("span");
      c.className = "pk-chip";
      c.style.left = `${50 + (schmal ? 30 : 30) * Math.cos(w)}%`;
      c.style.top = `${50 + 29 * Math.sin(w)}%`;
      c.textContent = (erg ? "+" : "") + zahl(chipBetrag);
      plaetze.append(c);
    }
  });
  // Board + Pot
  const board = $("board");
  board.textContent = "";
  for (let i = 0; i < 5; i++) {
    const c = st.board[i];
    const el =
      c === undefined
        ? Object.assign(document.createElement("div"), { className: "pk-karte leer" })
        : karteEl(c);
    if (c !== undefined && i >= alteBoardLaenge) el.classList.add("neu");
    board.append(el);
  }
  alteBoardLaenge = st.board.length;
  const pot = E.topf(st);
  $("topf").textContent = ende
    ? `Pot ${zahl(erg.toepfe.reduce((a, t) => a + t.betrag, 0))}`
    : `Pot ${zahl(pot)}`;
  // eigene Hand
  const hand = $("hand");
  hand.textContent = "";
  const ichS = meinPlatz();
  if (ichS?.karten && ichS.drin) for (const c of ichS.karten) hand.append(karteEl(c));
  hand.style.opacity = ichS?.raus ? ".45" : "1";
  meineHandZeigen(ichS);
  // Info
  $("info").textContent = infoText();
  // Bedienung
  const a = st.dran === ich && !gastWartet ? E.aktionen(st, ich) : null;
  $("aktionen").hidden = !a || !$("erhoehen").hidden;
  if (!a) $("erhoehen").hidden = true;
  if (a) {
    $("a-mitgehen").textContent = a.schieben
      ? "Schieben"
      : a.mitgehen >= ichS.stack
        ? `All-in ${zahl(a.mitgehen)}`
        : `Mitgehen ${zahl(a.mitgehen)}`;
    $("a-erhoehen").hidden = !a.erhoehen;
    if (a.erhoehen)
      $("a-erhoehen").textContent =
        a.erhoehen.min >= a.erhoehen.max
          ? `All-in ${zahl(a.erhoehen.max)}`
          : st.hoechst
            ? "Erhöhen"
            : "Setzen";
  }
  const zwischen = !laufend();
  $("weiter-zeile").hidden = !zwischen;
  $("weiter").hidden =
    rolle === "gast" || !E.handMoeglich(st) || (rolle === "solo" && (ichS?.stack ?? 0) < E.BB);
  $("nachkauf").hidden = !sitzung || (ichS?.stack ?? 0) >= E.BB;
  $("nachkauf").textContent = `Nachkaufen ${zahl(buyin)}`;
  // Sitzung mitschreiben + Topliste
  if (sitzung && ichS) {
    sitzung.stack = ichS.stack;
    sitzungSpeichern();
  }
  if (ende && st.handNr !== gewertet && sitzung) {
    gewertet = st.handNr;
    const netto = erg.netto[ich] ?? 0;
    if (netto > 0) stillEintragen(SPIEL, netto);
  }
}

/* Eigene Hand + Gewinnchance – nur aus eigenen Karten, Board und Zahl der Gegner (keine fremden Karten). */
let chanceKey = "",
  chanceWert = 0;
function meineHandZeigen(ichS) {
  const el = $("meine");
  if (!ichS?.karten || !ichS.drin || ichS.karten.includes(null)) return (el.textContent = "");
  const art = E.HAND_NAME[E.kategorie(E.bewerten([...ichS.karten, ...st.board]))];
  if (ichS.raus || st.phase === "ende") return (el.textContent = art);
  const gegner = st.spieler.filter((s, j) => j !== ich && s.drin && !s.raus).length;
  const key = [st.handNr, st.board.join(","), gegner].join("|");
  if (key !== chanceKey) {
    chanceKey = key;
    chanceWert = E.chance(st, ich, 1500);
  }
  el.textContent = `${art} · Gewinnchance ca. ${Math.round(chanceWert * 100)} % (${gegner} Gegner)`;
}

function infoText() {
  const ichS = meinPlatz();
  if (st.phase === "pause") {
    if (rolle === "host")
      return st.spieler.filter((s) => s.sitzt).length < 2
        ? "Warte auf Mitspieler – teile den Code."
        : "Gleich geht's los …";
    if (rolle === "gast") return "Gleich geht's los …";
    return "";
  }
  if (st.phase === "ende") {
    const e = st.ergebnis;
    const sieger = e.gewinn.map((g, j) => [g, j]).filter(([g]) => g > 0);
    const teile = sieger.map(
      ([g, j]) =>
        `${name(j)} ${j === ich ? "gewinnst" : "gewinnt"} ${zahl(g)}${e.showdown ? ` mit ${e.hand[j]}` : ""}`,
    );
    let t = teile.join(" · ") + ".";
    if ((ichS?.stack ?? 0) < E.BB && sitzung) t += " Dein Stapel ist leer.";
    return t;
  }
  if (st.dran === ich) {
    const a = E.aktionen(st, ich);
    return a?.schieben
      ? "Du bist dran."
      : `Du bist dran – Mitgehen kostet ${zahl(a?.mitgehen ?? 0)}.`;
  }
  if (ichS?.raus) return "Du hast gepasst.";
  return st.dran >= 0 ? `${name(st.dran)} überlegt …` : "";
}

/* ---------- Ablauf (Computer-Modus und Host) ---------- */
function botName() {
  const frei = NAMEN.filter((x) => !st?.spieler.some((s) => s.name === x));
  return frei[Math.floor(Math.random() * frei.length)] || "Computer";
}
function zeitenAus() {
  clearTimeout(zugTimer);
  clearTimeout(botTimer);
  zugBis = 0;
}
function naechsteHand() {
  clearTimeout(handTimer);
  handTimer = null;
  if (!st || rolle === "gast" || laufend()) return;
  if (rolle === "solo")
    st.spieler.forEach((s) => {
      if (s.bot && s.stack < E.BB) {
        s.name = botName();
        s.stack = buyin;
      }
    });
  for (const [j, b] of ersatz) st.spieler[j].stack = b;
  for (const [j, b] of nachkauf) st.spieler[j].stack += b;
  ersatz.clear();
  nachkauf.clear();
  if (!E.handMoeglich(st)) {
    st.phase = "pause";
    nachZustand();
    return;
  }
  st = E.neueHand(st);
  nachZustand();
}
function handPlanen() {
  if (handTimer || laufend() || !E.handMoeglich(st)) return;
  if (rolle === "solo" && meinPlatz().stack < E.BB) return;
  handTimer = setTimeout(naechsteHand, HAND_PAUSE);
}
function nachZustand() {
  zeitenAus();
  if (laufend()) {
    const s = st.spieler[st.dran];
    if (s.bot) {
      const ichRaus = meinPlatz()?.raus || !meinPlatz()?.drin;
      const t = bewegungReduziert() || ichRaus ? 350 : 650 + Math.random() * 700;
      botTimer = setTimeout(() => ausfuehren(st.dran, E.computerZug(st)), t);
    } else if (rolle === "host") {
      const j = st.dran;
      const zeit = s.sitzt ? ZUG_ZEIT : 400;
      zugBis = Date.now() + zeit;
      zugTimer = setTimeout(() => ausfuehren(j, { art: "schieben" }), zeit);
    }
  }
  zeigen();
  hostSenden();
  if (!laufend()) handPlanen();
}
function ausfuehren(j, a) {
  if (!st || !laufend() || st.dran !== j || !a) return;
  st = E.handeln(st, a);
  nachZustand();
}

/* ---------- eigene Aktionen ---------- */
function meinZug(a) {
  if (!st || st.dran !== ich || !laufend()) return;
  $("erhoehen").hidden = true;
  if (rolle === "gast") {
    gastWartet = true;
    netz.verbindung.senden({ t: "akt", art: a.art, bis: a.bis });
    zeigen();
  } else ausfuehren(ich, a);
}
function erhoehenOeffnen() {
  const a = E.aktionen(st, ich);
  if (!a?.erhoehen) return;
  if (a.erhoehen.min >= a.erhoehen.max) return meinZug({ art: "erhoehen", bis: a.erhoehen.max });
  const r = $("bis");
  r.min = a.erhoehen.min;
  r.max = a.erhoehen.max;
  r.value = a.erhoehen.min;
  $("bis-wert").textContent = zahl(r.value);
  $("erhoehen").hidden = false;
  $("aktionen").hidden = true;
  r.focus();
}
function schnellBetrag(teil) {
  const a = E.aktionen(st, ich);
  if (!a?.erhoehen) return;
  let bis = a.erhoehen.max;
  if (teil !== "all")
    bis = st.hoechst + Math.round(((E.topf(st) + a.mitgehen) * Number(teil)) / 5) * 5;
  bis = Math.max(a.erhoehen.min, Math.min(a.erhoehen.max, bis));
  $("bis").value = bis;
  $("bis-wert").textContent = zahl(bis);
}
$("a-passen").addEventListener("click", () => meinZug({ art: "passen" }));
$("a-mitgehen").addEventListener("click", () => {
  const a = E.aktionen(st, ich);
  if (a) meinZug({ art: a.schieben ? "schieben" : "mitgehen" });
});
$("a-erhoehen").addEventListener("click", erhoehenOeffnen);
$("bis").addEventListener("input", (e) => ($("bis-wert").textContent = zahl(e.target.value)));
document
  .querySelectorAll("[data-teil]")
  .forEach((k) => k.addEventListener("click", () => schnellBetrag(k.dataset.teil)));
$("e-zurueck").addEventListener("click", () => {
  $("erhoehen").hidden = true;
  zeigen();
});
$("e-ok").addEventListener("click", () =>
  meinZug({ art: "erhoehen", bis: Number($("bis").value) }),
);
$("weiter").addEventListener("click", naechsteHand);
$("nachkauf").addEventListener("click", () => {
  if (!sitzung || (laufend() && meinPlatz().drin && !meinPlatz().raus)) return;
  const b = geldNehmen(buyin);
  if (!b) {
    statusSetzen("Dein Konto ist leer – steh auf, um neues Startgeld zu holen.", "fehler");
    return;
  }
  sitzung.einsatz += b;
  if (rolle === "gast") {
    netz.verbindung.senden({ t: "nachkauf", betrag: b });
    statusSetzen(`${zahl(b)} nachgekauft – ab der nächsten Hand.`);
  } else if (laufend()) nachkauf.set(ich, (nachkauf.get(ich) || 0) + b);
  else meinPlatz().stack += b;
  zeigen();
  hostSenden();
  if (!laufend()) handPlanen();
});
document.addEventListener("keydown", (e) => {
  if ($("buehne").hidden || e.target.closest?.("input, textarea")) return;
  const k = e.key.toLowerCase();
  if (!$("aktionen").hidden) {
    if (k === "p") $("a-passen").click();
    else if (k === " ") {
      e.preventDefault();
      $("a-mitgehen").click();
    } else if (k === "e" && !$("a-erhoehen").hidden) $("a-erhoehen").click();
  } else if (
    k === "enter" &&
    !$("weiter-zeile").hidden &&
    !$("weiter").hidden &&
    document.activeElement?.tagName !== "BUTTON"
  )
    $("weiter").click();
});

/* ---------- Computer-Modus ---------- */
function soloStarten() {
  const b = geldNehmen(buyin);
  if (!b) return pleiteHinweis();
  sitzung = { einsatz: b, stack: b };
  sitzungSpeichern();
  rolle = "solo";
  st = null;
  const pl = [{ name: "Du", stack: b }];
  st = E.neuerTisch(pl);
  for (let i = 0; i < gegner; i++)
    st.spieler.push(E.neuerTisch([{ name: botName(), stack: buyin, bot: 1 }]).spieler[0]);
  ich = 0;
  gewertet = -1;
  statusSetzen("");
  ansicht(true);
  naechsteHand();
}

/* ---------- Online: Host ---------- */
function maskiert(j) {
  const m = E.kopie(st);
  delete m.deck;
  const zeigt = st.phase === "ende" && st.ergebnis?.showdown;
  m.spieler.forEach((s, i) => {
    if (i !== j && s.karten && !(zeigt && s.drin && !s.raus)) s.karten = s.karten.map(() => null);
  });
  return m;
}
function hostSenden() {
  if (rolle !== "host" || !netz?.raum) return;
  const rest = Math.max(0, zugBis - Date.now());
  for (const [platz, j] of gastSitz)
    netz.raum.senden(platz, { t: "stand", st: maskiert(j), ich: j, rest });
}
function freierSitz() {
  let j = st.spieler.findIndex(
    (s, i) => !s.sitzt && ![...gastSitz.values()].includes(i) && !(laufend() && s.drin),
  );
  if (j < 0 && st.spieler.length < 6) {
    st.spieler.push(E.neuerTisch([{ name: "", stack: 0 }]).spieler[0]);
    j = st.spieler.length - 1;
  }
  return j;
}
const buyinPruefen = (b) => Math.max(0, Math.min(1e6, Math.round(Number(b)) || 0));

async function hostStarten() {
  const b = geldNehmen(buyin);
  if (!b) return pleiteHinweis();
  sitzung = { einsatz: b, stack: b };
  sitzungSpeichern();
  rolle = "host";
  st = E.neuerTisch([{ name: "Platz 1", stack: b }]);
  ich = 0;
  gewertet = -1;
  gastSitz.clear();
  ansicht(true);
  statusSetzen("Eröffne Tisch …");
  zeigen();
  try {
    const raum = await raumEroeffnen(SPIEL, {
      gast() {
        statusSetzen("Jemand setzt sich …");
      },
      gastWeg(platz) {
        const j = gastSitz.get(platz);
        if (j === undefined) return;
        st.spieler[j].sitzt = false;
        statusSetzen(`${st.spieler[j].name} ist weg.`);
        if (laufend() && st.dran === j) nachZustand();
        else {
          zeigen();
          hostSenden();
        }
      },
      nachricht(platz, d) {
        if (!d || typeof d !== "object") return;
        let j = gastSitz.get(platz);
        if (d.t === "sitz") {
          const b = buyinPruefen(d.buyin);
          if (b < MIN_BUYIN) return;
          if (j === undefined) {
            j = freierSitz();
            if (j < 0) return netz.raum.senden(platz, { t: "voll" });
            gastSitz.set(platz, j);
            Object.assign(st.spieler[j], {
              name: `Platz ${j + 1}`,
              stack: laufend() ? 0 : b,
              sitzt: true,
              bot: null,
              drin: false,
              karten: null,
              einsatz: 0,
              gesamt: 0,
            });
            if (laufend()) ersatz.set(j, b);
            statusSetzen(`${st.spieler[j].name} hat sich gesetzt.`);
          } else {
            // Seite neu geladen: alter Stapel wurde dort schon abgerechnet
            st.spieler[j].sitzt = true;
            if (laufend()) ersatz.set(j, b);
            else st.spieler[j].stack = b;
          }
        } else if (j === undefined) return;
        else if (d.t === "da") st.spieler[j].sitzt = true;
        else if (d.t === "akt")
          return st.dran === j && ausfuehren(j, { art: String(d.art), bis: Number(d.bis) });
        else if (d.t === "nachkauf") {
          const b = buyinPruefen(d.betrag);
          if (!b) return;
          if (laufend()) nachkauf.set(j, (nachkauf.get(j) || 0) + b);
          else st.spieler[j].stack += b;
        } else return;
        zeigen();
        hostSenden();
        if (!laufend()) handPlanen();
      },
      status: (t, art) => statusSetzen(t, art),
    });
    netz = { rolle: "host", raum, code: raum.code };
    $("raumcode").textContent = raum.code;
    statusSetzen("Tisch offen – teile den Code.");
    zeigen();
  } catch (err) {
    abrechnen(meinPlatz()?.stack ?? 0);
    rolle = null;
    ansicht(false);
    $("menue-info").textContent = err.message || "Der Tisch ließ sich nicht eröffnen.";
  }
}

/* ---------- Online: Gast ---------- */
async function gastStarten(code) {
  if (kontostand() < MIN_BUYIN) return pleiteHinweis();
  rolle = "gast";
  st = null;
  gewertet = -1;
  $("menue-info").textContent = "Verbinde …";
  try {
    const verbindung = await raumBeitreten(SPIEL, code, {
      verbunden() {
        if (sitzung) return verbindung.senden({ t: "da" });
        const b = geldNehmen(buyin);
        if (!b) {
          statusSetzen("Dein Konto reicht nicht.", "fehler");
          return onlineEnde("Dein Konto reicht nicht.");
        }
        sitzung = { einsatz: b, stack: b };
        sitzungSpeichern();
        verbindung.senden({ t: "sitz", buyin: b });
        statusSetzen("Du sitzt am Tisch.");
      },
      nachricht(d) {
        if (d?.t === "voll") return onlineEnde("Der Tisch ist voll.");
        if (d?.t !== "stand" || !d.st?.spieler) return;
        st = d.st;
        ich = d.ich;
        zugBis = d.rest ? Date.now() + d.rest : 0;
        gastWartet = false;
        if (!$("erhoehen").hidden && st.dran !== ich) $("erhoehen").hidden = true;
        zeigen();
      },
      status: (t, art) => statusSetzen(t, art),
      ende: (grund) => onlineEnde(grund || "Der Tisch wurde geschlossen.", true),
    });
    netz = { rolle: "gast", verbindung, code };
    $("raumcode").textContent = code;
    ansicht(true);
    statusSetzen("Verbinde direkt …");
  } catch (err) {
    rolle = null;
    $("menue-info").textContent = err.message || "Beitreten hat nicht geklappt.";
  }
}

/* ---------- Aufstehen / Ende ---------- */
function onlineEnde(text, tischZu = false) {
  zeitenAus();
  clearTimeout(handTimer);
  handTimer = null;
  const n = netz;
  netz = null;
  let zurueck = 0;
  if (rolle === "host" || tischZu) zurueck = abrechnen(stapelMitEinsatz());
  else zurueck = abrechnen(meinPlatz()?.stack ?? 0);
  if (n?.rolle === "host") n.raum.schliessen();
  else if (n?.rolle === "gast") n.verbindung.verlassen();
  rolle = null;
  st = null;
  gastSitz.clear();
  ansicht(false);
  $("menue-info").textContent = `${text} ${zahl(zurueck)} zurück aufs Konto.`;
}
$("aufstehen").addEventListener("click", () =>
  onlineEnde(rolle === "solo" ? "Du bist aufgestanden." : "Du hast den Tisch verlassen."),
);
$("teilen").addEventListener("click", async () => {
  const code = netz?.code;
  if (!code) return;
  const url = `${location.origin}${location.pathname}?tisch=${code}`;
  try {
    if (navigator.share)
      await navigator.share({
        title: "Pokertisch",
        text: `Setz dich an meinen Pokertisch: ${code}`,
        url,
      });
    else {
      await navigator.clipboard.writeText(url);
      statusSetzen("Link kopiert.");
    }
  } catch {
    statusSetzen(`Code: ${code}`);
  }
});
window.addEventListener("pagehide", () => {
  if (rolle) onlineEnde("");
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

/* ---------- Menü ---------- */
function knopfWahl(gruppe, attr, wert, beiWahl) {
  gruppe.querySelectorAll(`[data-${attr}]`).forEach((k) => {
    k.setAttribute("aria-pressed", String(k.dataset[attr] === String(wert)));
    k.onclick = () => {
      gruppe
        .querySelectorAll(`[data-${attr}]`)
        .forEach((x) => x.setAttribute("aria-pressed", String(x === k)));
      beiWahl(k.dataset[attr]);
    };
  });
}
function modusSetzen(m) {
  modus = m;
  $("modi")
    .querySelectorAll("[data-modus]")
    .forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.modus === m)));
  $("gegner").hidden = m !== "computer";
  $("los-zeile").hidden = m !== "computer";
  $("online").hidden = m !== "online";
}
$("modi")
  .querySelectorAll("[data-modus]")
  .forEach((k) => k.addEventListener("click", () => modusSetzen(k.dataset.modus)));
knopfWahl($("gegner"), "gegner", gegner, (v) => (gegner = Number(v)));
knopfWahl($("buyin"), "buyin", buyin, (v) => (buyin = Number(v)));
$("los").addEventListener("click", soloStarten);
$("eroeffnen").addEventListener("click", hostStarten);
$("beitritt").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("code").value.toUpperCase().trim();
  if (!CODE_MUSTER.test(code)) {
    $("menue-info").textContent = "Der Code hat 4 Zeichen (A–Z, 2–9).";
    return;
  }
  gastStarten(code);
});

/* ---------- Start ---------- */
walletHud($("wallet-hud"));
const offen = lade(SPIEL, "offen", null);
if (offen && offen.einsatz > 0) {
  sitzung = offen;
  const z = abrechnen(offen.stack);
  $("menue-info").textContent = `Letzte Sitzung abgerechnet: ${zahl(z)} zurück aufs Konto.`;
}
toplisteAnzeigen($("topliste"), SPIEL, (p) => `+${zahl(p)}`);
const eingeladen = new URLSearchParams(location.search).get("tisch");
if (eingeladen) {
  modusSetzen("online");
  $("code").value = eingeladen.toUpperCase().slice(0, 4);
} else modusSetzen("computer");

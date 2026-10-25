/* ============================================================
   POKERTISCH · engine.js (Texas Hold'em No-Limit, rein, Node-testbar)
   ------------------------------------------------------------
   Karte = Zahl 0..51: Rang = k % 13 (0 = Zwei … 12 = Ass),
   Farbe = k / 13 (0 ♠, 1 ♥, 2 ♦, 3 ♣).
   Stand st:
     spieler[]: {name, stack, karten, einsatz (diese Setzrunde),
                 gesamt (diese Hand), raus, allin, drin, sitzt, bot}
     button, board[], deck[], phase (pause|preflop|flop|turn|river|ende),
     dran, hoechst, minRaise, gehandelt[], handNr, ergebnis
   ============================================================ */

export const SB = 5;
export const BB = 10;
export const RANG = "23456789TJQKA";
export const RANG_TEXT = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "B", "D", "K", "A"];
export const FARBE = ["♠", "♥", "♦", "♣"];
export const HAND_NAME = [
  "Höchste Karte",
  "Ein Paar",
  "Zwei Paare",
  "Drilling",
  "Straße",
  "Flush",
  "Full House",
  "Vierling",
  "Straight Flush",
];

export const rang = (k) => k % 13;
export const farbe = (k) => Math.floor(k / 13);

/** Zufall mit crypto (Browser + Node 20), sonst Math.random. */
export function zufall() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] / 4294967296;
  } catch {
    return Math.random();
  }
}

export function gemischt(z = zufall) {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(z() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/* ---------- Handbewertung: beste 5 aus 5–7 Karten ---------- */

/** Wert als Zahl (größer = besser). Kategorie = Math.floor(w / 13**5). */
export function bewerten(karten) {
  const anz = new Array(13).fill(0);
  const proFarbe = [[], [], [], []];
  for (const k of karten) {
    anz[rang(k)]++;
    proFarbe[farbe(k)].push(rang(k));
  }
  const strasse = (raenge) => {
    const hat = new Array(13).fill(false);
    for (const r of raenge) hat[r] = true;
    for (let h = 12; h >= 3; h--) {
      let ok = true;
      for (let i = 0; i < 5 && ok; i++) ok = hat[h - i < 0 ? 12 : h - i];
      if (ok) return h; // h = höchste Karte (3 = Fünf beim Ass-unten)
    }
    return -1;
  };
  const wert = (kat, ks) => {
    let w = kat;
    for (let i = 0; i < 5; i++) w = w * 13 + (ks[i] ?? 0);
    return w;
  };
  for (const f of proFarbe)
    if (f.length >= 5) {
      const h = strasse(f);
      if (h >= 0) return wert(8, [h]);
    }
  const nach = (n) => {
    const r = [];
    for (let i = 12; i >= 0; i--) if (anz[i] === n) r.push(i);
    return r;
  };
  const vier = nach(4),
    drei = nach(3),
    zwei = nach(2);
  const rest = (ohne, n) => {
    const r = [];
    for (let i = 12; i >= 0 && r.length < n; i--) if (anz[i] && !ohne.includes(i)) r.push(i);
    return r;
  };
  if (vier.length) return wert(7, [vier[0], ...rest([vier[0]], 1)]);
  if (drei.length >= 2 || (drei.length && zwei.length)) {
    const paar = drei.length >= 2 ? Math.max(drei[1], zwei[0] ?? -1) : zwei[0];
    return wert(6, [drei[0], paar]);
  }
  for (const f of proFarbe) if (f.length >= 5) return wert(5, f.sort((a, b) => b - a).slice(0, 5));
  const h = strasse(
    Object.keys(anz)
      .filter((i) => anz[i])
      .map(Number),
  );
  if (h >= 0) return wert(4, [h]);
  if (drei.length) return wert(3, [drei[0], ...rest([drei[0]], 2)]);
  if (zwei.length >= 2) return wert(2, [zwei[0], zwei[1], ...rest([zwei[0], zwei[1]], 1)]);
  if (zwei.length) return wert(1, [zwei[0], ...rest([zwei[0]], 3)]);
  return wert(0, rest([], 5));
}
export const kategorie = (w) => Math.floor(w / 13 ** 5);

/* ---------- Tisch ---------- */

export function neuerTisch(plaetze) {
  return {
    spieler: plaetze.map((p) => ({
      name: p.name,
      stack: p.stack,
      bot: p.bot ?? null,
      sitzt: true,
      karten: null,
      einsatz: 0,
      gesamt: 0,
      raus: false,
      allin: false,
      drin: false,
    })),
    button: -1,
    board: [],
    deck: [],
    phase: "pause",
    dran: -1,
    hoechst: 0,
    minRaise: BB,
    gehandelt: [],
    handNr: 0,
    ergebnis: null,
  };
}

export const kopie = (st) => JSON.parse(JSON.stringify(st));
const n = (st) => st.spieler.length;
const naechsterSitz = (st, ab, test) => {
  for (let i = 1; i <= n(st); i++) {
    const j = (ab + i) % n(st);
    if (test(st.spieler[j], j)) return j;
  }
  return -1;
};
const kannHandeln = (s) => s.drin && !s.raus && !s.allin;
const imSpiel = (s) => s.drin && !s.raus;

export const handMoeglich = (st) => st.spieler.filter((s) => s.sitzt && s.stack > 0).length >= 2;

function setzen(st, i, betrag) {
  const s = st.spieler[i];
  const b = Math.min(betrag, s.stack);
  s.stack -= b;
  s.einsatz += b;
  s.gesamt += b;
  if (s.stack === 0) s.allin = true;
}

/** Neue Hand geben. Liefert neuen Stand (oder den alten, wenn zu wenige). */
export function neueHand(alt, z = zufall) {
  if (!handMoeglich(alt)) return alt;
  const st = kopie(alt);
  for (const s of st.spieler) {
    Object.assign(s, { karten: null, einsatz: 0, gesamt: 0, raus: false, allin: false });
    s.drin = s.sitzt && s.stack > 0;
  }
  st.handNr++;
  st.board = [];
  st.ergebnis = null;
  st.deck = gemischt(z);
  st.button = naechsterSitz(st, st.button < 0 ? n(st) - 1 : st.button, (s) => s.drin);
  const aktive = st.spieler.filter((s) => s.drin).length;
  const sb = aktive === 2 ? st.button : naechsterSitz(st, st.button, (s) => s.drin);
  const bb = naechsterSitz(st, sb, (s) => s.drin);
  setzen(st, sb, SB);
  setzen(st, bb, BB);
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < n(st); i++) {
      const j = (st.button + 1 + i) % n(st);
      if (st.spieler[j].drin) (st.spieler[j].karten ??= []).push(st.deck.pop());
    }
  st.hoechst = BB;
  st.minRaise = BB;
  st.gehandelt = [];
  st.phase = "preflop";
  st.dran = naechsterSitz(st, bb, kannHandeln);
  st.sb = sb;
  st.bb = bb;
  st.letzt = null;
  if (st.dran < 0 || rundeFertig(st)) weiter(st);
  return st;
}

/** Was darf der Spieler am Zug? */
export function aktionen(st, i = st.dran) {
  const s = st.spieler[i];
  if (!s || i !== st.dran || !kannHandeln(s)) return null;
  const zuZahlen = Math.min(st.hoechst - s.einsatz, s.stack);
  const max = s.einsatz + s.stack;
  const minBis = Math.min(st.hoechst + st.minRaise, max);
  const darfErhoehen = max > st.hoechst && !(st.gehandelt.includes(i) && st.voll === false);
  return {
    schieben: zuZahlen === 0,
    mitgehen: zuZahlen,
    erhoehen: darfErhoehen ? { min: minBis, max } : null,
  };
}

function rundeFertig(st) {
  const offen = st.spieler.filter(
    (s, i) => kannHandeln(s) && (!st.gehandelt.includes(i) || s.einsatz < st.hoechst),
  );
  return offen.length === 0;
}

/** Aktion ausführen: {art: "passen"|"schieben"|"mitgehen"|"erhoehen", bis} */
export function handeln(alt, a) {
  const erlaubt = aktionen(alt);
  if (!erlaubt) return alt;
  const st = kopie(alt);
  const i = st.dran;
  const s = st.spieler[i];
  let art = a.art;
  if (art === "schieben" && !erlaubt.schieben) art = "passen";
  if (art === "erhoehen" && !erlaubt.erhoehen) art = "mitgehen";
  if (art === "passen") s.raus = true;
  else if (art === "schieben") {
    /* nichts */
  } else if (art === "mitgehen") setzen(st, i, erlaubt.mitgehen);
  else if (art === "erhoehen") {
    const bis = Math.max(
      erlaubt.erhoehen.min,
      Math.min(erlaubt.erhoehen.max, Math.round(a.bis) || 0),
    );
    const vorher = st.hoechst;
    setzen(st, i, bis - s.einsatz);
    if (s.einsatz > vorher) {
      const plus = s.einsatz - vorher;
      // volle Erhöhung öffnet die Runde neu, ein zu kleines All-in nicht
      if (plus >= st.minRaise) {
        st.minRaise = plus;
        st.gehandelt = [];
        st.voll = true;
      } else st.voll = false;
      st.hoechst = s.einsatz;
    }
  }
  if (!st.gehandelt.includes(i)) st.gehandelt.push(i);
  st.letzt = { platz: i, art, betrag: s.einsatz };
  const uebrig = st.spieler.filter(imSpiel);
  if (uebrig.length === 1) return abschluss(st);
  if (rundeFertig(st)) weiter(st);
  else
    st.dran = naechsterSitz(
      st,
      i,
      (x, j) => kannHandeln(x) && (!st.gehandelt.includes(j) || x.einsatz < st.hoechst),
    );
  return st;
}

/** Nächste Straße bzw. Showdown. */
function weiter(st) {
  for (;;) {
    for (const s of st.spieler) s.einsatz = 0;
    st.hoechst = 0;
    st.minRaise = BB;
    st.gehandelt = [];
    st.voll = true;
    if (st.phase === "river") return abschluss(st);
    const naechste = { preflop: "flop", flop: "turn", turn: "river" }[st.phase];
    st.deck.pop(); // Brennkarte
    const k = naechste === "flop" ? 3 : 1;
    for (let j = 0; j < k; j++) st.board.push(st.deck.pop());
    st.phase = naechste;
    const koennen = st.spieler.filter(kannHandeln).length;
    if (koennen >= 2) {
      st.dran = naechsterSitz(st, st.button, kannHandeln);
      return st;
    }
    // höchstens einer kann noch setzen: Board zu Ende auslegen
  }
}

/** Töpfe verteilen (mit Nebentöpfen). */
function abschluss(st) {
  st.phase = "ende";
  st.dran = -1;
  const im = st.spieler.map((s, i) => i).filter((i) => imSpiel(st.spieler[i]));
  const showdown = im.length > 1;
  if (showdown) while (st.board.length < 5) st.board.push(st.deck.pop());
  const werte = st.spieler.map((s) =>
    showdown && imSpiel(s) ? bewerten([...s.karten, ...st.board]) : -1,
  );
  const gewinn = st.spieler.map(() => 0);
  const stufen = [...new Set(st.spieler.map((s) => s.gesamt).filter((g) => g > 0))].sort(
    (a, b) => a - b,
  );
  let vorher = 0;
  const toepfe = [];
  for (const stufe of stufen) {
    let topf = 0;
    for (const s of st.spieler) topf += Math.min(s.gesamt, stufe) - Math.min(s.gesamt, vorher);
    let berechtigt = im.filter((i) => st.spieler[i].gesamt >= stufe);
    if (!berechtigt.length) berechtigt = im; // nur wenn alle darüber gepasst haben
    const best = Math.max(...berechtigt.map((i) => werte[i]));
    const sieger = berechtigt.filter((i) => werte[i] === best);
    // ungerader Chip an den ersten Sieger links vom Button
    sieger.sort(
      (a, b) => ((a - st.button - 1 + n(st)) % n(st)) - ((b - st.button - 1 + n(st)) % n(st)),
    );
    const teil = Math.floor(topf / sieger.length);
    sieger.forEach((i, j) => (gewinn[i] += teil + (j < topf - teil * sieger.length ? 1 : 0)));
    toepfe.push({ betrag: topf, sieger });
    vorher = stufe;
  }
  st.spieler.forEach((s, i) => (s.stack += gewinn[i]));
  st.ergebnis = {
    showdown,
    toepfe,
    gewinn,
    netto: st.spieler.map((s, i) => gewinn[i] - s.gesamt),
    hand: werte.map((w) => (w >= 0 ? HAND_NAME[kategorie(w)] : null)),
  };
  return st;
}

export const topf = (st) => st.spieler.reduce((a, s) => a + s.gesamt, 0);

/* ---------- Computer ---------- */

/** Gewinnchance per Simulation gegen die Gegner, die noch drin sind. */
export function chance(st, i, runden = 160, z = Math.random) {
  const mein = st.spieler[i].karten;
  const gegner = st.spieler.filter((s, j) => j !== i && imSpiel(s)).length;
  const bekannt = new Set([...mein, ...st.board]);
  const rest = [...Array(52).keys()].filter((k) => !bekannt.has(k));
  let punkte = 0;
  for (let r = 0; r < runden; r++) {
    const d = rest.slice();
    let m = d.length;
    const ziehe = () => {
      const j = Math.floor(z() * m);
      const k = d[j];
      d[j] = d[--m];
      return k;
    };
    const board = st.board.slice();
    const gk = [];
    for (let g = 0; g < gegner; g++) gk.push([ziehe(), ziehe()]);
    while (board.length < 5) board.push(ziehe());
    const ich = bewerten([...mein, ...board]);
    let besser = 0,
      gleich = 0;
    for (const h of gk) {
      const w = bewerten([...h, ...board]);
      if (w > ich) besser++;
      else if (w === ich) gleich++;
    }
    if (!besser) punkte += 1 / (gleich + 1);
  }
  return punkte / runden;
}

/** Computerentscheidung. */
export function computerZug(st, z = Math.random) {
  const i = st.dran;
  const a = aktionen(st, i);
  if (!a) return null;
  const s = st.spieler[i];
  const c = chance(st, i, 160, z);
  const pot = topf(st);
  const quote = a.mitgehen / (pot + a.mitgehen || 1);
  const gegner = st.spieler.filter((x, j) => j !== i && imSpiel(x)).length;
  const fair = 1 / (gegner + 1);
  const mut = z() * 0.12 - 0.04; // etwas Laune
  const staerke = c - fair + mut;
  const groesse = (f) => Math.round((Math.max(pot, BB * 2) * f + st.hoechst) / 5) * 5;
  if (
    a.erhoehen &&
    (staerke > 0.25 || (staerke > 0.1 && z() < 0.35) || (a.schieben && z() < 0.07))
  ) {
    const bis = staerke > 0.4 && z() < 0.3 ? a.erhoehen.max : groesse(staerke > 0.3 ? 0.9 : 0.55);
    return { art: "erhoehen", bis: Math.min(a.erhoehen.max, Math.max(a.erhoehen.min, bis)) };
  }
  if (a.schieben) return { art: "schieben" };
  // Mitgehen, wenn die Chance den Preis trägt (große Einsätze vorsichtiger)
  const druck = a.mitgehen / (s.stack + s.einsatz || 1);
  if (c + mut * 0.5 > quote + druck * 0.25) return { art: "mitgehen" };
  return { art: "passen" };
}

/** Kartentext, z.B. "A♠". */
export const karteText = (k) => RANG_TEXT[rang(k)] + FARBE[farbe(k)];

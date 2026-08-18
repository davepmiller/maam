"use strict";
const $ = s => document.querySelector(s);
let DB = null, CODEIDX = new Map(), CBAIDX = new Map(), STIDX = {};

/* ---------------- locality state ---------------- */
const LS = "allowed.v1";

// Deploy-time switch. PIN_ON = false ships the CATALOG below as a fixed list: search
// still works and every code in the dataset is still findable, but nothing can be
// pinned, unpinned or cleared, and a list saved by an earlier build cannot override it.
const PIN_ON = false;

// Moscow, ID (83843) -- Latah County is on the CMS rural ZIP list and in no former CBA
const HOME = { state:"ID", zip:"83843", rural:true, cbaIdx:-1 };

// Product lines carried by Northwest Respiratory & Medical (nwdme.com).
// [group, HCPCS, modifier] -- the modifier is the one the item is normally billed under,
// which tracks the CMS payment category: capped rental and frequently serviced -> RR,
// routinely purchased -> NU, lymphedema compression -> none, surgical dressing -> AW.
// Where the client's product line and the CMS category disagree, CMS wins (see A6545).
const CATALOG = [
  ["Sleep therapy", "E0601","RR"], ["Sleep therapy", "E0470","RR"], ["Sleep therapy", "E0471","RR"],
  ["Sleep therapy", "E0466","RR"], ["Sleep therapy", "E0562","RR"],
  ["Sleep therapy", "A7030","NU"], ["Sleep therapy", "A7031","NU"], ["Sleep therapy", "A7032","NU"],
  ["Sleep therapy", "A7033","NU"], ["Sleep therapy", "A7034","NU"], ["Sleep therapy", "A7035","NU"],
  ["Sleep therapy", "A7036","NU"], ["Sleep therapy", "A7037","NU"], ["Sleep therapy", "A7038","NU"],
  ["Sleep therapy", "A7039","NU"], ["Sleep therapy", "A7046","NU"],
  ["Sleep therapy", "A7027","NU"], ["Sleep therapy", "A7028","NU"], ["Sleep therapy", "A7029","NU"],
  ["Sleep therapy", "A4604","NU"],

  ["Oxygen", "E1390","RR"], ["Oxygen", "E0431","RR"], ["Oxygen", "E0443",""],

  ["Nebulizers", "E0570","RR"], ["Nebulizers", "A7004","NU"], ["Nebulizers", "A7005","NU"],

  ["Power mobility", "K0813","RR"], ["Power mobility", "K0820","RR"], ["Power mobility", "K0822","RR"],
  ["Power mobility", "K0823","RR"], ["Power mobility", "K0856","RR"], ["Power mobility", "K0861","RR"],
  ["Power mobility", "K0821","RR"], ["Power mobility", "K0835","RR"], ["Power mobility", "K0841","RR"],
  ["Power mobility", "K0843","RR"], ["Power mobility", "K0848","RR"], ["Power mobility", "K0862","RR"],

  ["Manual mobility", "K0001","RR"], ["Manual mobility", "K0002","RR"], ["Manual mobility", "K0003","RR"],
  ["Manual mobility", "K0004","RR"], ["Manual mobility", "K0005","NU"],
  ["Manual mobility", "E0135","NU"], ["Manual mobility", "E0143","NU"], ["Manual mobility", "E0154","NU"],
  ["Manual mobility", "E0100","NU"], ["Manual mobility", "E0105","NU"],
  ["Manual mobility", "E1161","RR"], ["Manual mobility", "E0111","NU"], ["Manual mobility", "E0149","RR"],
  ["Manual mobility", "E0156","NU"], ["Manual mobility", "E0181","RR"], ["Manual mobility", "E0630","RR"],
  ["Manual mobility", "E0163","NU"], ["Manual mobility", "E0165","RR"], ["Manual mobility", "E0168","NU"],

  ["Lift chairs", "E0627","NU"],

  ["Beds & support", "E0265","RR"], ["Beds & support", "E0266","RR"], ["Beds & support", "E0277","RR"],
  ["Beds & support", "E0272","NU"], ["Beds & support", "E0305","RR"],

  ["Breast pumps", "E0602","NU"],

  ["Compression", "A6530",""], ["Compression", "A6533",""], ["Compression", "A6539",""],
  ["Compression", "A6552",""], ["Compression", "A6534",""], ["Compression", "A6540",""],
  ["Compression", "A6578",""], ["Compression", "A6582",""], ["Compression", "A6581",""],
  ["Compression", "A6583",""], ["Compression", "A6587",""], ["Compression", "A6585",""],

  // the client groups A6545 with the compression items above, but CMS classifies it as a
  // surgical dressing billed under AW -- CMS wins, so it gets its own line
  ["Surgical dressings", "A6545","AW"],

  ["Wheelchair accessories", "E0951","NU"], ["Wheelchair accessories", "E0953","NU"],
  ["Wheelchair accessories", "E0954","NU"], ["Wheelchair accessories", "E0956","NU"],
  ["Wheelchair accessories", "E0960","NU"], ["Wheelchair accessories", "E0961","NU"],
  ["Wheelchair accessories", "E0971","NU"], ["Wheelchair accessories", "E0973","NU"],
  ["Wheelchair accessories", "E0978","NU"], ["Wheelchair accessories", "E2213","NU"],
  ["Wheelchair accessories", "E2359","NU"], ["Wheelchair accessories", "E2361","NU"],
  ["Wheelchair accessories", "E2363","NU"], ["Wheelchair accessories", "E2605","NU"],
  ["Wheelchair accessories", "E2607","NU"], ["Wheelchair accessories", "E2615","NU"],
  ["Wheelchair accessories", "E2620","NU"], ["Wheelchair accessories", "E2622","NU"],
  ["Wheelchair accessories", "E2624","NU"],
  ["Wheelchair accessories", "E0955","RR"], ["Wheelchair accessories", "E1002","RR"],
  ["Wheelchair accessories", "E1007","RR"], ["Wheelchair accessories", "E1012","RR"],
  ["Wheelchair accessories", "E1028","RR"], ["Wheelchair accessories", "E2298","RR"],
  ["Wheelchair accessories", "E2310","RR"], ["Wheelchair accessories", "E2311","RR"],
  ["Wheelchair accessories", "E2313","RR"], ["Wheelchair accessories", "E2377","RR"],
];
const defaultPins = () => CATALOG.map(([, code, mod]) => ({k:code+"|"+mod+"|"}));

// a pin's section is derived from the catalog, never stored -- so a code pinned by
// hand files itself under its own product line instead of a generic bucket, and an
// unpin/repin round trip puts it back where it started
const CODEGROUP = new Map(CATALOG.map(([g, code]) => [code, g]));
const GROUPRANK = new Map([...new Set(CATALOG.map(([g]) => g))].map((g, n) => [g, n]));
const OTHER = "Pinned";                                  // codes the catalog doesn't carry
const groupOf = k => CODEGROUP.get(k.split("|")[0]) || OTHER;
const rankOf = g => GROUPRANK.has(g) ? GROUPRANK.get(g) : GROUPRANK.size;

let loc = Object.assign({}, HOME);
let pins = [];
let collapsed = [];   // group names folded shut; everything starts open

let storedPins = null;   // kept verbatim while PIN_ON is off, so turning it back on restores the list

function load(){
  let s = null;
  try{ s = JSON.parse(localStorage.getItem(LS) || "null"); }catch(e){}
  pins = defaultPins();                             // first run, and the fixed list when pinning is off
  if (!s) return;
  if (s.loc) loc = Object.assign(loc, s.loc);
  if (Array.isArray(s.collapsed))
    collapsed = s.collapsed.filter(x => typeof x === "string");
  if (Array.isArray(s.pins)) storedPins = s.pins;
  if (!PIN_ON || !storedPins) return;               // a saved list can never override the catalog
  pins = storedPins.map(p => typeof p === "string" ? {k:p} : p)   // pre-v1 pins were bare keys
                   .filter(p => p && typeof p.k === "string")
                   .map(p => ({k:p.k}));                          // drop any stored group
}
function save(){
  const keep = PIN_ON ? pins : storedPins;          // don't clobber a list we're not letting them edit
  try{ localStorage.setItem(LS, JSON.stringify({loc, pins:keep, collapsed})); }catch(e){}
}

/* ---------------- data load ---------------- */
async function boot(){
  const b64 = document.getElementById("payload").textContent.trim();
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  let text;
  if (typeof DecompressionStream === "function"){
    const ds = new DecompressionStream("gzip");
    text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
  } else {
    throw new Error("This browser cannot decompress the embedded dataset.");
  }
  DB = JSON.parse(text);

  DB.states.forEach((s,i) => STIDX[s] = i);
  DB.rows.forEach((r,i) => {
    const k = r[0];
    if (!CODEIDX.has(k)) CODEIDX.set(k, []);
    CODEIDX.get(k).push(i);
  });
  DB.cbaRows.forEach(r => {
    CBAIDX.set(r[0]+"|"+r[1]+"|"+r[2], r);
    if (!CBAIDX.has(r[0]+"|"+r[1])) CBAIDX.set(r[0]+"|"+r[1], r);
  });

  $("#qtr").textContent = DB.quarter;
  $("#fqtr").textContent = DB.quarter;
  $("#fsrc").textContent = DB.source.split("/").pop();

  const sel = $("#state");
  DB.states.forEach(s => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s + " \u2014 " + (STATE_NAMES[s] || s);
    sel.appendChild(o);
  });

  load();
  paintLoc();
  render();
  runCheck(false);   // non-blocking: the page is usable before the check returns
}

const STATE_NAMES = {AL:"Alabama",AR:"Arkansas",AZ:"Arizona",CA:"California",CO:"Colorado",CT:"Connecticut",
DC:"District of Columbia",DE:"Delaware",FL:"Florida",GA:"Georgia",IA:"Iowa",ID:"Idaho",IL:"Illinois",IN:"Indiana",
KS:"Kansas",KY:"Kentucky",LA:"Louisiana",MA:"Massachusetts",MD:"Maryland",ME:"Maine",MI:"Michigan",MN:"Minnesota",
MO:"Missouri",MS:"Mississippi",MT:"Montana",NC:"North Carolina",ND:"North Dakota",NE:"Nebraska",NH:"New Hampshire",
NJ:"New Jersey",NM:"New Mexico",NV:"Nevada",NY:"New York",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",
RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VA:"Virginia",
VT:"Vermont",WA:"Washington",WI:"Wisconsin",WV:"West Virginia",WY:"Wyoming",AK:"Alaska",HI:"Hawaii",
PR:"Puerto Rico",VI:"U.S. Virgin Islands"};

const NONCONT = new Set(["AK","HI","PR","VI"]);

/* ---------------- locality resolution ---------------- */
function resolveZip(z){
  z = (z||"").trim();
  if (!/^\d{5}$/.test(z)) return null;
  if (Object.prototype.hasOwnProperty.call(DB.cbaZips, z)){
    return {kind:"cba", cbaIdx:DB.cbaZips[z], state:DB.cbaZipState[z] || null,
            name:DB.cbaNames[DB.cbaZips[z]][1]};
  }
  if (Object.prototype.hasOwnProperty.call(DB.ruralZips, z)){
    return {kind:"rural", cbaIdx:-1, state:DB.ruralZips[z], name:null};
  }
  return {kind:"nonrural", cbaIdx:-1, state:null, name:null};
}

function basis(){
  if (loc.cbaIdx >= 0) return "cba";
  return loc.rural ? "rural" : "nonrural";
}
function locLabel(){
  if (basis() === "cba") return DB.cbaNames[loc.cbaIdx][0];
  const base = loc.rural ? loc.state + " rural"
                         : loc.state + (NONCONT.has(loc.state) ? "" : " non-rural");
  return loc.zip ? loc.zip + " " + base : base;
}
function paintLoc(){
  $("#locbtn").dataset.basis = basis();
  $("#locname").textContent = locLabel();
}

/* ---------------- rate lookup ----------------
   CMS: "Fee schedule amounts for those codes not adjusted using competitive
   bidding information will only have fee schedule amounts in the non-rural (NR)
   columns." So an empty column is not "unpriced" -- the other column carries the
   single amount that applies in every area. Codes bid only for use with
   non-competitive-bid base equipment (KE) are the mirror case, R-only. */
function pickCol(row, i){
  const nr = row[8][i], ru = row[9][i];
  if (loc.rural){
    if (ru > 0) return {amt:ru, kind:"rural"};
    if (nr > 0) return {amt:nr, kind:"flat"};
  } else {
    if (nr > 0) return {amt:nr, kind:"nonrural"};
    if (ru > 0) return {amt:ru, kind:"flat"};
  }
  return {amt:0, kind:"none"};
}
function labelFor(kind){
  if (kind === "rural") return loc.state + " rural";
  if (kind === "nonrural") return loc.state + (NONCONT.has(loc.state) ? "" : " non-rural");
  if (kind === "flat") return loc.state + ", all areas";
  return loc.state;
}
function cbaRow(row){
  return CBAIDX.get(row[0]+"|"+row[1]+"|"+row[2]) || CBAIDX.get(row[0]+"|"+row[1]);
}
function rate(row){
  const si = STIDX[loc.state];
  if (loc.cbaIdx >= 0){
    const cr = cbaRow(row);
    if (cr){
      const v = cr[5][loc.cbaIdx];
      if (v > 0) return {amt:v, basis:"cba", label:DB.cbaNames[loc.cbaIdx][1]};
    }
    const s = pickCol(row, si);
    return {amt:s.amt, basis:"cba-fallback", kind:s.kind, label:labelFor(s.kind)};
  }
  const s = pickCol(row, si);
  return {amt:s.amt, basis:s.kind, kind:s.kind, label:labelFor(s.kind)};
}

// the same code priced everywhere else, resolved on the same basis as the user
function peers(row){
  let vals;
  if (loc.cbaIdx >= 0){
    const cr = cbaRow(row);
    vals = cr ? cr[5].slice() : [];
  } else {
    vals = DB.states.map((s, i) => pickCol(row, i).amt);
  }
  vals = vals.filter(v => v > 0).sort((a,b)=>a-b);
  if (!vals.length) return null;
  return {vals, min:vals[0], max:vals[vals.length-1], n:vals.length};
}

// the other column, when it is genuinely a different number worth seeing
function altRate(row){
  if (loc.cbaIdx >= 0) return null;
  const si = STIDX[loc.state];
  const mine = pickCol(row, si);
  const other = loc.rural ? row[8][si] : row[9][si];
  if (!(other > 0) || other === mine.amt || mine.kind === "flat") return null;
  return {amt:other, label:(loc.rural ? "Non-rural " : "Rural ") + loc.state};
}

const usd = n => "$" + n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const isRental = row => row[1] === "RR";

/* ---------------- search ---------------- */
function search(qs){
  const q = qs.trim().toUpperCase();
  if (!q) return [];
  const out = [], seen = new Set();
  if (CODEIDX.has(q)) CODEIDX.get(q).forEach(i => { out.push(i); seen.add(i); });
  if (out.length < 40){
    for (const [code, idxs] of CODEIDX){
      if (code.startsWith(q)) for (const i of idxs) if (!seen.has(i)){ out.push(i); seen.add(i); }
      if (out.length > 60) break;
    }
  }
  if (out.length < 25 && q.length >= 3){
    for (let i=0;i<DB.rows.length;i++){
      if (seen.has(i)) continue;
      if (DB.rows[i][7].toUpperCase().includes(q)){ out.push(i); seen.add(i); }
      if (out.length > 60) break;
    }
  }
  return out;
}

/* ---------------- render ---------------- */
function card(i, isNew){
  const row = DB.rows[i];
  const r = rate(row);
  const p = peers(row);
  const alt = altRate(row);
  const el = document.createElement("div");
  el.className = "card" + (isNew ? " is-new" : "");

  const tags = [];
  if (row[1]) tags.push(`<span class="tag mod">${row[1]}${row[2] ? " "+row[2] : ""}</span>`);
  tags.push(`<span class="tag" title="${DB.catg[row[4]]||row[4]}">${row[4]}</span>`);

  const nil = !(r.amt > 0);
  const amtHtml = nil
    ? `<span class="amt nil">not priced</span>`
    : `<span class="amt">${usd(r.amt)}</span>${isRental(row) ? `<span class="per">/ month</span>` : ``}`;

  let spread = "";
  if (!nil && p && p.max > p.min){
    const at = v => ((v - p.min) / (p.max - p.min) * 100);
    const pct = Math.max(0, Math.min(100, at(r.amt)));
    const noun = r.basis === "cba" ? "former CBAs" : "states";
    // one tick per comparable locality &mdash; shows the real distribution, not just the range
    const ticks = p.vals.map(v => `<div class="tick" style="left:${at(v).toFixed(2)}%"></div>`).join("");
    const below = p.vals.filter(v => v < r.amt).length;
    spread = `
      <div class="spread">
        <div class="spread-lab">
          <span>Every ${noun.replace(/s$/,"")} rate</span>
          <span>above ${below} of ${p.n} ${noun}</span>
        </div>
        <div class="track">
          <div class="rail"></div>${ticks}
          <div class="you" style="left:calc(${pct.toFixed(2)}% - 1px)"></div>
        </div>
        <div class="spread-ends"><span>${usd(p.min)}</span><span>${usd(p.max)}</span></div>
      </div>`;
  }

  let note = `Allowed amount for <b>${r.label}</b>, ${DB.quarter}.`;
  let cls = "note";
  if (r.basis === "cba") note = `Former competitive&#8209;bidding area rate \u2014 <b>${r.label}</b>, ${DB.quarter}.`;
  if (r.basis === "cba-fallback")
    note = `Not a competitive&#8209;bidding item, so the standard <b>${r.label}</b> rate applies in your area.`;
  if (r.kind === "flat")
    note = `This code was not adjusted using competitive&#8209;bidding information, so one
            <b>${loc.state}</b> amount applies in rural and non&#8209;rural areas alike.`;
  if (nil){
    cls = "note warn";
    note = `CMS lists 0.00 for this code in ${loc.state} \u2014 individually priced, gap&#8209;filled, or not payable on this schedule.`;
  }
  if (row[4] === "CR" && !nil) note += ` Capped rental: payment stops after 13 months.`;

  el.innerHTML = `
    <div class="chead"><span class="code">${row[0]}</span>${tags.join("")}</div>
    <div class="desc">${esc(row[7])}</div>
    <div class="amtrow">
      ${amtHtml}
      ${nil ? "" : `<div class="amtmeta">allowed${isRental(row)?" per rental month":""}<br><b>${r.label}</b></div>`}
    </div>
    ${nil ? "" : `<div class="split">
      <div>Medicare pays 80%<b>${usd(r.amt*0.8)}</b></div>
      <div>Patient owes 20%<b>${usd(r.amt*0.2)}</b></div>
      ${alt ? `<div>${alt.label}<b>${usd(alt.amt)}</b></div>` : ``}
    </div>`}
    ${spread}
    <div class="acts">
      ${PIN_ON ? `<button class="btn" data-act="pin" data-i="${i}">${pinned(i) ? "Unpin" : "Pin"}</button>` : ``}
      <button class="btn" data-act="copy" data-i="${i}">Copy</button>
    </div>
    <div class="${cls}">${note}</div>`;
  return el;
}

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// pins are stored as stable "CODE|MOD|MOD2" keys so they survive a dataset refresh
const keyOf = i => DB.rows[i][0]+"|"+DB.rows[i][1]+"|"+DB.rows[i][2];
const pinned = i => pins.some(p => p.k === keyOf(i));
function indexOfKey(k){
  const idxs = CODEIDX.get(k.split("|")[0]) || [];
  return idxs.find(i => keyOf(i) === k);
}
/* The search box narrows the list below it. A leading "/" escapes that and searches
   the whole fee schedule instead, rendering matches above an untouched list. */
const isGlobal = v => v.trimStart().startsWith("/");
const bareQuery = v => v.trim().replace(/^\/+/, "").trim().toUpperCase();
// what the list is filtered by right now, or null when it isn't
const listFilter = () => {
  const v = $("#q").value;
  return isGlobal(v) ? null : (v.trim().toUpperCase() || null);
};
// same shape as search(): match the code from its start, the description only once
// the query is specific enough that a substring hit means something
const rowMatches = (i, q) =>
  DB.rows[i][0].startsWith(q) || (q.length >= 3 && DB.rows[i][7].toUpperCase().includes(q));

// pins grouped in catalog order, skipping any key the current dataset no longer has.
// a group appears the moment its first code is pinned and disappears with its last.
function pinGroups(){
  const q = listFilter();
  const groups = new Map();
  for (const p of pins){
    const i = indexOfKey(p.k);
    if (i === undefined) continue;
    if (q && !rowMatches(i, q)) continue;
    const g = groupOf(p.k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  // catalog order regardless of when each code was pinned; off-catalog codes last
  return new Map([...groups].sort((a, b) => rankOf(a[0]) - rankOf(b[0])));
}
function togglePin(i){
  if (!PIN_ON) return;
  const k = keyOf(i);
  if (pinned(i)) pins = pins.filter(p => p.k !== k);
  else pins.push({k});
  save(); render();
}

let lastTop = -1;
function render(){
  renderPins();                       // the list tracks the filter on every keystroke
  const box = $("#results");
  box.innerHTML = "";
  if (!isGlobal($("#q").value)){ lastTop = -1; return; }
  const q = bareQuery($("#q").value);
  if (!q){ lastTop = -1; return; }
  const res = search(q);
  if (!res.length){
    box.innerHTML = `<div class="empty">Nothing on the DMEPOS fee schedule matches that.
      Try a partial code like <b>A70</b>. Codes that are individually priced, gap&#8209;filled, or paid
      under a different fee schedule are not listed here.</div>`;
    lastTop = -1;
    return;
  }
  box.appendChild(card(res[0], res[0] !== lastTop));
  lastTop = res[0];
  if (res.length > 1){
    const sec = document.createElement("div");
    sec.className = "sec";
    sec.innerHTML = `<span>${res.length - 1} more</span><i></i>`;
    box.appendChild(sec);
    res.slice(1, 26).forEach(i => box.appendChild(rowEl(i, false)));
  }
}

function rowEl(i, withX){
  const row = DB.rows[i], r = rate(row);
  const el = document.createElement("div");
  el.className = "row";
  const main = document.createElement("button");
  main.className = "main";
  main.innerHTML = `<span class="rc">${row[0]}</span><span class="rm">${row[1]||""}</span>
    <span class="rd">${esc(row[7])}</span>
    <span class="rv">${r.amt>0 ? usd(r.amt) + (isRental(row)?"/mo":"") : "&mdash;"}</span>`;
  // drilling into a row means seeing its card, which only the global view renders
  main.addEventListener("click", () => { $("#q").value = "/" + row[0]; render(); $("#q").select(); });
  el.appendChild(main);
  if (withX && PIN_ON){
    const x = document.createElement("button");
    x.className = "rx"; x.textContent = "\u00d7";
    x.setAttribute("aria-label", "Unpin " + row[0]);
    x.addEventListener("click", () => togglePin(i));
    el.appendChild(x);
  }
  return el;
}

function renderPins(){
  const wrap = $("#pinwrap"), box = $("#pins");
  const q = listFilter();
  const groups = pinGroups();
  wrap.hidden = false;
  box.innerHTML = "";
  if (!groups.size){
    if (q)
      box.innerHTML = `<div class="empty">Nothing in this list matches <b>${esc(q)}</b>.
        Start over with <kbd>/</kbd> to search every code on the fee schedule.</div>`;
    else if (PIN_ON){
      box.innerHTML = `<div class="empty">No codes pinned. Search a code and press
        <kbd>&#8629;</kbd> to pin it, or <button class="link" id="restore">load the catalog</button>.</div>`;
      $("#restore").addEventListener("click", () => { pins = defaultPins(); save(); render(); });
    }
    else box.innerHTML = `<div class="empty">No codes to show.</div>`;
    return;
  }
  let n = 0;
  for (const [g, idxs] of groups){
    const id = "grp" + (n++);
    const open = q ? true : !collapsed.includes(g);   // a filter hit must never sit behind a fold

    const head = document.createElement("button");
    head.className = "sec grp";
    head.id = id + "-h";
    head.setAttribute("aria-expanded", String(open));
    head.setAttribute("aria-controls", id);
    head.innerHTML = `<span class="car">&#9662;</span><span>${esc(g)}</span>
                      <i></i><span class="n">${idxs.length}</span>`;

    const body = document.createElement("div");
    body.id = id;
    body.setAttribute("role", "group");
    body.setAttribute("aria-labelledby", head.id);
    body.hidden = !open;
    idxs.forEach(i => body.appendChild(rowEl(i, true)));

    head.addEventListener("click", () => {
      const opening = body.hidden;
      body.hidden = !opening;
      head.setAttribute("aria-expanded", String(opening));
      collapsed = opening ? collapsed.filter(x => x !== g) : collapsed.concat(g);
      save();
    });

    box.appendChild(head);
    box.appendChild(body);
  }
}

function pinLine(i){
  const row = DB.rows[i], r = rate(row);
  return `${row[0]}${row[1] ? " "+row[1] : ""} = ${r.amt>0 ? usd(r.amt) + (isRental(row)?"/mo":"") : "not priced"}`;
}
function copyText(){
  const out = [];
  for (const [g, idxs] of pinGroups()){
    out.push(g.toUpperCase(), ...idxs.map(pinLine), "");
  }
  out.push(`Medicare allowed \u2014 ${locLabel()}, ${DB.quarter}`);
  return out.join("\n");
}

function toast(msg){
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 1500);
}
async function copy(text){
  try{ await navigator.clipboard.writeText(text); toast("Copied"); }
  catch(e){
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); toast("Copied"); }catch(_){ toast("Copy failed"); }
    ta.remove();
  }
}

/* ---------------- theme ----------------
   Three states, matching the CSS: no attribute = follow the OS, which keeps
   working live via the media query if the OS flips while the page is open. */
const THEMES = ["system", "light", "dark"];
const THEME_LS = "allowed.theme";

function applyTheme(t){
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const btn = $("#themebtn");
  btn.dataset.mode = t;
  $("#thememode").textContent = t === "system" ? "Sys" : t;
  btn.setAttribute("aria-label",
    "Theme: " + (t === "system" ? "follow system" : t) + ". Activate to change.");
}
function currentTheme(){
  let t = null;
  try{ t = localStorage.getItem(THEME_LS); }catch(e){}
  return THEMES.includes(t) ? t : "system";
}
function cycleTheme(){
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  try{ localStorage.setItem(THEME_LS, next); }catch(e){}
  applyTheme(next);
}

/* ---------------- is a newer quarter out? ----------------
   CMS publishes each DMEPOS update at a predictable path: the January file is
   dme{YY}.zip, and later quarters are dme{YY}-b (April), -c (July), -d (October).
   Those files answer cross-origin with access-control-allow-origin:*, so a HEAD
   costs nothing and 404 vs 200 tells us whether a quarter has actually shipped --
   CMS updates "as necessary", so a new quarter starting is not proof of a new file.
   On the hosted copy the page CSP blocks the request; then we fall back to the
   calendar alone and say plainly that the check could not run. */
const CMS_PAGE = "https://www.cms.gov/medicare/payment/fee-schedules/dmepos/dmepos-fee-schedule";
const QNAME = {1:"January", 2:"April", 3:"July", 4:"October"};
const CHECK_EVERY = 6 * 60 * 60 * 1000;

function dataQuarter(){
  const [y, m] = DB.effective.split("-").map(Number);
  return {y, q: Math.floor((m - 1) / 3) + 1};
}
function fileFor(y, q){
  const yy = String(y).slice(2);
  return q === 1 ? `dme${yy}` : `dme${yy}-${"?bcd"[q - 1]}`;
}
function quartersAfter(from){
  const now = new Date(), cy = now.getFullYear(), cq = Math.floor(now.getMonth() / 3) + 1;
  const out = [];
  let {y, q} = from;
  for (let n = 0; n < 12; n++){
    q++; if (q > 4){ q = 1; y++; }
    // allow one quarter ahead: CMS posts the January file in December
    if (y > cy + 1 || (y * 4 + q) > (cy * 4 + cq + 1)) break;
    out.push({y, q});
  }
  return out;
}
async function published(y, q){
  const res = await fetch(`https://www.cms.gov/files/zip/${fileFor(y, q)}.zip`,
                          {method:"HEAD", cache:"no-store"});
  return res.ok;
}
async function checkForUpdate(force){
  const mine = dataQuarter();
  const ahead = quartersAfter(mine);
  if (!ahead.length) return {state:"current", at:Date.now()};

  let cached = null;
  try{ cached = JSON.parse(localStorage.getItem(LS + ".upd") || "null"); }catch(e){}
  if (!force && cached && Date.now() - cached.at < CHECK_EVERY) return cached;

  let result;
  try{
    result = {state:"current", at:Date.now()};
    for (let i = ahead.length - 1; i >= 0; i--){            // newest first
      if (await published(ahead[i].y, ahead[i].q)){
        result = {state:"stale", newer:ahead[i], at:Date.now()};
        break;
      }
    }
  }catch(e){
    result = {state:"unreachable", at:Date.now()};
  }
  try{ localStorage.setItem(LS + ".upd", JSON.stringify(result)); }catch(e){}
  return result;
}

function paintAlert(r){
  const el = $("#alert");
  if (!r || r.state === "current"){ el.hidden = true; return; }
  el.hidden = false;
  if (r.state === "stale"){
    el.className = "alert";
    el.innerHTML = `<div class="txt"><b>${QNAME[r.newer.q]} ${r.newer.y} rates are published.</b>
      These amounts are still ${DB.quarter} and will not change until the file is rebuilt.
      <a href="${CMS_PAGE}" target="_blank" rel="noopener">Open the CMS file page</a></div>
      <button class="link" data-recheck>Check again</button>`;
  } else {
    // Nothing newer can exist until the next quarter starts, so a failed check
    // inside our own quarter is not worth a banner -- the footer still says so.
    const mine = dataQuarter(), now = new Date();
    const started = (now.getFullYear() * 4 + Math.floor(now.getMonth() / 3) + 1) > (mine.y * 4 + mine.q);
    if (!started){ el.hidden = true; return; }
    el.className = "alert soft";
    el.innerHTML = `<div class="txt">A new quarter has started and cms.gov could not be reached
      to check for an update, so this may no longer be the latest file. Showing ${DB.quarter} amounts.</div>
      <button class="link" data-recheck>Check again</button>`;
  }
  el.querySelector("[data-recheck]").addEventListener("click", () => runCheck(true));
}

function paintFootCheck(r){
  const el = $("#freshness");
  if (!el) return;
  if (!r) { el.textContent = "checking cms.gov\u2026"; return; }
  if (r.state === "current")
    el.innerHTML = `Checked cms.gov &mdash; ${DB.quarter} is the current file.
      <button class="link" data-recheck>Check again</button>`;
  else if (r.state === "stale")
    el.innerHTML = `A newer file (${QNAME[r.newer.q]} ${r.newer.y}) is available from CMS.`;
  else
    el.innerHTML = `Update check unavailable. <button class="link" data-recheck>Try again</button>`;
  const b = el.querySelector("[data-recheck]");
  if (b) b.addEventListener("click", () => runCheck(true));
}

async function runCheck(force){
  paintFootCheck(null);
  const r = await checkForUpdate(force);
  paintAlert(r); paintFootCheck(r);
}

/* ---------------- events ---------------- */
applyTheme(currentTheme());   // sync the button with what the early script already set
$("#themebtn").addEventListener("click", cycleTheme);
$("#q").addEventListener("input", render);
$("#q").addEventListener("keydown", e => {
  if (e.key === "Enter"){
    if (!isGlobal($("#q").value)) return;   // filtering the list pins nothing
    const res = search(bareQuery($("#q").value));
    if (res.length){
      if (PIN_ON && !pinned(res[0])) togglePin(res[0]);
      $("#q").select();
    }
  } else if (e.key === "Escape"){
    $("#q").value = ""; render();
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement !== $("#q")){
    e.preventDefault();
    $("#q").value = "/";              // the key that focuses the box also starts the global search
    $("#q").focus();
    render();
  }
});
$("#results").addEventListener("click", e => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const i = +b.dataset.i;
  if (b.dataset.act === "pin") togglePin(i);
  else if (b.dataset.act === "copy") copy(pinLine(i));
});
$("#copyall").addEventListener("click", () => copy(copyText()));
$("#clearpins").addEventListener("click", () => { pins = []; save(); render(); });
if (!PIN_ON){                       // nothing is pinned, nothing to clear, no key to pin with
  $("#pinlabel").hidden = true;
  $("#clearpins").hidden = true;
  $("#hintpin").hidden = true;
}

/* ---------------- locality dialog ---------------- */
const dlg = $("#locdlg");
$("#locbtn").addEventListener("click", () => {
  $("#zip").value = loc.zip || "";
  $("#state").value = loc.state;
  previewLoc();
  dlg.showModal();
});
$("#loccancel").addEventListener("click", () => dlg.close());
$("#zip").addEventListener("input", () => {
  const z = $("#zip").value.trim();
  const r = /^\d{5}$/.test(z) ? resolveZip(z) : null;
  if (r && r.state && DB.states.includes(r.state)) $("#state").value = r.state;
  previewLoc();
});
$("#state").addEventListener("change", previewLoc);

function previewLoc(){
  const z = $("#zip").value.trim();
  const st = $("#state").value;
  const box = $("#resolved");
  if (!/^\d{5}$/.test(z)){
    box.innerHTML = NONCONT.has(st)
      ? `<b>${STATE_NAMES[st]}</b> &mdash; non&#8209;continental, not subject to the ceiling and floor. Rural rates do not apply.`
      : `Standard <b>non&#8209;rural</b> rate for <b>${STATE_NAMES[st]}</b>. Add a ZIP to check rural and former&#8209;CBA status.`;
    return;
  }
  const r = resolveZip(z);
  if (r.kind === "cba")
    box.innerHTML = `<b>${z}</b> is in the former competitive&#8209;bidding area <b>${esc(r.name)}</b>. Former&#8209;CBA rates apply.`;
  else if (r.kind === "rural")
    box.innerHTML = `<b>${z}</b> is on the CMS <b>rural</b> ZIP list for <b>${r.state}</b>. Rural rates apply.`;
  else
    box.innerHTML = `<b>${z}</b> is on neither the rural nor the former&#8209;CBA list, so the standard <b>non&#8209;rural</b> rate for <b>${STATE_NAMES[st]}</b> applies.`;
}

$("#locsave").addEventListener("click", () => {
  const z = $("#zip").value.trim();
  const st = $("#state").value;
  if (/^\d{5}$/.test(z)){
    const r = resolveZip(z);
    loc.zip = z;
    loc.state = (r.state && DB.states.includes(r.state)) ? r.state : st;
    loc.rural = r.kind === "rural";
    loc.cbaIdx = r.kind === "cba" ? r.cbaIdx : -1;
  } else {
    loc.zip = ""; loc.state = st; loc.rural = false; loc.cbaIdx = -1;
  }
  save(); paintLoc(); render(); dlg.close();
});

if ("serviceWorker" in navigator &&
    (location.protocol === "https:" || location.hostname === "localhost"))
  navigator.serviceWorker.register("sw.js").catch(() => {});

boot().catch(err => {
  document.getElementById("results").innerHTML =
    `<div class="card"><div class="code">Could not load the dataset</div>
     <div class="desc">${esc(err.message)}</div></div>`;
});

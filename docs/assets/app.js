// NEET PG Cutoff Explorer — static, no backend. Loads docs/data/<year>.json and does everything client-side.

const SAFE = 1.2;   // closing rank ≥ 120% of your rank
const REACH = 0.85; // closing rank ≥ 85% of your rank (a stretch)
// Tab order; the first entry is the landing view.
const VIEWS = [
  ["states", "State map"],
  ["cutoffs", "Cutoff table"],
  ["predict", "Rank predictor"],
  ["specialities", "Course ladder"],
  ["trends", "Year-on-year"],
  ["rank", "Rank lookup"],
  ["about", "About data"],
];
const ROUND_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)"];
// Rounds are matched across years by id, not position: 2025 has no special stray round.
const ROUND_IDS = [["R1", "Round 1"], ["R2", "Round 2"], ["R3", "Round 3"], ["SR", "Stray vacancy round"], ["SSV", "Special stray vacancy"]];
const REPO = "https://github.com/dr-pavani-utti/neet-pg-cutoff-explorer";
const MCC = "https://mcc.nic.in/pg-medical-counselling/";
const CONTRIBUTOR = {
  name: "Dr. Pavani Utti",
  linkedin: "https://www.linkedin.com/in/dr-pavani-utti/",
  portfolio: "https://dr-pavani-utti.github.io/portfolio/",
};
// Quotas any NEET-PG candidate can choose. The rest need university, NRI, minority or AFMS eligibility.
const OPEN_QUOTAS = ["All India", "DNB Quota", "Deemed/Paid Seats"];
const CANDIDATE_CATS = ["General", "EWS", "OBC", "SC", "ST"];

const app = { index: null, years: {}, data: null, model: null, view: VIEWS[0][0], p: {} };

// ------------------------------------------------------------------ utilities

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null ? "–" : n.toLocaleString("en-IN"));
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const degClass = (d) => `deg deg-${d.replace(/\W/g, "")}`;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

// ------------------------------------------------------------------ model

// A "seat" is one course × institute × quota × allotted category: that is the unit MCC fills by rank.
function buildModel(d) {
  const nRounds = d.rounds.length;
  const seatMap = new Map();
  const byRank = new Map(); // `${round}|${rank}` -> allotment index
  let maxRank = 0;
  d.allotments.forEach((a, i) => {
    const [r, rank, inst, course, quota, cat] = a;
    byRank.set(`${r}|${rank}`, i);
    if (rank > maxRank) maxRank = rank;
    const k = `${inst}|${course}|${quota}|${cat}`;
    let s = seatMap.get(k);
    if (!s) {
      const [degree, spec] = d.courses[course];
      const [instName, state, address] = d.institutes[inst];
      s = {
        inst, instName, state, address, course, degree, spec,
        quota: d.quotas[quota], cat: d.categories[cat],
        ranks: Array.from({ length: nRounds }, () => []),
        xkey: crossYearKey(degree, spec, address, d.quotas[quota], d.categories[cat]),
      };
      seatMap.set(k, s);
    }
    s.ranks[r].push(rank);
  });
  const seats = [...seatMap.values()];
  for (const s of seats) {
    s.ranks.forEach((list) => list.sort((x, y) => x - y));
    s.close = s.ranks.map((l) => (l.length ? l[l.length - 1] : null));
    s.open = s.ranks.map((l) => (l.length ? l[0] : null));
    s.best = Math.max(...s.close.filter((c) => c != null));
  }
  const byX = new Map(seats.map((s) => [s.xkey, s]));
  const uniq = (f) => [...new Set(seats.map(f))].sort();
  return {
    data: d, seats, byX, byRank, maxRank, nRounds,
    degrees: uniq((s) => s.degree), states: uniq((s) => s.state), specs: uniq((s) => s.spec),
    quotas: d.quotas, categories: d.categories,
  };
}

// Same identity rule as scripts/build_data.py: institute name (before the first comma) + last PIN code.
function crossYearKey(degree, spec, address, quota, cat) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pins = address.match(/(?<!\d)\d{6}(?!\d)/g);
  const inst = norm(address.split(",")[0]) + (pins ? pins[pins.length - 1] : "");
  return [degree, norm(spec), inst, quota, cat].join("|");
}

const myRank = () => {
  const r = parseInt(app.p.rank, 10);
  return r > 0 ? r : null;
};
const roundIndex = (id, data = app.data) => data.rounds.findIndex((r) => r.id === id);

// Seat categories open to the candidate: unreserved ("Open") seats plus their own category, and the
// PwD versions of both for PwD candidates.
function eligibleCats() {
  const c = app.p.mycat;
  if (!CANDIDATE_CATS.includes(c)) return null;
  const base = c === "General" ? ["Open"] : ["Open", c];
  return new Set(app.p.pwd === "1" ? [...base, ...base.map((b) => `${b} PwD`)] : base);
}

const quotaParam = () => app.p.quota || "open";
function quotaMatch(q) {
  const sel = quotaParam();
  return sel === "all" || (sel === "open" ? OPEN_QUOTAS.includes(q) : q === sel);
}

function filteredSeats({ model = app.model, ignoreState = false, eligible = null } = {}) {
  const p = app.p;
  const q = (p.q || "").trim().toLowerCase();
  return model.seats.filter(
    (s) =>
      (!p.deg || s.degree === p.deg) &&
      (!p.spec || s.spec === p.spec) &&
      (ignoreState || !p.state || s.state === p.state) &&
      quotaMatch(s.quota) &&
      (!p.cat || s.cat === p.cat) &&
      (!eligible || eligible.has(s.cat)) &&
      (!q || s.instName.toLowerCase().includes(q) || s.spec.toLowerCase().includes(q) || s.address.toLowerCase().includes(q)),
  );
}

// ------------------------------------------------------------------ routing & state

const PROFILE_KEY = "neetpg.profile";

function readHash() {
  const [view, query] = location.hash.replace(/^#\/?/, "").split("?");
  app.view = VIEWS.some(([v]) => v === view) ? view : VIEWS[0][0];
  const p = Object.fromEntries(new URLSearchParams(query || ""));
  const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
  app.p = { ...saved, ...p };
}

function writeHash() {
  const clean = Object.fromEntries(Object.entries(app.p).filter(([, v]) => v !== "" && v != null));
  const qs = new URLSearchParams(clean).toString();
  history.replaceState(null, "", `#${app.view}${qs ? "?" + qs : ""}`);
  const { year, mycat, pwd, rank } = app.p;
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ year, mycat, pwd, rank }));
}

function setParam(changes, { full = false } = {}) {
  trackChange(changes);
  Object.assign(app.p, changes);
  writeHash();
  if (full) render();
  else renderResults();
}

// ------------------------------------------------------------------ analytics (GoatCounter, cookieless)

// index.html loads count.js with no_onload: the page sends one pageview per tab plus feature events.
// GoatCounter ignores localhost, so local previews stay out of the stats. Calls made before the async
// script loads are queued; if it never loads (ad blocker) the queue is dropped.
const trackQueue = [];
function count(vars) {
  if (window.goatcounter?.count) window.goatcounter.count(vars);
  else if (trackQueue.length < 50) trackQueue.push(vars);
}
document.querySelector("script[data-goatcounter]")?.addEventListener("load", () => {
  while (trackQueue.length) window.goatcounter?.count?.(trackQueue.shift());
});
// GoatCounter events are just a name, so the detail goes into the path: "filter-quota/NRI".
const track = (name, detail) => count({ path: detail ? `${name}/${String(detail).slice(0, 60)}` : name, title: name, event: true });

// One pageview per tab; the path is the bare tab name so ranks and filters never reach the stats.
let trackedView = null;
function trackView() {
  if (trackedView === app.view) return;
  trackedView = app.view;
  count({ path: `/${app.view}`, title: VIEWS.find(([v]) => v === app.view)[1] });
}

// Outbound links (footer, About, MCC) and the static per-year CSV downloads.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a) return;
  if (a.hasAttribute("download")) track("download-csv", a.getAttribute("href").split("/").pop());
  else if (a.target === "_blank") track("outbound", new URL(a.href).hostname);
});

const RANK_BANDS = [1000, 5000, 10000, 20000, 50000, 100000];
const rankBand = (r) => {
  const hi = RANK_BANDS.find((b) => r <= b);
  return hi ? `${(RANK_BANDS[RANK_BANDS.indexOf(hi) - 1] || 0) + 1}-${hi}` : `${RANK_BANDS.at(-1)}+`;
};
const FILTER_KEYS = { deg: "degree", spec: "course", state: "state", quota: "quota", cat: "seat-category", round: "round", rid: "round", metric: "metric" };

// Only the first key is the user's action; the rest are side effects.
let typingTimer;
function trackChange(changes) {
  const [key, value] = Object.entries(changes)[0] || [];
  const view = app.view;
  if (key === "mycat" && value) track("select-category", value);
  else if (key === "pwd") track("select-pwd", value ? "yes" : "no");
  else if (key === "rank" || key === "q") {
    clearTimeout(typingTimer); // wait until the user stops typing
    typingTimer = setTimeout(() => {
      const r = parseInt(value, 10);
      if (key === "rank" && r > 0) track("enter-rank", rankBand(r));
      if (key === "q" && value.trim()) track(`search-${view}`, value.trim().toLowerCase());
    }, 1500);
  } else if (key === "sort") track(`sort-${view}`, value);
  else if (key === "all") track("show-all", view);
  else if (FILTER_KEYS[key] && value) track(`filter-${FILTER_KEYS[key]}`, value);
}

// ------------------------------------------------------------------ controls

function selectCtl(label, param, options, { all = "All", onchange } = {}) {
  const sel = h(
    "select",
    { onchange: (e) => (onchange ? onchange(e.target.value) : setParam({ [param]: e.target.value })) },
    all != null ? h("option", { value: "" }, all) : null,
    options.map(([v, l]) => h("option", { value: v, selected: String(app.p[param] ?? "") === String(v) }, l)),
  );
  return h("label", { class: "ctl" }, h("span", {}, label), sel);
}

function inputCtl(label, param, attrs = {}) {
  let timer;
  const input = h("input", {
    value: app.p[param] || "",
    ...attrs,
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => setParam({ [param]: e.target.value }), 180);
    },
  });
  return h("label", { class: "ctl" }, h("span", {}, label), input);
}

const roundOptions = () => app.data.rounds.map((r) => [r.id, r.label]);

function quotaCtl() {
  const opts = [["open", "Open to all (AI · DNB · Deemed/Paid)"], ["all", "Every quota"], ...app.model.quotas.map((q) => [q, q])];
  const sel = h("select", { onchange: (e) => setParam({ quota: e.target.value }) },
    opts.map(([v, l]) => h("option", { value: v, selected: quotaParam() === v }, l)));
  return h("label", { class: "ctl" }, h("span", {}, "Quota"), sel);
}

function filterBar({ round = false, anyRound = false, search = true, spec = true, cat = true } = {}) {
  const m = app.model;
  return h(
    "div",
    { class: "filters" },
    round ? selectCtl("Round", "round", [...roundOptions(), ...(anyRound ? [["any", "Best of all rounds"]] : [])], { all: null }) : null,
    selectCtl("Degree", "deg", m.degrees.map((d) => [d, d])),
    spec ? selectCtl("Course", "spec", specsForDegree().map((s) => [s, s])) : null,
    selectCtl("State", "state", m.states.map((s) => [s, s])),
    quotaCtl(),
    cat ? selectCtl("Seat category", "cat", m.categories.map((c) => [c, c])) : null,
    search ? inputCtl("Search", "q", { type: "search", placeholder: "Institute, city, course…" }) : null,
  );
}

function specsForDegree() {
  return [...new Set(app.model.seats.filter((s) => !app.p.deg || s.degree === app.p.deg).map((s) => s.spec))].sort();
}

function renderProfile() {
  const el = $("#profile");
  el.replaceChildren(
    selectCtl("Year", "year", app.index.years.map((y) => [y.year, y.year]), {
      all: null,
      onchange: async (v) => {
        app.p.year = v;
        track("select-year", v);
        writeHash();
        await loadYear(v);
        render();
      },
    }),
    selectCtl("Your category", "mycat", CANDIDATE_CATS.map((c) => [c, c]), {
      all: "Choose category…",
      onchange: (v) => setParam({ mycat: v }, { full: true }),
    }),
    selectCtl("PwD", "pwd", [["1", "Yes"]], { all: "No", onchange: (v) => setParam({ pwd: v }, { full: true }) }),
    inputCtl("Your rank", "rank", { type: "number", min: 1, inputmode: "numeric", placeholder: "e.g. 12500" }),
  );
  ["year", "category", "pwd", "rank"].forEach((id, i) => (el.children[i].dataset.tour = id));
}

// ------------------------------------------------------------------ render shell

function render() {
  $("#tabs").replaceChildren(
    ...VIEWS.map(([id, label]) =>
      h("a", { href: `#${id}`, class: id === app.view ? "active" : "", onclick: (e) => { e.preventDefault(); app.view = id; writeHash(); render(); } }, label),
    ),
  );
  renderProfile();
  const view = $("#view");
  const def = RENDERERS[app.view];
  view.replaceChildren(h("section", { class: "head" }, h("h2", {}, def.title), h("p", { class: "lede" }, def.lede)), def.controls ? def.controls() : "", h("div", { id: "results" }));
  renderResults();
  trackView();
}

function renderResults() {
  const box = $("#results");
  if (!box) return;
  box.replaceChildren(RENDERERS[app.view].results());
}

function needProfile(msg) {
  return h("div", { class: "empty" }, h("strong", {}, "Add your details"), h("p", {}, msg), h("p", { class: "muted" }, "Seats are reserved by category, so a rank only means something together with the category of seat it can take."));
}

// ------------------------------------------------------------------ view: predictor

function chance(close, rank) {
  if (close == null) return null;
  if (close >= rank * SAFE) return "safe";
  if (close >= rank) return "likely";
  if (close >= rank * REACH) return "reach";
  return null;
}
const CHANCE_LABEL = { safe: "Safe", likely: "Likely", reach: "Reach" };

function predictResults() {
  const rank = myRank();
  const eligible = eligibleCats();
  if (!eligible || !rank) {
    return needProfile("Enter your category and rank (top right). You'll get every seat open to you whose closing rank was at or beyond yours.");
  }
  const roundSel = app.p.round || app.data.rounds[0].id;
  const r = roundIndex(roundSel);
  const rows = [];
  for (const s of filteredSeats({ eligible })) {
    const close = r >= 0 ? s.close[r] : s.best;
    const c = chance(close, rank);
    if (c) rows.push({ s, close, c, past: pastYears(s, roundSel, rank) });
  }
  rows.sort((a, b) => a.close - b.close);
  const withPast = rows.filter((x) => x.past.some((p) => p.close != null));
  const steady = withPast.filter((x) => x.past.every((p) => p.close == null || p.c)).length;
  const counts = { safe: 0, likely: 0, reach: 0 };
  rows.forEach((x) => counts[x.c]++);
  const bySpec = new Map();
  rows.filter((x) => x.c !== "reach").forEach(({ s }) => bySpec.set(`${s.degree} ${s.spec}`, (bySpec.get(`${s.degree} ${s.spec}`) || 0) + 1));
  const specChips = [...bySpec.entries()].sort((a, b) => b[1] - a[1]);
  const max = app.model.maxRank;

  return h(
    "div",
    {},
    h(
      "div",
      { class: "cards" },
      card("Safe", counts.safe, `closing rank ≥ ${fmt(Math.round(rank * SAFE))}`, "safe"),
      card("Likely", counts.likely, `closed between ${fmt(rank)} and ${fmt(Math.round(rank * SAFE) - 1)}`, "likely"),
      card("Reach", counts.reach, `closed ${fmt(Math.ceil(rank * REACH))}–${fmt(rank - 1)}; needs luck`, "reach"),
      card("Your position", `${pct(rank, max)}%`, `of the way to rank ${fmt(max)}, the last rank that got any seat this year`, ""),
      app.index.years.length > 1
        ? card("Consistent", steady, `of ${withPast.length} seats that also existed in other years reached your rank every year`, "safe")
        : null,
    ),
    h("p", { class: "muted small" }, `Counting ${[...eligible].join(", ")} seats${quotaParam() === "open" ? " in quotas open to everyone" : ""}. Change the Quota filter to add university, NRI, minority or AFMS seats you are eligible for.`),
    specChips.length
      ? h("div", { class: "chips" }, h("span", { class: "muted" }, "Safe + likely seats by course:"), specChips.slice(0, 18).map(([name, n]) => h("span", { class: "chip" }, name, h("b", {}, n))))
      : null,
    rows.length
      ? seatTable(rows, { rank, max, showChance: true, history: true })
      : h("div", { class: "empty" }, h("strong", {}, "No seat closed at or beyond this rank"), h("p", {}, "Try “Best of all rounds” or remove filters: later rounds often go to much later ranks.")),
  );
}

function card(title, value, note, tone) {
  return h("div", { class: `card ${tone}` }, h("span", { class: "card-title" }, title), h("strong", {}, value), h("small", {}, note));
}

// The same seat in every other loaded year, in the same round (by id) or best round for "any".
function pastYears(s, roundId, rank) {
  return app.index.years
    .filter((y) => y.year !== app.data.year && app.years[y.year])
    .map(({ year }) => {
      const { data, model } = app.years[year];
      const other = model.byX.get(s.xkey);
      const ri = roundIndex(roundId, data);
      const close = other ? (roundId === "any" ? other.best : ri >= 0 ? other.close[ri] : null) : null;
      return { year, close, c: close != null ? chance(close, rank) : null };
    });
}

// Seat table shared by predictor, cutoff and state views.
function seatTable(rows, { rank = null, max, showChance = false, history = false, limit = 400 } = {}) {
  const rounds = app.data.rounds;
  const sortKey = app.p.sort || (showChance ? "" : "spec");
  const dir = app.p.dir === "desc" ? -1 : 1;
  const keyed = {
    spec: (x) => `${x.s.spec} ${x.s.degree}`,
    inst: (x) => x.s.instName,
    state: (x) => x.s.state,
    ...Object.fromEntries(rounds.map((r, i) => [r.id, (x) => x.s.close[i] ?? Infinity])),
  };
  if (keyed[sortKey]) {
    const f = keyed[sortKey];
    rows = [...rows].sort((a, b) => {
      const va = f(a), vb = f(b);
      const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return c * dir || (a.s.best ?? 1e9) - (b.s.best ?? 1e9);
    });
  }
  const th = (k, label, cls = "") =>
    h("th", { class: `${cls} sortable ${sortKey === k ? "sorted " + (dir < 0 ? "desc" : "asc") : ""}`, onclick: () => setParam({ sort: k, dir: sortKey === k && dir > 0 ? "desc" : "asc" }) }, label);
  const shown = app.p.all ? rows : rows.slice(0, limit);
  const table = h(
    "table",
    { class: "seats" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        showChance ? h("th", {}, "Chance") : null,
        th("spec", "Course"),
        th("inst", "Institute"),
        th("state", "State"),
        rounds.map((r) => th(r.id, r.label, "num")),
        h("th", { class: "gauge-h", title: "Log scale from rank 1 to the year's last allotted rank" }, rank ? "Your rank vs allotted range" : "Allotted rank range"),
        history ? h("th", {}, "Same seat, other years") : null,
      ),
    ),
    h(
      "tbody",
      {},
      shown.map(({ s, c, past }) =>
        h(
          "tr",
          {},
          showChance ? h("td", {}, h("span", { class: `badge ${c}` }, CHANCE_LABEL[c])) : null,
          h("td", {}, h("span", { class: degClass(s.degree) }, s.degree), " ", s.spec, h("div", { class: "tags" }, h("span", { class: "tag" }, s.quota), h("span", { class: `tag cat-${s.cat.split(" ")[0]}` }, s.cat))),
          h("td", { class: "inst", title: s.address }, s.instName),
          h("td", {}, s.state),
          rounds.map((_, i) => h("td", { class: "num" }, s.close[i] == null ? h("span", { class: "muted" }, "–") : h("span", { title: `${s.ranks[i].length} seat(s); opening ${fmt(s.open[i])}` }, fmt(s.close[i]), h("small", {}, ` ×${s.ranks[i].length}`)))),
          h("td", { class: "gauge", html: gaugeSvg(s, rank, max) }),
          history ? h("td", { class: "past" }, past.map((p) => h("span", { class: `yr ${p.close == null ? "none" : p.c || "miss"}`, title: p.close == null ? `${p.year}: seat not filled in this round` : `${p.year}: closed at ${fmt(p.close)}` }, `’${p.year.slice(2)} `, h("b", {}, p.close == null ? "–" : fmt(p.close))))) : null,
        ),
      ),
    ),
  );
  return h(
    "div",
    {},
    h("div", { class: "table-meta" }, h("span", {}, `${fmt(rows.length)} seats (course × institute × quota × category)`), h("button", { class: "link", onclick: () => downloadCsv(rows) }, "Download CSV")),
    h("div", { class: "scroll" }, table),
    rows.length > shown.length ? h("button", { class: "more", onclick: () => setParam({ all: "1" }) }, `Show all ${fmt(rows.length)} rows`) : null,
  );
}

// Inline SVG: each round's allotted range as a bar on a shared log-scale 1..maxRank axis, plus your rank.
// Log scale because PG ranks span 1 to ~2 lakh: on a linear axis everything under 20,000 is a sliver.
function gaugeSvg(s, rank, max) {
  const W = 160, rowH = 6, n = s.ranks.length;
  const x = (v) => (Math.log(Math.max(1, v)) / Math.log(max)) * W;
  let out = `<svg viewBox="0 0 ${W} ${n * rowH + 4}" width="${W}" height="${n * rowH + 4}" aria-hidden="true">`;
  s.ranks.forEach((list, i) => {
    if (!list.length) return;
    const y = 2 + i * rowH;
    out += `<rect x="${x(list[0])}" y="${y}" width="${Math.max(2, x(list[list.length - 1]) - x(list[0]))}" height="${rowH - 2}" rx="2" fill="${ROUND_COLORS[i]}" opacity=".85"/>`;
  });
  if (rank) out += `<line x1="${x(rank)}" x2="${x(rank)}" y1="0" y2="${n * rowH + 4}" stroke="var(--fg)" stroke-width="1.5"/>`;
  return out + "</svg>";
}

function downloadCsv(rows) {
  track("download-csv", `${app.data.year}-${app.view}`);
  const rounds = app.data.rounds;
  const head = ["Degree", "Course", "Institute", "State", "Quota", "Seat category", ...rounds.flatMap((r) => [`${r.label} closing`, `${r.label} opening`, `${r.label} seats`]), "Address"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")];
  for (const { s } of rows) {
    lines.push([s.degree, s.spec, s.instName, s.state, s.quota, s.cat, ...rounds.flatMap((_, i) => [s.close[i], s.open[i], s.ranks[i].length || ""]), s.address].map(q).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `neet-pg-${app.data.year}-cutoffs.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ view: cutoff table

function cutoffResults() {
  const rows = filteredSeats().map((s) => ({ s }));
  if (!rows.length) return h("div", { class: "empty" }, h("strong", {}, "Nothing matches these filters"));
  return seatTable(rows, { rank: myRank(), max: app.model.maxRank });
}

// ------------------------------------------------------------------ view: course ladder

function specialityResults() {
  const r = Math.max(0, roundIndex(app.p.round || app.data.rounds[0].id));
  const buckets = new Map();
  for (const s of filteredSeats()) {
    const list = s.ranks[r];
    if (!list.length) continue;
    const k = `${s.degree}|${s.spec}`;
    if (!buckets.has(k)) buckets.set(k, { degree: s.degree, spec: s.spec, ranks: [], inst: new Set() });
    const b = buckets.get(k);
    b.ranks.push(...list);
    b.inst.add(s.inst);
  }
  const rows = [...buckets.values()].map((b) => {
    b.ranks.sort((x, y) => x - y);
    return { ...b, med: quantile(b.ranks, 0.5), q1: quantile(b.ranks, 0.25), q3: quantile(b.ranks, 0.75), close: b.ranks[b.ranks.length - 1] };
  });
  if (!rows.length) return h("div", { class: "empty" }, h("strong", {}, "No allotments for these filters in this round"));
  rows.sort((a, b) => a.med - b.med);
  const max = Math.max(...rows.map((row) => row.close));
  const rank = myRank();
  const L = 300, W = 1000, rowH = 30, top = 30, plotW = W - L - 70;
  const x = (v) => L + (v / max) * plotW;
  const H = top + rows.length * rowH + 10;
  const DOTS = 120; // per row; big courses have thousands of allotments, so plot evenly spaced quantiles
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Allotted rank distribution per course">`;
  const ticks = niceTicks(max, 6);
  for (const t of ticks) svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 10}" class="grid"/><text x="${x(t)}" y="${top - 12}" class="tick" text-anchor="middle">${fmt(t)}</text>`;
  rows.forEach((row, i) => {
    const y = top + i * rowH + rowH / 2;
    const tip = `${row.degree} ${row.spec}: ${fmt(row.ranks.length)} allotments at ${row.inst.size} institutes · best ${fmt(row.ranks[0])} · median ${fmt(row.med)} · closing ${fmt(row.close)}`;
    svg += `<g class="row" data-tip="${esc(tip)}"><rect x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" class="hit"/>`;
    svg += `<text x="${L - 10}" y="${y + 4}" text-anchor="end" class="label">${esc(row.spec)} <tspan class="deg-t">${esc(row.degree)}</tspan></text>`;
    svg += `<rect x="${x(row.q1)}" y="${y - 8}" width="${Math.max(2, x(row.q3) - x(row.q1))}" height="16" rx="4" class="iqr"/>`;
    const n = row.ranks.length;
    const pts = n <= DOTS ? row.ranks : Array.from({ length: DOTS }, (_, j) => row.ranks[Math.round((j * (n - 1)) / (DOTS - 1))]);
    pts.forEach((v) => {
      const jitter = ((Math.imul(v, 2654435761) >>> 0) % 13) - 6;
      svg += `<circle cx="${x(v).toFixed(1)}" cy="${(y + jitter).toFixed(1)}" r="2.2" class="dot"/>`;
    });
    svg += `<line x1="${x(row.med)}" x2="${x(row.med)}" y1="${y - 10}" y2="${y + 10}" class="median"/>`;
    svg += `<text x="${x(row.close) + 6}" y="${y + 4}" class="close">${fmt(row.close)}</text></g>`;
  });
  if (rank && rank <= max) svg += `<line x1="${x(rank)}" x2="${x(rank)}" y1="${top - 6}" y2="${H - 10}" class="you"/><text x="${x(rank)}" y="${H - 1}" text-anchor="middle" class="you-t">you · ${fmt(rank)}</text>`;
  svg += "</svg>";
  return h(
    "div",
    {},
    h("div", { class: "legend" }, legendItem("dot", `allotted candidates (up to ${DOTS} evenly spaced per course)`), legendItem("iqr", "middle 50% of allotted ranks"), legendItem("median", "median"), h("span", {}, "number = closing rank"), rank ? legendItem("you", "your rank") : null),
    h("div", { class: "chart-wrap", html: svg }),
    h("p", { class: "muted small" }, "Sorted by median allotted rank: the higher a course sits, the earlier its seats go. Reserved-category seats close later, so set Seat category to compare like with like. Hover a row for numbers."),
  );
}

function legendItem(cls, label) {
  return h("span", { class: "lg" }, h("i", { class: `lg-${cls}` }), label);
}

function niceTicks(max, count) {
  const step0 = max / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

// ------------------------------------------------------------------ view: year-on-year

function trendsResults() {
  const years = [...app.index.years].map((y) => y.year).filter((y) => app.years[y]).sort();
  if (years.length < 2) return h("div", { class: "empty" }, h("strong", {}, "Loading other years…"));
  const rid = ROUND_IDS.some(([id]) => id === app.p.rid) ? app.p.rid : "R1";
  const rank = myRank();
  const perYear = years.map((y) => {
    const { model, data } = app.years[y];
    return { ri: roundIndex(rid, data), seats: filteredSeats({ model }) };
  });
  const ranksOf = (s, yi) => (perYear[yi].ri >= 0 ? s.ranks[perYear[yi].ri] : []);

  // Course level: every allotted rank in that round, per year.
  const specs = new Map();
  perYear.forEach(({ seats }, yi) => {
    for (const s of seats) {
      const list = ranksOf(s, yi);
      if (!list.length) continue;
      const k = `${s.degree}|${s.spec}`;
      if (!specs.has(k)) specs.set(k, { degree: s.degree, spec: s.spec, ranks: years.map(() => []) });
      specs.get(k).ranks[yi].push(...list);
    }
  });
  const specRows = [...specs.values()].map((row) => {
    const stats = row.ranks.map((l) => {
      l.sort((a, b) => a - b);
      return l.length ? { n: l.length, med: quantile(l, 0.5), close: l[l.length - 1] } : null;
    });
    return { ...row, stats };
  });
  const latest = years.length - 1;
  specRows.sort((a, b) => (a.stats[latest]?.med ?? 1e9) - (b.stats[latest]?.med ?? 1e9));

  // Seat level: same course × institute × quota × category across years.
  const seatRows = new Map();
  perYear.forEach(({ seats }, yi) => {
    for (const s of seats) {
      const list = ranksOf(s, yi);
      if (!list.length) continue;
      if (!seatRows.has(s.xkey)) seatRows.set(s.xkey, { s, close: years.map(() => null), n: years.map(() => 0) });
      const row = seatRows.get(s.xkey);
      row.s = s; // newest year's naming wins
      row.close[yi] = list[list.length - 1];
      row.n[yi] = list.length;
    }
  });
  const seatList = [...seatRows.values()].sort((a, b) => (a.close[latest] ?? 1e9) - (b.close[latest] ?? 1e9));
  const shown = app.p.all ? seatList : seatList.slice(0, 300);
  const delta = (vals) => {
    const known = vals.filter((v) => v != null);
    if (known.length < 2) return h("span", { class: "muted" }, "–");
    const dlt = known[known.length - 1] - known[0];
    return h("span", { class: dlt > 0 ? "up" : dlt < 0 ? "down" : "muted", title: "latest minus earliest closing rank" }, `${dlt > 0 ? "+" : ""}${fmt(dlt)}`);
  };
  const cell = (v, n) => (v == null ? h("span", { class: "muted" }, "–") : h("span", { class: rank ? (v >= rank ? "hit" : "") : "" }, fmt(v), h("small", {}, ` ×${n}`)));
  const roundName = (y, yi) => (perYear[yi].ri >= 0 ? app.years[y].data.rounds[perYear[yi].ri].label : "no such round");

  const reachCards = rank
    ? h("div", { class: "cards" }, years.map((y, yi) => {
        if (perYear[yi].ri < 0) return null; // e.g. 2025 had no special stray round
        const seats = perYear[yi].seats.filter((s) => ranksOf(s, yi).length);
        const ok = seats.filter((s) => ranksOf(s, yi).at(-1) >= rank).length;
        return card(`${y} · ${roundName(y, yi)}`, fmt(ok), `of ${fmt(seats.length)} seats closed at or after rank ${fmt(rank)}`, ok ? "likely" : "reach");
      }))
    : null;

  return h(
    "div",
    {},
    reachCards,
    h("h3", {}, "Course trend"),
    h("p", { class: "muted small" }, "Median and closing allotted rank per year. Sparkline shows the closing rank (higher point = closed at a later rank, so easier that year)."),
    h("div", { class: "scroll" }, h("table", { class: "seats" },
      h("thead", {}, h("tr", {}, h("th", {}, "Course"), years.map((y) => h("th", { class: "num" }, `${y} median / closing`)), h("th", {}, "Closing trend"), h("th", { class: "num" }, "Change"))),
      h("tbody", {}, specRows.map((row) => h("tr", {},
        h("td", {}, h("span", { class: degClass(row.degree) }, row.degree), " ", row.spec),
        row.stats.map((st) => h("td", { class: "num" }, st ? [fmt(st.med), h("span", { class: "muted" }, " / "), h("span", { class: rank && st.close >= rank ? "hit" : "" }, fmt(st.close)), h("small", {}, ` ×${st.n}`)] : h("span", { class: "muted" }, "–"))),
        h("td", { html: sparkline(row.stats.map((st) => st?.close ?? null), years, rank) }),
        h("td", { class: "num" }, delta(row.stats.map((st) => st?.close ?? null))),
      ))),
    )),
    h("h3", {}, "Same seat, year by year"),
    h("p", { class: "muted small" }, `Closing rank of each course × institute × quota × category in ${ROUND_IDS.find(([id]) => id === rid)[1]}, matched across years by institute name and PIN code.${rank ? " Highlighted = closed at or after your rank." : ""}`),
    h("div", { class: "table-meta" }, h("span", {}, `${fmt(seatList.length)} seats`)),
    h("div", { class: "scroll" }, h("table", { class: "seats" },
      h("thead", {}, h("tr", {}, h("th", {}, "Course"), h("th", {}, "Institute"), h("th", {}, "State"), years.map((y) => h("th", { class: "num" }, y)), h("th", { class: "num" }, "Change"))),
      h("tbody", {}, shown.map(({ s, close, n }) => h("tr", {},
        h("td", {}, h("span", { class: degClass(s.degree) }, s.degree), " ", s.spec, h("div", { class: "tags" }, h("span", { class: "tag" }, s.quota), h("span", { class: `tag cat-${s.cat.split(" ")[0]}` }, s.cat))),
        h("td", { class: "inst", title: s.address }, s.instName),
        h("td", {}, s.state),
        close.map((v, yi) => h("td", { class: "num" }, cell(v, n[yi]))),
        h("td", { class: "num" }, delta(close)),
      ))),
    )),
    seatList.length > shown.length ? h("button", { class: "more", onclick: () => setParam({ all: "1" }) }, `Show all ${fmt(seatList.length)} rows`) : null,
  );
}

function sparkline(vals, years, rank) {
  const W = 110, H = 30, pad = 4;
  const known = vals.filter((v) => v != null);
  if (!known.length) return "";
  const lo = Math.min(...known, rank || Infinity), hi = Math.max(...known, rank || 0);
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, vals.length - 1);
  const y = (v) => H - pad - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * pad);
  let path = "";
  vals.forEach((v, i) => { if (v != null) path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="spark">`;
  if (rank && rank >= lo && rank <= hi) svg += `<line x1="0" x2="${W}" y1="${y(rank)}" y2="${y(rank)}" class="spark-you"/>`;
  svg += `<path d="${path}" class="spark-line"/>`;
  vals.forEach((v, i) => { if (v != null) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" class="spark-dot"><title>${years[i]}: ${fmt(v)}</title></circle>`; });
  return svg + "</svg>";
}

// ------------------------------------------------------------------ view: state map

// Simplified state boundaries (scripts/build_map.py); fetched the first time the view opens.
let indiaMap = null;
function loadIndiaMap() {
  indiaMap ||= fetch("assets/india-map.json").then((r) => r.json()).then((m) => (indiaMap = m) && renderResults());
  return indiaMap;
}

function stateResults() {
  if (!indiaMap || indiaMap instanceof Promise) {
    loadIndiaMap();
    return h("p", { class: "loading" }, "Loading map…");
  }
  const r = Math.max(0, roundIndex(app.p.round || app.data.rounds[0].id));
  const rank = myRank();
  const eligible = eligibleCats();
  const metric = app.p.metric || (rank ? "reach" : "seats");
  const stats = new Map();
  // The map always shows every state; the State filter only highlights one.
  for (const s of filteredSeats({ ignoreState: true })) {
    const list = s.ranks[r];
    if (!list.length) continue;
    const st = stats.get(s.state) || { seats: 0, ranks: [], reach: 0, inst: new Set() };
    st.seats += list.length;
    st.ranks.push(...list);
    st.inst.add(s.inst);
    if (rank && (!eligible || eligible.has(s.cat))) st.reach += list.filter((v) => v >= rank).length;
    stats.set(s.state, st);
  }
  for (const st of stats.values()) { st.ranks.sort((a, b) => a - b); st.median = quantile(st.ranks, 0.5); }
  const value = (st) => (metric === "median" ? st.median : st[metric]);
  const vals = [...stats.values()].map(value);
  const vmax = Math.max(1, ...vals), vmin = Math.min(...vals);
  // Median: lower rank = more competitive = darker.
  const shade = (v) => 0.12 + 0.88 * (metric === "median" ? 1 - (v - vmin) / Math.max(1, vmax - vmin) : v / vmax);
  const tipFor = (name, st) => (st ? `${name}: ${fmt(st.seats)} seats at ${st.inst.size} institutes · median allotted rank ${fmt(st.median)}${rank ? ` · ${fmt(st.reach)} closed at/after your rank` : ""}` : `${name}: no seats for these filters`);

  const { width: W, height: H, states } = indiaMap;
  const SMALL = 150; // map units²: too small to see or click, drawn as a marker instead
  let shapes = "", markers = "", labels = "";
  for (const [name, shape] of Object.entries(states)) {
    const st = stats.get(name);
    const sel = app.p.state === name ? " selected" : "";
    const fill = st ? `fill="var(--accent)" fill-opacity="${shade(value(st)).toFixed(2)}" class="state${sel}"` : `class="state empty-state"`;
    shapes += `<path d="${shape.d}" ${fill} data-state="${esc(name)}" data-tip="${esc(tipFor(name, st))}"/>`;
    if (!st) continue;
    if (shape.area < SMALL) {
      markers += `<circle cx="${shape.x}" cy="${shape.y}" r="7" class="marker-bg"/><circle cx="${shape.x}" cy="${shape.y}" r="7" fill="var(--accent)" fill-opacity="${shade(value(st)).toFixed(2)}" class="state marker${sel}" data-state="${esc(name)}" data-tip="${esc(tipFor(name, st))}"/>`;
    } else if (shape.area > 900) {
      const dark = shade(value(st)) > 0.55 ? " on" : "";
      labels += `<text x="${shape.x}" y="${shape.y + 4}" text-anchor="middle" class="map-v${dark}">${fmt(value(st))}</text>`;
    }
  }
  const svg = `<svg viewBox="-4 -4 ${W + 8} ${H + 8}" class="chart india" role="img" aria-label="India map shaded by ${metric}">${shapes}${markers}${labels}</svg>`;

  const list = [...stats.entries()].sort((a, b) => value(b[1]) - value(a[1]));
  if (metric === "median") list.reverse();
  const pick = (name) => setParam({ state: app.p.state === name ? "" : name, sort: "" }, { full: true });
  const caption = metric === "median"
    ? "Darker = lower median allotted rank = more competitive."
    : metric === "reach" ? `Seats in ${app.data.rounds[r].label} that went to rank ${fmt(rank)} or later${eligible ? ` in ${[...eligible].join(" / ")} seats` : ""}. Darker = more options for you.` : "Darker = more seats filled.";
  return h("div", {},
    h("p", { class: "muted small" }, caption, " Click a state to select it; click again to clear. Small UTs are shown as dots."),
    h("div", { class: "map-layout" },
      h("div", { class: "chart-wrap map" },
        h("div", { html: svg, onclick: (e) => { const st = e.target.closest("[data-state]")?.dataset.state; if (st && stats.has(st)) pick(st); } }),
        h("div", { class: "scale" }, h("span", {}, fmt(metric === "median" ? vmax : 0)), h("i", {}), h("span", {}, fmt(metric === "median" ? vmin : vmax)))),
      h("div", { class: "scroll" }, h("table", { class: "seats compact" },
        h("thead", {}, h("tr", {}, h("th", {}, "State"), h("th", { class: "num" }, "Seats"), h("th", { class: "num" }, "Institutes"), h("th", { class: "num" }, "Median rank"), rank ? h("th", { class: "num" }, "Within reach") : null)),
        h("tbody", {}, list.map(([name, st]) => h("tr", { class: `click${app.p.state === name ? " me" : ""}`, onclick: () => pick(name) }, h("td", {}, name), h("td", { class: "num" }, fmt(st.seats)), h("td", { class: "num" }, st.inst.size), h("td", { class: "num" }, fmt(st.median)), rank ? h("td", { class: "num" }, fmt(st.reach)) : null))),
      )),
    ),
    app.p.state && stats.has(app.p.state) ? stateSeats(app.p.state, r, rank) : null,
  );
}

// Seats in the selected state, so a click on the map leads straight to institutes.
function stateSeats(state, r, rank) {
  const rows = filteredSeats().filter((s) => s.ranks[r].length).sort((a, b) => b.close[r] - a.close[r]).map((s) => ({ s }));
  return h("div", {}, h("h3", {}, `Seats in ${state}`), seatTable(rows, { rank, max: app.model.maxRank, limit: 150 }));
}

// ------------------------------------------------------------------ view: rank lookup

// Upgrade-round outcomes per rank live in a separate file; only this view needs them.
const trails = {};
function loadTrail(year) {
  trails[year] ||= fetch(`data/${year}-rounds.json`).then(async (res) => {
    if (!res.ok) throw new Error(`data/${year}-rounds.json: HTTP ${res.status}`);
    const t = await res.json();
    t.byRank = new Map(t.trail.map((row) => [`${row[0]}|${row[1]}`, row]));
    trails[year] = t;
    if (app.view === "rank" && app.data.year === year) renderResults();
  });
  return trails[year];
}

function rankResults() {
  const d = app.data, m = app.model;
  const rank = myRank();
  if (!rank) return needProfile("Enter a rank (top right) to trace what that rank got in every round.");
  const trail = trails[d.year];
  if (!trail || trail instanceof Promise) {
    loadTrail(d.year).catch((err) => console.error(err));
    return h("p", { class: "loading" }, "Loading round-by-round outcomes…");
  }
  const seatText = (i) => {
    const a = d.allotments[i];
    const [degree, spec] = d.courses[a[3]];
    return h("div", { class: "seat" }, h("span", { class: degClass(degree) }, degree), " ", h("b", {}, spec), h("div", { class: "muted" }, `${d.institutes[a[2]][0]} · ${d.institutes[a[2]][1]} · ${d.quotas[a[4]]} · ${d.categories[a[5]]} seat`));
  };
  const steps = d.rounds.map((r, ri) => {
    const i = m.byRank.get(`${ri}|${rank}`);
    const t = trail.byRank.get(`${ri}|${rank}`);
    let body;
    if (t) {
      body = [h("div", { class: "muted" }, `Seat going in: ${trail.statuses[t[2]]}`), h("div", { class: "pill" }, trail.outcomes[t[3]] + (t[4] ? ` · choice #${t[4]}` : "")), i != null ? seatText(i) : null];
    } else if (i != null) {
      body = [h("div", { class: "pill" }, d.kinds[d.allotments[i][6]]), seatText(i)];
    } else {
      body = [h("div", { class: "muted" }, "Not in this round's list")];
    }
    return h("div", { class: `step ${i != null ? "got" : ""}` }, h("span", { class: "step-n", style: `background:${ROUND_COLORS[ri]}` }, r.id), h("strong", {}, r.label), body);
  });
  // Neighbouring ranks in the first round show what the rank band typically got.
  const near = [];
  for (let v = Math.max(1, rank - 10); v <= rank + 10; v++) {
    const i = m.byRank.get(`0|${v}`);
    if (i != null) near.push([v, i]);
  }
  return h(
    "div",
    {},
    h("div", { class: "timeline" }, steps),
    h("h3", {}, `Ranks around ${fmt(rank)} in ${d.rounds[0].label}`),
    h("div", { class: "scroll" }, h("table", { class: "seats compact" },
      h("thead", {}, h("tr", {}, h("th", { class: "num" }, "Rank"), h("th", {}, "Course"), h("th", {}, "Institute"), h("th", {}, "State"), h("th", {}, "Quota"), h("th", {}, "Seat category"))),
      h("tbody", {}, near.map(([v, i]) => {
        const a = d.allotments[i];
        const [degree, spec] = d.courses[a[3]];
        return h("tr", { class: v === rank ? "me" : "" }, h("td", { class: "num" }, fmt(v)), h("td", {}, h("span", { class: degClass(degree) }, degree), " ", spec), h("td", { class: "inst" }, d.institutes[a[2]][0]), h("td", {}, d.institutes[a[2]][1]), h("td", {}, d.quotas[a[4]]), h("td", {}, d.categories[a[5]]));
      })),
    )),
    h("p", { class: "muted small" }, "Ranks missing from the list did not take a seat in that round."),
  );
}

// ------------------------------------------------------------------ view: about

function aboutResults() {
  const years = app.index.years.map((y) => y.year).filter((y) => app.years[y]);
  const rows = years.flatMap((y) => app.years[y].data.sources.map((s, i) => ({ y, s, round: app.years[y].data.rounds.find((r) => r.id === s.round).label, first: i === 0, span: app.years[y].data.sources.length })));
  const total = (k) => fmt(rows.reduce((n, { s }) => n + s[k], 0));
  const ext = (href, label) => h("a", { href, target: "_blank", rel: "noopener" }, label);
  return h(
    "div",
    { class: "prose" },
    h("h3", {}, "Source PDFs"),
    h("p", {}, "Every number on this site comes from the official MCC NEET PG allotment lists below. The original PDFs are in the ", ext(`${REPO}/tree/main/raw`, "raw folder on GitHub"), "."),
    h("div", { class: "scroll" }, h("table", { class: "seats compact" },
      h("thead", {}, h("tr", {}, h("th", {}, "Year"), h("th", {}, "Round"), h("th", {}, "PDF"), h("th", { class: "num" }, "Pages"), h("th", { class: "num" }, "Rows"), h("th", { class: "num" }, "Allotments used"), h("th", {}, "Download"))),
      h("tbody", {}, rows.map(({ y, s, round, first, span }) => h("tr", {},
        first ? h("td", { rowspan: span }, h("b", {}, y)) : null,
        h("td", {}, round),
        h("td", {}, ext(`${REPO}/blob/main/${s.file}`, s.file.split("/").pop())),
        h("td", { class: "num" }, fmt(s.pages)),
        h("td", { class: "num" }, fmt(s.rows)),
        h("td", { class: "num" }, fmt(s.allotments)),
        first ? h("td", { rowspan: span }, h("a", { href: `data/${y}-allotments.csv`, download: true }, `${y}-allotments.csv`)) : null,
      ))),
      h("tfoot", {}, h("tr", {}, h("th", { colspan: 3 }, `All ${years.length} years`), h("th", { class: "num" }, total("pages")), h("th", { class: "num" }, total("rows")), h("th", { class: "num" }, total("allotments")), h("th", {}))),
    )),
    years.length < app.index.years.length ? h("p", { class: "muted small" }, "Loading remaining years…") : null,
    h("p", { class: "muted small" }, "“Rows” are lines in the PDF; Round 2 and Round 3 lists repeat every earlier seat holder, so only seats newly allotted in that round count as “allotments used”."),
    h("h3", {}, "How to read the numbers"),
    h("ul", {},
      h("li", {}, h("b", {}, "A seat "), "= one course at one institute under one quota and one seat category (Open, OBC, EWS, SC, ST and their PwD versions). Each has its own closing rank."),
      h("li", {}, h("b", {}, "Closing rank "), "= the last (highest) NEET PG All-India rank that got that seat in that round. Opening rank = the first. “×3” = number of seats filled."),
      h("li", {}, h("b", {}, "Your category "), "decides which seats the predictor counts: Open seats plus your own category's seats (and PwD seats if you are PwD). Reserved candidates also take Open seats on merit."),
      h("li", {}, h("b", {}, "Quotas. "), "“Open to all” = All India, DNB and Deemed/Paid seats, which any candidate can choose. Delhi/IP/BHU/AMU university, NRI, minority and Armed Forces seats need separate eligibility; pick them in the Quota filter. Armed Forces seats are filled by AFMS merit, so their NEET ranks look out of order."),
      h("li", {}, h("b", {}, "Round 2 and 3 "), "count only seats newly allotted in that round (upgrades and fresh allotments). Candidates who kept an earlier seat are not re-counted."),
      h("li", {}, h("b", {}, "Chance bands "), `are a rule of thumb: Safe if the seat closed ≥ ${Math.round((SAFE - 1) * 100)}% past your rank, Likely if at/after it, Reach if within ${Math.round((1 - REACH) * 100)}% before it. Seat matrices and competition change every year.`),
      h("li", {}, "Institute names are cleaned from MCC's address strings; hover a name to see the original address."),
    ),
    h("h3", {}, "Found a mistake or want a feature?"),
    h("p", {}, "Open an issue on ", ext(`${REPO}/issues`, "GitHub Issues"), ": a wrong rank, a misnamed institute, a missing year, or an idea for a new view. The code and data pipeline are in the ", ext(REPO, "GitHub repository"), "."),
    h("h3", {}, "Contributor"),
    h("p", {}, h("b", {}, CONTRIBUTOR.name), " · ", ext(CONTRIBUTOR.linkedin, "LinkedIn"), " · ", ext(CONTRIBUTOR.portfolio, "Portfolio")),
    h("h3", {}, "Credits"),
    h("ul", {},
      h("li", {}, "State boundaries: ", ext("https://github.com/datta07/INDIAN-SHAPEFILES", "datta07/INDIAN-SHAPEFILES"), " (MIT), simplified."),
      h("li", {}, "Caduceus logo: ", ext("https://commons.wikimedia.org/wiki/File:Caduceus.svg", "Wikimedia Commons"), " (public domain)."),
    ),
  );
}

const RENDERERS = {
  predict: { title: "Which seats does my rank reach?", lede: "Every seat open to your category whose closing rank was at or beyond your rank, sorted from most to least competitive.", controls: () => filterBar({ round: true, anyRound: true }), results: predictResults },
  cutoffs: { title: "Closing ranks, every seat", lede: "Opening/closing rank per course × institute × quota × category per round. Click headers to sort; bars show each round's allotted range.", controls: () => filterBar(), results: cutoffResults },
  specialities: { title: "Course ladder", lede: "Where every allotted candidate's rank fell, per course. Shows which branches fill first.", controls: () => filterBar({ round: true, spec: false }), results: specialityResults },
  trends: { title: "Year-on-year", lede: "The same courses and seats across every loaded year. Spot courses that are getting tougher or easier.", controls: () => { const bar = filterBar(); bar.prepend(selectCtl("Round", "rid", ROUND_IDS, { all: null })); return bar; }, results: trendsResults },
  states: { title: "Seats across India", lede: "Filled seats by state. Switch the metric to see competitiveness or seats within your reach; click a state to list its seats.", controls: () => { const bar = filterBar({ round: true }); bar.prepend(selectCtl("Metric", "metric", [...(myRank() ? [["reach", "Seats within your rank"]] : []), ["seats", "Seats filled"], ["median", "Median allotted rank"]], { all: null })); return bar; }, results: stateResults },
  rank: { title: "Rank lookup", lede: "Trace one rank through every round, and see what neighbouring ranks took.", controls: null, results: rankResults },
  about: { title: "About the data", lede: "Built from official MCC NEET PG allotment PDFs. No database: the data is static JSON shipped with the site.", controls: null, results: aboutResults },
};

// ------------------------------------------------------------------ first-visit tour

const TOUR_KEY = "neetpg.tour";
const TOUR = [
  { target: '[data-tour="year"]', title: "1 · Pick a year", text: "Choose the counselling year you want to explore. 2023, 2024 and 2025 are available." },
  { target: '[data-tour="category"]', title: "2 · Choose your category", text: "Seats are reserved by category. The predictor counts Open seats plus your own category's seats." },
  { target: '[data-tour="pwd"]', title: "3 · PwD", text: "Set Yes if you have a PwD certificate: PwD-reserved seats are added to your options." },
  { target: '[data-tour="rank"]', title: "4 · Enter your rank", text: "Your NEET PG All-India rank. Seats that closed at or after it get highlighted everywhere." },
  { target: "#tabs", title: "5 · Explore", text: "Start with the State map, check exact closing ranks in the Cutoff table, then see your chances in the Rank predictor." },
];

// Spotlight + card. The page stays interactive, so users can fill the highlighted control right away.
function startTour(source = "first-visit") {
  if ($(".tour-card")) return;
  localStorage.setItem(TOUR_KEY, "1"); // shown once, even if the tab is closed mid-tour
  let step = 0, raf = 0;
  track("tour-start", source);
  const spot = h("div", { class: "tour-spot" });
  const card = h("div", { class: "tour-card", role: "dialog", "aria-live": "polite" });
  const close = (outcome = "skipped") => {
    track("tour-end", `${outcome}-step-${step + 1}`);
    cancelAnimationFrame(raf); spot.remove(); card.remove(); document.removeEventListener("keydown", onKey);
  };
  const go = (n) => { if (n >= TOUR.length) return close("finished"); step = Math.max(0, n); paint(); };
  const onKey = (e) => { if (e.key === "Escape") close(); else if (e.key === "ArrowRight") go(step + 1); else if (e.key === "ArrowLeft") go(step - 1); };
  function paint() {
    const s = TOUR[step];
    card.replaceChildren(
      h("strong", {}, s.title),
      h("p", {}, s.text),
      h("div", { class: "tour-nav" },
        h("span", { class: "tour-dots" }, TOUR.map((_, i) => h("i", { class: i === step ? "on" : "" }))),
        h("button", { class: "link", onclick: () => close() }, "Skip"),
        step > 0 ? h("button", { class: "tour-btn ghost", onclick: () => go(step - 1) }, "Back") : null,
        h("button", { class: "tour-btn", onclick: () => go(step + 1) }, step === TOUR.length - 1 ? "Get started" : "Next"),
      ),
    );
    $(s.target)?.scrollIntoView({ block: "nearest" });
  }
  // Re-measure every frame: the profile bar re-renders on input, and layout shifts on resize/scroll.
  function place() {
    const el = $(TOUR[step].target);
    if (el) {
      const r = el.getBoundingClientRect(), pad = 6;
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      const cw = card.offsetWidth, ch = card.offsetHeight;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), window.innerWidth - cw - 8);
      const below = r.bottom + pad + 12;
      const top = below + ch < window.innerHeight ? below : Math.max(8, r.top - pad - 12 - ch);
      Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    }
    raf = requestAnimationFrame(place);
  }
  document.body.append(spot, card);
  document.addEventListener("keydown", onKey);
  paint();
  place();
}

// ------------------------------------------------------------------ tooltip

function initTooltip() {
  const tip = $("#tooltip");
  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.transform = `translate(${x}px, ${e.clientY + 16}px)`;
  });
}

// ------------------------------------------------------------------ boot

const pending = {};
function fetchYear(year) {
  pending[year] ||= fetch(`data/${year}.json`).then(async (res) => {
    if (!res.ok) throw new Error(`data/${year}.json: HTTP ${res.status}`);
    const data = await res.json();
    app.years[year] = { data, model: buildModel(data) };
  });
  return pending[year];
}

async function loadYear(year) {
  await fetchYear(year);
  app.data = app.years[year].data;
  app.model = app.years[year].model;
  const ext = (href, label) => h("a", { href, target: "_blank", rel: "noopener" }, label);
  $("#foot").replaceChildren(
    h("p", {}, `${app.data.year}: ${fmt(app.data.allotments.length)} allotments, ${fmt(app.data.institutes.length)} institutes, ${app.data.rounds.map((r) => r.label).join(" · ")}. Unofficial; verify with `, ext(MCC, "MCC"), " before choice filling."),
    h("div", { class: "credit" },
      h("div", { class: "credit-who" }, "Built by ", h("b", {}, CONTRIBUTOR.name), h("span", { class: "credit-links" }, ext(CONTRIBUTOR.linkedin, "LinkedIn"), ext(CONTRIBUTOR.portfolio, "Portfolio"), ext(REPO, "GitHub"), h("button", { class: "link", onclick: () => startTour("replay") }, "Take the tour"))),
      h("a", { class: "credit-issue", href: `${REPO}/issues`, target: "_blank", rel: "noopener" }, "Report an issue"),
    ),
  );
}

async function boot() {
  readHash();
  initTooltip();
  try {
    const res = await fetch("data/index.json");
    app.index = await res.json();
    if (!app.index.years.some((y) => y.year === app.p.year)) app.p.year = app.index.years[0].year;
    await loadYear(app.p.year);
    // Other years feed the year-on-year view and the predictor's "other years" column.
    Promise.all(app.index.years.map((y) => fetchYear(y.year)))
      .then(() => { if (["trends", "predict", "about"].includes(app.view)) renderResults(); })
      .catch((err) => console.error(err));
  } catch (err) {
    $("#view").replaceChildren(h("div", { class: "empty" }, h("strong", {}, "Could not load data"), h("p", {}, String(err))));
    return;
  }
  writeHash();
  render();
  if (!localStorage.getItem(TOUR_KEY)) startTour();
  window.addEventListener("hashchange", async () => {
    readHash();
    if (!app.index.years.some((y) => y.year === app.p.year)) app.p.year = app.data.year;
    if (app.p.year !== app.data.year) await loadYear(app.p.year);
    render();
  });
}

boot();

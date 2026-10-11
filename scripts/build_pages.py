"""Static, crawlable cutoff pages for search engines, generated from docs/data/<year>.json.

    .venv/bin/python scripts/build_pages.py

The explorer is a single-page app whose tabs are #fragments, so search engines see one URL. This
writes plain HTML pages that need no JavaScript:

    docs/cutoffs/index.html                    hub: every year, course and state
    docs/cutoffs/<year>/index.html             all courses that year
    docs/cutoffs/<year>/<course>/index.html    every institute × quota × category for one course
    docs/cutoffs/<year>/state/<state>/index.html
    docs/sitemap.xml                           all of the above + the explorer

and refreshes the link block between <!-- seo-links --> markers in docs/index.html.
Run it after scripts/build_data.py.
"""
import datetime
import html
import json
import os
import re
from urllib.parse import urlencode
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
SITE = "https://dr-pavani-utti.github.io/neet-pg-cutoff-explorer/"
AUTHOR = {"name": "Dr. Pavani Utti", "linkedin": "https://www.linkedin.com/in/dr-pavani-utti/",
          "portfolio": "https://dr-pavani-utti.github.io/portfolio/",
          "repo": "https://github.com/dr-pavani-utti/neet-pg-cutoff-explorer"}
QUOTA_ORDER = ["All India", "DNB Quota", "Deemed/Paid Seats"]
CAT_ORDER = ["Open", "EWS", "OBC", "SC", "ST", "Open PwD", "EWS PwD", "OBC PwD", "SC PwD", "ST PwD"]
TODAY = datetime.date.today().isoformat()
esc = html.escape


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("&", "and").replace("/", "-")).strip("-")


def fmt(n):
    """Indian digit grouping, as on the site (1,23,456)."""
    if n is None:
        return "–"
    s = str(n)
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    head = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", head)
    return f"{head},{tail}"


def load_years():
    with open(os.path.join(DOCS, "data", "index.json")) as fh:
        years = [y["year"] for y in json.load(fh)["years"]]
    out = {}
    for y in years:
        with open(os.path.join(DOCS, "data", f"{y}.json")) as fh:
            out[y] = json.load(fh)
    return out


def seats_of(d):
    """Seat = institute × course × quota × allotted category; ranks per round."""
    n = len(d["rounds"])
    seats = {}
    for r, rank, inst, course, quota, cat, _ in d["allotments"]:
        s = seats.setdefault((inst, course, quota, cat), [[] for _ in range(n)])
        s[r].append(rank)
    out = []
    for (inst, course, quota, cat), ranks in seats.items():
        name, state, address = d["institutes"][inst]
        degree, subject = d["courses"][course]
        out.append({"inst": name, "state": state, "address": address, "degree": degree, "subject": subject,
                    "course": course, "quota": d["quotas"][quota], "cat": d["categories"][cat],
                    "close": [max(l) if l else None for l in ranks], "n": [len(l) for l in ranks]})
    return out


def quota_key(q):
    return QUOTA_ORDER.index(q) if q in QUOTA_ORDER else len(QUOTA_ORDER)


def cat_key(c):
    return CAT_ORDER.index(c) if c in CAT_ORDER else len(CAT_ORDER)


def first_close(s):
    return next((c for c in s["close"] if c is not None), 10 ** 9)


# ---------------------------------------------------------------- page shell


def page(path, title, description, crumbs, body, jsonld=()):
    """Write docs/<path>/index.html. crumbs: [(label, url-relative-to-site)]; last is the page itself."""
    depth = path.count("/") + 1 if path else 0
    up = "../" * depth
    url = SITE + (path + "/" if path else "")
    graph = [{
        "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": label, "item": SITE + href}
                            for i, (label, href) in enumerate(crumbs)],
    }, *jsonld]
    crumb_html = " › ".join(
        f'<a href="{up}{href}">{esc(label)}</a>' if i < len(crumbs) - 1 else f"<span>{esc(label)}</span>"
        for i, (label, href) in enumerate(crumbs))
    doc = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="author" content="{AUTHOR['name']}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="NEET PG Cutoff Explorer">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}assets/og.png">
  <meta property="og:locale" content="en_IN">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="{SITE}assets/og.png">
  <script type="application/ld+json">{json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)}</script>
  <link rel="icon" href="{up}assets/caduceus.svg" type="image/svg+xml">
  <link rel="stylesheet" href="{up}assets/style.css">
  <script data-goatcounter="https://dr-pavani-utti.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</head>
<body>
  <header class="top">
    <a class="brand plain" href="{up}">
      <span class="logo" aria-hidden="true"><i></i></span>
      <div>
        <strong class="brand-name">NEET PG Cutoff Explorer</strong>
        <p class="sub">Closing ranks from official MCC allotment lists</p>
      </div>
    </a>
    <a class="cta" href="{up}#predict">Open the rank predictor →</a>
  </header>
  <main class="static">
    <nav class="crumbs" aria-label="Breadcrumb">{crumb_html}</nav>
{body}
  </main>
  <footer class="foot">
    <p>Unofficial; verify with <a href="https://mcc.nic.in/pg-medical-counselling/" rel="noopener">MCC</a> before choice filling. Data: official MCC NEET PG allotment PDFs, <a href="{up}cutoffs/">all cutoff pages</a>, <a href="{up}#about">about the data</a>.</p>
    <div class="credit"><div class="credit-who">Built by <b>{AUTHOR['name']}</b><span class="credit-links"><a href="{AUTHOR['linkedin']}" rel="noopener">LinkedIn</a><a href="{AUTHOR['portfolio']}" rel="noopener">Portfolio</a><a href="{AUTHOR['repo']}" rel="noopener">GitHub</a></span></div></div>
  </footer>
</body>
</html>
"""
    out = os.path.join(DOCS, path, "index.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        fh.write(doc)
    return url


def seat_table(rows, rounds, show_course=False, show_state=True):
    """Kept lean (no per-row address tooltips): state pages run to 2,000+ rows."""
    head = "".join(f'<th class="num">{esc(r["label"])}</th>' for r in rounds)
    out = ['<div class="scroll"><table class="seats compact"><thead><tr>',
           "<th>Course</th>" if show_course else "", "<th>Institute</th>", "<th>State</th>" if show_state else "",
           f"<th>Quota</th><th>Category</th>{head}</tr></thead><tbody>"]
    for s in rows:
        cells = "".join(f'<td class="num">{fmt(c)}{f"<small> ×{n}</small>" if c else ""}</td>'
                        for c, n in zip(s["close"], s["n"]))
        course = f'<td>{esc(s["degree"])} {esc(s["subject"])}</td>' if show_course else ""
        state = f'<td>{esc(s["state"])}</td>' if show_state else ""
        out.append(f'<tr>{course}<td class="inst">{esc(s["inst"])}</td>{state}<td>{esc(s["quota"])}</td>'
                   f'<td>{esc(s["cat"])}</td>{cells}</tr>')
    out.append("</tbody></table></div>")
    return "".join(out)


ROUND_NOTE = ('<p class="muted small">Closing rank = the last NEET PG All-India rank allotted that seat in that round; '
              "×n = seats filled. Round 2/3 count only seats newly allotted in that round. – = no allotment.</p>")


# ---------------------------------------------------------------- pages


def course_pages(year, d, seats, by_subject_years):
    rounds = d["rounds"]
    rlabels = ", ".join(r["label"] for r in rounds)
    urls, index = [], []
    by_course = defaultdict(list)
    for s in seats:
        by_course[(s["degree"], s["subject"])].append(s)
    for (degree, subject), rows in by_course.items():
        name = f"{degree} {subject}"
        sl = slug(name)
        path = f"cutoffs/{year}/{sl}"
        ai_open = [s for s in rows if s["quota"] == "All India" and s["cat"] == "Open" and s["close"][0]]
        r1 = sorted(s["close"][0] for s in ai_open)
        n_seats = sum(sum(s["n"]) for s in rows)
        n_inst = len({s["inst"] for s in rows})
        lede = (f"NEET PG {year} {name} cutoff: {fmt(n_seats)} seats filled at {n_inst} institutes across "
                f"{rlabels}.")
        if r1:
            best = min(ai_open, key=lambda s: s["close"][0])
            last = max(ai_open, key=lambda s: s["close"][0])
            lede += (f" All India quota, Open category, Round 1 closing ranks ran from {fmt(best['close'][0])} "
                     f"({best['inst']}) to {fmt(last['close'][0])} ({last['inst']}).")
        sections = []
        for quota in sorted({s["quota"] for s in rows}, key=lambda q: (quota_key(q), q)):
            qrows = sorted((s for s in rows if s["quota"] == quota),
                           key=lambda s: (cat_key(s["cat"]), first_close(s), s["inst"]))
            sections.append(f'<h2>{esc(quota)}</h2>{seat_table(qrows, rounds)}')
        other_years = [y for y in sorted(by_subject_years[(degree, subject)], reverse=True) if y != year]
        same_subject = sorted({(s2["degree"]) for s2 in seats if s2["subject"] == subject} - {degree})
        related = [f'<a href="../../{y}/{sl}/">NEET PG {y} {esc(name)} cutoff</a>' for y in other_years]
        related += [f'<a href="../{slug(f"{dg} {subject}")}/">{esc(dg)} {esc(subject)} {year}</a>' for dg in same_subject]
        explorer = "../../../#cutoffs?" + urlencode({"year": year, "deg": degree, "spec": subject, "quota": "all"})
        body = f"""    <h1>NEET PG {year} {esc(name)} cutoff: closing ranks by institute</h1>
    <p class="lede">{esc(lede)}</p>
    <p><a class="cta" href="{esc(explorer)}">Filter, sort and compare in the explorer →</a></p>
    {ROUND_NOTE}
    {''.join(sections)}
    {f'<h2>Related</h2><p class="links">{" · ".join(related)}</p>' if related else ''}"""
        title = f"NEET PG {year} {name} Cutoff: Closing Ranks by College, Round & Category"
        desc = (f"NEET PG {year} {name} closing ranks for all {n_inst} institutes, every quota and category, "
                f"{rlabels}. From official MCC allotment lists.")
        urls.append(page(path, title, desc, [("NEET PG Cutoff Explorer", ""), ("Cutoffs", "cutoffs/"),
                                             (year, f"cutoffs/{year}/"), (name, path + "/")], body))
        index.append({"degree": degree, "subject": subject, "slug": sl, "seats": n_seats, "inst": n_inst,
                      "r1": (r1[0], r1[-1]) if r1 else None,
                      "last": max((c for s in rows for c in s["close"] if c), default=None)})
    return urls, index


def state_pages(year, d, seats):
    rounds = d["rounds"]
    urls, index = [], []
    by_state = defaultdict(list)
    for s in seats:
        if s["state"] != "Unknown":
            by_state[s["state"]].append(s)
    for state, rows in by_state.items():
        sl = slug(state)
        path = f"cutoffs/{year}/state/{sl}"
        n_seats = sum(sum(s["n"]) for s in rows)
        insts = {s["inst"] for s in rows}
        rows = sorted(rows, key=lambda s: (s["subject"], s["degree"], quota_key(s["quota"]), cat_key(s["cat"]),
                                           first_close(s)))
        body = f"""    <h1>NEET PG {year} cutoff in {esc(state)}: all colleges and courses</h1>
    <p class="lede">{fmt(n_seats)} NEET PG seats were filled through MCC counselling at {len(insts)} institutes in {esc(state)} in {year}. Closing ranks below are per course, quota and seat category. State-quota counselling is run by the state and is not included.</p>
    <p><a class="cta" href="../../../../#states?{esc(urlencode({"year": year, "state": state}))}">See {esc(state)} on the map →</a></p>
    {ROUND_NOTE}
    {seat_table(rows, rounds, show_course=True, show_state=False)}"""
        title = f"NEET PG {year} Cutoff {state}: College-wise Closing Ranks (MCC All India)"
        desc = (f"NEET PG {year} closing ranks for {len(insts)} colleges in {state}: every MD, MS, DNB and Diploma "
                f"course, quota and category, all MCC rounds.")
        urls.append(page(path, title, desc, [("NEET PG Cutoff Explorer", ""), ("Cutoffs", "cutoffs/"),
                                             (year, f"cutoffs/{year}/"), (state, path + "/")], body))
        index.append({"state": state, "slug": sl, "seats": n_seats, "inst": len(insts)})
    return urls, sorted(index, key=lambda x: -x["seats"])


def year_page(year, d, courses, states):
    rounds = ", ".join(r["label"] for r in d["rounds"])
    courses = sorted(courses, key=lambda c: (c["r1"][0] if c["r1"] else 10 ** 9))
    rows = "".join(
        f'<tr><td><a href="{c["slug"]}/">{esc(c["degree"])} {esc(c["subject"])}</a></td>'
        f'<td class="num">{fmt(c["seats"])}</td><td class="num">{c["inst"]}</td>'
        f'<td class="num">{f"{fmt(c["r1"][0])} – {fmt(c["r1"][1])}" if c["r1"] else "–"}</td>'
        f'<td class="num">{fmt(c["last"])}</td></tr>' for c in courses)
    state_links = " · ".join(f'<a href="state/{s["slug"]}/">{esc(s["state"])}</a>' for s in states)
    total = len(d["allotments"])
    body = f"""    <h1>NEET PG {year} cutoff: closing ranks for every course</h1>
    <p class="lede">{fmt(total)} seats were allotted in NEET PG {year} MCC counselling ({rounds}). Each course below links to its full college-wise cutoff list with every quota and category. Courses are ordered by their best All India Open closing rank in Round 1.</p>
    <p><a class="cta" href="../../#predict?year={year}">Check which seats your rank gets →</a></p>
    <div class="scroll"><table class="seats compact"><thead><tr><th>Course</th><th class="num">Seats filled</th><th class="num">Institutes</th><th class="num">Round 1 closing, All India Open (lowest – highest)</th><th class="num">Last rank allotted, any round</th></tr></thead><tbody>{rows}</tbody></table></div>
    <h2>NEET PG {year} cutoff by state</h2>
    <p class="links">{state_links}</p>"""
    title = f"NEET PG {year} Cutoff: Course-wise & College-wise Closing Ranks (All Rounds)"
    desc = (f"NEET PG {year} cutoff ranks for all {len(courses)} MD, MS, DNB and Diploma courses across {rounds}, "
            "with college-wise, quota-wise and category-wise closing ranks from MCC allotment lists.")
    return page(f"cutoffs/{year}", title, desc,
                [("NEET PG Cutoff Explorer", ""), ("Cutoffs", "cutoffs/"), (year, f"cutoffs/{year}/")], body)


def hub_page(per_year):
    blocks = []
    for year, (courses, states) in per_year.items():
        course_links = " · ".join(f'<a href="{year}/{c["slug"]}/">{esc(c["degree"])} {esc(c["subject"])}</a>'
                                  for c in sorted(courses, key=lambda c: (c["subject"], c["degree"])))
        state_links = " · ".join(f'<a href="{year}/state/{s["slug"]}/">{esc(s["state"])}</a>' for s in states)
        blocks.append(f'<h2><a href="{year}/">NEET PG {year} cutoff</a></h2><h3>By course</h3><p class="links">{course_links}</p>'
                      f'<h3>By state</h3><p class="links">{state_links}</p>')
    years = ", ".join(per_year)
    body = f"""    <h1>NEET PG cutoffs {years}: every course, college and state</h1>
    <p class="lede">College-wise NEET PG closing ranks for MCC All India counselling (All India, DNB, Deemed/Paid and other central quotas), every round, every category. Built from the official MCC allotment PDFs by {AUTHOR['name']}.</p>
    {''.join(blocks)}"""
    return page("cutoffs", f"NEET PG Cutoff {years}: All Courses, Colleges & States",
                f"NEET PG cutoff ranks for {years}: course-wise, college-wise and state-wise closing ranks for every MCC round and category.",
                [("NEET PG Cutoff Explorer", ""), ("Cutoffs", "cutoffs/")], body)


def write_sitemap(urls):
    items = "".join(f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{TODAY}</lastmod>\n  </url>\n" for u in urls)
    with open(os.path.join(DOCS, "sitemap.xml"), "w") as fh:
        fh.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<!-- Generated by scripts/build_pages.py. The explorer\'s tabs are #fragments, so its root is one URL. -->\n'
                 f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{items}</urlset>\n')


def update_index_links(per_year):
    """Plain links from the explorer page so crawlers find the static pages."""
    path = os.path.join(DOCS, "index.html")
    with open(path) as fh:
        doc = fh.read()
    year_links = " · ".join(f'<a href="cutoffs/{y}/">NEET PG {y} cutoff</a>' for y in per_year)
    latest, (courses, states) = next(iter(per_year.items()))
    top = sorted(courses, key=lambda c: -c["seats"])[:12]
    course_links = " · ".join(f'<a href="cutoffs/{latest}/{c["slug"]}/">{esc(c["degree"])} {esc(c["subject"])}</a>' for c in top)
    state_links = " · ".join(f'<a href="cutoffs/{latest}/state/{s["slug"]}/">{esc(s["state"])}</a>' for s in states[:12])
    block = (f'<!-- seo-links -->\n  <nav class="seo-links" aria-label="Cutoff pages">\n'
             f'    <p><b>Cutoff lists:</b> {year_links} · <a href="cutoffs/">all courses &amp; states</a></p>\n'
             f'    <p><b>{latest} by course:</b> {course_links}</p>\n'
             f'    <p><b>{latest} by state:</b> {state_links}</p>\n'
             f'  </nav>\n  <!-- /seo-links -->')
    doc, n = re.subn(r"<!-- seo-links -->.*?<!-- /seo-links -->", block, doc, flags=re.S)
    if n != 1:
        raise ValueError("docs/index.html needs exactly one <!-- seo-links --> … <!-- /seo-links --> block")
    with open(path, "w") as fh:
        fh.write(doc)


def main():
    years = load_years()
    all_seats = {y: seats_of(d) for y, d in years.items()}
    by_subject_years = defaultdict(set)
    for y, seats in all_seats.items():
        for s in seats:
            by_subject_years[(s["degree"], s["subject"])].add(y)
    urls = [SITE, SITE + "cutoffs/"]
    per_year = {}
    for y, d in years.items():
        c_urls, courses = course_pages(y, d, all_seats[y], by_subject_years)
        s_urls, states = state_pages(y, d, all_seats[y])
        urls += [year_page(y, d, courses, states)] + c_urls + s_urls
        per_year[y] = (courses, states)
        print(f"{y}: {len(c_urls)} course pages, {len(s_urls)} state pages")
    hub_page(per_year)
    write_sitemap(urls)
    update_index_links(per_year)
    print(f"sitemap: {len(urls)} URLs")


if __name__ == "__main__":
    main()

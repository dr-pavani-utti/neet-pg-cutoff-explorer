"""Build compact JSON datasets for the website from MCC NEET-PG allotment PDFs.

    .venv/bin/python scripts/build_data.py            # all years in scripts/sources.json
    .venv/bin/python scripts/build_data.py 2025       # one year

Reads PDFs listed in scripts/sources.json, caches raw table rows in build/, and writes
docs/data/<year>.json (allotments), docs/data/<year>-rounds.json (per-rank upgrade outcomes,
loaded only by the Rank lookup), docs/data/<year>-allotments.csv and docs/data/index.json.

Two table layouts are understood, detected from the header row:
  * single round:  SNo | Rank | Allotted Quota | Allotted Institute | Course | Alloted Category
                   | Candidate Category | Remarks
  * upgrade round: [SNo] | Rank | <Allotted Quota | Allotted Institute | Course | Remarks> per earlier round
                   | Allotted Quota | Allotted Institute | Course | Alloted Category | candidate Category
                   | option No. | [Remarks]
    One Rank column serves every round; each round's block starts at "Allotted Quota". Earlier-round
    blocks may print course codes ("GMED") instead of names; they are only read for the reporting status.
"""
import csv
import json
import os
import re
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

import pdfplumber

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data")
CACHE = os.path.join(ROOT, "build")

# ---------------------------------------------------------------- extraction


def _page_rows(args):
    path, index = args
    with pdfplumber.open(path) as pdf:
        tables = pdf.pages[index].extract_tables()
    return [row for table in tables for row in table]


def extract_rows(pdf_path):
    """All table rows of a PDF, cached by file size + mtime."""
    st = os.stat(pdf_path)
    tag = f"{st.st_size}-{int(st.st_mtime)}"
    cache = os.path.join(CACHE, re.sub(r"[^\w.-]", "_", os.path.relpath(pdf_path, ROOT)) + ".json")
    if os.path.exists(cache):
        with open(cache) as fh:
            data = json.load(fh)
        if data.get("tag") == tag:
            return data["pages"], data["rows"]
    with pdfplumber.open(pdf_path) as pdf:
        count = len(pdf.pages)
    with ProcessPoolExecutor() as pool:
        pages = list(pool.map(_page_rows, [(pdf_path, i) for i in range(count)], chunksize=8))
    rows = [row for page in pages for row in page]
    os.makedirs(CACHE, exist_ok=True)
    with open(cache, "w") as fh:
        json.dump({"tag": tag, "pages": count, "rows": rows}, fh)
    return count, rows


# ---------------------------------------------------------------- normalisation


def clean(value):
    return re.sub(r"\s+", " ", (value or "").replace("\n", " ")).strip()


def key(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


SMALL_WORDS = {"and", "of", "the", "for", "in", "at", "&"}
ACRONYMS = {"AIIMS", "IPGMER", "JIPMER", "PGIMER", "SKIMS", "NIMHANS", "SGPGI", "SGPGIMS", "KIMS", "SIMS", "NIMS",
            "ESIC", "IGIMS", "RIMS", "GIPMER", "SCTIMST", "HCG", "MIOT", "SRM", "NRS", "KEM", "BYL", "PVT", "LTD",
            "LLP", "ILBS", "IGMC", "RMLIMS", "KGMU", "BHU", "CMC", "SMS", "GMCH", "AMRI", "KMC", "MGM", "GMC", "GMERS",
            "AIIMS,", "PGIMS", "IMS", "SVIMS", "JJM", "JSS", "KVG", "MVJ", "RML", "LTMMC", "BRD", "GSVM", "SSKM",
            "IPGME&R", "VMMC", "UCMS", "MAMC", "LHMC", "ABVIMS", "MLN", "SN", "SNMC", "PIMS", "DY", "ESI", "BJ"}


def tidy_caps(name):
    """Title-case names printed in ALL CAPS; keep short tokens (AIIMS-style acronyms) upper-case."""
    if any(ch.islower() for ch in name):
        return name
    words = []
    for word in name.split(" "):
        low = word.lower()
        if low in SMALL_WORDS:
            words.append(low)
        elif len(word.strip(".()-")) <= 3 or "." in word or word.strip(".()-,") in ACRONYMS:
            words.append(word)
        else:
            words.append(word.capitalize())
    return " ".join(words)


def to_int(value):
    value = clean(value)
    return int(value) if value.isdigit() else None


STATES = {
    "Andaman and Nicobar": "Andaman & Nicobar", "Andhra Pradesh": None, "Arunachal Pradesh": None,
    "Assam": None, "Bihar": None, "Chandigarh": None, "Chhattisgarh": None, "Delhi": None, "Goa": None,
    "Gujarat": None, "Haryana": None, "Himachal Pradesh": None, "Jammu and Kashmir": "Jammu & Kashmir",
    "Jammu & Kashmir": None, "Jharkhand": None, "Karnataka": None, "Kerala": None, "Ladakh": None,
    "Madhya Pradesh": None, "Maharashtra": None, "Manipur": None, "Meghalaya": None, "Mizoram": None,
    "Nagaland": None, "Odisha": None, "Orissa": "Odisha", "Puducherry": None, "Pondicherry": "Puducherry",
    "Punjab": None, "Rajasthan": None, "Sikkim": None, "Tamil Nadu": None, "Telangana": None,
    "Tripura": None, "Uttar Pradesh": None, "Uttarakhand": None, "West Bengal": None,
    "Dadra and Nagar Haveli": "Dadra & Nagar Haveli", "Daman": "Daman & Diu", "Silvassa": "Dadra & Nagar Haveli",
    "Uttaranchal": "Uttarakhand", "TamilNadu": "Tamil Nadu", "J&K": "Jammu & Kashmir",
}
# Addresses that never spell out the state.
CITY_STATE = {
    "ahmedabad": "Gujarat", "kachchh": "Gujarat", "mumbai": "Maharashtra", "hyderabad": "Telangana",
    "kannur": "Kerala", "guwahati": "Assam", "bhopal": "Madhya Pradesh", "dehradun": "Uttarakhand",
    "bangalore": "Karnataka", "bengaluru": "Karnataka", "varanasi": "Uttar Pradesh", "chennai": "Tamil Nadu",
    "kolkata": "West Bengal", "pune": "Maharashtra", "lucknow": "Uttar Pradesh", "jaipur": "Rajasthan",
    "madurai": "Tamil Nadu", "u\\.p\\.?": "Uttar Pradesh", "up": "Uttar Pradesh", "m\\.p\\.?": "Madhya Pradesh",
    "c\\.g": "Chhattisgarh", "hp": "Himachal Pradesh", "andhra": "Andhra Pradesh", "karnata": "Karnataka",
    "palakkad": "Kerala", "almora": "Uttarakhand", "anantnag": "Jammu & Kashmir", "baramulla": "Jammu & Kashmir",
    "kathua": "Jammu & Kashmir", "machilipatnam": "Andhra Pradesh", "ramagundam": "Telangana",
    "chikkaballapura": "Karnataka", "haveri": "Karnataka", "lakhimpur": "Assam", "fatehpur": "Uttar Pradesh",
}
# Last resort: PIN code prefix (India Post postal circles), longest prefix wins.
PIN_STATE = {
    "11": "Delhi", "12": "Haryana", "13": "Haryana", "14": "Punjab", "15": "Punjab", "160": "Chandigarh",
    "16": "Punjab", "17": "Himachal Pradesh", "18": "Jammu & Kashmir", "19": "Jammu & Kashmir", "194": "Ladakh",
    "20": "Uttar Pradesh", "21": "Uttar Pradesh", "22": "Uttar Pradesh", "23": "Uttar Pradesh",
    "24": "Uttar Pradesh", "246": "Uttarakhand", "247": "Uttarakhand", "248": "Uttarakhand", "249": "Uttarakhand",
    "25": "Uttar Pradesh", "26": "Uttar Pradesh", "262": "Uttarakhand", "263": "Uttarakhand",
    "27": "Uttar Pradesh", "28": "Uttar Pradesh", "30": "Rajasthan", "31": "Rajasthan", "32": "Rajasthan",
    "33": "Rajasthan", "34": "Rajasthan", "36": "Gujarat", "37": "Gujarat", "38": "Gujarat", "39": "Gujarat",
    "40": "Maharashtra", "403": "Goa", "41": "Maharashtra", "42": "Maharashtra", "43": "Maharashtra",
    "44": "Maharashtra", "45": "Madhya Pradesh", "46": "Madhya Pradesh", "47": "Madhya Pradesh",
    "48": "Madhya Pradesh", "49": "Chhattisgarh", "50": "Telangana", "51": "Andhra Pradesh",
    "52": "Andhra Pradesh", "53": "Andhra Pradesh", "56": "Karnataka", "57": "Karnataka", "58": "Karnataka",
    "59": "Karnataka", "60": "Tamil Nadu", "605": "Puducherry", "61": "Tamil Nadu", "62": "Tamil Nadu",
    "63": "Tamil Nadu", "64": "Tamil Nadu", "67": "Kerala", "68": "Kerala", "69": "Kerala", "70": "West Bengal",
    "71": "West Bengal", "72": "West Bengal", "73": "West Bengal", "737": "Sikkim", "74": "West Bengal",
    "744": "Andaman & Nicobar", "75": "Odisha", "76": "Odisha", "77": "Odisha", "78": "Assam",
    "790": "Arunachal Pradesh", "791": "Arunachal Pradesh", "792": "Arunachal Pradesh", "793": "Meghalaya",
    "794": "Meghalaya", "795": "Manipur", "796": "Mizoram", "797": "Nagaland", "798": "Nagaland",
    "799": "Tripura", "80": "Bihar", "81": "Jharkhand", "82": "Jharkhand", "83": "Jharkhand", "84": "Bihar",
    "85": "Bihar",
}
STATE_RX = re.compile(r"\b(" + "|".join(re.escape(s) for s in sorted(STATES, key=len, reverse=True)) + r")(?![\w])", re.I)
CITY_RX = re.compile(r"\b(" + "|".join(CITY_STATE) + r")(?![\w])", re.I)
CITY_CANON = [(re.compile(rx + "$", re.I), s) for rx, s in CITY_STATE.items()]
STATE_CANON = {s.lower(): (alias or s) for s, alias in STATES.items()}


def detect_state(address):
    hits = STATE_RX.findall(address)
    if hits:
        return STATE_CANON[hits[-1].lower()]
    hits = CITY_RX.findall(address)
    if hits:
        return next(s for rx, s in CITY_CANON if rx.match(hits[-1]))
    pins = re.findall(r"(?<!\d)\d{6}(?!\d)", address)
    if pins:
        return PIN_STATE.get(pins[-1][:3]) or PIN_STATE.get(pins[-1][:2]) or "Unknown"
    return "Unknown"


# Degree from the start of the course text. MCC prints e.g. "M.D. (GENERAL MEDICINE)",
# "(NBEMS) GENERAL MEDICINE", "(NBEMS-DIPLOMA) PAEDIATRICS", "DIP. IN FORENSIC MEDICINE", "MD/MS (Anatomy)".
DEGREES = [
    (r"\(NBEMS\s*-\s*DIPLOMA\)", "DNB Diploma"), (r"\(NBEMS\)", "DNB"), (r"MD\s*/\s*MS\b", "MD/MS"),
    (r"M\.\s*D\.?", "MD"), (r"M\.\s*S\.", "MS"), (r"M\.\s*Ch\.?", "MCh"), (r"M\.\s*P\.\s*H\.", "MPH"),
    (r"(PG\s+)?DIP(LOMA)?\.?\s*(IN\b|-)?", "Diploma"),
]
DEGREE_RX = [(re.compile(r"^\s*" + rx, re.I), deg) for rx, deg in DEGREES]
# Canonical subject: first rule whose fragment occurs in the letters-only course text wins, so
# wrapped words ("DERMATOLO GY") and the many MCC spellings of one subject land together.
# Order matters (paediatric surgery before paediatrics, community health before community medicine).
SUBJECTS = [
    ("paediatricsurgery", "Paediatric Surgery (6-yr)"), ("plastic", "Plastic & Reconstructive Surgery (6-yr)"),
    ("cardio", "Cardiothoracic & Vascular Surgery (6-yr)"), ("neurosurgery", "Neurosurgery (6-yr)"),
    ("anaesthesi", "Anaesthesiology"), ("anatomy", "Anatomy"), ("biochem", "Biochemistry"),
    ("transfusion", "Immunohaematology & Blood Transfusion"),
    ("communityhealth", "Community Health & Administration"), ("communitymedicine", "Community Medicine"),
    ("preventive", "Community Medicine"), ("derm", "Dermatology, Venereology & Leprosy"),
    ("emergency", "Emergency Medicine"), ("familymedicine", "Family Medicine"), ("forensic", "Forensic Medicine"),
    ("generalmedicine", "General Medicine"), ("generalsurgery", "General Surgery"), ("geriatric", "Geriatrics"),
    ("hospitaladministration", "Hospital Administration"), ("healthadministration", "Hospital Administration"),
    ("bacteriology", "Microbiology"), ("microbiology", "Microbiology"), ("nuclearmedicine", "Nuclear Medicine"),
    ("radiationmedicine", "Nuclear Medicine"), ("radiotherapy", "Radiation Oncology"),
    ("radiationoncology", "Radiation Oncology"), ("radiodiagnosis", "Radiodiagnosis"),
    ("ophthal", "Ophthalmology"), ("orthopaed", "Orthopaedics"), ("obst", "Obstetrics & Gynaecology"),
    ("gynae", "Obstetrics & Gynaecology"), ("otorhino", "ENT"), ("childhealth", "Paediatrics"),
    ("paediatrics", "Paediatrics"), ("pathology", "Pathology"), ("pharmacology", "Pharmacology"),
    ("physicalmed", "Physical Medicine & Rehabilitation"), ("phymedicine", "Physical Medicine & Rehabilitation"),
    ("physiology", "Physiology"), ("psychiatr", "Psychiatry"), ("psychological", "Psychiatry"),
    ("palliative", "Palliative Medicine"), ("respiratory", "Respiratory Medicine"),
    ("tuberculosis", "Respiratory Medicine"), ("chest", "Respiratory Medicine"),
    ("sportsmedicine", "Sports Medicine"), ("tropical", "Tropical Medicine"), ("aerospace", "Aerospace Medicine"),
    ("laboratorymedicine", "Laboratory Medicine"), ("epidemiology", "Epidemiology"),
    ("traumatology", "Traumatology & Surgery"), ("publichealth", "Public Health"), ("diabetology", "Diabetology"),
]
UNKNOWN_COURSES = Counter()


def split_course(text):
    degree, rest = "Other", text
    for rx, deg in DEGREE_RX:
        m = rx.match(text)
        if m:
            degree, rest = deg, text[m.end():]
            break
    if degree == "MD" and re.search(r"/\s*MS\b", rest):  # "M.D. (Obst. and Gynae)/MS (Obstetrics and Gynaecology)"
        degree = "MD/MS"
    k = key(rest)
    if k == "ent":  # "M.S. (E.N.T.)"
        return degree, "ENT"
    for frag, subject in SUBJECTS:
        if frag in k:
            return degree, subject
    UNKNOWN_COURSES[text] += 1
    rest = rest.strip(" ()")
    return degree, rest if rest != rest.upper() else rest.title()


QUOTAS = {
    "allindia": "All India", "ai": "All India",
    "dnbquota": "DNB Quota", "ad": "DNB Quota",
    "managementpaidseatsquota": "Deemed/Paid Seats", "selffinancedmeritseatpaidseatquota": "Deemed/Paid Seats",
    "selffinancedmeritseat": "Deemed/Paid Seats", "ps": "Deemed/Paid Seats",
    "nonresidentindian": "NRI", "nr": "NRI",
    "delhiuniversityquota": "Delhi University", "du": "Delhi University",
    "ipuniversityquota": "IP University", "ip": "IP University",
    "aligarhmuslimuniversity": "Aligarh Muslim University", "am": "Aligarh Muslim University",
    "banarashinduuniversity": "Banaras Hindu University", "bh": "Banaras Hindu University",
    "jainminorityquota": "Jain Minority", "jm": "Jain Minority",
    "muslimminorityquota": "Muslim Minority", "mm": "Muslim Minority",
    "armedforcesmedical": "Armed Forces Medical", "af": "Armed Forces Medical",
}


def normalise_quota(text):
    q = QUOTAS.get(key(text))
    if q is None:
        raise ValueError(f"unknown quota {text!r}; add it to QUOTAS")
    return q


CATEGORIES = {"open": "Open", "gn": "Open", "general": "General", "obc": "OBC", "bc": "OBC", "ews": "EWS",
              "ew": "EWS", "sc": "SC", "st": "ST"}


def normalise_category(text):
    k = key(text)
    # Stray lists print some PwD candidates as "GNYes" (code + PwD flag).
    pwd = k.endswith("pwd") or k.endswith("yes")
    base = CATEGORIES.get(k[:-3] if pwd else k)
    if base is None:
        raise ValueError(f"unknown category {text!r}; add it to CATEGORIES")
    return f"{base} PwD" if pwd else base


OUTCOMES = {
    "upgraded": "Upgraded", "noupgradation": "No Upgradation", "notallotted": "Not Allotted",
    "didnotfillupfreshchoices": "Did not fill up fresh choices",
    "didnotoptforupgradation": "Did not opt for Upgradation",
}


def normalise_outcome(text):
    text = re.sub(r"\(\s*(NRI Priority|AFMS Rank)\s*:\s*\d+\s*\)", "", text).strip()
    k = key(text)
    if k.startswith("freshallotted"):  # "Fresh Allotted in 2nd Round" / "... 3nd Round"
        return "Fresh allotment"
    return OUTCOMES.get(k, text.rstrip("."))


class Table:
    """Interning table: value -> index, preserving first-seen order."""

    def __init__(self):
        self.items, self.index = [], {}

    def add(self, k, value=None):
        if k not in self.index:
            self.index[k] = len(self.items)
            self.items.append(value if value is not None else k)
        return self.index[k]


# ---------------------------------------------------------------- parsing


def find_header(rows):
    """Header row (names as letters-only keys, blank cells kept so raw rows can be aligned)."""
    for row in rows:
        names = [key(clean(c)) for c in row]
        if "rank" in names and "allottedinstitute" in names:
            return names
    raise ValueError("no header row with Rank and Allotted Institute found")


def data_rows(rows, raw_header):
    """Rows aligned to the header with its blank columns removed.

    Narrow numeric columns wrap ("1000 0" for 10000), so digits-and-spaces cells are joined. Any other
    row as wide as the header that is neither a header nor a data row is an error, not a skip.
    """
    blanks = {i for i, n in enumerate(raw_header) if not n}
    width = len(raw_header) - len(blanks)
    out = []
    for row in rows:
        if not row:
            continue
        cells = [clean(c) for c in row]
        cells = [c.replace(" ", "") if re.fullmatch(r"\d[\d ]*", c) else c for c in cells]
        if not cells[0].isdigit():
            if len(cells) >= width and any(cells) and key(cells[0]) not in ("sno", "rank") \
                    and not cells[0].startswith(("NEET", "Round", "Counselling", "Provisional")):
                raise ValueError(f"unrecognised row: {cells}")
            continue
        if len(cells) == len(raw_header) and blanks:
            cells = [c for i, c in enumerate(cells) if i not in blanks]
        while len(cells) > width:  # stray empty column on some pages
            gap = next((i for i, c in enumerate(cells) if c == "" and i > 0), None)
            if gap is None:
                raise ValueError(f"cannot fit row to header: {cells}")
            del cells[gap]
        if len(cells) != width:
            raise ValueError(f"row width {len(cells)} != header {width}: {cells}")
        out.append(cells)
    return out


def check_order(rows, header):
    """Rows are lost silently if pdfplumber misses a table; serial numbers / rank order catch that."""
    if header[0] == "sno":
        sno = [int(r[0]) for r in rows]
        if sno != list(range(1, len(sno) + 1)):
            raise ValueError("serial numbers are not contiguous 1..N; extraction lost rows")
    rank = header.index("rank")
    ranks = [int(r[rank]) for r in rows]
    if any(b <= a for a, b in zip(ranks, ranks[1:])) and header[0] != "sno":
        raise ValueError("ranks are not strictly increasing; extraction mangled rows")


class YearBuilder:
    def __init__(self, year):
        self.year = year
        self.quotas, self.categories, self.kinds = Table(), Table(), Table()
        self.statuses, self.outcomes = Table(), Table()
        self.courses, self.institutes = Table(), Table()
        self.allotments = []  # [round, rank, inst, course, quota, category, kind]
        self.candidate_cats = []  # parallel to allotments; CSV only
        self.trail = []  # [round, rank, status going in, outcome, option]
        self.rounds = []
        self.quotas.add("All India")

    def course(self, text):
        degree, subject = split_course(text)
        return self.courses.add(f"{degree}|{subject}", [degree, subject])

    def institute(self, text):
        """Same institute is printed with differing addresses across rounds; identify it by name + PIN."""
        name = text.split(",")[0].strip()
        pins = re.findall(r"(?<!\d)\d{6}(?!\d)", text)
        k = key(name) + pins[-1] if pins else key(text)
        if k not in self.institutes.index:
            self.institutes.add(k, {"name": name, "address": text, "state": detect_state(text)})
        return self.institutes.index[k]

    def add_allotment(self, rnd, rank, inst, course, quota, category, candidate, kind):
        self.allotments.append([rnd, rank, self.institute(inst), self.course(course),
                                self.quotas.add(normalise_quota(quota)),
                                self.categories.add(normalise_category(category)), self.kinds.add(kind)])
        self.candidate_cats.append(normalise_category(candidate))

    def parse_round(self, rnd, path):
        pages, raw = extract_rows(path)
        raw_header = find_header(raw)
        header = [n for n in raw_header if n]
        rows = data_rows(raw, raw_header)
        check_order(rows, header)
        starts = [i for i, n in enumerate(header) if n == "allottedquota"]
        sections = [{n: i for i, n in enumerate(header[s:e], s)} for s, e in zip(starts, starts[1:] + [len(header)])]
        *prev, cur = sections
        cat = cur["allotedcategory"]
        cand = next(i for n, i in cur.items() if n.startswith("candidatecategory"))
        course = next(i for n, i in cur.items() if n.startswith("course"))
        rank_col = header.index("rank")
        held = {a[1] for a in self.allotments}  # ranks holding a seat from an earlier round
        listed = set()
        for r in rows:
            rank = int(r[rank_col])
            listed.add(rank)
            remark = r[cur["remarks"]] if "remarks" in cur else ""
            got = r[cur["allottedinstitute"]] not in ("", "-")
            if not prev:
                if got:
                    self.add_allotment(rnd, rank, r[cur["allottedinstitute"]], r[course], r[cur["allottedquota"]],
                                       r[cat], r[cand], "Allotted")
                continue
            # Status going into this round: the latest earlier block that shows a seat.
            status = next((r[s["remarks"]] for s in reversed(prev) if r[s["allottedinstitute"]] not in ("", "-")),
                          "No earlier seat")
            outcome = normalise_outcome(remark) if remark else ""
            if got:
                kind = "Upgraded" if outcome == "Upgraded" or (not outcome and status != "No earlier seat") else "Fresh"
                outcome = outcome or ("Upgraded" if kind == "Upgraded" else "Fresh allotment")
                self.add_allotment(rnd, rank, r[cur["allottedinstitute"]], r[course], r[cur["allottedquota"]],
                                   r[cat], r[cand], kind)
            option = (to_int(r[cur["optionno"]]) or 0) if "optionno" in cur else 0
            self.trail.append([rnd, rank, self.statuses.add(status), self.outcomes.add(outcome or "Not Allotted"),
                               option])
        if prev:
            missing = held - listed
            if missing:
                print(f"  warning: {len(missing)} earlier seat holders missing from this list, e.g. {sorted(missing)[:5]}")
        return pages, len(rows)

    def institute_labels(self):
        insts = self.institutes.items
        # Bare acronyms ("PGIMER") say little on their own; append the next address segment.
        labels = [i["name"] if len(i["name"]) >= 12 or not self._second_segment(i)
                  else f"{i['name']}, {self._second_segment(i)}" for i in insts]
        for extra in (self._second_segment, lambda i: i["state"], lambda i: re.findall(r"\d{6}", i["address"])[-1:]):
            counts = Counter(l.lower() for l in labels)
            for n, inst in enumerate(insts):
                if counts[labels[n].lower()] > 1:
                    add = extra(inst)
                    add = add[0] if isinstance(add, list) else add
                    if add and add.lower() not in labels[n].lower():
                        labels[n] = f"{labels[n]}, {add}"
        return [tidy_caps(l) for l in labels]

    @staticmethod
    def _second_segment(inst):
        parts = [s.strip() for s in inst["address"].split(",")]
        seg = next((p for p in parts[1:] if p), "")
        return seg if len(seg) <= 40 and not seg.isdigit() and key(seg) != key(inst["name"]) else ""

    def to_json(self, meta):
        labels = self.institute_labels()
        return {
            "year": self.year,
            "rounds": self.rounds,
            "quotas": self.quotas.items,
            "categories": self.categories.items,
            "kinds": self.kinds.items,
            "courses": self.courses.items,
            "institutes": [[labels[n], i["state"], i["address"]] for n, i in enumerate(self.institutes.items)],
            "allotments": self.allotments,
            "sources": meta,
        }

    def trail_json(self):
        return {"year": self.year, "statuses": self.statuses.items, "outcomes": self.outcomes.items,
                "trail": self.trail}


def build_year(year, spec):
    b = YearBuilder(year)
    meta = []
    for rnd, entry in enumerate(spec["rounds"]):
        path = os.path.join(ROOT, entry["file"])
        pages, rows = b.parse_round(rnd, path)
        b.rounds.append({"id": entry["id"], "label": entry["label"]})
        n = sum(1 for a in b.allotments if a[0] == rnd)
        meta.append({"round": entry["id"], "file": entry["file"], "pages": pages, "rows": rows, "allotments": n})
        print(f"  {entry['id']}: {pages} pages, {rows} rows, {n} allotments")
    unknown = [i["address"] for i in b.institutes.items if i["state"] == "Unknown"]
    if unknown:
        print(f"  warning: state unknown for {len(unknown)} institutes: {unknown[:8]}")
    return b, meta


def write_csv(path, b, data):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["year", "round", "rank", "degree", "subject", "institute", "state", "quota",
                    "allotted_category", "candidate_category", "kind"])
        for a, cand in zip(data["allotments"], b.candidate_cats):
            course, inst = data["courses"][a[3]], data["institutes"][a[2]]
            w.writerow([data["year"], data["rounds"][a[0]]["label"], a[1], course[0], course[1], inst[0], inst[1],
                        data["quotas"][a[4]], data["categories"][a[5]], cand, data["kinds"][a[6]]])


def main(argv):
    with open(os.path.join(ROOT, "scripts", "sources.json")) as fh:
        sources = json.load(fh)
    years = argv or list(sources)
    os.makedirs(OUT, exist_ok=True)
    for year in years:
        print(f"{year}:")
        b, meta = build_year(year, sources[year])
        data = b.to_json(meta)
        with open(os.path.join(OUT, f"{year}.json"), "w") as fh:
            json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
        with open(os.path.join(OUT, f"{year}-rounds.json"), "w") as fh:
            json.dump(b.trail_json(), fh, separators=(",", ":"), ensure_ascii=False)
        write_csv(os.path.join(OUT, f"{year}-allotments.csv"), b, data)
    if UNKNOWN_COURSES:
        print(f"warning: courses without a SUBJECTS rule: {UNKNOWN_COURSES.most_common()}")
    index = [{"year": y, "rounds": [r["label"] for r in sources[y]["rounds"]]}
             for y in sorted(sources, reverse=True) if os.path.exists(os.path.join(OUT, f"{y}.json"))]
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump({"years": index}, fh, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])

#!/usr/bin/env python3
"""Rebuild index.html from the current CMS DMEPOS fee schedule.

Finds the newest quarterly file CMS has published, downloads it, and embeds the
data into template.html. Standard library only -- no pip install, so this runs
anywhere Python 3.8+ exists, including a bare CI runner.

    python3 build.py            # rebuild from the newest published quarter
    python3 build.py --check    # say what's newest and whether we're behind (exit 1 if behind)
    python3 build.py --quarter 2026-c

CMS naming, verified back to 2024: the January file is dme{YY}.zip and later
quarters are dme{YY}-b (April), -c (July), -d (October). Quarters are published
"as necessary", so a quarter starting does not mean a file exists -- we probe.
"""

import argparse
import base64
import csv
import gzip
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import date

BASE = "https://www.cms.gov/files/zip/{}.zip"
HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "template.html")
OUTPUT = os.path.join(HERE, "index.html")
UA = {"User-Agent": "nwrm-dmepos-builder/1.0"}

QNAME = {1: "January", 2: "April", 3: "July", 4: "October"}
QMONTH = {1: 1, 2: 4, 3: 7, 4: 10}

CATG = {
    "IN": "Inexpensive and Other Routinely Purchased Items",
    "FS": "Frequently Serviced Items",
    "CR": "Capped Rental Items",
    "OX": "Oxygen and Oxygen Equipment",
    "OS": "Ostomy, Tracheostomy & Urological Items",
    "SD": "Surgical Dressings",
    "PO": "Prosthetics & Orthotics",
    "SU": "Supplies",
    "TE": "Transcutaneous Electrical Nerve Stimulators",
    "TS": "Therapeutic Shoes",
    "IL": "Intraocular Lenses",
    "SC": "Splints and Casts",
    "LC": "Lymphedema Compression Treatment Items",
    "LT": "Labor Rates",
}
JURIS = {
    "D": "DME MAC jurisdiction",
    "L": "Local Part B Carrier jurisdiction",
    "J": "Joint DME MAC / Local Carrier jurisdiction",
}
MODS = {
    "NU": "New equipment (purchase)",
    "RR": "Rental (monthly)",
    "UE": "Used equipment (purchase)",
    "KE": "Bid under round one of the DMEPOS CBP, for use with non-competitive-bid base equipment",
    "KU": "DMEPOS item subject to DMEPOS Competitive Bidding Program number 3",
    "KF": "Item designated by FDA as a class III device",
    "KG": "DMEPOS item subject to DMEPOS Competitive Bidding Program number 1",
    "KL": "DMEPOS item delivered via mail",
    "KM": "Replacement of facial prosthesis including new impression/moulage",
    "KN": "Replacement of facial prosthesis using previous master model",
    "KC": "Replacement of special power wheelchair interface",
    "AU": "Item furnished in conjunction with a urological, ostomy, or tracheostomy supply",
    "AV": "Item furnished in conjunction with a prosthetic device, prosthetic or orthotic",
    "AW": "Item furnished in conjunction with a surgical dressing",
    "QB": "Stationary oxygen prescribed above 4 LPM with portable oxygen",
    "QF": "Stationary oxygen at rest above 4 LPM with portable oxygen",
}


# ---------------------------------------------------------------- CMS discovery
def filename_for(year, q):
    yy = str(year)[2:]
    return "dme{}".format(yy) if q == 1 else "dme{}-{}".format(yy, "?bcd"[q - 1])


def exists(year, q):
    req = urllib.request.Request(BASE.format(filename_for(year, q)), headers=UA, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError:
        return False
    except urllib.error.URLError as e:
        raise SystemExit("Could not reach cms.gov: {}".format(e.reason))


def newest_published():
    """Walk back from one quarter ahead of today until CMS has a file."""
    today = date.today()
    y, q = today.year, (today.month - 1) // 3 + 1
    q += 1                                   # CMS posts January in December
    if q > 4:
        q, y = 1, y + 1
    for _ in range(12):                      # three years is far more than enough
        if exists(y, q):
            return y, q
        q -= 1
        if q < 1:
            q, y = 4, y - 1
    raise SystemExit("Found no published DMEPOS file in the last three years.")


def download(year, q):
    url = BASE.format(filename_for(year, q))
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        return url, r.read()


# ---------------------------------------------------------------- zip contents
def pick(names, *must, **kw):
    """Find one .csv whose name contains every `must` and no `avoid` token."""
    avoid = kw.get("avoid", ())
    hits = [
        n for n in names
        if n.lower().endswith(".csv")
        and all(m in n.lower() for m in must)
        and not any(a in n.lower() for a in avoid)
    ]
    if not hits:
        raise SystemExit("No CSV in the CMS zip matching {} (avoiding {}).".format(must, avoid))
    return sorted(hits, key=len)[0]


def read_csv(zf, name):
    with zf.open(name) as fh:
        text = io.TextIOWrapper(fh, encoding="latin-1", newline="")
        return list(csv.reader(text))


def header_row(rows, first_cell):
    for i, r in enumerate(rows):
        if r and r[0].strip().lower() == first_cell:
            return i
    raise SystemExit("Could not find a header row starting with {!r}.".format(first_cell))


def money(s):
    s = (s or "").strip().replace("$", "").replace(",", "")
    if not s:
        return 0
    try:
        return round(float(s), 2)
    except ValueError:
        return 0


# ---------------------------------------------------------------- parsing
def parse_schedule(rows):
    h = header_row(rows, "hcpcs")
    hdr = rows[h]
    state_cols = hdr[7:-1]
    states, pairs = [], []
    for i in range(0, len(state_cols) - 1, 2):
        a = re.match(r"([A-Z]{2})\s*\(NR\)", state_cols[i].strip())
        b = re.match(r"([A-Z]{2})\s*\(R\)", state_cols[i + 1].strip())
        if not (a and b and a.group(1) == b.group(1)):
            raise SystemExit("Unexpected state columns: {!r} {!r}".format(state_cols[i], state_cols[i + 1]))
        states.append(a.group(1))
        pairs.append((7 + i, 8 + i))

    out = []
    for r in rows[h + 1:]:
        if not r or len(r) < len(hdr) - 2:
            continue
        code = r[0].strip().upper()
        if not re.match(r"^[A-Z0-9]{5}$", code):
            continue
        out.append([
            code, r[1].strip(), r[2].strip(), r[3].strip(), r[4].strip(),
            money(r[5]), money(r[6]), r[-1].strip(),
            [money(r[i]) for i, _ in pairs],
            [money(r[j]) for _, j in pairs],
        ])
    if not out:
        raise SystemExit("Parsed zero fee schedule rows.")
    return states, out


def parse_cba_fees(rows):
    h = header_row(rows, "hcpcs")
    names = [c.strip() for c in rows[h][5:] if c.strip()]
    n = len(names)
    out = []
    for r in rows[h + 1:]:
        if not r or not r[0].strip():
            continue
        code = r[0].strip().upper()
        if not re.match(r"^[A-Z0-9]{5}$", code):
            continue
        vals = [money(v) for v in r[5:5 + n]]
        vals += [0] * (n - len(vals))
        out.append([code, r[1].strip(), r[2].strip(), r[3].strip(), r[4].strip(), vals])
    return names, out


def parse_zip_rows(rows):
    """Yield (state, zip, rest) for any row shaped like one, ignoring headers."""
    for r in rows:
        if len(r) < 2:
            continue
        st, z = r[0].strip().upper(), r[1].strip()
        if re.match(r"^[A-Z]{2}$", st) and re.match(r"^\d{4,5}$", z):
            yield st, z.zfill(5), r


# ---------------------------------------------------------------- build
def build(year, q, blob, url):
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = zf.namelist()

    f_main = pick(names, "dmepos", avoid=("pen", "former"))
    f_rural = pick(names, "rural", "zip")
    f_cbafee = pick(names, "former cba", "fee", avoid=("mail-order", "national"))
    f_cbazip = pick(names, "former cba", "zip")

    states, fee_rows = parse_schedule(read_csv(zf, f_main))
    cba_names, cba_rows = parse_cba_fees(read_csv(zf, f_cbafee))

    rural = {}
    for st, z, _ in parse_zip_rows(read_csv(zf, f_rural)):
        rural[z] = st

    cba_zip, cba_state, cba_long = {}, {}, {}
    idx = {n: i for i, n in enumerate(cba_names)}
    for st, z, row in parse_zip_rows(read_csv(zf, f_cbazip)):
        cba_state[z] = st
        if len(row) >= 4:
            short, long_ = row[2].strip(), row[3].strip()
            cba_long[short] = long_
            if short in idx:
                cba_zip[z] = idx[short]

    bundle = {
        "quarter": "{} {}".format(QNAME[q], year),
        "effective": "{:04d}-{:02d}-01".format(year, QMONTH[q]),
        "source": url,
        "states": states,
        "catg": CATG,
        "juris": JURIS,
        "mods": MODS,
        "rows": fee_rows,
        "cbaNames": [[s, cba_long.get(s, s)] for s in cba_names],
        "cbaRows": cba_rows,
        "ruralZips": rural,
        "cbaZips": cba_zip,
        "cbaZipState": cba_state,
    }

    raw = json.dumps(bundle, separators=(",", ":")).encode()
    b64 = base64.b64encode(gzip.compress(raw, 9)).decode()

    with open(TEMPLATE, encoding="utf-8") as fh:
        template = fh.read()
    if "__DATA__" not in template:
        raise SystemExit("template.html has no __DATA__ placeholder.")
    page = template.replace("__DATA__", b64)

    if any(ord(c) > 127 for c in page):
        raise SystemExit("Built page contains non-ASCII characters; use HTML entities or \\u escapes.")

    with open(OUTPUT, "w", encoding="utf-8") as fh:
        fh.write(page)

    return {
        "quarter": bundle["quarter"], "codes": len(fee_rows), "states": len(states),
        "cbas": len(cba_names), "cba_rows": len(cba_rows),
        "rural_zips": len(rural), "cba_zips": len(cba_zip),
        "raw_mb": len(raw) / 1e6, "page_kb": len(page.encode()) / 1024,
        "files": [f_main, f_rural, f_cbafee, f_cbazip],
    }


def embedded_quarter():
    """What quarter is the current index.html built from?"""
    if not os.path.exists(OUTPUT):
        return None
    with open(OUTPUT, encoding="utf-8") as fh:
        page = fh.read()          # the payload runs past any partial read
    m = re.search(r'id="payload"[^>]*>\s*([A-Za-z0-9+/=]+)\s*<', page)
    if not m:
        return None
    try:
        data = json.loads(gzip.decompress(base64.b64decode(m.group(1))))
        y, mo = (int(x) for x in data["effective"].split("-")[:2])
        return y, (mo - 1) // 3 + 1
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="report the newest published quarter and exit 1 if index.html is behind")
    ap.add_argument("--quarter", metavar="YYYY-[1-4|b|c|d]",
                    help="build a specific quarter instead of the newest")
    args = ap.parse_args()

    if args.quarter:
        m = re.match(r"^(\d{4})-([1-4bcd])$", args.quarter.lower())
        if not m:
            raise SystemExit("--quarter looks like 2026-c or 2026-3")
        year = int(m.group(1))
        q = {"b": 2, "c": 3, "d": 4}.get(m.group(2), None) or int(m.group(2))
        if not exists(year, q):
            raise SystemExit("CMS has no file at {}.zip".format(filename_for(year, q)))
    else:
        year, q = newest_published()

    have = embedded_quarter()
    label = "{} {}".format(QNAME[q], year)

    if args.check:
        print("newest published : {}  ({}.zip)".format(label, filename_for(year, q)))
        if have:
            print("index.html built : {} {}".format(QNAME[have[1]], have[0]))
        else:
            print("index.html built : (none found)")
        behind = have != (year, q)
        print("status           : {}".format("BEHIND - rebuild needed" if behind else "up to date"))
        return 1 if behind else 0

    print("building from {} ({}.zip) ...".format(label, filename_for(year, q)))
    url, blob = download(year, q)
    print("  downloaded {:.1f} MB".format(len(blob) / 1e6))
    s = build(year, q, blob, url)
    print("  source files : {}".format(", ".join(s["files"])))
    print("  {} codes across {} states, {} former CBAs".format(s["codes"], s["states"], s["cbas"]))
    print("  {} rural ZIPs, {} former-CBA ZIPs".format(s["rural_zips"], s["cba_zips"]))
    print("  {:.2f} MB of data -> {:.0f} KB page".format(s["raw_mb"], s["page_kb"]))
    print("wrote {}".format(OUTPUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())

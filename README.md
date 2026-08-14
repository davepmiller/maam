# DMEPOS Allowed Amounts — Northwest Respiratory & Medical

A single-file lookup for Medicare DMEPOS allowed amounts. Open `index.html`
and type a HCPCS code; the whole fee schedule is embedded, so it works offline
with no server and no CMS lookups.

Defaults are set for **Latah County, Idaho (ZIP 83843)** — on the CMS rural ZIP
list and in no former competitive-bidding area — with NWRM's product lines
pinned in eight collapsible groups.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The built page. This is the only file the user needs. |
| `template.html` | The page source, with a `__DATA__` placeholder for the fee schedule. Edit this, never `index.html`. |
| `build.py` | Downloads the newest CMS quarter and writes `index.html`. Standard library only. |
| `.github/workflows/refresh.yml` | Weekly check + automatic rebuild and commit. |

## Rebuilding

```bash
python3 build.py            # find the newest published quarter, rebuild index.html
python3 build.py --check    # report status only; exits 1 if index.html is behind
python3 build.py --quarter 2026-c   # pin a specific quarter
```

Takes about two seconds and needs no dependencies.

`build.py` locates the four source CSVs by pattern rather than by name, because
CMS renames them between quarters (`DMEPOS_JUL.csv` in July 2026,
`DMEPOS26_JAN.csv` in January; `Zip` vs `ZIP` in the rural file). It refuses to
write a page containing non-ASCII characters, since the published copy relies on
the host's charset.

**After editing `template.html`, run `build.py` to regenerate `index.html`.**

## How CMS publishes

Verified back to 2024:

| Quarter | File |
| --- | --- |
| January | `dme{YY}.zip` — bare year, *not* `-a` |
| April | `dme{YY}-b.zip` |
| July | `dme{YY}-c.zip` |
| October | `dme{YY}-d.zip` |

Updates are quarterly "as necessary" — April and October files sometimes never
appear. So both `build.py` and the page itself probe for a file rather than
assuming one exists because the calendar turned over.

The page runs the same check on open: a zero-byte `HEAD` against cms.gov, which
answers `access-control-allow-origin: *`. If a newer quarter is out it says so
in a banner; if it can't reach CMS it says that instead of pretending.

## A correctness note worth keeping

From the CMS file spec: *"Fee schedule amounts for those codes not adjusted
using competitive bidding information will only have fee schedule amounts in the
non-rural (NR) columns."*

An empty rural column does **not** mean the code is unpriced — the non-rural
figure applies everywhere. This affects roughly two-thirds of the schedule in
Idaho. Reading the rural column naively reports canes, breast pumps, walker
attachments and Group 3 power chairs as "not priced". The page falls back to the
other column and labels those results "ID, all areas". Don't undo that.

## Publishing

`index.html` is self-contained, so any static host works. With
`refresh.yml` running, the published copy updates itself.

Figures are **allowed amounts**. Medicare pays 80% after the Part B deductible.
This is a reference, not a payment determination.

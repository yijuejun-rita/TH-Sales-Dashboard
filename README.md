# TH-Sales-Dashboard

Thailand KA Sales Review — Monthly + Weekly dashboards, static site on GitHub Pages.

- **Monthly Dashboard** (existing, unchanged): `index.html` and the 4 monthly HTML pages.
- **Weekly Dashboard** (new, this update): `weekly/overview.html`, `weekly/channel-store.html`, `weekly/category-sku.html`.

The Weekly Dashboard reads `data/weekly_data.json`, which is regenerated automatically from the
private Google Sheet on an hourly schedule by GitHub Actions (`.github/workflows/weekly-sync.yml`).
**Updating the Google Sheet is the only action required going forward** — no re-upload, no manual
edit of any HTML/JSON file.

## 1. Sheet roles and priority (spec section 一/二)

The workbook currently has 6 tabs. Roles are **detected every sync run by header content**, never by
tab position — `etl/classify.py` looks for the Barcode/Item/Category/WEEK-N-QTY pattern (channel
sheets), the Channel+Store-without-Barcode pattern (store sheet), and the Barcode/Item-without-week
pattern (SKU-total sheet). The names actually recognized are cached in `config/sheet_mapping.json`
after each run purely as an audit trail — renaming a tab or reordering tabs does not break the sync,
it just gets re-detected and the cache file updates itself.

| Sheet (as currently named) | Role | Used for |
|---|---|---|
| `Beautrium`, `Eveandboy`, `Konvy`, `KIS` | Channel × SKU weekly sales | SKU × Channel breakdown (Dashboard 3); fallback/supplement for SKU & category weekly totals |
| `店铺销量` | Store-level weekly sales **value (THB)** | **Source of truth** for overall + channel + store KPIs (Dashboards 1 & 2) |
| `SKU销量` | SKU-level sales | Monthly-only cross-check against the 4 channel sheets; **not usable for weekly KPIs in the current workbook** (no week columns exist on it — see Data Quality below) |

Priority rules implemented exactly as specified:
- Overall & channel weekly totals = **always** `店铺销量` (sum of that channel's valid stores; a
  channel's own `Total` row is used only as a fallback when its per-store rows are blank — flagged,
  never silently invented).
- Store-level figures, WoW, and store alerts = **only** `店铺销量`.
- SKU & category weekly totals = **always** the 4 channel sheets (since `SKU销量` has no week
  columns in this workbook). If `SKU销量` gains week columns in a future edit, `etl/sheet_parser.py`
  picks them up automatically (header-text driven) with no code change.
- SKU × Channel = the 4 channel sheets.
- Selecting "All Channels + All Categories" on Dashboard 1 shows the store-sales-basis KPIs.
  Selecting a specific Category switches those KPIs to the SKU-sales basis and shows the label
  **"Category/SKU scope – based on SKU sales source"**.
- The three sources are **never** reconciled by hand-editing numbers. Differences are computed and
  displayed in the Data Quality panel on every sync (see `data_quality.reconciliation` in the JSON,
  rendered on the Channel & Store and Category & SKU pages).

### Why the store-sales total and the SKU-sales total differ by orders of magnitude

Two separate causes stack up here, and both matter:

1. **Different unit.** `店铺销量` has **no PCS/quantity column at all** — every numeric column on it is
   Thai Baht sales **value**. This was confirmed directly against the workbook: Beautrium's store-sales
   Total row for Aug W1 + Aug W2 is `41,523 + 125,916 = 167,439`, which matches Beautrium's own channel
   sheet **"8月 TTL Value"** column exactly (not "TTL QTY", which is 311 for the same period). A full
   header scan of `店铺销量` turns up zero PCS-labeled columns anywhere. Because of this, overall/
   channel/store KPIs (Dashboards 1 & 2) are reported in **THB**, not PCS — this was an explicit,
   user-confirmed decision (the store-sales sheet genuinely has no PCS basis to report instead).
2. **Different scope.** `店铺销量` reflects each store's total sales value across its whole assortment,
   while the 4 channel sheets and `SKU销量` track only this one product line (~80 barcodes, "RED
   CHAMBER" multi-use sticks/creams/liquids) in PCS piece-count.

Because the two bases differ in both unit and scope, they must never be summed or compared directly —
the dashboards enforce this everywhere, and `data_quality.reconciliation` (`weekly_store_vs_sku_scope`)
carries both `store_basis_unit: "THB"` and `sku_basis_unit: "PCS"` alongside the numeric gap so this is
explicit in the shipped data, not just in this doc.

## 2. Time / week definition (spec section 三)

- Business week = Monday–Sunday, `Asia/Bangkok`. Verified to reproduce the workbook's own free-text
  date-range labels exactly (e.g. `1-2nd Aug`, `3-9th Aug`, `1-7 June`) — see `week_date_range()` in
  `etl/sheet_parser.py`.
- A week is `complete` only if: its end date has passed, **and** every currently-recognized channel
  has reported data for it (via store rows or that channel's own Total row), **and** no channel's
  reporting-store count collapsed vs. its trailing 4-week average. Otherwise it is
  `pending_validation` and is excluded from KPI cards / formal WoW, though it still appears as a raw
  point on the 16-week trend line.
- `Konvy` has **no per-store breakdown at all**, in any week, in `店铺销量` — every store row under it
  is permanently blank; only its channel-level `Total` row carries real numbers. This is flagged as a
  structural Data Quality issue (`sheet_issues`), not a per-week anomaly, and Konvy is excluded from
  store-level drilldowns/alerts (with an explanatory empty-state instead of fake rows).

## 3. Metrics (spec section 四)

Implemented once in `etl/metrics.py` (Python, used only for ETL-side sanity/reconciliation) and
mirrored exactly in `weekly/common.js` (JS, used for all on-page KPI/table/chart math, since filters
must recompute live). Both are null/zero-safe: missing data, a zero denominator, insufficient week
history, or a genuine zero sale never produce `NaN`/`Infinity` — they render as `N/A` with the
underlying reason visible in the surrounding text (e.g. "仅2周历史").

## 4. Delivering the 3 dashboards (spec section 五/六/七)

- **Weekly Sales Overview** (`weekly/overview.html`) — Week/Channel/Category filters, 4 KPI cards,
  16-week trend line (Chart.js `line`, no fill/smoothing/dual-axis, latest point highlighted, past-3-
  week average reference line, tooltips), Weekly Key Findings (≤5 bullets, always concrete numbers,
  never speculative).
- **Channel & Store Performance** (`weekly/channel-store.html`) — channel table + sorted horizontal
  bar chart, channel→store drilldown with search/sort/Top-growth/Top-decline, store alerts.
- **Category & SKU Performance** (`weekly/category-sku.html`) — category table + sorted horizontal
  bar chart, category→SKU drilldown (default sorted by absolute change), SKU×Channel breakdown table
  + chart, SKU alerts.

No pie/gauge/area charts anywhere; all bar charts are horizontal; all % values show an explicit sign;
0% reference implicit via the axis; explicit unit on every value (**THB** for overall/channel/store
figures sourced from `店铺销量`, **PCS** for category/SKU figures sourced from the 4 channel sheets —
never mixed); empty states instead of blank charts where data genuinely doesn't exist (e.g. Konvy's
store table).

## 5. Data quality checks (spec section 九)

Every sync run computes and ships, inside `data.data_quality`:

`sheet_issues`, `week_issues`, `duplicate_barcodes`, `unmapped_sku`, `unmapped_category`,
`unmapped_store`, `negative_values`, `null_as_zero_flags`, `reconciliation`, `structural_warnings`.

Each item carries a `type`, the relevant `week`/`channel`/object, a human `detail` string with actual
numbers, and a `severity` (`high`/`medium`/`low`/`info`). Rendered in full on the Channel & Store and
Category & SKU pages ("数据质量 Data Quality" section), sorted by severity. Nothing here is ever
"fixed" by editing source numbers — only surfaced.

## 6. Google Sheets auto-update setup (spec section 十)

Chosen approach: **GitHub Actions + read-only Google Service Account** (the recommended option).

1. Create/select a Google Cloud project → enable the **Google Sheets API**.
2. Create a **Service Account** (no project-level role needed) → **Keys → Add key → Create new key
   → JSON** → download it.
3. Open the Google Sheet → Share → add the service account's `client_email` as **Viewer**.
4. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = the full contents of the downloaded JSON key file.
   - `GOOGLE_SHEET_ID` = the ID from the sheet's URL
     (`https://docs.google.com/spreadsheets/d/<THIS PART>/edit`).
5. Enable GitHub Pages: **Settings → Pages → Source = GitHub Actions**.
6. Done. `weekly-sync.yml` runs hourly, on every push that touches `etl/**`, and on-demand via the
   **Actions → Weekly Dashboard Sync → Run workflow** button.

Guarantees enforced in the workflow/script:
- The service account key is never written into the repo, never echoed to logs, never embedded in
  any frontend file — only read from the `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable inside
  the Actions runner.
- A sync failure (API error, malformed row, quota, etc.) leaves the last successful
  `data/weekly_data.json` untouched except for a `meta.sync_status="failed"` flag — the site keeps
  showing the last good numbers and a visible "Data sync failed" banner instead of going blank. See
  the failure-path test below.
- If a sync has *never* succeeded (fresh repo, no `data/weekly_data.json` yet), the job fails loudly
  instead of publishing an empty dashboard.

## 7. Field mapping file

`config/sheet_mapping.json` — regenerated on every sync, see section 1 above.

## 8. Local development / testing

```
cd etl
pip install -r requirements.txt   # only needed for --source sheets
python3 build_json.py --source xlsx --path /path/to/exported/workbook.xlsx --out ../data/weekly_data.json
cd ..
python3 -m http.server 8000       # serve the repo root
# open http://localhost:8000/weekly/overview.html
```

`test_pages.js` (Playwright) loads all 4 top-level pages at desktop/tablet/mobile widths and asserts:
no console errors, no `NaN`/`Infinity` anywhere in the rendered text, no horizontal page overflow.
Run with `node test_pages.js` while the local server above is running.

## 9. Test results (this delivery)

**Responsive test** — `node test_pages.js` against `index.html`, `weekly/overview.html`,
`weekly/channel-store.html`, `weekly/category-sku.html` at 1400px / 820px / 390px: all 12
combinations passed (status 200, 0 console errors beyond the CDN block that only exists in this
sandboxed dev environment, no `NaN`/`Infinity`, no horizontal overflow). Screenshots for every
combination are under `screenshots/` in this delivery.

**Sync-failure test** — ran `build_json.py` against a missing/invalid source: exit code 0 (job
would continue to commit + deploy), previous good `data/weekly_data.json` preserved byte-for-byte
except for the added `sync_status="failed"` + reason fields, `latest_complete_week` and all figures
unchanged. Confirms the dashboard cannot go blank from a single failed sync.

**End-to-end ETL test** — ran against the real exported workbook (`Thailand Sales Data.xlsx`):
sheet roles detected correctly with zero warnings, 17 weeks parsed, latest complete week =
2026-08-03~2026-08-09, all three business-week date ranges independently reproduced the workbook's
own free-text week labels exactly, July monthly totals reconcile exactly between the 4 channel
sheets and the `SKU销量` TTL block (5,416 = 5,416), barcode-type inconsistency across sheets
(float vs. text) caught and normalized.

## 10. Known data-source limitations (not bugs — see Data Quality panel for live detail)

- `Konvy` has no store-level breakdown in `店铺销量`, ever — channel total only.
- `SKU销量` has no weekly columns in the current workbook — weekly SKU/category figures are built
  from the 4 channel sheets instead (flagged, source-tagged).
- `SKU销量` is missing ~41 of the ~80 barcodes tracked in the 4 channel sheets.
- Konvy reports **zero** data of any kind (not even a Total-row entry) for all of May 2026 — those
  weeks are excluded from formal comparisons for that reason, not a bug in the completeness check.

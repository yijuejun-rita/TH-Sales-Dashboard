#!/usr/bin/env python3
"""
ETL for the "Thailand September 2026 Weekly Sales Review" (Sep W1-W3, month not
closed). Reads the raw source workbook and produces the JSON files consumed by
/september-weekly-review/*.html.

Usage:
    python3 etl/september_review/build_data.py "source-data/Thailand Sales Data (3).xlsx"

Design rules (see README "September Weekly Review" section for the long version):
  - Overall / channel / store KPIs = THB, sourced ONLY from 店铺销量 (store-sales).
    Channel Total rows are the source of truth for overall+channel; per-store
    rows (excluding any row literally named "Total") are the source of truth
    for store-level figures. The two are never summed together.
  - Category / SKU KPIs = PCS, sourced ONLY from the Beautrium / Eveandboy / KIS
    channel sheets' own weekly QTY columns. Konvy has no September weekly SKU
    columns in this workbook and is excluded from this view entirely (not
    treated as zero).
  - Blank cells are never coerced to 0. A blank stays `null` in the JSON; a
    reported 0 stays `0`. Downstream code must keep the two distinct.
  - Every number this script emits must trace back to a specific cell range;
    nothing is hand-adjusted to make totals line up. If verify_control_totals.py
    disagrees with the checked-in control totals, that is a bug in this script
    (or a real change in the source data) -- never "fix" it by editing output
    JSON by hand.
"""
import json
import os
import re
import sys
import datetime
from collections import defaultdict, OrderedDict

import openpyxl
from openpyxl.utils import column_index_from_string as cidx

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO_ROOT, 'data', 'september')

CHANNELS_ALL = ['Beautrium', 'Eveandboy', 'KIS', 'Konvy']
CHANNELS_SKU = ['Beautrium', 'Eveandboy', 'KIS']  # Konvy excluded from SKU/category view

REVIEW_SCOPE_LABEL = 'September Weeks 1–3 | Month Not Closed'
SKU_COVERAGE_NOTE = 'SKU coverage: Beautrium, Eveandboy and KIS only; Konvy September SKU data unavailable.'

# Known same-product barcode aliases the raw data does not merge on its own
# (confirmed by cross-checking SKU销量 and the 3 channel sheets: both barcodes
# always resolve to the exact same item-name text and category).
KNOWN_BARCODE_ALIASES = [
    {'6975025856014', '6975025857097'},  # Jayin C102
    {'6975025852054', '6975025856625'},  # Approaching
]

SPELLING_FIXES = [
    (re.compile(r'HARUKl\b'), 'HARUKI'),  # consistent lowercase-L typo throughout the workbook
]


def norm_ws(s):
    return re.sub(r'\s+', ' ', str(s).strip())


def canonical_name(raw_item):
    s = norm_ws(raw_item)
    for pat, repl in SPELLING_FIXES:
        s = pat.sub(repl, s)
    return s


def canon_key(raw_item):
    return canonical_name(raw_item).lower()


def num_or_none(v):
    """openpyxl gives None for a truly blank cell; keep that distinct from 0."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip() == '':
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def bc_str(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


# --------------------------------------------------------------------------
# 1. 店铺销量 -- overall / channel / store THB
# --------------------------------------------------------------------------
def parse_store_sales(wb, dq):
    ws = wb['店铺销量']
    hdr = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]

    expected_letters = {'Sep Week 1': 'AL', 'Sep Week 2': 'AM', 'Sep Week 3': 'AN'}
    week_cols = {}
    for label, letter in expected_letters.items():
        if label not in hdr:
            raise RuntimeError(f'店铺销量: expected header "{label}" not found -- source layout changed, aborting rather than guessing.')
        found_col = hdr.index(label) + 1
        if found_col != cidx(letter):
            raise RuntimeError(
                f'店铺销量: "{label}" expected at column {letter} ({cidx(letter)}) but found at column {found_col}. '
                'Source layout changed -- update the spec/script before trusting the numbers.'
            )
        week_cols[label] = found_col

    c_channel, c_store = 1, 2
    c_w1, c_w2, c_w3 = week_cols['Sep Week 1'], week_cols['Sep Week 2'], week_cols['Sep Week 3']

    channel_totals = {}   # channel -> {w1,w2,w3}
    store_rows = []       # list of dicts, Total rows excluded
    seen_total_for = set()
    cur_channel = None

    for r in range(2, ws.max_row + 1):
        ch = ws.cell(row=r, column=c_channel).value
        store = ws.cell(row=r, column=c_store).value
        if ch:
            cur_channel = str(ch).strip()
        if not store:
            continue
        store_name = str(store).strip()
        w1 = num_or_none(ws.cell(row=r, column=c_w1).value)
        w2 = num_or_none(ws.cell(row=r, column=c_w2).value)
        w3 = num_or_none(ws.cell(row=r, column=c_w3).value)

        if store_name == 'Total':
            if cur_channel in seen_total_for:
                raise RuntimeError(f'店铺销量: duplicate Total row detected for channel {cur_channel} at row {r} -- would double count.')
            seen_total_for.add(cur_channel)
            channel_totals[cur_channel] = {'w1': w1, 'w2': w2, 'w3': w3}
            continue

        store_rows.append({'channel': cur_channel, 'store': store_name, 'w1': w1, 'w2': w2, 'w3': w3, 'row': r})

    missing_totals = set(CHANNELS_ALL) - seen_total_for
    if missing_totals:
        raise RuntimeError(f'店铺销量: no Total row found for channel(s) {missing_totals} -- cannot compute official channel/overall THB.')

    # channel with genuinely no store-level breakdown at all (every store row blank
    # for all 3 weeks) -- Konvy, per spec. Detected structurally, not hardcoded.
    storeless_channels = set()
    for ch in CHANNELS_ALL:
        ch_stores = [s for s in store_rows if s['channel'] == ch]
        if ch_stores and all(s['w1'] is None and s['w2'] is None and s['w3'] is None for s in ch_stores):
            storeless_channels.add(ch)
        if not ch_stores:
            storeless_channels.add(ch)

    overall = {}
    for wk in ('w1', 'w2', 'w3'):
        vals = [channel_totals[ch][wk] for ch in CHANNELS_ALL]
        overall[wk] = sum(v for v in vals if v is not None) if any(v is not None for v in vals) else None
    overall['cum'] = sum(v for v in (overall['w1'], overall['w2'], overall['w3']) if v is not None)

    channels_out = {}
    for ch in CHANNELS_ALL:
        d = dict(channel_totals[ch])
        d['cum'] = sum(v for v in (d['w1'], d['w2'], d['w3']) if v is not None)
        channels_out[ch] = d

    # store status + cumulative, blank-safe
    stores_out = []
    for s in store_rows:
        weeks = [s['w1'], s['w2'], s['w3']]
        if s['channel'] in storeless_channels:
            status = 'no_store_breakdown'
        elif all(v is None for v in weeks):
            status = 'no_data'
        elif any(v is None for v in weeks):
            missing = [w for w, v in zip(('w1', 'w2', 'w3'), weeks) if v is None]
            status = 'partial_missing_' + '_'.join(missing)
        else:
            status = 'complete'
        cum = sum(v for v in weeks if v is not None) if any(v is not None for v in weeks) else None
        stores_out.append({
            'channel': s['channel'], 'store': s['store'],
            'w1': s['w1'], 'w2': s['w2'], 'w3': s['w3'], 'cum': cum, 'status': status,
        })

    if 'Konvy' in storeless_channels:
        dq.append({
            'id': 'konvy_store_blank', 'severity': 'high', 'category': 'store',
            'detail': 'All Konvy stores are blank for Sep W1–W3 in 店铺销量; only the channel Total row carries real figures. Konvy is excluded from all store-level drilldowns and rankings.',
        })
    for s in stores_out:
        if s['status'].startswith('partial_missing'):
            dq.append({
                'id': 'store_partial_missing', 'severity': 'medium', 'category': 'store',
                'detail': f"{s['store']} ({s['channel']}) is missing {s['status'].replace('partial_missing_', '').replace('_', '/').upper()} in 店铺销量 (blank cell, not a reported 0) -- excluded from formal WoW ranking for that comparison.",
            })

    return {
        'overall': overall,
        'channels': channels_out,
        'stores': stores_out,
        'storeless_channels': sorted(storeless_channels),
    }


# --------------------------------------------------------------------------
# 2. Beautrium / Eveandboy / KIS -- per-SKU weekly PCS + Amount
# --------------------------------------------------------------------------
def find_channel_week_cols(ws, sheet_name):
    """Confirm F/G/H/I/K/L/N/O match the spec by header text; raise if not."""
    expected = {
        'F': ('TTL QTY', 6), 'G': ('TTL Value', 7),
        'H': ('WEEK 1 QTY', 8), 'I': ('WEEK 1', 9),          # 'WEEK 1 \nAmount'
        'K': ('WEEK 2', 11), 'L': ('WEEK 2 Amount', 12),
        'N': ('WEEK 3', 14), 'O': ('WEEK 3', 15),            # 'WEEK 3 \nAmount'
    }
    hdr2 = [ws.cell(row=2, column=c).value for c in range(1, ws.max_column + 1)]
    for letter, (needle, col) in expected.items():
        actual = hdr2[col - 1]
        if actual is None or needle.split()[0] not in str(actual):
            raise RuntimeError(f'{sheet_name}: expected column {letter} (idx {col}) to contain "{needle}", found {actual!r}. Layout changed -- aborting.')
    return {'w1_qty': 8, 'w1_amt': 9, 'w2_qty': 11, 'w2_amt': 12, 'w3_qty': 14, 'w3_amt': 15}


def parse_channel_sheet(wb, sheet_name, dq):
    ws = wb[sheet_name]
    cols = find_channel_week_cols(ws, sheet_name)
    rows = []
    for r in range(3, ws.max_row + 1):
        item = ws.cell(row=r, column=3).value
        if not item or not str(item).strip():
            continue
        barcode = bc_str(ws.cell(row=r, column=2).value)
        category = ws.cell(row=r, column=5).value
        category = str(category).strip() if category else None
        rec = {
            'raw_item': str(item), 'barcode': barcode, 'category': category,
            'w1_qty': num_or_none(ws.cell(row=r, column=cols['w1_qty']).value),
            'w1_amt': num_or_none(ws.cell(row=r, column=cols['w1_amt']).value),
            'w2_qty': num_or_none(ws.cell(row=r, column=cols['w2_qty']).value),
            'w2_amt': num_or_none(ws.cell(row=r, column=cols['w2_amt']).value),
            'w3_qty': num_or_none(ws.cell(row=r, column=cols['w3_qty']).value),
            'w3_amt': num_or_none(ws.cell(row=r, column=cols['w3_amt']).value),
        }
        rows.append(rec)
    return rows


def check_konvy_no_sep_sku(wb, dq):
    ws = wb['Konvy']
    hdr1 = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]
    has_sep_block = any(v in ('9月 TTL', '9月') for v in hdr1) or any(v == 'Sep' for v in hdr1)
    if has_sep_block:
        dq.append({
            'id': 'konvy_sku_now_present', 'severity': 'info', 'category': 'coverage',
            'detail': 'Konvy channel sheet now appears to have a September weekly SKU block, but this pipeline version still formally excludes Konvy from category/SKU output by design -- extend build_data.py before relying on it.',
        })
    else:
        dq.append({
            'id': 'konvy_sku_missing', 'severity': 'high', 'category': 'coverage',
            'detail': 'Konvy channel sheet has no September weekly SKU columns (stops at August). ' + SKU_COVERAGE_NOTE,
        })
    return has_sep_block


# --------------------------------------------------------------------------
# 3. SKU销量 -- category/barcode mapping + AO/AV cross-check source
# --------------------------------------------------------------------------
def parse_sku_master(wb):
    ws = wb['SKU销量']
    barcode_to_name = {}
    barcode_to_cat = {}
    name_to_cats = defaultdict(set)
    for r in range(3, ws.max_row + 1):
        bc = bc_str(ws.cell(row=r, column=1).value)
        item = ws.cell(row=r, column=2).value
        cat = ws.cell(row=r, column=4).value
        if not item:
            continue
        key = canon_key(item)
        if bc:
            barcode_to_name[bc] = key
            if cat:
                barcode_to_cat[bc] = str(cat).strip()
        if cat:
            name_to_cats[key].add(str(cat).strip())
    return {'barcode_to_name': barcode_to_name, 'barcode_to_cat': barcode_to_cat, 'name_to_cats': name_to_cats}


# --------------------------------------------------------------------------
# 4. Merge 3 channel sheets into canonical SKUs (barcode-alias + name aware)
# --------------------------------------------------------------------------
def build_sku_master_list(channel_rows_by_ch, sku_master, dq):
    alias_of = {}
    for group in KNOWN_BARCODE_ALIASES:
        canon = sorted(group)[0]
        for bc in group:
            alias_of[bc] = canon

    skus = OrderedDict()  # canon_key -> record
    barcode_to_keys = defaultdict(set)
    key_to_barcodes = defaultdict(set)

    for ch, rows in channel_rows_by_ch.items():
        for rec in rows:
            key = canon_key(rec['raw_item'])
            bc = rec['barcode']
            bc_canon = alias_of.get(bc, bc)
            if bc:
                barcode_to_keys[bc_canon].add(key)
                key_to_barcodes[key].add(bc)
            if key not in skus:
                skus[key] = {
                    'name': canonical_name(rec['raw_item']),
                    'category': None,
                    'category_source': None,
                    'blank_category_channels': [],
                    'barcodes': set(),
                    'per_channel': {ch2: {'w1': None, 'w2': None, 'w3': None} for ch2 in CHANNELS_SKU},
                }
            s = skus[key]
            if bc:
                s['barcodes'].add(bc)
            cell = s['per_channel'][ch]
            for wk in ('w1', 'w2', 'w3'):
                v = rec[f'{wk}_qty']
                if v is not None:
                    cell[wk] = (cell[wk] or 0) + v
            # category: first non-null wins, prefer the channel-sheet value itself.
            # Track which channel(s) shipped a *blank* Category cell for this SKU
            # even if another channel's row resolves it, so we can still flag the
            # gap explicitly (e.g. Beautrium's Snow Song row has no Category).
            if not rec['category']:
                s['blank_category_channels'].append(ch)
            elif s['category'] is None:
                s['category'] = rec['category']
                s['category_source'] = f'{ch} sheet'

    # category backfill from SKU销量 for anything still blank (e.g. Beautrium's
    # Snow Song row, which ships with an empty Category cell)
    for key, s in skus.items():
        if s['category'] is None:
            bcs = key_to_barcodes.get(key, set())
            for bc in bcs:
                cat = sku_master['barcode_to_cat'].get(alias_of.get(bc, bc)) or sku_master['barcode_to_cat'].get(bc)
                if cat:
                    s['category'] = cat
                    s['category_source'] = 'backfilled from SKU销量 via shared barcode'
                    break

    # a channel shipped a blank Category cell for this SKU, but the SKU still
    # resolved a category (either from another channel's row, or the backfill
    # step just above) -- flag it either way, e.g. Beautrium's Snow Song row.
    for key, s in skus.items():
        if s['blank_category_channels'] and s['category']:
            dq.append({
                'id': 'category_backfilled', 'severity': 'info', 'category': 'sku_mapping',
                'detail': f'"{s["name"]}" has a blank Category cell on {", ".join(s["blank_category_channels"])}; resolved as "{s["category"]}" via the same barcode’s Category on {s["category_source"] or "another sheet"}.',
            })
        elif s['blank_category_channels'] and not s['category']:
            dq.append({
                'id': 'category_unresolved', 'severity': 'medium', 'category': 'sku_mapping',
                'detail': f'"{s["name"]}" has a blank Category cell on {", ".join(s["blank_category_channels"])} and no other sheet resolves it; left uncategorized rather than guessed.',
            })

    # also pull in any barcode aliases known from SKU销量 itself even if only one
    # of the pair ever appears on a channel sheet
    for group in KNOWN_BARCODE_ALIASES:
        canon = sorted(group)[0]
        matching_keys = [k for k, bcs in key_to_barcodes.items() if bcs & group]
        for k in matching_keys:
            skus[k]['barcodes'] |= group

    # data-quality: barcode -> multiple distinct SKU names (real conflict)
    for bc, keys in barcode_to_keys.items():
        if len(keys) > 1:
            dq.append({
                'id': 'barcode_maps_to_multiple_skus', 'severity': 'high', 'category': 'sku_mapping',
                'detail': f'Barcode {bc} maps to {len(keys)} different SKU names ({", ".join(sorted(skus[k]["name"] for k in keys))}) across the channel sheets -- please confirm with source data owner; not auto-merged.',
            })
    # data-quality: SKU -> multiple barcodes (expected/merged case), checked
    # against the FINAL barcode set (post alias-merge), not just what happened
    # to appear on the 3 channel sheets.
    for key, s in skus.items():
        if len(s['barcodes']) > 1:
            dq.append({
                'id': 'sku_has_multiple_barcodes', 'severity': 'info', 'category': 'sku_mapping',
                'detail': f'"{s["name"]}" is sold under {len(s["barcodes"])} barcodes ({", ".join(sorted(s["barcodes"]))}); merged into one SKU so units are not double counted.',
            })

    return skus


# --------------------------------------------------------------------------
# 5. Category rollup (3-channel PCS scope)
# --------------------------------------------------------------------------
def build_category_rollup(skus):
    cats = defaultdict(lambda: {'w1': 0, 'w2': 0, 'w3': 0})
    for s in skus.values():
        cat = s['category'] or '(Uncategorized)'
        for wk in ('w1', 'w2', 'w3'):
            total = sum((s['per_channel'][ch][wk] or 0) for ch in CHANNELS_SKU)
            cats[cat][wk] += total

    total_w1 = sum(c['w1'] for c in cats.values())
    total_w2 = sum(c['w2'] for c in cats.values())
    total_w3 = sum(c['w3'] for c in cats.values())
    total_change = total_w3 - total_w2

    out = []
    for cat, v in cats.items():
        chg_abs = v['w3'] - v['w2']
        chg_pct = (v['w3'] / v['w2'] - 1) if v['w2'] else None
        vs_avg12 = (v['w1'] + v['w2']) / 2
        vs_avg12_pct = (v['w3'] / vs_avg12 - 1) if vs_avg12 else None
        out.append({
            'category': cat, 'w1': v['w1'], 'w2': v['w2'], 'w3': v['w3'],
            'w3_vs_w2_abs': chg_abs, 'w3_vs_w2_pct': chg_pct,
            'w3_vs_avg12_pct': vs_avg12_pct,
            'share_w3': (v['w3'] / total_w3) if total_w3 else None,
            'contribution_to_total_change': (chg_abs / total_change) if total_change else None,
        })
    out.sort(key=lambda x: -x['w3'])
    return out, {'w1': total_w1, 'w2': total_w2, 'w3': total_w3, 'cum': total_w1 + total_w2 + total_w3}


# --------------------------------------------------------------------------
# 6. SKU-level output rows with per-channel deltas + contribution
# --------------------------------------------------------------------------
def build_sku_rows(skus):
    cat_change_totals = defaultdict(float)
    rows = []
    for key, s in skus.items():
        w1 = sum((s['per_channel'][ch]['w1'] or 0) for ch in CHANNELS_SKU)
        w2 = sum((s['per_channel'][ch]['w2'] or 0) for ch in CHANNELS_SKU)
        w3 = sum((s['per_channel'][ch]['w3'] or 0) for ch in CHANNELS_SKU)
        chg_abs = w3 - w2
        cat_change_totals[s['category'] or '(Uncategorized)'] += chg_abs
        rows.append({
            'sku_key': key, 'name': s['name'], 'category': s['category'],
            'category_source': s['category_source'],
            'barcodes': sorted(s['barcodes']),
            'w1': w1, 'w2': w2, 'w3': w3, 'cum': w1 + w2 + w3,
            'w3_vs_w2_abs': chg_abs,
            'w3_vs_w2_pct': (w3 / w2 - 1) if w2 else None,
            'by_channel_change': {
                ch: (s['per_channel'][ch]['w3'] or 0) - (s['per_channel'][ch]['w2'] or 0)
                for ch in CHANNELS_SKU
            },
            'by_channel_w3': {ch: s['per_channel'][ch]['w3'] for ch in CHANNELS_SKU},
        })
    for r in rows:
        cat_total_chg = cat_change_totals[r['category'] or '(Uncategorized)']
        r['contribution_to_category_change'] = (r['w3_vs_w2_abs'] / cat_total_chg) if cat_total_chg else None
    rows.sort(key=lambda r: -abs(r['w3_vs_w2_abs']))
    return rows


# --------------------------------------------------------------------------
# 7. Cross-source reconciliation checks (spec section 十, item 4)
# --------------------------------------------------------------------------
def kis_reconciliation_check(store_data, kis_rows, dq):
    store_kis_w2 = store_data['channels']['KIS']['w2']
    sku_kis_w2 = sum((r['w2_amt'] or 0) for r in kis_rows)
    diff = None
    if store_kis_w2 is not None:
        diff = round(sku_kis_w2 - store_kis_w2, 2)
    dq.append({
        'id': 'kis_w2_amount_discrepancy', 'severity': 'low', 'category': 'reconciliation',
        'detail': f'KIS store-sales W2 Total = ฿{store_kis_w2:,.0f} vs KIS SKU-sheet W2 Amount sum = ฿{sku_kis_w2:,.0f} (฿{diff:+,.0f} difference). Both are shown as-is; not reconciled by hand.',
    })
    return diff


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print('Usage: python3 build_data.py <path-to-source-xlsx>', file=sys.stderr)
        sys.exit(2)
    src_path = sys.argv[1]
    if not os.path.isfile(src_path):
        print(f'Source file not found: {src_path}', file=sys.stderr)
        sys.exit(2)

    wb = openpyxl.load_workbook(src_path, data_only=True)
    for sheet in ['Beautrium', 'Eveandboy', 'Konvy', 'KIS', '店铺销量', 'SKU销量']:
        if sheet not in wb.sheetnames:
            raise RuntimeError(f'Expected sheet "{sheet}" not found in {src_path}. Found: {wb.sheetnames}')

    dq = []
    generated_at = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

    store_data = parse_store_sales(wb, dq)
    konvy_has_sep = check_konvy_no_sep_sku(wb, dq)

    channel_rows_by_ch = {ch: parse_channel_sheet(wb, ch, dq) for ch in CHANNELS_SKU}
    sku_master = parse_sku_master(wb)
    skus = build_sku_master_list(channel_rows_by_ch, sku_master, dq)
    category_rollup, sku_total_3ch = build_category_rollup(skus)
    sku_rows = build_sku_rows(skus)

    kis_reconciliation_check(store_data, channel_rows_by_ch['KIS'], dq)

    dq.append({'id': 'month_not_closed', 'severity': 'medium', 'category': 'scope',
                'detail': 'This review covers September Weeks 1-3 only; the month is not closed. Do not read W1-3 totals as a full-month figure.'})
    dq.append({'id': 'three_channel_sku_scope', 'severity': 'medium', 'category': 'coverage',
                'detail': 'All category and SKU findings on this review represent Beautrium + Eveandboy + KIS only, not all 4 channels (Konvy excluded, see coverage note).'})
    dq.append({'id': 'av_not_official', 'severity': 'info', 'category': 'methodology',
                'detail': 'SKU销量!AV is an SRP × PCS estimate, not an official sales-value figure. It is not used for any overall/channel/store/category/SKU THB KPI.'})
    dq.append({'id': 'no_exact_week_dates', 'severity': 'info', 'category': 'methodology',
                'detail': 'The source workbook gives no explicit Sep week start/end dates (unlike August’s "1-2nd Aug" style labels). Only the labels Sep W1 / Sep W2 / Sep W3 are used; no calendar dates are inferred.'})
    dq.append({'id': 'no_update_timestamp', 'severity': 'info', 'category': 'methodology',
                'detail': 'The source workbook carries no data-refresh timestamp field of its own. "generated_at" below reflects when this ETL script last ran, not when the underlying sheet data was last entered.'})

    os.makedirs(OUT_DIR, exist_ok=True)

    meta_common = {
        'generated_at': generated_at,
        'review_scope': REVIEW_SCOPE_LABEL,
        'source_file_name': os.path.basename(src_path),
    }

    weekly_channel_value = {
        'meta': {**meta_common, 'unit': 'THB', 'source': '店铺销量 (channel Total rows)'},
        'overall': store_data['overall'],
        'channels': store_data['channels'],
    }
    weekly_store_value = {
        'meta': {**meta_common, 'unit': 'THB', 'source': '店铺销量 (per-store rows, Total rows excluded)'},
        'storeless_channels': store_data['storeless_channels'],
        'stores': store_data['stores'],
    }
    weekly_sku_units = {
        'meta': {**meta_common, 'unit': 'PCS', 'coverage': SKU_COVERAGE_NOTE,
                  'source': 'Beautrium + Eveandboy + KIS weekly QTY columns'},
        'skus': sku_rows,
    }
    weekly_category_units = {
        'meta': {**meta_common, 'unit': 'PCS', 'coverage': SKU_COVERAGE_NOTE},
        'categories': category_rollup,
        'total_3channel': sku_total_3ch,
    }
    data_quality = {'generated_at': generated_at, 'items': dq}

    key_findings = build_key_findings(store_data, category_rollup, sku_rows, sku_total_3ch)

    write_json('weekly_channel_value.json', weekly_channel_value)
    write_json('weekly_store_value.json', weekly_store_value)
    write_json('weekly_sku_units.json', weekly_sku_units)
    write_json('weekly_category_units.json', weekly_category_units)
    write_json('data_quality.json', data_quality)
    write_json('key_findings.json', {'generated_at': generated_at, 'findings': key_findings})

    print(f'Wrote 6 JSON files to {OUT_DIR}')
    print(f'Overall W1={store_data["overall"]["w1"]:.0f} W2={store_data["overall"]["w2"]:.0f} W3={store_data["overall"]["w3"]:.0f}')
    print(f'3-channel PCS W1={sku_total_3ch["w1"]:.0f} W2={sku_total_3ch["w2"]:.0f} W3={sku_total_3ch["w3"]:.0f}')


def build_key_findings(store_data, category_rollup, sku_rows, sku_total_3ch):
    findings = []
    ov = store_data['overall']
    if ov['w2'] and ov['w3'] is not None:
        pct = ov['w3'] / ov['w2'] - 1
        findings.append(
            f"Overall Sep W3 sales value was ฿{ov['w3']:,.0f}, down {abs(pct)*100:.1f}% ({ov['w3']-ov['w2']:+,.0f} THB) vs W2 (฿{ov['w2']:,.0f})."
        )
    ch_deltas = []
    for ch, v in store_data['channels'].items():
        if v['w2'] is not None and v['w3'] is not None:
            ch_deltas.append((ch, v['w3'] - v['w2']))
    ch_deltas.sort(key=lambda x: x[1])
    if ch_deltas:
        worst_ch, worst_d = ch_deltas[0]
        findings.append(f"{worst_ch} W3 vs W2 changed by {worst_d:+,.0f} THB, the largest single driver of the overall W3 decline." if worst_d < 0 else f"{worst_ch} W3 vs W2 changed by {worst_d:+,.0f} THB, the largest channel move this week.")
    ch_deltas_sorted_desc = sorted(ch_deltas, key=lambda x: -x[1])
    gainers = [c for c in ch_deltas_sorted_desc if c[1] > 0][:2]
    for ch, d in gainers:
        findings.append(f"{ch} W3 vs W2 increased by ฿{d:,.0f}.")
    findings.append('Category/SKU findings below represent Beautrium + Eveandboy + KIS only (3 of 4 channels) -- Konvy September SKU data is unavailable and is not part of these numbers.')
    return findings[:5]


def write_json(name, obj):
    path = os.path.join(OUT_DIR, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, allow_nan=False)


if __name__ == '__main__':
    main()

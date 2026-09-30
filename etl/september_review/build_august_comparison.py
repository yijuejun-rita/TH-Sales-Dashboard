#!/usr/bin/env python3
"""
Extends the September Weekly Review with a "Sep W1-3 vs August" comparison.
Reads the SAME source workbook as build_data.py (August has 5 complete weeks,
September only has 3 so far) and writes one JSON:

    data/september/august_comparison.json

Usage:
    python3 etl/september_review/build_august_comparison.py "source-data/Thailand Sales Data (3).xlsx"

Methodology (must match what was already verified in chat with the user):
  - August total vs Sep W1-3 total is NOT a fair comparison on its own (5 weeks
    vs 3 weeks), so every comparison here is done on a WEEKLY-AVERAGE PACE
    basis (period total / number of weeks in that period) in addition to the
    raw totals. The raw totals are still shipped so the page can show them,
    but every "change" percentage/label is computed on the weekly-pace basis
    unless explicitly marked "raw total".
  - Overall/channel/store: THB, from 店铺销量 (August "Aug Total" + "Aug week
    1..5" columns for channel Total rows; September from build_data.py's own
    output so the two never drift apart).
  - Category/SKU: PCS, from Beautrium+Eveandboy+KIS "8月 TTL" QTY column only
    (Konvy has no August OR September weekly SKU columns available on a
    per-week basis comparable to Sep's week columns in a compatible way here;
    Konvy IS included in the overall/channel THB view via its Total row, but
    excluded from category/SKU on BOTH sides of the comparison so the
    comparison is apples-to-apples, not just because Sep is missing it).
  - Blank stays null; a reported 0 stays 0. Same barcode-alias merge and
    category backfill as build_data.py (re-uses its functions directly so the
    two pipelines can never disagree on what a "SKU" is).
"""
import json
import os
import sys
import datetime
from collections import defaultdict

import openpyxl
from openpyxl.utils import column_index_from_string as cidx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as bd  # re-use canon_key / canonical_name / alias map / SKU master parsing

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO_ROOT, 'data', 'september')
SEP_DIR = OUT_DIR  # build_data.py's own output lives here too

AUG_WEEKS = 5
SEP_WEEKS = 3
CHANNELS_SKU = bd.CHANNELS_SKU
CHANNELS_ALL = bd.CHANNELS_ALL


def parse_store_sales_august(wb, dq):
    ws = wb['店铺销量']
    hdr = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]

    if 'Aug Total' not in hdr:
        raise RuntimeError('店铺销量: expected header "Aug Total" not found -- source layout changed, aborting.')
    c_aug_total = hdr.index('Aug Total') + 1
    aug_week_labels = [f'Aug week {i}' for i in range(1, 6)]
    for lbl in aug_week_labels:
        if lbl not in hdr:
            raise RuntimeError(f'店铺销量: expected header "{lbl}" not found -- aborting.')
    aug_week_cols = [hdr.index(lbl) + 1 for lbl in aug_week_labels]

    c_channel, c_store = 1, 2
    cur_channel = None
    channel_totals = {}
    store_rows = []
    seen_total_for = set()

    for r in range(2, ws.max_row + 1):
        ch = ws.cell(row=r, column=c_channel).value
        store = ws.cell(row=r, column=c_store).value
        if ch:
            cur_channel = str(ch).strip()
        if not store:
            continue
        store_name = str(store).strip()
        total_val = bd.num_or_none(ws.cell(row=r, column=c_aug_total).value)
        weeks = [bd.num_or_none(ws.cell(row=r, column=c).value) for c in aug_week_cols]

        if store_name == 'Total':
            if cur_channel in seen_total_for:
                raise RuntimeError(f'店铺销量: duplicate August Total row for {cur_channel} at row {r}.')
            seen_total_for.add(cur_channel)
            channel_totals[cur_channel] = {'total': total_val, 'weeks': weeks}
            continue
        store_rows.append({'channel': cur_channel, 'store': store_name, 'total': total_val, 'weeks': weeks})

    missing = set(CHANNELS_ALL) - seen_total_for
    if missing:
        raise RuntimeError(f'店铺销量: no August Total row for {missing}.')

    overall_total = sum(v['total'] for v in channel_totals.values() if v['total'] is not None)
    return {'channel_totals': channel_totals, 'overall_total': overall_total, 'store_rows': store_rows}


def parse_channel_august(wb, sheet_name):
    ws = wb[sheet_name]
    hdr1 = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]
    if '8月 TTL' not in hdr1:
        raise RuntimeError(f'{sheet_name}: expected header "8月 TTL" not found -- aborting.')
    aug_ttl_col = hdr1.index('8月 TTL') + 1
    hdr2 = [ws.cell(row=2, column=c).value for c in range(1, ws.max_column + 1)]
    if hdr2[aug_ttl_col - 1] != 'TTL QTY':
        raise RuntimeError(f'{sheet_name}: column under "8月 TTL" is {hdr2[aug_ttl_col-1]!r}, expected "TTL QTY".')

    rows = []
    for r in range(3, ws.max_row + 1):
        item = ws.cell(row=r, column=3).value
        if not item or not str(item).strip():
            continue
        barcode = bd.bc_str(ws.cell(row=r, column=2).value)
        category = ws.cell(row=r, column=5).value
        category = str(category).strip() if category else None
        qty = bd.num_or_none(ws.cell(row=r, column=aug_ttl_col).value)
        rows.append({'raw_item': str(item), 'barcode': barcode, 'category': category, 'aug_qty': qty})
    return rows


def build_sku_august(wb, dq):
    aug_rows_by_ch = {ch: parse_channel_august(wb, ch) for ch in CHANNELS_SKU}
    sku_master = bd.parse_sku_master(wb)

    skus = {}
    for ch, rows in aug_rows_by_ch.items():
        for rec in rows:
            key = bd.canon_key(rec['raw_item'])
            if key not in skus:
                skus[key] = {'name': bd.canonical_name(rec['raw_item']), 'category': None, 'aug_qty': 0.0, 'barcodes': set()}
            s = skus[key]
            if rec['barcode']:
                s['barcodes'].add(rec['barcode'])
            if rec['category'] and s['category'] is None:
                s['category'] = rec['category']
            if rec['aug_qty'] is not None:
                s['aug_qty'] += rec['aug_qty']

    # category backfill (mirrors build_data.py's approach)
    for key, s in skus.items():
        if s['category'] is None:
            cats = sku_master['name_to_cats'].get(key)
            if cats:
                s['category'] = sorted(cats)[0]
                dq.append({
                    'id': 'august_category_backfilled', 'severity': 'info', 'category': 'sku_mapping',
                    'detail': f'"{s["name"]}" had a blank Category in its August row; backfilled via SKU销量.',
                })

    # merge known barcode aliases (Jayin / Approaching) same as September
    for group in bd.KNOWN_BARCODE_ALIASES:
        matching_keys = [k for k, s in skus.items() if s['barcodes'] & group]
        for k in matching_keys:
            skus[k]['barcodes'] |= group

    for s in skus.values():
        s['barcodes'] = sorted(s['barcodes'])

    total_3ch = sum(s['aug_qty'] for s in skus.values())
    cat_totals = defaultdict(float)
    for s in skus.values():
        cat_totals[s['category'] or '(Uncategorized)'] += s['aug_qty']

    return skus, total_3ch, cat_totals


def load_september_outputs():
    with open(os.path.join(SEP_DIR, 'weekly_channel_value.json'), encoding='utf-8') as f:
        sep_channel = json.load(f)
    with open(os.path.join(SEP_DIR, 'weekly_category_units.json'), encoding='utf-8') as f:
        sep_category = json.load(f)
    with open(os.path.join(SEP_DIR, 'weekly_sku_units.json'), encoding='utf-8') as f:
        sep_sku = json.load(f)
    return sep_channel, sep_category, sep_sku


def pace_change(sep_total, sep_weeks, aug_total, aug_weeks):
    if aug_total is None or sep_total is None or aug_total == 0:
        return None, None, None
    sep_pace = sep_total / sep_weeks
    aug_pace = aug_total / aug_weeks
    if aug_pace == 0:
        return sep_pace, aug_pace, None
    return sep_pace, aug_pace, (sep_pace / aug_pace - 1)


def main():
    if len(sys.argv) < 2:
        print('Usage: python3 build_august_comparison.py <path-to-source-xlsx>', file=sys.stderr)
        sys.exit(2)
    src_path = sys.argv[1]
    if not os.path.isfile(src_path):
        print(f'Source file not found: {src_path}', file=sys.stderr)
        sys.exit(2)
    if not os.path.isfile(os.path.join(SEP_DIR, 'weekly_channel_value.json')):
        print('data/september/weekly_channel_value.json not found -- run build_data.py first.', file=sys.stderr)
        sys.exit(2)

    wb = openpyxl.load_workbook(src_path, data_only=True)
    dq = []
    generated_at = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

    store_aug = parse_store_sales_august(wb, dq)
    sku_aug, sku_aug_total_3ch, cat_aug_totals = build_sku_august(wb, dq)
    sep_channel, sep_category, sep_sku = load_september_outputs()

    # ---- overall / channel THB, weekly-pace basis ----
    overall_sep_pace, overall_aug_pace, overall_pace_chg = pace_change(
        sep_channel['overall']['cum'], SEP_WEEKS, store_aug['overall_total'], AUG_WEEKS
    )
    channels_out = {}
    for ch in CHANNELS_ALL:
        aug_total = store_aug['channel_totals'][ch]['total']
        sep_total = sep_channel['channels'][ch]['cum']
        sep_pace, aug_pace, chg = pace_change(sep_total, SEP_WEEKS, aug_total, AUG_WEEKS)
        channels_out[ch] = {
            'aug_total': aug_total, 'aug_weekly_pace': aug_pace,
            'sep_total': sep_total, 'sep_weekly_pace': sep_pace,
            'weekly_pace_change_pct': chg,
        }
    overall_out = {
        'aug_total': store_aug['overall_total'], 'aug_weekly_pace': overall_aug_pace,
        'sep_total': sep_channel['overall']['cum'], 'sep_weekly_pace': overall_sep_pace,
        'weekly_pace_change_pct': overall_pace_chg,
    }

    # ---- category, weekly-pace basis (3-channel PCS scope) ----
    sep_cat_map = {c['category']: (c['w1'] + c['w2'] + c['w3']) for c in sep_category['categories']}
    all_cats = set(cat_aug_totals) | set(sep_cat_map)
    categories_out = []
    for cat in all_cats:
        aug_total = cat_aug_totals.get(cat, 0.0)
        sep_total = sep_cat_map.get(cat, 0.0)
        sep_pace, aug_pace, chg = pace_change(sep_total, SEP_WEEKS, aug_total, AUG_WEEKS)
        categories_out.append({
            'category': cat, 'aug_total': aug_total, 'aug_weekly_pace': aug_pace,
            'sep_total': sep_total, 'sep_weekly_pace': sep_pace,
            'weekly_pace_change_pct': chg,
        })
    categories_out.sort(key=lambda c: -(c['sep_weekly_pace'] or 0))

    sep_pace3, aug_pace3, chg3 = pace_change(
        sum(sep_cat_map.values()), SEP_WEEKS, sku_aug_total_3ch, AUG_WEEKS
    )
    total_3ch_out = {
        'aug_total': sku_aug_total_3ch, 'aug_weekly_pace': aug_pace3,
        'sep_total': sum(sep_cat_map.values()), 'sep_weekly_pace': sep_pace3,
        'weekly_pace_change_pct': chg3,
    }

    # ---- SKU, weekly-pace basis ----
    sep_sku_by_key = {s['sku_key']: s for s in sep_sku['skus']}
    sku_rows = []
    for key, a in sku_aug.items():
        s = sep_sku_by_key.get(key)
        sep_total = s['cum'] if s else 0.0
        sep_pace, aug_pace, chg = pace_change(sep_total, SEP_WEEKS, a['aug_qty'], AUG_WEEKS)
        barcodes = sorted(set(a['barcodes']) | set(s['barcodes'] if s else []))
        sku_rows.append({
            'sku_key': key, 'name': a['name'], 'category': a['category'] or (s['category'] if s else None),
            'barcodes': barcodes,
            'aug_total': a['aug_qty'], 'aug_weekly_pace': aug_pace,
            'sep_total': sep_total, 'sep_weekly_pace': sep_pace,
            'weekly_pace_change_pct': chg,
            'weekly_pace_change_abs': (sep_pace - aug_pace) if (sep_pace is not None and aug_pace is not None) else None,
        })
    # also include Sept-only SKUs that had zero August qty (e.g. brand new SKUs)
    for key, s in sep_sku_by_key.items():
        if key not in sku_aug:
            sep_pace = s['cum'] / SEP_WEEKS
            sku_rows.append({
                'sku_key': key, 'name': s['name'], 'category': s['category'], 'barcodes': s['barcodes'],
                'aug_total': 0.0, 'aug_weekly_pace': 0.0,
                'sep_total': s['cum'], 'sep_weekly_pace': sep_pace,
                'weekly_pace_change_pct': None,  # base is 0, undefined
                'weekly_pace_change_abs': sep_pace,
            })
    sku_rows.sort(key=lambda r: -abs(r['weekly_pace_change_abs'] or 0))

    dq.append({
        'id': 'comparison_basis_weekly_pace', 'severity': 'medium', 'category': 'methodology',
        'detail': f'August has {AUG_WEEKS} complete weeks and September only has {SEP_WEEKS} so far -- every comparison here is on a weekly-average-pace basis (period total ÷ number of weeks), not raw totals, so the two periods are comparable despite the different week counts.',
    })
    dq.append({
        'id': 'konvy_excluded_both_periods', 'severity': 'medium', 'category': 'coverage',
        'detail': 'Category/SKU comparison excludes Konvy for BOTH August and September (not just because September is missing it) so the comparison stays apples-to-apples on the same 3-channel scope in both periods. Konvy IS included in the overall/channel THB comparison via its 店铺销量 Total row for both periods.',
    })
    dq.append({
        'id': 'konvy_august_product_line_context', 'severity': 'info', 'category': 'coverage',
        'detail': 'For context only (not included in any total above): Konvy’s own channel sheet shows August TTL QTY = ' + str(int(sum(
            bd.num_or_none(wb['Konvy'].cell(row=r, column=[h for h in [wb['Konvy'].cell(row=1, column=c).value for c in range(1, wb['Konvy'].max_column+1)]].index('8月 TTL')+1).value) or 0
            for r in range(3, wb['Konvy'].max_row + 1) if wb['Konvy'].cell(row=r, column=3).value
        ))) + ' PCS -- roughly comparable in size to the other 3 channels’ August total, so the 3-channel total understates true company volume.',
    })

    meta = {
        'generated_at': generated_at,
        'source_file_name': os.path.basename(src_path),
        'aug_weeks': AUG_WEEKS, 'sep_weeks': SEP_WEEKS,
        'basis': 'weekly-average pace (period total / number of weeks in that period)',
    }

    out = {
        'meta': meta,
        'overall': overall_out,
        'channels': channels_out,
        'categories': categories_out,
        'total_3channel': total_3ch_out,
        'skus': sku_rows,
        'data_quality_additions': dq,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, 'august_comparison.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2, allow_nan=False)

    print('Wrote data/september/august_comparison.json')
    print(f'Overall: Aug pace={overall_aug_pace:,.0f}/wk  Sep pace={overall_sep_pace:,.0f}/wk  change={overall_pace_chg:+.1%}')
    print(f'3-channel PCS: Aug pace={aug_pace3:,.1f}/wk  Sep pace={sep_pace3:,.1f}/wk  change={chg3:+.1%}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Main ETL entry point. Reads the workbook (xlsx locally, or the live Google
Sheet in GitHub Actions), re-detects sheet roles by structure every run,
parses all 6 sheets by header text, reconciles the three sales sources, and
writes a single JSON file the three Weekly Dashboard pages fetch client-side.

Usage:
  python3 build_json.py --source xlsx --path /path/to/file.xlsx --out ../data/weekly_data.json
  python3 build_json.py --source sheets --out ../data/weekly_data.json

Design commitments this file exists to enforce (see project spec):
  - Field/sheet lookup is always by header text, never by fixed column index.
  - Overall + channel KPIs are ALWAYS store-sales-sourced.
  - SKU + category KPIs are ALWAYS SKU-sourced (channel-sheet sums, since the
    SKU-total sheet has no weekly granularity in the current workbook).
  - The two bases are never silently blended.
  - A sync failure must never wipe out the last good data/weekly_data.json.
"""
import argparse
import json
import os
import sys
import traceback
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sheet_parser import parse_channel_sheet, parse_store_sheet, parse_sku_total_sheet, norm
from classify import classify_all
from metrics import clean_num

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config', 'sheet_mapping.json')


# ---------------------------------------------------------------------------
# Sheet-mapping config (records recognized sheet names; see classify.py)
# ---------------------------------------------------------------------------

def load_remembered_mapping():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save_mapping(mapping, warnings):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    payload = {
        **mapping,
        'last_detected_at': datetime.now(timezone.utc).isoformat(),
        'detection_warnings': warnings,
        'note': ("Recorded automatically by etl/build_json.py on every sync run. "
                 "Sheets are re-classified by header structure each run; this file "
                 "is a cache/audit trail, not a hard-coded requirement -- renaming a "
                 "sheet or reordering sheets does not break the sync."),
    }
    with open(CONFIG_PATH, 'w') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Canonical SKU merge (multiple barcodes / color variants -> one product)
# ---------------------------------------------------------------------------

def canonical_sku_key(item_name):
    return norm(item_name).upper() if item_name else None


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------

def build(grids, sheet_names, run_date=None):
    dq = {
        'sheet_issues': [], 'week_issues': [], 'duplicate_barcodes': [],
        'unmapped_sku': [], 'unmapped_category': [], 'unmapped_store': [],
        'negative_values': [], 'null_as_zero_flags': [], 'reconciliation': [],
        'structural_warnings': [],
    }
    run_date = run_date or date.today()

    remembered = load_remembered_mapping()
    mapping, warnings = classify_all(grids, sheet_names, remembered)
    dq['structural_warnings'] = warnings
    save_mapping(mapping, warnings)

    channel_sheet_names = mapping['channel_sheets']
    store_sheet_name = mapping['store_sheet']
    sku_total_sheet_name = mapping['sku_total_sheet']

    if not store_sheet_name:
        raise RuntimeError('Cannot find the store-sales sheet by structure. Aborting sync (previous data/weekly_data.json is left untouched).')

    # ---- Parse channel x SKU sheets ----
    channel_parsed = {}
    for name in channel_sheet_names:
        channel_parsed[name] = parse_channel_sheet(grids[name], channel_name=name)

    # ---- Parse store-sales sheet ----
    store_parsed = parse_store_sheet(grids[store_sheet_name])

    # ---- Parse SKU-total sheet (monthly only, cross-check use) ----
    sku_total_parsed = parse_sku_total_sheet(grids[sku_total_sheet_name]) if sku_total_sheet_name else None

    # =========================================================================
    # 1) STORE-SOURCED: overall + channel + store weekly series (source of
    #    truth per spec sections 2.1/2.2/2.3)
    # =========================================================================
    week_meta = {}
    for wc in store_parsed['week_cols']:
        week_meta[wc['week_key']] = {
            'week_key': wc['week_key'], 'month': wc['month'], 'week_idx': wc['week_idx'],
            'week_start': wc['week_start'], 'week_end': wc['week_end'],
        }

    # Channels this workbook actually recognizes (from the store sheet, which is
    # the source of truth for what a "channel" is for overall/channel KPIs).
    all_channels = sorted({r['channel'] for r in store_parsed['store_rows'] if r['channel']} |
                           {r['channel'] for r in store_parsed['total_rows'] if r['channel']})

    # channel_week_total[channel][week_key] -> (value, source) where source is
    # 'store_sum' (normal case) or 'total_row_fallback' (channel has an
    # entered Total but no usable per-store breakdown for that week).
    channel_week_total = {ch: {} for ch in all_channels}
    channel_week_store_count = {ch: {} for ch in all_channels}
    store_week_value = {}  # (channel, store) -> {week_key: value_or_None}

    for row in store_parsed['store_rows']:
        key = (row['channel'], row['store'])
        store_week_value[key] = row['weeks']

    for ch in all_channels:
        ch_stores = [r for r in store_parsed['store_rows'] if r['channel'] == ch]
        ch_total_row = next((r for r in store_parsed['total_rows'] if r['channel'] == ch), None)
        for wk in week_meta:
            vals = [r['weeks'].get(wk) for r in ch_stores]
            reporting = [v for v in vals if v is not None]
            channel_week_store_count[ch][wk] = len(reporting)
            if reporting:
                channel_week_total[ch][wk] = {'value': sum(reporting), 'source': 'store_sum'}
            elif ch_total_row and ch_total_row['weeks'].get(wk) is not None:
                channel_week_total[ch][wk] = {'value': ch_total_row['weeks'][wk], 'source': 'total_row_fallback'}
                dq['week_issues'].append({
                    'type': 'channel_missing_store_breakdown', 'week': wk, 'channel': ch,
                    'detail': f"{ch} has no per-store data for this week; channel total taken from the sheet's own Total row instead of a store sum.",
                    'severity': 'medium',
                })
            else:
                channel_week_total[ch][wk] = {'value': None, 'source': 'no_data'}

    # Structural, not per-week: a channel that NEVER has store-level rows.
    for ch in all_channels:
        ch_stores = [r for r in store_parsed['store_rows'] if r['channel'] == ch]
        if ch_stores and all(all(v is None for v in r['weeks'].values()) for r in ch_stores):
            dq['sheet_issues'].append({
                'type': 'channel_no_store_breakdown_ever', 'channel': ch,
                'detail': f"Every store row under {ch} is blank for all weeks in {store_sheet_name}. "
                          f"Store-level drilldown/alerts are not available for this channel; only the channel total is usable.",
                'severity': 'high',
            })

    overall_week_total = {}
    for wk in week_meta:
        parts = [channel_week_total[ch][wk]['value'] for ch in all_channels]
        parts = [p for p in parts if p is not None]
        overall_week_total[wk] = sum(parts) if parts else None

    # ---- Week completeness (spec section 3) ----
    sorted_weeks = sorted(week_meta.keys())
    for i, wk in enumerate(sorted_weeks):
        wm = week_meta[wk]
        end = date.fromisoformat(wm['week_end'])
        has_any_data = overall_week_total.get(wk) is not None
        end_passed = end <= run_date
        channels_reporting = [ch for ch in all_channels if channel_week_total[ch][wk]['value'] is not None]
        all_channels_reported = len(channels_reporting) == len(all_channels)

        # store-count anomaly vs trailing 4 weeks (only checked for channels
        # that DO normally report at store level; the permanently-store-less
        # channels are excluded via the sheet_issues flag above).
        anomaly_channels = []
        for ch in all_channels:
            has_ever_reported_stores = any(
                any(v is not None for v in r['weeks'].values())
                for r in store_parsed['store_rows'] if r['channel'] == ch
            )
            if not has_ever_reported_stores:
                continue
            trailing = [channel_week_store_count[ch][sorted_weeks[j]] for j in range(max(0, i - 4), i)]
            trailing = [t for t in trailing if t is not None]
            avg_trailing = (sum(trailing) / len(trailing)) if trailing else None
            this_count = channel_week_store_count[ch][wk]
            if avg_trailing and avg_trailing > 0 and this_count < avg_trailing * 0.5:
                anomaly_channels.append(ch)

        if not has_any_data:
            status = 'no_data'
        elif not end_passed:
            status = 'pending_validation'
        elif not all_channels_reported:
            status = 'pending_validation'
        elif anomaly_channels:
            status = 'pending_validation'
        else:
            status = 'complete'

        wm['status'] = status
        wm['end_passed'] = end_passed
        wm['channels_reporting'] = channels_reporting
        wm['anomaly_channels'] = anomaly_channels
        wm['overall_total'] = overall_week_total.get(wk)
        if status == 'pending_validation':
            dq['week_issues'].append({
                'type': 'incomplete_week', 'week': wk,
                'detail': f"{wm['month']}月 week{wm['week_idx']} ({wk}~{wm['week_end']}) is not used for formal comparisons: "
                          f"end_passed={end_passed}, all_channels_reported={all_channels_reported}, anomaly_channels={anomaly_channels}.",
                'severity': 'low',
            })

    complete_weeks = [w for w in sorted_weeks if week_meta[w]['status'] == 'complete']
    latest_complete_week = complete_weeks[-1] if complete_weeks else None

    # ---- Store-level series for dashboard 2 ----
    stores_out = []
    for (ch, store), weeks in store_week_value.items():
        stores_out.append({'channel': ch, 'store': store, 'weekly': weeks})

    # =========================================================================
    # 2) SKU-SOURCED: canonical SKU + category weekly series, built from the
    #    4 channel sheets (per spec: SKU-total sheet has no weekly data in
    #    this workbook, so it cannot be the weekly source -- flagged below).
    # =========================================================================
    if sku_total_sheet_name:
        has_week_data_in_sku_total = any(
            len(parsed_row) for parsed_row in [sku_total_parsed['week_cols']]
        ) if sku_total_parsed else False
        if not has_week_data_in_sku_total:
            dq['sheet_issues'].append({
                'type': 'sku_total_sheet_monthly_only', 'sheet': sku_total_sheet_name,
                'detail': f"'{sku_total_sheet_name}' only has month-level columns, no week-level columns. "
                          f"Per spec fallback rule, weekly SKU/category figures are built from the 4 channel sheets "
                          f"instead, tagged source='channel_sheets'. '{sku_total_sheet_name}' is used only for a "
                          f"monthly cross-check and for flagging SKUs it's missing.",
                'severity': 'medium',
            })

    # canonical SKU registry: key -> {item, category, barcodes:set, variants:set}
    sku_registry = {}
    barcode_to_items = {}
    sku_week_channel = {}  # sku_key -> {week_key: {channel: qty}}

    for name in channel_sheet_names:
        parsed = channel_parsed[name]
        for row in parsed['rows']:
            key = canonical_sku_key(row['item'])
            if key is None:
                if row['barcode']:
                    dq['unmapped_sku'].append({'type': 'blank_item_name', 'channel': name, 'barcode': row['barcode']})
                continue
            reg = sku_registry.setdefault(key, {'item': row['item'], 'category': set(), 'barcodes': set(), 'variants': set()})
            if row['category']:
                reg['category'].add(row['category'])
            else:
                dq['unmapped_category'].append({'sku': row['item'], 'channel': name, 'barcode': row['barcode']})
            if row['barcode']:
                reg['barcodes'].add(row['barcode'])
                barcode_to_items.setdefault(row['barcode'], set()).add(key)
            if row['variant']:
                reg['variants'].add(row['variant'])
            wk_bucket = sku_week_channel.setdefault(key, {})
            for wk, qty in row['weeks'].items():
                if wk not in week_meta:
                    continue
                q = clean_num(qty) or 0
                if q < 0:
                    dq['negative_values'].append({'sku': row['item'], 'channel': name, 'week': wk, 'value': q})
                    q = 0
                wk_bucket.setdefault(wk, {})
                wk_bucket[wk][name] = wk_bucket[wk].get(name, 0) + q

    for bc, items in barcode_to_items.items():
        if len(items) > 1:
            dq['duplicate_barcodes'].append({
                'type': 'barcode_maps_to_multiple_skus', 'barcode': bc,
                'skus': [sku_registry[i]['item'] for i in items],
                'severity': 'high',
            })
    for key, reg in sku_registry.items():
        if len(reg['barcodes']) > 1:
            dq['duplicate_barcodes'].append({
                'type': 'sku_has_multiple_barcodes', 'sku': reg['item'],
                'barcodes': sorted(reg['barcodes']), 'severity': 'info',
                'detail': 'Merged into one SKU total per spec (barcodes/color variants combined).',
            })

    # category totals derived from the (barcode-deduped) canonical SKU series
    category_week_total = {}
    for key, reg in sku_registry.items():
        cat = sorted(reg['category'])[0] if reg['category'] else 'Uncategorized'
        for wk, by_ch in sku_week_channel.get(key, {}).items():
            total = sum(by_ch.values())
            category_week_total.setdefault(cat, {}).setdefault(wk, 0)
            category_week_total[cat][wk] += total

    skus_out = []
    for key, reg in sku_registry.items():
        skus_out.append({
            'sku_key': key, 'item': reg['item'],
            'category': sorted(reg['category'])[0] if reg['category'] else 'Uncategorized',
            'barcodes': sorted(reg['barcodes']),
            'weekly_by_channel': sku_week_channel.get(key, {}),
        })

    # ---- Monthly cross-check against the SKU-total sheet (best-effort) ----
    if sku_total_parsed:
        sku_total_barcode_set = {r['barcode'] for r in sku_total_parsed['rows'] if r['barcode']}
        channel_barcode_set = set(barcode_to_items.keys())
        missing_from_sku_total = channel_barcode_set - sku_total_barcode_set
        missing_from_channels = sku_total_barcode_set - channel_barcode_set
        if missing_from_sku_total:
            dq['reconciliation'].append({
                'type': 'sku_total_missing_barcodes', 'count': len(missing_from_sku_total),
                'detail': f"{len(missing_from_sku_total)} barcodes appear in the 4 channel sheets but not in "
                          f"'{sku_total_sheet_name}'. Their weekly figures still come from the channel sheets "
                          f"(source='channel_sheets'); '{sku_total_sheet_name}' is incomplete for them.",
                'severity': 'medium',
            })
        if missing_from_channels:
            dq['reconciliation'].append({
                'type': 'channel_sheets_missing_barcodes', 'count': len(missing_from_channels),
                'detail': f"{len(missing_from_channels)} barcodes appear in '{sku_total_sheet_name}' but not in "
                          f"any of the 4 channel sheets (no channel/week breakdown available for them).",
                'severity': 'low',
            })

    # =========================================================================
    # 3) Three-source weekly reconciliation snapshot (store vs channel-sheet
    #    SKU sum) for every week that has data in both -- surfaced in Data
    #    Quality, never used to "correct" either source.
    # =========================================================================
    for wk in sorted_weeks:
        store_total = overall_week_total.get(wk)
        sku_total = 0
        has_sku = False
        for key, byweek in sku_week_channel.items():
            if wk in byweek:
                has_sku = True
                sku_total += sum(byweek[wk].values())
        if store_total is None or not has_sku:
            continue
        diff = store_total - sku_total
        diff_pct = (diff / store_total) if store_total else None
        dq['reconciliation'].append({
            'type': 'weekly_store_vs_sku_scope', 'week': wk,
            'store_basis_total': store_total, 'store_basis_unit': 'THB',
            'sku_basis_total': sku_total, 'sku_basis_unit': 'PCS',
            'diff_abs': diff, 'diff_pct': diff_pct,
            'detail': "Store-basis total is Thai Baht sales VALUE (the store-sales sheet has no PCS column); "
                      "SKU-basis total is piece-count QTY from the 4 channel sheets, for this product line only. "
                      "These are two different units measuring two different scopes -- never sum or compare them "
                      "directly. Not a data error; see README for the verification.",
            'severity': 'info',
        })

    # =========================================================================
    # Assemble output
    # =========================================================================
    out = {
        'meta': {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'sheet_mapping': mapping,
            'latest_complete_week': latest_complete_week,
            'week_timezone': 'Asia/Bangkok',
            'week_start_day': 'Monday',
            'week_end_day': 'Sunday',
            # IMPORTANT: the store-sales sheet has no PCS/quantity column at all --
            # every one of its numeric columns is Thai Baht sales VALUE (verified:
            # a channel's Aug-week1 + Aug-week2 store-sheet total reproduces that
            # channel's "TTL Value" column on its own channel sheet exactly, e.g.
            # Beautrium 41,523 + 125,916 = 167,439 = Beautrium's 8-month TTL Value,
            # NOT its TTL QTY of 311). So overall/channel/store KPIs are reported in
            # THB, not PCS, per the user's explicit decision. SKU/category KPIs are
            # unaffected -- the 4 channel sheets' "WEEK N QTY" columns are genuine
            # piece counts and remain PCS.
            'store_basis_unit': 'THB',
            'sku_basis_unit': 'PCS',
        },
        'weeks': [week_meta[w] for w in sorted_weeks],
        'channels': all_channels,
        'channel_weekly': {ch: channel_week_total[ch] for ch in all_channels},
        'channel_weekly_store_count': channel_week_store_count,
        'overall_weekly': overall_week_total,
        'stores': stores_out,
        'skus': skus_out,
        'category_weekly': category_week_total,
        'data_quality': dq,
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', choices=['xlsx', 'sheets'], required=True)
    ap.add_argument('--path', help='xlsx file path (source=xlsx)')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    out_path = os.path.abspath(args.out)
    prior = None
    if os.path.exists(out_path):
        try:
            with open(out_path) as f:
                prior = json.load(f)
        except Exception:
            prior = None

    try:
        if args.source == 'xlsx':
            from xlsx_source import load_grids
            grids, names = load_grids(args.path)
        else:
            from sheets_source import load_grids
            grids, names = load_grids()

        result = build(grids, names)
        result['meta']['sync_status'] = 'ok'
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, 'w') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"OK: wrote {out_path} (latest_complete_week={result['meta']['latest_complete_week']})")
    except Exception as e:
        # Deliberately do NOT sys.exit(1) here. A sheet hiccup (rate limit,
        # transient API error, a temporarily malformed row) must never wipe
        # the live dashboard or block deployment -- per spec, the site keeps
        # showing the last successful data plus a visible "sync failed"
        # banner (rendered by weekly/common.js from meta.sync_status). The
        # GitHub Actions run is still flagged via the ::warning:: annotation
        # below so it's visible in the Actions tab without red-X'ing the
        # whole workflow and skipping the commit/deploy steps.
        print(f"::warning::Weekly dashboard sync failed: {e}", file=sys.stderr)
        traceback.print_exc()
        if prior is not None:
            prior.setdefault('meta', {})['sync_status'] = 'failed'
            prior['meta']['sync_failed_at'] = datetime.now(timezone.utc).isoformat()
            prior['meta']['sync_failure_reason'] = str(e)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, 'w') as f:
                json.dump(prior, f, ensure_ascii=False, indent=2)
            print("Kept previous successful data (sync_status='failed' flag set).", file=sys.stderr)
        else:
            # No prior successful run exists at all (e.g. very first sync
            # fails) -- there is nothing safe to serve yet, so this case
            # DOES fail the job rather than publish an empty/broken dashboard.
            print("::error::No previous successful data exists; failing the job instead of publishing nothing.", file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Checks the JSON output of build_data.py against the control totals that were
manually verified against the source workbook (see README "September Weekly
Review" section). These constants are NEVER used to compute the output --
only to catch a regression in build_data.py. Exit code is nonzero on any
mismatch.

Usage:
    python3 etl/september_review/verify_control_totals.py
"""
import json
import os
import sys

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'data', 'september')

CONTROL_OVERALL = {'w1': 235586, 'w2': 254006, 'w3': 235018, 'cum': 724610}
CONTROL_CHANNELS = {
    'Beautrium': {'w1': 70474, 'w2': 64530, 'w3': 83295, 'cum': 218299},
    'Eveandboy': {'w1': 52113, 'w2': 41823, 'w3': 57648, 'cum': 151584},
    'KIS': {'w1': 5931, 'w2': 8115, 'w3': 6179, 'cum': 20225},
    'Konvy': {'w1': 107068, 'w2': 139538, 'w3': 87896, 'cum': 334502},
}
CONTROL_3CH_PCS = {'w1': 239, 'w2': 216, 'w3': 273, 'cum': 728}
CONTROL_CATEGORY_W3 = {
    '多用膏': {'w3': 128, 'delta': -8},
    '多用粉': {'w3': 91, 'delta': 42},
    '水光多用棒': {'w3': 13, 'delta': 6},
    '多用液': {'w3': 13, 'delta': 5},
    '水光多用液': {'w3': 10, 'delta': 9},
    '粉饼': {'w3': 9, 'delta': 4},
}
CONTROL_STORE_DELTA = {
    ('Beautrium', 'Central World (BA)'): 11927,
    ('Eveandboy', 'Terminal21 Asoke (BA)'): 6922,
    ('Eveandboy', 'MAJOR RATCHAYOTHIN'): 4083,
    ('Eveandboy', 'One bangkok'): -2147,
    ('Beautrium', 'Central Ladprao (BA)'): -2048,
    ('Beautrium', 'Central Pattaya Beach'): -1996,
}
CONTROL_SKU_DELTA = {
    "moon’s path": 13,
    'satin rise': 11,
    'moon': -9,
    'jenchun': -8,
    'veiled dawn': 7,
    'suin': 7,
}

# August comparison (weekly-average pace basis: total / weeks-in-period),
# manually verified against the source workbook in chat with the user before
# build_august_comparison.py existed. Kept here purely as a regression check.
CONTROL_AUG_CHANNEL_TOTAL = {'Beautrium': 496236, 'Eveandboy': 268704, 'KIS': 110292, 'Konvy': 748026}
CONTROL_AUG_OVERALL_TOTAL = 1623258
CONTROL_AUG_3CH_PCS_TOTAL = 1633
CONTROL_PACE_CHANGE_PCT = {
    'overall': -0.256,
    'Beautrium': -0.267, 'Eveandboy': -0.060, 'KIS': -0.694, 'Konvy': -0.255,
    '3channel_pcs': -0.257,
}
CONTROL_CATEGORY_PACE_CHANGE_PCT = {
    '多用膏': -0.263, '多用粉': -0.318, '水光多用棒': -0.394,
}

EPS_THB = 1.0
EPS_PCS = 0.5
EPS_PCT = 0.01  # 1 percentage point

failures = []
checks_run = 0


def check(label, actual, expected, eps):
    global checks_run
    checks_run += 1
    if actual is None or abs(actual - expected) > eps:
        failures.append(f'{label}: expected {expected}, got {actual}')


def load(name):
    with open(os.path.join(OUT_DIR, name), encoding='utf-8') as f:
        return json.load(f)


def main():
    cv = load('weekly_channel_value.json')
    sv = load('weekly_store_value.json')
    su = load('weekly_sku_units.json')
    cu = load('weekly_category_units.json')

    for wk in ('w1', 'w2', 'w3', 'cum'):
        check(f'overall.{wk}', cv['overall'][wk], CONTROL_OVERALL[wk], EPS_THB)
    for ch, exp in CONTROL_CHANNELS.items():
        for wk in ('w1', 'w2', 'w3', 'cum'):
            check(f'channel.{ch}.{wk}', cv['channels'][ch][wk], exp[wk], EPS_THB)

    for wk in ('w1', 'w2', 'w3', 'cum'):
        check(f'3ch_pcs.{wk}', cu['total_3channel'][wk], CONTROL_3CH_PCS[wk], EPS_PCS)

    cat_by_name = {c['category']: c for c in cu['categories']}
    for cat, exp in CONTROL_CATEGORY_W3.items():
        if cat not in cat_by_name:
            failures.append(f'category "{cat}" missing from output entirely')
            continue
        check(f'category.{cat}.w3', cat_by_name[cat]['w3'], exp['w3'], EPS_PCS)
        check(f'category.{cat}.w3_vs_w2_abs', cat_by_name[cat]['w3_vs_w2_abs'], exp['delta'], EPS_PCS)

    store_by_key = {(s['channel'], s['store']): s for s in sv['stores']}
    for (ch, store), exp_delta in CONTROL_STORE_DELTA.items():
        s = store_by_key.get((ch, store))
        if s is None:
            failures.append(f'store {ch}/{store} missing from output entirely')
            continue
        actual_delta = None if s['w2'] is None or s['w3'] is None else s['w3'] - s['w2']
        check(f'store.{ch}.{store}.w3_vs_w2', actual_delta, exp_delta, EPS_THB)

    import re
    sku_by_lower_name = {s['name'].lower(): s for s in su['skus']}

    def find_sku(fragment):
        pat = re.compile(r'(?<![a-z0-9’\'])' + re.escape(fragment) + r'(?![a-z0-9’\'])')
        for name, s in sku_by_lower_name.items():
            if pat.search(name):
                return s
        return None

    for fragment, exp_delta in CONTROL_SKU_DELTA.items():
        s = find_sku(fragment)
        if s is None:
            failures.append(f'SKU matching "{fragment}" missing from output entirely')
            continue
        check(f'sku.{fragment}.w3_vs_w2_abs', s['w3_vs_w2_abs'], exp_delta, EPS_PCS)

    # sanity: no NaN/Infinity, no Konvy in SKU output, Total rows not double counted
    for s in su['skus']:
        for k in ('w1', 'w2', 'w3'):
            v = s[k]
            if v != v or v in (float('inf'), float('-inf')):
                failures.append(f'SKU {s["name"]} has NaN/Infinity in {k}')
    if any('Konvy' in s.get('by_channel_w3', {}) for s in su['skus']):
        failures.append('Konvy channel key leaked into SKU output (must be Beautrium/Eveandboy/KIS only)')
    if 'Total' in {s['store'] for s in sv['stores']}:
        failures.append('A row literally named "Total" leaked into per-store output -- Total-row double count risk')

    # -------- August comparison (data/september/august_comparison.json) --------
    aug_path = os.path.join(OUT_DIR, 'august_comparison.json')
    if os.path.isfile(aug_path):
        ac = load('august_comparison.json')
        check('august.overall.aug_total', ac['overall']['aug_total'], CONTROL_AUG_OVERALL_TOTAL, EPS_THB)
        check('august.overall.weekly_pace_change_pct', ac['overall']['weekly_pace_change_pct'], CONTROL_PACE_CHANGE_PCT['overall'], EPS_PCT)
        for ch, exp_total in CONTROL_AUG_CHANNEL_TOTAL.items():
            check(f'august.channel.{ch}.aug_total', ac['channels'][ch]['aug_total'], exp_total, EPS_THB)
            check(f'august.channel.{ch}.weekly_pace_change_pct', ac['channels'][ch]['weekly_pace_change_pct'], CONTROL_PACE_CHANGE_PCT[ch], EPS_PCT)
        check('august.total_3channel.aug_total', ac['total_3channel']['aug_total'], CONTROL_AUG_3CH_PCS_TOTAL, EPS_PCS)
        check('august.total_3channel.weekly_pace_change_pct', ac['total_3channel']['weekly_pace_change_pct'], CONTROL_PACE_CHANGE_PCT['3channel_pcs'], EPS_PCT)
        cat_by_name = {c['category']: c for c in ac['categories']}
        for cat, exp_chg in CONTROL_CATEGORY_PACE_CHANGE_PCT.items():
            if cat not in cat_by_name:
                failures.append(f'august category "{cat}" missing from august_comparison.json')
                continue
            check(f'august.category.{cat}.weekly_pace_change_pct', cat_by_name[cat]['weekly_pace_change_pct'], exp_chg, EPS_PCT)
        for row in ac['skus']:
            for k in ('aug_total', 'sep_total', 'aug_weekly_pace', 'sep_weekly_pace'):
                v = row[k]
                if v is not None and (v != v or v in (float('inf'), float('-inf'))):
                    failures.append(f'august SKU {row["name"]} has NaN/Infinity in {k}')
        if any('Konvy' in r.get('by_channel_w3', {}) for r in ac['skus'] if isinstance(r, dict)):
            failures.append('Konvy leaked into august_comparison.json SKU rows')
    else:
        failures.append('data/september/august_comparison.json not found -- run build_august_comparison.py')

    print(f'{checks_run} control-total checks run.')
    if failures:
        print(f'\n{len(failures)} FAILURE(S):')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('ALL CONTROL TOTALS MATCH.')


if __name__ == '__main__':
    main()

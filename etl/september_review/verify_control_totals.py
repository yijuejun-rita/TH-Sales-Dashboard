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

EPS_THB = 1.0
EPS_PCS = 0.5

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

    print(f'{checks_run} control-total checks run.')
    if failures:
        print(f'\n{len(failures)} FAILURE(S):')
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('ALL CONTROL TOTALS MATCH.')


if __name__ == '__main__':
    main()

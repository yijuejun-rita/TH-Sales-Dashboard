"""
Dynamic, name-based parser for the Thailand Sales Google Sheet.

Design principle (per project spec): NEVER rely on fixed column indexes.
Every field is located by matching header text (case/whitespace-insensitive,
tolerant of typos like "WEEK 3QTY" vs "WEEK 3 QTY"). If the sheet owner adds
columns, reorders columns, or adds new weeks, this module keeps working as
long as the header text still contains a recognizable field name.

Input contract: every parser function takes a "grid" -- a list of rows,
each row a list of cell values (already evaluated, not formulas) -- so the
same logic works whether the grid came from openpyxl (local xlsx, used for
testing) or the Google Sheets API (production, see sheets_source.py).
"""
import re
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# Month detection
# ---------------------------------------------------------------------------

_MONTH_ABBR = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def norm(s):
    if s is None:
        return ''
    return re.sub(r'\s+', ' ', str(s)).strip()


def normalize_barcode(v):
    """Barcodes appear inconsistently typed across sheets in this workbook
    (e.g. the same barcode is a float 6975025852931.0 in three sheets and a
    plain text string '6975025852931' in a fourth). Normalize both to the
    same digit string so they aren't mistaken for two different barcodes."""
    if v is None or v == '':
        return None
    s = str(v).strip()
    if re.fullmatch(r'\d+\.0+', s):
        s = s.split('.')[0]
    return s


def detect_month(text):
    """Return 1-12 if `text` names a month (Chinese '8月' or English 'Aug'), else None."""
    if text is None:
        return None
    t = str(text)
    m = re.search(r'(\d{1,2})\s*月', t)
    if m:
        mm = int(m.group(1))
        if 1 <= mm <= 12:
            return mm
    tl = t.lower()
    for k, v in _MONTH_ABBR.items():
        if k in tl:
            return v
    return None


# ---------------------------------------------------------------------------
# Business-week calendar (Monday start / Sunday end, per spec section 3).
# Verified against the workbook's own free-text date-range labels
# (e.g. "1-2nd Aug" / "3-9th Aug" / "1-7 June") -- this formula reproduces
# them exactly, so it is used as the canonical, typo-proof source of week
# boundaries instead of trusting the free-text labels themselves.
# ---------------------------------------------------------------------------

def week_date_range(year, month, week_idx):
    if not month or not week_idx:
        return None
    first = date(year, month, 1)
    next_month = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last = next_month - timedelta(days=1)
    days_to_sunday = (6 - first.weekday()) % 7  # Mon=0 .. Sun=6
    first_sunday = min(first + timedelta(days=days_to_sunday), last)
    weeks = [(first, first_sunday)]
    w_end = first_sunday
    while w_end < last:
        w_start = w_end + timedelta(days=1)
        w_end = min(w_start + timedelta(days=6), last)
        weeks.append((w_start, w_end))
    idx = week_idx - 1
    if 0 <= idx < len(weeks):
        return weeks[idx]
    return None


def iso_week_key(year, month, week_idx):
    wr = week_date_range(year, month, week_idx)
    return wr[0].isoformat() if wr else None


# ---------------------------------------------------------------------------
# Channel x SKU sheets (Beautrium / Eveandboy / Konvy / KIS)
# 2-row header: row0 = month/date-range markers (sparse), row1 = sub-labels
# (Barcode/Item/.../WEEK N QTY/Amount/占比/TTL QTY/TTL Value).
# ---------------------------------------------------------------------------

FIELD_PATTERNS = {
    'barcode': re.compile(r'barcode', re.I),
    'item': re.compile(r'^item$', re.I),
    'variant': re.compile(r'色号'),
    'category': re.compile(r'category', re.I),
    'channel': re.compile(r'^channel$', re.I),
}


def find_static_columns(header_row):
    """Locate Barcode/Item/Variant/Category/Channel columns by header text."""
    cols = {}
    for c, v in enumerate(header_row):
        vn = norm(v)
        if not vn:
            continue
        for key, pat in FIELD_PATTERNS.items():
            if key not in cols and pat.search(vn):
                cols[key] = c
    return cols


def parse_channel_sheet(grid, channel_name, year=2026):
    """
    grid: list of rows (0-indexed), row0/row1 = the two header rows,
          data starts row2.
    channel_name: used as the channel identity for every row (per spec,
          the sheet itself IS the channel -- more robust than trusting a
          'Channel' header cell, which is blank/inconsistent on some sheets).
    Returns: {
      'static_cols': {...},
      'week_cols': [ {col, month, week_idx, week_key, week_start, week_end,
                      amount_col, pct_col} ... ],
      'month_ttl_cols': [ {col, month} ... ],
      'rows': [ {barcode, item, variant, category, weeks: {week_key: qty}} ... ]
    }
    """
    row0 = grid[0] if len(grid) > 0 else []
    row1 = grid[1] if len(grid) > 1 else []
    ncols = max(len(row0), len(row1))
    static_cols = find_static_columns(row0)

    week_cols = []
    month_ttl_cols = []
    current_month = None
    for c in range(ncols):
        r0 = row0[c] if c < len(row0) else None
        r1 = row1[c] if c < len(row1) else None
        mm = detect_month(r0)
        if mm:
            current_month = mm
        r1n = norm(r1).lower().replace('\n', ' ')
        r1n = re.sub(r'\s+', ' ', r1n)
        wk_match = re.search(r'week\s*(\d+)\s*qty', r1n)
        if wk_match and current_month:
            wk = int(wk_match.group(1))
            wr = week_date_range(year, current_month, wk)
            week_cols.append({
                'col': c, 'month': current_month, 'week_idx': wk,
                'week_key': wr[0].isoformat() if wr else None,
                'week_start': wr[0].isoformat() if wr else None,
                'week_end': wr[1].isoformat() if wr else None,
                'amount_col': c + 1 if c + 1 < ncols else None,
                'pct_col': c + 2 if c + 2 < ncols else None,
                'header_r0': r0, 'header_r1': r1,
            })
        elif 'ttl qty' in r1n and current_month:
            month_ttl_cols.append({'col': c, 'month': current_month})

    rows = []
    for r in range(2, len(grid)):
        row = grid[r]

        def cell(colkey):
            idx = static_cols.get(colkey)
            if idx is None or idx >= len(row):
                return None
            return row[idx]

        barcode = cell('barcode')
        item = cell('item')
        if barcode in (None, '') and item in (None, ''):
            continue
        weeks = {}
        for wc in week_cols:
            v = row[wc['col']] if wc['col'] < len(row) else None
            weeks[wc['week_key']] = v if isinstance(v, (int, float)) else (0 if v in (None, '') else v)
        rows.append({
            'channel': channel_name,
            'barcode': normalize_barcode(barcode),
            'item': norm(item) or None,
            'variant': norm(cell('variant')) or None,
            'category': norm(cell('category')) or None,
            'weeks': weeks,
        })

    return {
        'static_cols': static_cols,
        'week_cols': week_cols,
        'month_ttl_cols': month_ttl_cols,
        'rows': rows,
    }


# ---------------------------------------------------------------------------
# Store-sales sheet ("店铺销量") -- single header row. Channel + Store are
# forward-filled (Google Sheets keeps the value only on the block's first
# row when cells are visually merged). Rows whose Store == "Total" are the
# sheet's own channel-level subtotal and are kept separately, never treated
# as a store.
# ---------------------------------------------------------------------------

def parse_store_sheet(grid, year=2026):
    header = grid[0] if grid else []
    ncols = len(header)
    week_cols = []
    for c, hv in enumerate(header):
        if hv is None:
            continue
        flat = norm(hv)
        m = re.search(r'week\s*(\d+)', flat, re.I)
        if not m:
            continue
        mm = detect_month(flat)
        if not mm:
            continue
        wk = int(m.group(1))
        wr = week_date_range(year, mm, wk)
        week_cols.append({
            'col': c, 'month': mm, 'week_idx': wk,
            'week_key': wr[0].isoformat() if wr else None,
            'week_start': wr[0].isoformat() if wr else None,
            'week_end': wr[1].isoformat() if wr else None,
            'header': hv,
        })

    store_rows = []   # real stores
    total_rows = []    # per-channel "Total" rows (channel-level, sheet-provided)
    current_channel = None
    for r in range(1, len(grid)):
        row = grid[r]
        ch = row[0] if len(row) > 0 else None
        store = row[1] if len(row) > 1 else None
        if ch not in (None, ''):
            current_channel = norm(ch)
        if store in (None, ''):
            continue
        store_n = norm(store)
        weeks = {}
        for wc in week_cols:
            v = row[wc['col']] if wc['col'] < len(row) else None
            weeks[wc['week_key']] = v if isinstance(v, (int, float)) else None
        entry = {'channel': current_channel, 'store': store_n, 'weeks': weeks}
        if store_n == 'Total':
            total_rows.append(entry)
        else:
            store_rows.append(entry)

    return {'week_cols': week_cols, 'store_rows': store_rows, 'total_rows': total_rows}


# ---------------------------------------------------------------------------
# SKU-total sheet ("SKU销量") -- 2-row header, channel blocks (BT/EB/KIS/
# Konvey/TTL) x month columns. NO week-level data exists on this sheet in
# the current workbook; only month totals. If a future edit of the sheet
# adds week columns under a block, they will be picked up automatically
# because detection is header-text driven, not position driven.
# ---------------------------------------------------------------------------

_SKU_STATIC = {
    'barcode': re.compile(r'barcode', re.I),
    'item': re.compile(r'^item$', re.I),
    'variant': re.compile(r'色号'),
    'category': re.compile(r'category', re.I),
    'srp': re.compile(r'^srp$', re.I),
}


def parse_sku_total_sheet(grid, year=2026):
    row0 = grid[0] if len(grid) > 0 else []
    row1 = grid[1] if len(grid) > 1 else []
    ncols = max(len(row0), len(row1))

    static_cols = {}
    for c, v in enumerate(row1):
        vn = norm(v)
        for key, pat in _SKU_STATIC.items():
            if key not in static_cols and pat.search(vn):
                static_cols[key] = c

    # Blocks are marked in row0 by a channel/aggregate label (BT/EB/KIS/
    # Konvey/TTL or similar); every subsequent column belongs to that block
    # until the next label appears.
    blocks = []
    current_block = None
    current_block_start = None
    for c in range(ncols):
        v0 = norm(row0[c]) if c < len(row0) else ''
        if v0:
            if current_block is not None:
                blocks.append((current_block, current_block_start, c - 1))
            current_block = v0
            current_block_start = c
    if current_block is not None:
        blocks.append((current_block, current_block_start, ncols - 1))

    week_cols = []   # stays empty unless the sheet is later extended with weeks
    month_cols = []  # [{block, col, month, is_value}]
    for block_name, start, end in blocks:
        for c in range(start, end + 1):
            if c in static_cols.values():
                continue
            v1 = norm(row1[c]) if c < len(row1) else ''
            if not v1 or v1.lower() == 'ttl':
                continue
            is_value = bool(re.search(r'value|金额|amount', v1, re.I))
            mm = detect_month(v1)
            wk_match = re.search(r'week\s*(\d+)', v1, re.I)
            if wk_match and mm:
                wr = week_date_range(year, mm, int(wk_match.group(1)))
                week_cols.append({
                    'col': c, 'block': block_name, 'month': mm,
                    'week_idx': int(wk_match.group(1)),
                    'week_key': wr[0].isoformat() if wr else None,
                    'is_value': is_value,
                })
            elif mm:
                month_cols.append({'col': c, 'block': block_name, 'month': mm, 'is_value': is_value})

    rows = []
    for r in range(2, len(grid)):
        row = grid[r]

        def cell(colkey):
            idx = static_cols.get(colkey)
            if idx is None or idx >= len(row):
                return None
            return row[idx]

        barcode = cell('barcode')
        item = cell('item')
        if barcode in (None, '') and item in (None, ''):
            continue
        months = {}
        for mc in month_cols:
            if mc['is_value']:
                continue
            v = row[mc['col']] if mc['col'] < len(row) else None
            months.setdefault(mc['block'], {})[mc['month']] = v if isinstance(v, (int, float)) else 0
        rows.append({
            'barcode': normalize_barcode(barcode),
            'item': norm(item) or None,
            'variant': norm(cell('variant')) or None,
            'category': norm(cell('category')) or None,
            'srp': cell('srp'),
            'months': months,   # {block_name: {month: qty}}
        })

    return {'static_cols': static_cols, 'month_cols': month_cols, 'week_cols': week_cols, 'blocks': blocks, 'rows': rows}

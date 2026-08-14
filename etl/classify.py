"""
Sheet-role classification by header content (never by position).

On every run we re-classify every sheet in the live workbook by what its
headers actually contain, then cross-check against config/sheet_mapping.json
(the names we recognized last time). If a previously-known sheet still
carries the same structural signature under its old name, we trust the
fast name match. If a name disappeared, was renamed, or a brand-new sheet
appeared, we fall back to structural detection and update the config file
-- so the mapping self-heals across renames/reorders instead of silently
reading the wrong sheet.
"""
import re

from sheet_parser import norm


def _has_col(header_rows, pattern):
    for row in header_rows:
        for v in row:
            if v is not None and pattern.search(norm(v)):
                return True
    return False


_BARCODE = re.compile(r'barcode', re.I)
_ITEM = re.compile(r'^item$', re.I)
_CHANNEL_HDR = re.compile(r'^channel$', re.I)
_STORE_HDR = re.compile(r'^store$', re.I)
_WEEK_QTY = re.compile(r'week\s*\d+\s*qty', re.I)


def classify_sheet(grid):
    """Return one of 'channel_sku', 'store_sales', 'sku_total', 'unknown'."""
    if not grid:
        return 'unknown'
    header_rows = grid[:2]
    has_barcode = _has_col(header_rows, _BARCODE)
    has_item = _has_col(header_rows, _ITEM)
    has_channel_store = _has_col(header_rows, _CHANNEL_HDR) and _has_col(header_rows, _STORE_HDR)
    has_week_qty = _has_col(header_rows, _WEEK_QTY)

    if has_channel_store and not has_barcode:
        return 'store_sales'
    if has_barcode and has_item and has_week_qty:
        return 'channel_sku'
    if has_barcode and has_item and not has_week_qty:
        return 'sku_total'
    return 'unknown'


def classify_all(grids, sheet_names, remembered=None):
    """
    grids: {name: grid}
    sheet_names: sheet order as returned by the source (workbook/API order)
    remembered: previously-saved config/sheet_mapping.json contents, or None

    Returns (mapping, warnings) where mapping = {
      'channel_sheets': [name, ...]   # in sheet order
      'store_sheet': name or None,
      'sku_total_sheet': name or None,
    }
    """
    warnings = []
    live_roles = {name: classify_sheet(grids[name]) for name in sheet_names}

    channel_sheets = [n for n in sheet_names if live_roles[n] == 'channel_sku']
    store_candidates = [n for n in sheet_names if live_roles[n] == 'store_sales']
    sku_total_candidates = [n for n in sheet_names if live_roles[n] == 'sku_total']

    store_sheet = store_candidates[0] if store_candidates else None
    if len(store_candidates) > 1:
        warnings.append(f"Multiple sheets look like the store-sales sheet: {store_candidates}. Using '{store_sheet}'.")
    elif not store_candidates:
        warnings.append("No sheet matched the store-sales structure (Channel+Store columns, no Barcode). "
                         "Overall/channel KPIs cannot be computed until this is fixed.")

    # sku_total = the LAST sheet in the workbook among the sku_total candidates
    # (per spec: "最后一个工作表是SKU整体销量数据"), used only to break ties when
    # more than one sheet has this shape.
    sku_total_sheet = None
    if sku_total_candidates:
        sku_total_sheet = sorted(sku_total_candidates, key=lambda n: sheet_names.index(n))[-1]
        if len(sku_total_candidates) > 1:
            warnings.append(f"Multiple sheets look like a SKU-total sheet: {sku_total_candidates}. "
                             f"Using the last one in sheet order: '{sku_total_sheet}'.")
    else:
        warnings.append("No sheet matched the SKU-total structure (Barcode/Item without weekly columns). "
                         "SKU/category KPIs will fall back entirely to the 4 channel sheets.")

    if len(channel_sheets) != 4:
        warnings.append(f"Expected 4 channel x SKU sheets, structurally found {len(channel_sheets)}: {channel_sheets}.")

    mapping = {
        'channel_sheets': channel_sheets,
        'store_sheet': store_sheet,
        'sku_total_sheet': sku_total_sheet,
    }

    if remembered:
        # Sanity-check: if a remembered name still exists AND still classifies
        # the same way, prefer it (stable even if structural detection above
        # is ambiguous in a corner case). Any mismatch is surfaced as a warning
        # rather than silently overridden.
        for key in ('store_sheet', 'sku_total_sheet'):
            old = remembered.get(key)
            if old and old in sheet_names and old != mapping[key]:
                if key == 'store_sheet' and live_roles.get(old) == 'store_sales':
                    mapping[key] = old
                elif key == 'sku_total_sheet' and live_roles.get(old) == 'sku_total':
                    mapping[key] = old
                else:
                    warnings.append(f"Previously-remembered {key} '{old}' no longer matches its expected structure; "
                                     f"re-detected as '{mapping[key]}'.")
        old_channels = remembered.get('channel_sheets') or []
        if old_channels and set(old_channels) != set(channel_sheets):
            warnings.append(f"Channel-sheet set changed since last run: was {old_channels}, now {channel_sheets}.")

    return mapping, warnings

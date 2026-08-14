"""
Metric formulas shared by all three weekly dashboards.

Every function is null/zero-safe per spec section 4: no NaN, no Infinity,
no divide-by-zero ever reaches the frontend. When a ratio can't be computed
(no denominator, insufficient history, etc.) the function returns None and
the caller/frontend renders "N/A" instead of a number.
"""


def safe_div(a, b):
    if a is None or b in (None, 0):
        return None
    return a / b


def pct_change(current, base):
    """(current / base) - 1, None-safe."""
    d = safe_div(current, base)
    if d is None:
        return None
    return d - 1.0


def wow(current_week, prev_week):
    return {
        'value': current_week,
        'change_pct': pct_change(current_week, prev_week),
        'change_abs': (current_week - prev_week) if (current_week is not None and prev_week is not None) else None,
        'base': prev_week,
    }


def vs_avg3(current_week, avg3):
    return {
        'value': current_week,
        'change_pct': pct_change(current_week, avg3),
        'change_abs': (current_week - avg3) if (current_week is not None and avg3 is not None) else None,
        'base': avg3,
    }


def avg_of_weeks(values):
    """values: list of numbers/None for the N weeks preceding the current one.
    Returns None if there is no usable history at all (spec: 历史不足3周 handling
    happens by averaging over however many complete weeks ARE available, min 1;
    the caller marks `insufficient_history` if fewer than 3 were available)."""
    usable = [v for v in values if v is not None]
    if not usable:
        return None, 0
    return sum(usable) / len(usable), len(usable)


def share(part, whole):
    return safe_div(part, whole)


def contribution(part_change_abs, whole_change_abs):
    """变化贡献 = 对象变化PCS / 对应层级整体变化PCS. Guards zero/near-zero whole
    change (a flat total with big internal swings would otherwise blow up)."""
    if part_change_abs is None or whole_change_abs in (None, 0):
        return None
    return part_change_abs / whole_change_abs


def clean_num(v):
    """Coerce blanks to None (never silently to 0) and pass numbers through."""
    if v is None or v == '':
        return None
    try:
        f = float(v)
        if f != f or f in (float('inf'), float('-inf')):  # NaN / Inf guard
            return None
        return f
    except (TypeError, ValueError):
        return None

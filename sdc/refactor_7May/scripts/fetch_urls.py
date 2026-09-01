from datetime import datetime, timezone, timedelta

# -----------------------------------------------------------------------------
# WFA · Fetch all upload attempts → dropdown options
#
# Input  (Python action input schema)
#   uploads  list of objects, mapped from «Get records · RUN_Upload › Records»
#            upload_id          string    required  → option value
#            submitted_at       date_time optional  → option label
#            created_at         date_time optional  → label fallback when submitted_at is empty
#            status             string    optional  → only used if listed in SUFFIX_FIELDS
#            submission_source  string    optional  → only used if listed in SUFFIX_FIELDS
#
# Output (Python action output schema)
#   options        list of { label: string, value: string }  ← map straight into the app-function return
#   count          integer   number of options emitted
#   default_value  string    upload_id of the first option (newest attempt) — handy for the dropdown default
#   log            string    one line per anomaly (skipped rows, unparseable timestamps); empty when clean
#
# Decision: the dropdown value is upload_id only. supplier_request_id comes from
# the page; LNK-02 resolves the validation result from upload_id. Nothing else
# needs to round-trip through the component.
# -----------------------------------------------------------------------------

DISPLAY_TZ    = "UTC"                      # IANA name, e.g. "America/New_York". Falls back to UTC if unavailable.
LABEL_FORMAT  = "%Y-%m-%d %H:%M:%S %Z"     # 2026-08-14 09:32:11 UTC — unambiguous across regions, sorts visually
NEWEST_FIRST  = True
SUFFIX_FIELDS = ()                         # e.g. ("submission_source", "status") → "… UTC (upload · validated)"


def _display_tz(log):
    if DISPLAY_TZ.upper() == "UTC":
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(DISPLAY_TZ)
    except Exception as exc:  # zoneinfo missing, or tzdata absent in the sandbox
        log.append(f"display_tz_unavailable: {DISPLAY_TZ} ({exc.__class__.__name__}); using UTC")
        return timezone.utc


def _parse_ts(value):
    """ISO-8601 → aware datetime, or None. Tolerates 'Z', offsets, fractional seconds, naive (assumed UTC)."""
    if not value:
        return None
    s = str(value).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # datetime.fromisoformat (3.7+) accepts at most 6 fractional digits
    if "." in s:
        head, tail = s.split(".", 1)
        frac = ""
        for ch in tail:
            if ch.isdigit():
                frac += ch
            else:
                break
        rest = tail[len(frac):]
        s = f"{head}.{frac[:6].ljust(6, '0')}{rest}" if frac else f"{head}{rest}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def main(input):
    log = []
    tz = _display_tz(log)
    rows = input.get("uploads") or []
    if not isinstance(rows, list):
        rows = [rows]

    parsed = []   # (sort_key, label, value)
    for i, row in enumerate(rows):
        row = row or {}
        value = (row.get("upload_id") or "").strip()
        if not value:
            log.append(f"row {i}: skipped, no upload_id")
            continue

        raw_ts = row.get("submitted_at") or row.get("created_at")
        dt = _parse_ts(raw_ts)
        if dt is not None:
            label = dt.astimezone(tz).strftime(LABEL_FORMAT).strip()
            sort_key = dt.timestamp()
        else:
            # Never lose an attempt over a bad timestamp: show what we have, sort it last.
            label = str(raw_ts).strip() if raw_ts else "Unknown time"
            sort_key = float("-inf") if NEWEST_FIRST else float("inf")
            log.append(f"row {i} ({value}): unparseable timestamp {raw_ts!r}")

        suffix = [str(row.get(f) or "").strip() for f in SUFFIX_FIELDS]
        suffix = [p for p in suffix if p]
        if suffix:
            label = f"{label} ({' · '.join(suffix)})"

        parsed.append((sort_key, label, value))

    parsed.sort(key=lambda t: t[0], reverse=NEWEST_FIRST)

    # Labels must be unique for the analyst even if two attempts share a second.
    seen = {}
    options = []
    for _, label, value in parsed:
        n = seen.get(label, 0) + 1
        seen[label] = n
        options.append({"label": label if n == 1 else f"{label} ({n})", "value": value})

    return {
        "options": options,
        "count": len(options),
        "default_value": options[0]["value"] if options else "",
        "log": "\n".join(log),
    }

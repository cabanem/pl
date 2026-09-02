from datetime import datetime, timezone

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
#   validation_results  list of objects, mapped from «Get records · RUN_ValidationResult › Records»
#            upload_id    string    required
#            report_path  string    optional  ← map the SAME column LNK-02 links from
#            created_at   date_time optional  ← used to pick the latest result per upload
#            Leave the whole field unmapped to disable the no-report flag.
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
#
# Decision: the no-report flag mirrors LNK-02 exactly — take the LATEST
# RUN_ValidationResult row per upload (by created_at) and test the report
# column on that row. If the flag says "no validation report", LNK-02 will
# return a nil report link for that upload, and vice versa. Keep the two in
# sync by mapping the same column into report_path that LNK-02 reads.
# -----------------------------------------------------------------------------

DISPLAY_TZ       = "UTC"                    # IANA name, e.g. "America/New_York". Falls back to UTC if unavailable.
LABEL_FORMAT     = "%Y-%m-%d %H:%M:%S %Z"   # 2026-08-14 09:32:11 UTC — unambiguous across regions, sorts visually
NEWEST_FIRST     = True
SUFFIX_FIELDS    = ()                       # e.g. ("submission_source", "status") → "… UTC (upload · validated)"
NO_REPORT_SUFFIX = "no validation report"   # appended as "… — no validation report"; set to "" to disable


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


def _has_report_by_upload(validation_rows):
    """upload_id → True/False: does the LATEST validation result carry a report?

    Rows are sorted oldest→newest and written into a dict, so the last write
    per upload_id wins — the same "latest by created_at" rule LNK-02 applies.
    Rows with an unparseable created_at sort oldest, so they only decide when
    no better-dated row exists.
    """
    keyed = []
    for row in validation_rows:
        row = row or {}
        uid = (row.get("upload_id") or "").strip()
        if not uid:
            continue
        dt = _parse_ts(row.get("created_at"))
        sort_key = dt.timestamp() if dt else float("-inf")
        keyed.append((sort_key, uid, bool(str(row.get("report_path") or "").strip())))
    keyed.sort(key=lambda t: t[0])
    return {uid: has_report for _, uid, has_report in keyed}


def main(input):
    log = []
    tz = _display_tz(log)
    rows = input.get("uploads") or []
    if not isinstance(rows, list):
        rows = [rows]

    validation_rows = input.get("validation_results")
    flag_enabled = bool(NO_REPORT_SUFFIX) and validation_rows is not None
    if NO_REPORT_SUFFIX and validation_rows is None:
        log.append("validation_results not provided; no-report flags skipped")
    if not isinstance(validation_rows, list):
        validation_rows = [validation_rows] if validation_rows else []
    has_report = _has_report_by_upload(validation_rows) if flag_enabled else {}

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

        if flag_enabled and not has_report.get(value, False):
            label = f"{label} — {NO_REPORT_SUFFIX}"

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

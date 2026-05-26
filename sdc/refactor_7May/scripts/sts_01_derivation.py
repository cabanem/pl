import re

# -----------------------------------------------------------------------------
# DERIVATION TABLE
# Source of truth: sdc-state-machines-v1.md (Display derivation section)
# To change wording: update the doc first, then mirror here.
# Templates use Python str.format placeholders ({name}); ensure every
# placeholder used in a template has a corresponding key in CONTEXT_KEYS below.
# Last synced: 2026-05-08
# -----------------------------------------------------------------------------
DERIVATION_TABLE = {
    # pending: no portal access, no display rendering. Empty strings on creation.
    ("pending", "initial_creation"): {
        "display_status": "",
        "message": "",
    },

    ("sent", "invitation_issued"): {
        "display_status": "Action needed: data template",
        "message": "Please complete the attached template and submit by {due_date}.",
    },

    ("supplier_action_required", "system_validation_failed"): {
        "display_status": "Action needed: corrections required",
        "message": (
            "Validation found {invalid_row_count} issue(s) in your submission "
            "on {validated_at}. Please review the error report and resubmit. "
            "{validation_report_link}"
        ),
    },

    # display_refresh reuses the system_validation_failed wording — same row,
    # different trigger (no-op transition under invariant 7).
    ("supplier_action_required", "display_refresh"): {
        "display_status": "Action needed: corrections required",
        "message": (
            "Validation found {invalid_row_count} issue(s) in your submission "
            "on {validated_at}. Please review the error report and resubmit. "
            "{validation_report_link}"
        ),
    },

    ("supplier_action_required", "analyst_rework"): {
        "display_status": "Action needed: changes requested by reviewer",
        "message": (
            "The reviewer requested changes on {reviewed_at}: {review_note_text}. "
            "Please review and resubmit."
        ),
    },

    ("pending_review", "system_validation_passed"): {
        "display_status": "Submitted \u2014 under review",
        "message": (
            "Your submission was received on {submitted_at} and is being reviewed. "
            "No further action is needed."
        ),
    },

    ("approved", "analyst_approve"): {
        "display_status": "Approved",
        "message": "Your submission was approved on {approved_at}. Thank you.",
    },

    ("cancelled", "analyst_cancel"): {
        "display_status": "Request closed",
        "message": "This request has been closed. Please contact {analyst_email} with questions.",
    },
}

# Every placeholder that may appear in any template above. Kept explicit so a
# missing key is a code bug (KeyError, surfaced loudly) rather than silent
# substitution failure. Empty-string defaults if the caller didn't supply.
CONTEXT_KEYS = (
    "due_date",
    "invalid_row_count",
    "validated_at",
    "validation_report_link",
    "review_note_text",
    "reviewed_at",
    "submitted_at",
    "approved_at",
    "analyst_email",
)

# Subset of CONTEXT_KEYS that arrive as date_time and must be rendered as a
# friendly, supplier-facing date instead of a raw ISO timestamp. Invariant:
# DATE_KEYS must be a subset of CONTEXT_KEYS (verified at authoring time).
DATE_KEYS = (
    "due_date",
    "validated_at",
    "reviewed_at",
    "submitted_at",
    "approved_at",
)

# Locale-independent month names (server locale is not guaranteed to be set,
# so we do not rely on strftime("%B")).
_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

# An ISO-8601 value always begins YYYY-MM-DD; that prefix is all we need for a
# date-only display, so we never parse time or timezone (avoids fromisoformat
# version quirks, the pre-3.11 'Z' rejection, and any tz-conversion surprises).
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def _format_date(value):
    """Render a date_time/date value as 'Month D, YYYY' (e.g. 'June 2, 2026').

    Accepts ISO-8601 strings (with or without time/offset), date/datetime
    objects, or already-rendered text. On anything it cannot parse, returns
    the value unchanged so a message degrades gracefully rather than raising.
    """
    if value is None or value == "":
        return ""

    # date or datetime object (defensive — Workato usually passes ISO strings).
    if hasattr(value, "year") and hasattr(value, "month") and hasattr(value, "day"):
        return "{0} {1}, {2}".format(_MONTHS[value.month - 1], value.day, value.year)

    match = _ISO_DATE.match(str(value).strip())
    if not match:
        return str(value)

    year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
    if not (1 <= month <= 12):
        return str(value)

    return "{0} {1}, {2}".format(_MONTHS[month - 1], day, year)


def main(input):
    target = (input.get("target_state") or "").strip()
    trigger = (input.get("trigger_context") or "").strip()

    key = (target, trigger)

    if key not in DERIVATION_TABLE:
        # The transition-validation step should have caught this, but be defensive.
        return {
            "supplier_display_status": "",
            "supplier_message": "",
            "lookup_failed": True,
            "error_message": "No derivation row for ({0}, {1})".format(target, trigger),
        }

    template = DERIVATION_TABLE[key]

    # Build full substitution context. Every CONTEXT_KEYS entry gets a value
    # (empty string if the caller didn't provide one). Templates only use
    # the placeholders they need; extras are ignored by str.format.
    context = {key_name: (input.get(key_name) or "") for key_name in CONTEXT_KEYS}

    # Render date_time fields as friendly dates (empty stays empty).
    for date_key in DATE_KEYS:
        context[date_key] = _format_date(context[date_key])

    # Coerce invalid_row_count to string for template substitution
    # (it may arrive as int from a prior step).
    if context["invalid_row_count"] != "":
        context["invalid_row_count"] = str(context["invalid_row_count"])

    return {
        "supplier_display_status": template["display_status"].format(**context),
        "supplier_message": template["message"].format(**context),
        "lookup_failed": False,
        "error_message": "",
    }

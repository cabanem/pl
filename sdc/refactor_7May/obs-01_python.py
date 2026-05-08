# SDC Data Collection — Stage 1 Python Steps (v1)
#
# Three Workato Python steps, one per section. Each section is fully self-contained
# (imports + constants + logic) so it can be copied directly into a "Run Python script"
# action without cross-section dependencies.
#
# Convention: each script reads from `input` (a dict of declared step inputs) and ends
# with a `result = {...}` assignment whose keys match the step's declared output fields.
# Adapt the I/O mechanism if your workspace uses a different Python action variant.
#
# Section 1: OBS-01 — Validate and compose EventLog row
# Section 2: STS-01 — Validate transition legality
# Section 3: STS-01 — Derive display fields (display_status + message)


# =============================================================================
# SECTION 1: OBS-01 — Validate and compose EventLog row
# =============================================================================
#
# Purpose: Validate caller-provided severity and phase against the canonical sets.
#          On valid input, compose the EventLog row payload for the next step
#          (Data Tables → Create row in EventLog) to write.
#          On invalid input, override severity/phase to flag the validation failure
#          and annotate details_json. The row still gets written — discipline is
#          enforced via auditing, not by breaking the caller.
#
# Inputs (declared on the Python step):
#   severity              (string, required)
#   source_recipe         (string, required)
#   step_number           (integer, required)
#   phase                 (string, required)
#   human_message         (string, required)
#   details_json          (string, optional)
#   analyst_email         (string, optional)
#   supplier_request_id   (string, optional)
#   error_type            (string, optional)
#   alert_sent            (boolean, optional)
#   resolved              (boolean, optional)
#   resolved_at           (datetime, optional)
#
# Outputs (declared on the Python step — mapped to EventLog columns by the next step):
#   event_id, timestamp, severity, source_recipe, step_number, phase, human_message,
#   details_json, analyst_email, supplier_request_id, error_type, alert_sent,
#   resolved, resolved_at

import uuid
import json
from datetime import datetime, timezone

# -----------------------------------------------------------------------------
# CANONICAL PHASE TAXONOMY
# Source of truth: sdc-event-phase-taxonomy-v1.md
# To add a phase: update the doc first, then mirror here. Do not add directly.
# Last synced: 2026-05-08
# -----------------------------------------------------------------------------
PHASE_TAXONOMY = {
    "config_parsed",
    "config_rejected",
    "config_validated",
    "engagement_closed",
    "incumbent_data_seeded",
    "invitation_sent",
    "invitation_triggered",
    "outreach_refreshed",
    "project_recorded",
    "provisioning_complete",
    "provisioning_triggered",
    "recipe_failed",
    "reminder_cycle_triggered",
    "reminder_sent",
    "reminder_tier_exhausted",
    "request_reassigned",
    "resubmission_template_generated",
    "state_transition",
    "submission_received",
    "suppliers_staged",
    "template_built",
    "upload_extracted",
    "user_added_to_request",
    "validation_errored",
    "validation_failed",
    "validation_passed",
    "version_deprecated",
    "version_published",
    "invalid_phase",  # reserved for self-reported validation failures
}

VALID_SEVERITIES = {"info", "warn", "error"}

# -----------------------------------------------------------------------------
# Read inputs
# -----------------------------------------------------------------------------
severity_in = (input.get("severity") or "").strip()
phase_in = (input.get("phase") or "").strip()
details_json_in = input.get("details_json") or ""

# -----------------------------------------------------------------------------
# Validate
# -----------------------------------------------------------------------------
validation_errors = []
if severity_in not in VALID_SEVERITIES:
    validation_errors.append({
        "field": "severity",
        "invalid_value": severity_in,
        "reason": "severity_not_in_set",
    })
if phase_in not in PHASE_TAXONOMY:
    validation_errors.append({
        "field": "phase",
        "invalid_value": phase_in,
        "reason": "phase_not_in_taxonomy",
    })

# -----------------------------------------------------------------------------
# Parse incoming details_json defensively
# -----------------------------------------------------------------------------
parsed_details = {}
if details_json_in:
    try:
        loaded = json.loads(details_json_in)
        if isinstance(loaded, dict):
            parsed_details = loaded
        else:
            # Caller passed an array or scalar — wrap so we can still annotate
            parsed_details = {"_original_details": loaded}
    except (ValueError, TypeError):
        parsed_details = {"_unparseable_details": str(details_json_in)}

# -----------------------------------------------------------------------------
# Compose output (apply validation overrides if needed)
# -----------------------------------------------------------------------------
out_severity = severity_in
out_phase = phase_in

if validation_errors:
    out_severity = "error"
    out_phase = "invalid_phase"
    parsed_details["_validation_error"] = validation_errors
    parsed_details["_original_severity"] = severity_in
    parsed_details["_original_phase"] = phase_in

# Re-serialize details_json (always a string for the EventLog write)
out_details_json = json.dumps(parsed_details) if parsed_details else ""

# -----------------------------------------------------------------------------
# Final output
# -----------------------------------------------------------------------------
result = {
    "event_id": str(uuid.uuid4()),
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "severity": out_severity,
    "source_recipe": input.get("source_recipe") or "",
    "step_number": int(input.get("step_number") or 0),
    "phase": out_phase,
    "human_message": input.get("human_message") or "",
    "details_json": out_details_json,
    "analyst_email": input.get("analyst_email") or "",
    "supplier_request_id": input.get("supplier_request_id") or "",
    "error_type": input.get("error_type") or "",
    "alert_sent": bool(input.get("alert_sent") or False),
    "resolved": bool(input.get("resolved") or False),
    "resolved_at": input.get("resolved_at") or "",
}


# =============================================================================
# SECTION 2: STS-01 — Validate transition legality
# =============================================================================
#
# Purpose: Check that (prior_state, target_state, trigger_context) is a legal
#          transition per the state-machine doc. Returns a structured pass/fail.
#          The recipe branches on `legal` — proceed on True, return error on False.
#
# Inputs (declared on the Python step):
#   prior_state      (string, required) — current SUP_SupplierRequest.status from prior search step
#   target_state     (string, required) — what the caller wants to transition to
#   trigger_context  (string, required) — what's driving the transition
#
# Outputs:
#   legal           (boolean) — True if the triple is in the legal-transition set
#   error_code      (string)  — empty when legal, "illegal_transition" otherwise
#   error_message   (string)  — empty when legal, descriptive otherwise

# -----------------------------------------------------------------------------
# LEGAL TRANSITION TABLE
# Source of truth: sdc-state-machines-v1.md (Transition graph + The no-op transition)
# To change: update the doc first, then mirror here.
# Last synced: 2026-05-08
#
# Each entry is (from_state, to_state, trigger_context).
# Empty string for from_state represents the "row does not yet exist" case
# (initial creation by the PRV chain).
# -----------------------------------------------------------------------------
LEGAL_TRANSITIONS = {
    # Initial creation — the only entry into pending
    ("", "pending", "initial_creation"),

    # pending → ...
    ("pending", "sent", "invitation_issued"),
    ("pending", "cancelled", "analyst_cancel"),

    # sent → ...
    ("sent", "pending_review", "system_validation_passed"),
    ("sent", "supplier_action_required", "system_validation_failed"),
    ("sent", "cancelled", "analyst_cancel"),

    # supplier_action_required → ...
    ("supplier_action_required", "pending_review", "system_validation_passed"),
    ("supplier_action_required", "cancelled", "analyst_cancel"),
    # No-op self-transition: display refresh on repeated validation failure
    # (state-machine invariant 7 — repeated failures don't churn state)
    ("supplier_action_required", "supplier_action_required", "display_refresh"),

    # pending_review → ...
    ("pending_review", "approved", "analyst_approve"),
    ("pending_review", "supplier_action_required", "analyst_rework"),
    ("pending_review", "cancelled", "analyst_cancel"),

    # approved and cancelled are terminal — no outbound transitions.
}

# -----------------------------------------------------------------------------
# Read inputs and look up
# -----------------------------------------------------------------------------
prior = (input.get("prior_state") or "").strip()
target = (input.get("target_state") or "").strip()
trigger = (input.get("trigger_context") or "").strip()

key = (prior, target, trigger)
is_legal = key in LEGAL_TRANSITIONS

if is_legal:
    result = {
        "legal": True,
        "error_code": "",
        "error_message": "",
    }
else:
    result = {
        "legal": False,
        "error_code": "illegal_transition",
        "error_message": "Transition not legal: ({0}, {1}, {2})".format(
            prior or "<no prior state>", target, trigger
        ),
    }


# =============================================================================
# SECTION 3: STS-01 — Derive display fields (supplier_display_status, supplier_message)
# =============================================================================
#
# Purpose: Look up the display strings for (target_state, trigger_context) in the
#          derivation table, perform placeholder substitution against caller-supplied
#          context, and return literal strings ready to write to SUP_SupplierRequest.
#          Snapshot semantics (state-machine invariant 6): templates are resolved
#          here, not at WFA render time.
#
# Inputs (declared on the Python step — provide all that may appear in any template):
#   target_state              (string, required)
#   trigger_context           (string, required)
#   due_date                  (string, optional)
#   invalid_row_count         (string or integer, optional)
#   validated_at              (string, optional)
#   validation_report_link    (string, optional)
#   review_note_text          (string, optional)
#   reviewed_at               (string, optional)
#   submitted_at              (string, optional)
#   approved_at               (string, optional)
#   analyst_email             (string, optional)
#
# Outputs:
#   supplier_display_status   (string)
#   supplier_message          (string)
#   lookup_failed             (boolean) — True if no derivation row matched
#   error_message             (string)  — empty unless lookup_failed

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

# -----------------------------------------------------------------------------
# Read inputs
# -----------------------------------------------------------------------------
target = (input.get("target_state") or "").strip()
trigger = (input.get("trigger_context") or "").strip()

# -----------------------------------------------------------------------------
# Lookup
# -----------------------------------------------------------------------------
key = (target, trigger)

if key not in DERIVATION_TABLE:
    # The transition-validation step should have caught this, but be defensive.
    result = {
        "supplier_display_status": "",
        "supplier_message": "",
        "lookup_failed": True,
        "error_message": "No derivation row for ({0}, {1})".format(target, trigger),
    }
else:
    template = DERIVATION_TABLE[key]

    # Build full substitution context. Every CONTEXT_KEYS entry gets a value
    # (empty string if the caller didn't provide one). Templates only use
    # the placeholders they need; extras are ignored by str.format.
    context = {key_name: (input.get(key_name) or "") for key_name in CONTEXT_KEYS}

    # Coerce invalid_row_count to string for template substitution
    # (it may arrive as int from a prior step).
    if context["invalid_row_count"] != "":
        context["invalid_row_count"] = str(context["invalid_row_count"])

    result = {
        "supplier_display_status": template["display_status"].format(**context),
        "supplier_message": template["message"].format(**context),
        "lookup_failed": False,
        "error_message": "",
    }

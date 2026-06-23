import uuid


# -----------------------------------------------------------------------------
# RESOLVE BUILD IDENTITY (recover-or-mint, change-detect) + COMPOSE ROWS
#
# Keyed on config_fingerprint (the GAS SHA-256 of the canonical serialized
# config), NOT correlation_id -- correlation_id churns per invocation, the
# fingerprint is stable for the same workbook content, so it survives GAS
# re-invocations. Three-way decision:
#
#   "resume"    -> a DRAFT row has this fingerprint: an incomplete prior attempt;
#                  rejoin it, reuse its ids. Write step UPDATEs/no-ops the version
#                  row and skips the Project insert + analyst invite.
#   "unchanged" -> the CURRENT PUBLISHED row has this fingerprint: the config is
#                  already live and identical. No-op; do NOT cut a new version.
#                  (Caller short-circuits and returns success.)
#   "new"       -> no fingerprint match: genuinely new/changed config; mint as
#                  before (E1 or E2 per is_initial + prior_version_number).
#
# Match scope: only DRAFT (for resume) and PUBLISHED (for unchanged). A match on
# a DEPRECATED row is ignored, so reverting a workbook to a deprecated version's
# content still produces a NEW version, not a no-op.
#
# Inputs (map in the recipe):
#   is_initial, correlation_id, existing_project_id, prior_version_number  (as before)
#   config_fingerprint : string  -- GAS-computed; the recovery / change key
#   version_records    : list    -- CFG_TemplateVersion rows for THIS project
#                                    (the feeding lookup scopes; Python matches).
#                                    Each item must expose the column labels:
#                                    config_fingerprint, status,
#                                    template_version_id, version_number, project_id
#
# correlation_id stays on the row + Project.external_request_id as the per-call
# trace id -- it is no longer the recovery key. Empty config_fingerprint degrades
# safely to "new" (provisioning still works; recovery just won't fire).
# -----------------------------------------------------------------------------


def main(input):
    corr = _s(input.get("correlation_id"))
    fp = _s(input.get("config_fingerprint"))
    is_initial = bool(input.get("is_initial"))

    if not corr:
        return _fail("correlation_id is required")

    versions = input.get("version_records") or []
    fp_matches = [v for v in versions if fp and _s(v.get("config_fingerprint")) == fp]

    # 1) DRAFT match -> rejoin the in-progress build.
    draft = next((v for v in fp_matches
                  if _s(v.get("status")).lower() == "draft"), None)
    if draft:
        tvid = _s(draft.get("template_version_id"))
        vnum = _i(draft.get("version_number"))
        return _ok("resume", _s(draft.get("project_id")), tvid, vnum, fp,
                   {}, _tv_row(tvid, vnum, corr, fp))

    # 2) CURRENT PUBLISHED match -> config already live and unchanged; no-op.
    live = next((v for v in fp_matches
                 if _s(v.get("status")).lower() == "published"), None)
    if live:
        return _ok("unchanged", _s(live.get("project_id")),
                   _s(live.get("template_version_id")),
                   _i(live.get("version_number")), fp,
                   {}, {})  # nothing to write; the row is already live

    # ===== NEW build: no fingerprint match. Mint as before. =====
    prior_version_number_raw = input.get("prior_version_number")
    if prior_version_number_raw is None or str(prior_version_number_raw).strip() == "":
        next_version_number = 1
    else:
        try:
            next_version_number = int(prior_version_number_raw) + 1
        except (TypeError, ValueError):
            next_version_number = 1

    # is_initial cross-check (authoritative -- step 5 redundant).
    if is_initial and next_version_number != 1:
        return _fail("is_initial=true but next_version_number={}".format(next_version_number))
    if (not is_initial) and next_version_number == 1:
        return _fail("is_initial=false but no prior version found")

    # Mint or reuse IDs.  E1: mint project_id.  E2: reuse existing.
    if is_initial:
        project_id = str(uuid.uuid4())
    else:
        project_id = _s(input.get("existing_project_id"))
        if not project_id:
            return _fail("E2 path but no existing_project_id provided")

    template_version_id = str(uuid.uuid4())

    project_row = {
        "project_id": project_id,
        "analyst_email": _s(input.get("analyst_email")),
        "customer_name": _s(input.get("client_name")),  # webhook -> manifest rename
        "target_vms": _s(input.get("target_vms")),
        "output_drive_folder_id": _s(input.get("output_drive_folder_id")),
        "reminder_days_1": _i(input.get("reminder_days_1")),
        "reminder_days_2": _i(input.get("reminder_days_2")),
        "reminder_days_3": _i(input.get("reminder_days_3")),
        "project_completion_status": "active",
        "external_request_id": corr,
    }

    return _ok("new", project_id, template_version_id, next_version_number, fp,
               project_row, _tv_row(template_version_id, next_version_number, corr, fp))


# --- HELPERS ----------------------------------------------------------------------------------------
def _paths(n):
    d = "/templates/v{}".format(n)
    return {
        "version_dir": d,
        "gas_export_path": "{}/gas_export.json".format(d),
        "master_template_path": "{}/master.xlsx".format(d),
        "parsed_config_path": "{}/parsed_config.json".format(d),
        "canonical_model_path": "{}/canonical_model.json".format(d),
    }


def _tv_row(template_version_id, version_number, corr, fp):
    p = _paths(version_number)
    return {
        "template_version_id": template_version_id,
        "version_number": version_number,
        "correlation_id": corr,            # per-call trace id (NOT the recovery key)
        "config_fingerprint": fp,          # recovery / change-detection key
        "version_label": "",               # write-once at publish (PRV-04)
        "status": "draft",
        "master_template_path": p["master_template_path"],
        "gas_export_path": p["gas_export_path"],
        "parsed_config_path": p["parsed_config_path"],
        "canonical_model_path": p["canonical_model_path"],
        "validation_summary": "",
    }


def _ok(mode, project_id, template_version_id, version_number, fp, project_row, tv_row):
    p = _paths(version_number)
    return {
        "ok": True,
        "mode": mode,                      # new | resume | unchanged | error
        "error": "",
        "project_id": project_id,
        "template_version_id": template_version_id,
        "version_number": version_number,
        "config_fingerprint": fp,
        "is_e1": version_number == 1,      # derived from data; correct on resume too
        "version_dir": p["version_dir"],
        "gas_export_path": p["gas_export_path"],
        "master_template_path": p["master_template_path"],
        "parsed_config_path": p["parsed_config_path"],
        "canonical_model_path": p["canonical_model_path"],
        "project_row": project_row,
        "template_version_row": tv_row,
    }


def _fail(reason):
    return {
        "ok": False, "mode": "error", "error": reason,
        "project_id": "", "template_version_id": "", "version_number": 0,
        "config_fingerprint": "", "is_e1": False, "version_dir": "",
        "gas_export_path": "", "master_template_path": "",
        "parsed_config_path": "", "canonical_model_path": "",
        "project_row": {}, "template_version_row": {},
    }


def _s(value):
    if value is None:
        return ""
    return str(value).strip()


def _i(value):
    if value is None:
        return 0
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return 0

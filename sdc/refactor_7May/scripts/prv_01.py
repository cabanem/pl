import uuid


# -----------------------------------------------------------------------------
# RESOLVE BUILD IDENTITY (recover-or-mint, change-detect) + COMPOSE ROWS
#
# Keyed on config_fingerprint (GAS SHA-256 of canonical config), NOT
# correlation_id. Three-way:
#   "resume"    -> a DRAFT row has this fingerprint: incomplete prior attempt.
#   "unchanged" -> the CURRENT PUBLISHED row has this fingerprint: config is
#                  already live; no-op, no new version.
#   "new"       -> no match: mint (E1 or E2 per is_initial + data).
# Only DRAFT and PUBLISHED are matched; a DEPRECATED match is ignored, so
# reverting to a deprecated version's content produces a NEW version.
#
# Inputs (must match the recipe's input schema):
#   is_initial          : boolean
#   correlation_id      : string   (per-call trace id; required; NOT the recovery key)
#   config_fingerprint  : string   (the recovery / change key)
#   existing_project_id : string   (first Project record's project_id; "" if none)
#   version_records     : array    (CFG_TemplateVersion rows for THIS workspace)
#       each row must expose: config_fingerprint, status, template_version_id,
#       version_number   (project_id is NOT required -- see resume note below)
#
# version_number is derived from the PUBLISHED rows in version_records (no
# separate prior_version_number input). project_id on resume/unchanged comes
# from existing_project_id, not the version row.
# -----------------------------------------------------------------------------


def main(input):
    corr = _s(input.get("correlation_id"))
    fp = _s(input.get("config_fingerprint"))
    is_initial = bool(input.get("is_initial"))

    if not corr:
        return _fail("correlation_id is required")

    versions = input.get("version_records") or []
    fp_matches = [v for v in versions if fp and _s(v.get("config_fingerprint")) == fp]

    # 1) DRAFT match -> resume. project_id comes from the Project lookup
    #    (existing_project_id): the Project insert precedes the version write, so a
    #    recoverable draft implies the Project already exists. CFG_TemplateVersion
    #    carries no project_id column.
    draft = next((v for v in fp_matches
                  if _s(v.get("status")).lower() == "draft"), None)
    if draft:
        tvid = _s(draft.get("template_version_id"))
        vnum = _i(draft.get("version_number"))
        return _ok("resume", _s(input.get("existing_project_id")), tvid, vnum, fp,
                   {}, _tv_row(tvid, vnum, corr, fp))

    # 2) CURRENT PUBLISHED match -> config already live, unchanged; no-op.
    live = next((v for v in fp_matches
                 if _s(v.get("status")).lower() == "published"), None)
    if live:
        return _ok("unchanged", _s(input.get("existing_project_id")),
                   _s(live.get("template_version_id")),
                   _i(live.get("version_number")), fp, {}, {})

    # ===== NEW build: no fingerprint match. =====
    # Next version number from PUBLISHED predecessors in version_records
    # (drafts don't claim numbers). Replaces the prior_version_number input.
    published_nums = [_i(v.get("version_number")) for v in versions
                      if _s(v.get("status")).lower() == "published"]
    next_version_number = (max(published_nums) if published_nums else 0) + 1

    # is_initial cross-check (authoritative -- step 5 redundant).
    if is_initial and next_version_number != 1:
        return _fail("is_initial=true but next_version_number={}".format(next_version_number))
    if (not is_initial) and next_version_number == 1:
        return _fail("is_initial=false but no prior published version found")

    # Mint or reuse IDs.  E1: mint project_id.  E2: reuse existing.
    if is_initial:
        project_id = str(uuid.uuid4())
    else:
        project_id = _s(input.get("existing_project_id"))
        if not project_id:
            return _fail("E2 path but no existing_project_id provided")

    template_version_id = str(uuid.uuid4())

    # project_row -- composed from 7 trigger fields that are NOT in the current
    # input schema. If the Project add_record consumes this project_row, MAP THEM
    # (else the Project row is written blank). If add_record maps the trigger
    # datapills directly, this output is unused -- drop the composition.
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

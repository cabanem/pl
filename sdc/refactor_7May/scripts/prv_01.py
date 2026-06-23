import uuid


def _str(v):
    return str(v).strip() if v is not None else ""


def _bool(v):
    if isinstance(v, bool):
        return v
    return _str(v).lower() in ("true", "1", "yes")


def _int(v):
    try:
        return int(_str(v))
    except (ValueError, TypeError):
        return 0


def main(input):
    """
    Resolve the build identity for PRV-01 (recover-or-mint) and validate is_initial.

    Replaces the early "validate is_initial (input param)" step. It MUST run AFTER
    both the Project lookup and the CFG_TemplateVersion lookup, because recovery
    needs to see existing rows. Move the CFG_TemplateVersion lookup ahead of this
    step and have it return ALL version rows for the workspace (not pre-filtered);
    this function does the filtering.

    Expected input keys (map these in the recipe):
      is_initial          : boolean  (trigger)
      correlation_id      : string   (trigger) -- the build's idempotency key
      existing_project_id : string   (first Project record's project_id; "" if none)
      version_records     : list     (ALL CFG_TemplateVersion rows; Python filters)

    Each item in version_records must expose these keys. The key names below must
    match your CFG_TemplateVersion COLUMN LABELS as they surface in the py_eval
    input mapping -- adjust the literals if your labels differ:
      correlation_id, status, template_version_id, version_number, project_id

    NOTE: correlation_id is a NEW column on CFG_TemplateVersion (see S2). It is what
    makes a draft findable on retry. The downstream compose/write step must stamp
    output["correlation_id"] onto the row it writes when mode == "new".

    Returns:
      ok                  : boolean
      mode                : "new" | "resume" | "done" | "error"
      template_version_id : string
      project_id          : string
      version_number      : integer
      is_e1               : boolean
      is_e2               : boolean
      correlation_id      : string  (echo; stamp on the new row when mode == "new")
      error               : string
    """
    corr = _str(input.get("correlation_id"))
    is_initial = _bool(input.get("is_initial"))
    versions = input.get("version_records") or []

    def fail(msg, is_e2=False):
        return {"ok": False, "mode": "error", "template_version_id": "",
                "project_id": "", "version_number": 0,
                "is_e1": False, "is_e2": is_e2,
                "correlation_id": corr, "error": msg}

    if not corr:
        return fail("correlation_id is required")

    # 1) RECOVER -- has this exact build (correlation_id) already produced a row?
    mine = [v for v in versions if _str(v.get("correlation_id")) == corr]
    if mine:
        row = mine[0]
        status = _str(row.get("status")).lower()
        vnum = _int(row.get("version_number"))
        # "published" => the build already finished; caller should no-op/return ok.
        # anything else (draft) => an incomplete attempt; rejoin it, reuse its ids.
        return {"ok": True,
                "mode": "done" if status == "published" else "resume",
                "template_version_id": _str(row.get("template_version_id")),
                "project_id": _str(row.get("project_id")),
                "version_number": vnum,
                "is_e1": vnum == 1, "is_e2": vnum > 1,
                "correlation_id": corr, "error": ""}

    # 2) NEW -- classify E1/E2 from PUBLISHED predecessors, cross-check is_initial.
    #    Drafts (incl. other abandoned ones) do NOT set the version floor.
    published_nums = [_int(v.get("version_number")) for v in versions
                      if _str(v.get("status")).lower() == "published"]
    prior_max = max(published_nums) if published_nums else 0
    next_vnum = prior_max + 1

    if is_initial and next_vnum != 1:
        return fail("is_initial=true but a prior published version exists "
                    "(next_version_number=%d)" % next_vnum)
    if not is_initial and prior_max == 0:
        return fail("is_initial=false but no prior published version found")

    is_e1 = next_vnum == 1

    if is_e1:
        project_id = str(uuid.uuid4())
    else:
        project_id = _str(input.get("existing_project_id"))
        if not project_id:
            return fail("E2 path but no existing project_id to reuse", is_e2=True)

    return {"ok": True, "mode": "new",
            "template_version_id": str(uuid.uuid4()),
            "project_id": project_id,
            "version_number": next_vnum,
            "is_e1": is_e1, "is_e2": not is_e1,
            "correlation_id": corr, "error": ""}



import uuid


# -----------------------------------------------------------------------------
# RESOLVE BUILD IDENTITY (recover-or-mint) + COMPOSE PROJECT / CFG_TEMPLATEVERSION
#
# This is the original compose step with recover-or-mint folded onto the front.
# It now classifies the run into one of three modes BEFORE minting:
#
#   "done"   -> a row for this correlation_id is already published; the build
#               finished on a prior attempt. Caller should short-circuit and
#               return success WITHOUT re-running downstream steps.
#   "resume" -> a draft row for this correlation_id exists; an earlier attempt
#               got at least this far. Reuse its ids; the write step must
#               UPDATE/no-op the version row rather than insert, and must skip
#               the Project insert + analyst invite.
#   "new"    -> no row for this correlation_id; mint as before. The is_initial
#               cross-check (formerly duplicated in step 5) lives here now.
#
# Recovery keys on CFG_TemplateVersion.correlation_id -- a NEW column, mirroring
# Project.external_request_id. It must live on the VERSION row, not the Project:
# on E2 the Project is reused, so its external_request_id holds the FIRST build's
# correlation_id, not the re-version's.
#
# Inputs (map in the recipe):
#   is_initial, correlation_id, existing_project_id, prior_version_number  (as today)
#   version_records  -- NEW: ALL CFG_TemplateVersion rows (broaden the lookup);
#                       Python filters. Each item must expose the column labels
#                       correlation_id, status, template_version_id,
#                       version_number, project_id.
# -----------------------------------------------------------------------------


def main(input):
    corr = _s(input.get("correlation_id"))
    is_initial = bool(input.get("is_initial"))

    if not corr:
        return _fail("correlation_id is required")

    # ===== RECOVER: has this build (correlation_id) already written a row? =====
    versions = input.get("version_records") or []
    mine = [v for v in versions if _s(v.get("correlation_id")) == corr]
    if mine:
        row = mine[0]
        status = _s(row.get("status")).lower()
        tvid = _s(row.get("template_version_id"))
        vnum = _i(row.get("version_number"))
        pid = _s(row.get("project_id"))
        mode = "done" if status == "published" else "resume"
        # No project_row on recovery: E1's project already exists, E2 reuses it.
        return _ok(mode, pid, tvid, vnum, {}, _tv_row(tvid, vnum, corr))
    # ===== end recovery; below is the original NEW-build path, intact =====

    # Compute next version_number.  E1: 1   E2: MAX(prior) + 1
    prior_version_number_raw = input.get("prior_version_number")
    if prior_version_number_raw is None or str(prior_version_number_raw).strip() == "":
        next_version_number = 1
    else:
        try:
            next_version_number = int(prior_version_number_raw) + 1
        except (TypeError, ValueError):
            next_version_number = 1

    # is_initial cross-check (now authoritative -- step 5 becomes redundant).
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

    return _ok("new", project_id, template_version_id, next_version_number,
               project_row, _tv_row(template_version_id, next_version_number, corr))


# ----- helpers -----

def _paths(n):
    d = "/templates/v{}".format(n)
    return {
        "version_dir": d,
        "gas_export_path": "{}/gas_export.json".format(d),
        "master_template_path": "{}/master.xlsx".format(d),
        "parsed_config_path": "{}/parsed_config.json".format(d),
        "canonical_model_path": "{}/canonical_model.json".format(d),
    }


def _tv_row(template_version_id, version_number, corr):
    p = _paths(version_number)
    return {
        "template_version_id": template_version_id,
        "version_number": version_number,
        "correlation_id": corr,          # NEW recovery key
        "version_label": "",             # write-once at publish (PRV-04)
        "status": "draft",
        "master_template_path": p["master_template_path"],
        "gas_export_path": p["gas_export_path"],
        "parsed_config_path": p["parsed_config_path"],
        "canonical_model_path": p["canonical_model_path"],
        "validation_summary": "",
    }


def _ok(mode, project_id, template_version_id, version_number, project_row, tv_row):
    p = _paths(version_number)
    return {
        "ok": True,
        "mode": mode,                    # new | resume | done
        "error": "",
        "project_id": project_id,
        "template_version_id": template_version_id,
        "version_number": version_number,
        "is_e1": version_number == 1,    # derived from data; correct on resume too
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
        "is_e1": False, "version_dir": "",
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

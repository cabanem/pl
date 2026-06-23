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

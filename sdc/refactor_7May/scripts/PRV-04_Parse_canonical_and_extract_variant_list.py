import json


# -----------------------------------------------------------------------------
# Parse canonical model and extract variant list
#
# Reads the canonical model JSON from FileStorage (passed in as
# canonical_model_json), parses it, and returns the cfg_variants array as
# a flat list for the downstream variant-rendering loop to iterate over.
#
# Each variant carries the version number from _meta so the rendering loop
# can construct deterministic template paths without re-reading _meta on
# every iteration.
# -----------------------------------------------------------------------------


def main(input):
    canonical_model_json = input.get("canonical_model_json") or ""
    if not canonical_model_json:
        return _fail("canonical_model_json is empty")

    try:
        model = json.loads(canonical_model_json)
    except (ValueError, TypeError) as e:
        return _fail("canonical model JSON parse error: {}".format(str(e)))

    variants = model.get("cfg_variants") or []
    if not variants:
        return _fail("canonical model has no variants")

    meta = model.get("_meta") or {}
    version_number = meta.get("version_number") or 0
    template_version_id = meta.get("template_version_id") or ""

    # Enrich each variant with version context. The rendering loop uses
    # these to construct the FileStorage path for the variant's XLSX:
    #   /templates/v{version_number}/variants/{variant_id}.xlsx
    enriched = []
    for v in variants:
        enriched.append({
            "variant_id": v.get("variant_id") or "",
            "variant_name": v.get("variant_name") or "",
            "description": v.get("description") or "",
            "is_synthesized": bool(v.get("is_synthesized")),
            "version_number": version_number,
            "template_version_id": template_version_id,
        })

    return {
        "ok": True,
        "error": "",
        "variants": enriched,
        "variant_count": len(enriched),
    }


def _fail(reason):
    return {
        "ok": False,
        "error": reason,
        "variants": [],
        "variant_count": 0,
    }

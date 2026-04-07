import json

def main(params):
    fields = json.loads(params["fields_json"])
    lookups = json.loads(params["lookups_json"])
    variants = json.loads(params["variants_json"])
    variant_fields = json.loads(params["variant_fields_json"])
    client_name = params["client_name"]

    vf_map = {}
    for vf in variant_fields:
        vid = vf.get("variant_id")
        fid = vf.get("field_id")
        if vid and fid:
            vf_map.setdefault(vid, []).append(fid)

    lookups_str = json.dumps(lookups)
    payloads = []

    if not variants:
        payloads.append({
            "variant_name": "",
            "fields": json.dumps(fields),
            "lookups": lookups_str,
            "client_name": client_name,
        })
    else:
        for v in variants:
            vid = v.get("variant_id")
            vname = v.get("variant_name", "")
            visible_fids = set(vf_map.get(vid, []))
            visible_fields = [f for f in fields if f.get("field_id") in visible_fids]
            payloads.append({
                "variant_name": vname,
                "fields": json.dumps(visible_fields),
                "lookups": lookups_str,
                "client_name": client_name,
            })

    return {
        "payloads": payloads,
        "payload_count": len(payloads),
    }

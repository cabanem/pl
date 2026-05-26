#!/usr/bin/env python3
"""
Local TPL-02 test harness — generate SDC XLSX templates without provisioning.

The builder (tpl02_builder.py) is TPL-02's py_eval code, extracted VERBATIM.
This wrapper feeds it hand-written canonical models (sample_models.py) and
writes real .xlsx files you can open in Excel.

Usage:
    python build.py                      # build every sample model (base + variants)
    python build.py realistic            # build one model, base case
    python build.py realistic v_short    # build one model, a specific variant_id
    python build.py --list               # list available sample models

Add your own configs by editing sample_models.py (same shape CAN-01 emits).
Requires: pip install openpyxl
"""
import json, base64, sys, os
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "output")

def _load_builder():
    spec = importlib.util.spec_from_file_location("tpl02", os.path.join(HERE, "tpl02_builder.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

def build_one(builder, models, key, variant_id="", customer="AcmeCorp", variant_name=""):
    if key not in models:
        print(f"  unknown model '{key}' (try --list)"); return
    # mirror TPL-01: variant_name defaults to the variant_id label or 'base'
    vname = variant_name or (variant_id if variant_id else "")
    payload = {
        "canonical_model_json": json.dumps(models[key]),
        "variant_id": variant_id,
        "customer_name": customer,
        "variant_name": vname,
    }
    label = f"{key}/{variant_id or 'base'}"
    try:
        out = builder.main(payload)
    except Exception as e:
        # This is what TPL-01's catch block would turn into an OBS-01 recipe_failed.
        print(f"  [{label}] RAISED {type(e).__name__}: {e}")
        return
    if out.get("file_content"):
        os.makedirs(OUT, exist_ok=True)
        path = os.path.join(OUT, f"{key}_{variant_id or 'base'}.xlsx")
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(out["file_content"]))
        md = out["metadata"]
        print(f"  [{label}] {out['status']} -> {path}  ({md['byte_size']} B, {md['field_count']} fields)")
    else:
        print(f"  [{label}] {out['status']}  error={out.get('error')}")

def main(argv):
    builder = _load_builder()
    from sample_models import MODELS
    if "--list" in argv:
        print("Available sample models:", ", ".join(MODELS)); return
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print("Building all sample models:")
        for key in MODELS:
            build_one(builder, MODELS, key)
            # also build any variants declared for that model
            vids = sorted({vf["variant_id"] for vf in MODELS[key].get("cfg_variant_fields", [])})
            for vid in vids:
                build_one(builder, MODELS, key, variant_id=vid)
    else:
        key = args[0]
        vid = args[1] if len(args) > 1 else ""
        build_one(builder, MODELS, key, variant_id=vid)
    print(f"\nOpen the .xlsx files in {OUT} with Excel to inspect.")

if __name__ == "__main__":
    main(sys.argv[1:])

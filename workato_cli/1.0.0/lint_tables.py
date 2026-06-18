PYTHONPATH=sdc_recipe_model.py python - <<'PY'
import json
from workato_client import WorkatoClient, WorkatoConfig, load_dotenv
load_dotenv()
client = WorkatoClient(config=WorkatoConfig.from_env())

tbl = next(t for t in client.list_data_tables() if t.get("name") == "SUP_SupplierRequest")
wanted = {"84d52734", "c060f6fc", "e1257e22", "d4b0feff"}   # status, display_status, message, entered_at
for col in tbl.get("schema", []):
    fid = str(col.get("field_id", ""))
    if any(fid.startswith(w) for w in wanted):
        print(json.dumps(col, indent=2))
PY

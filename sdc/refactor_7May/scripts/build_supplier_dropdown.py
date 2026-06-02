def main(input):
    """
    Build dropdown options for WFA-08, including suppliers that have no request yet.

    Workato 'Python by Workato' action contract:
      - `input` is a dict of the input fields you declare on the action.
      - Return a dict whose keys match the output fields you declare.

    Declare two LIST inputs and map the get_records datapills into them:

      requests  (from SUP_SupplierRequest get_records -> records)
        - supplier_request_id   <- a047ca07... column
        - supplier_id           <- e9930c43... column

      suppliers (from SUP_Supplier get_records -> records)   # fetch ALL suppliers
        - supplier_id           <- 5ad8308b... column
        - supplier_name         <- 35224003... column
        - status                <- 2992c4e8... column   (optional; only if you filter)

    Declare output:
      options (list of: label [string], value [string], has_request [boolean])
      count   (integer)
    """
    requests = input.get('requests') or []
    suppliers = input.get('suppliers') or []

    # supplier_id -> supplier_name, used to label the request-backed entries.
    name_by_id = {}
    for s in suppliers:
        sid = (s.get('supplier_id') or '').strip()
        if sid:
            name_by_id[sid] = s.get('supplier_name') or ''

    options = []
    requested_ids = set()

    # 1) One option per existing request. This preserves today's behavior:
    #    a supplier with multiple requests still produces multiple entries,
    #    each carrying its own request id as the value.
    for r in requests:
        rid = (r.get('supplier_request_id') or '').strip()
        sid = (r.get('supplier_id') or '').strip()
        if not rid:
            continue
        requested_ids.add(sid)
        options.append({
            'label': name_by_id.get(sid) or sid,
            'value': rid,
            'has_request': True,
        })

    # 2) One option per supplier that has NO request yet (the new set).
    for s in suppliers:
        sid = (s.get('supplier_id') or '').strip()
        if not sid or sid in requested_ids:
            continue
        # --- DECISION POINT -------------------------------------------------
        # No request id exists for these. Default: hand back the supplier_id so
        # the consumer can branch on it. If your downstream can't distinguish a
        # request id from a supplier id, prefix instead, e.g.  value = 'sup:' + sid
        # (and prefix the request-backed branch above with 'req:' + rid).
        value = sid
        # --------------------------------------------------------------------
        options.append({
            'label': s.get('supplier_name') or sid,
            'value': value,
            'has_request': False,
        })

    # Tidy, deterministic ordering for the dropdown.
    options.sort(key=lambda o: (o['label'] or '').lower())

    return {'options': options, 'count': len(options)}

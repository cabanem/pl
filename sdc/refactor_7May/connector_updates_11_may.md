import json


def main(input):
    prior_uploads = input['prior_uploads']
    scoped_field_ids = input['scoped_field_ids']
    scoped_rules = input['scoped_rules']
    field_name_by_id_list = input['field_name_by_id']
    current_supplier_id = input['current_supplier_id']

    # Reconstruct dicts from the array-of-pairs shape
    field_name_by_id = {
        item['field_id']: item['field_name']
        for item in field_name_by_id_list
    }
    field_id_by_name = {v: k for k, v in field_name_by_id.items()}

    # Per-field scope: engagement wins over supplier when a field has both
    field_scope = {}
    for rule in scoped_rules:
        fid = rule.get('field_id')
        scope = rule.get('scope')
        if not fid:
            continue
        if fid not in field_scope:
            field_scope[fid] = scope
        elif field_scope[fid] == 'supplier' and scope == 'engagement':
            field_scope[fid] = 'engagement'

    # Collect values per field_id
    values_by_field = {fid: [] for fid in scoped_field_ids}

    for upload in prior_uploads:
        payload_json = upload.get('valid_payload_json', '')
        if not payload_json:
            continue

        try:
            payload = json.loads(payload_json)
        except (ValueError, TypeError):
            continue

        upload_supplier_id = upload.get('supplier_id')
        submission_id = upload.get('submission_id')

        for row_idx, row in enumerate(payload):
            for field_name, value in row.items():
                if field_name == '_row_number':
                    continue
                fid = field_id_by_name.get(field_name)
                if fid not in field_scope:
                    continue

                scope = field_scope[fid]
                if scope == 'supplier' and upload_supplier_id != current_supplier_id:
                    continue

                values_by_field[fid].append({
                    'value': str(value) if value is not None else '',
                    'row_number': row.get('_row_number', row_idx + 1),
                    'submission_id': submission_id,
                })

    # Return as array of {field_id, values} pairs
    prior_values = [
        {'field_id': fid, 'values': vals}
        for fid, vals in values_by_field.items()
    ]

    return {'prior_values': prior_values}

import re

def main(params):
    errors = []

    # 1. correlation_id: required, UUID format
    cid = (params.get('correlation_id') or '').strip()
    if not cid:
        errors.append('correlation_id is missing')
    elif not re.match(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        cid, re.IGNORECASE
    ):
        errors.append('correlation_id is not a valid UUID')

    # 2. client_name: required, non-empty
    if not (params.get('client_name') or '').strip():
        errors.append('client_name is missing')

    # 3. analyst_email: required, basic email format
    email = (params.get('analyst_email') or '').strip()
    if not email:
        errors.append('analyst_email is missing')
    elif not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
        errors.append('analyst_email is not a valid email')

    # 4. config_file_id: required, non-empty
    if not (params.get('config_file_id') or '').strip():
        errors.append('config_file_id is missing')

    # 5. timestamp: required, ISO-8601
    ts = (params.get('timestamp') or '').strip()
    if not ts:
        errors.append('timestamp is missing')
    elif not re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', ts):
        errors.append('timestamp is not ISO-8601 format')

    return {
        'is_valid': len(errors) == 0,
        'error_details': '; '.join(errors) if errors else ''
    }

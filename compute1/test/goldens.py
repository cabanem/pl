"""
Golden generator: runs the ORIGINAL Python steps (from the manifest dump) on the shared fixtures and writes
goldens.json in the connector's vocabulary and output shape.

Two kinds of translation happen here, both deliberate and both listed in WAVE1_GUIDE.md:
  adapters     rename fixture keys (connector vocabulary) to the column dialect each Python step expects
  corrections  reshape the Python OUTPUT into the connector's contract (envelope; INV-04's plan nested; REQ-01's
               user row fields; UTL-06's renamed outputs). A correction never changes a decision, only a shape —
               except where the design record documents a bug fix.

Usage: python3 goldens.py <python_steps_dir> <fixtures.json> <goldens.json>
"""
import json, sys, types, glob, os

STEP_FILES = {
    'plan_primary_user_change': '2286522_INV-04',
    'plan_task_ensure':         '2202944_INV-02',
    'classify_requests_by_task': '2203181_UTL-06',
    'compute_reminders':        '2148602_REM-02',
    'build_request_rows':       '2115623_REQ-01',
    'plan_user_migration':      '2286232_MIG-01',
}

def load_step(dirname, prefix):
    path = glob.glob(os.path.join(dirname, prefix + '*.py'))[0]
    mod = types.ModuleType(prefix)
    exec(open(path).read(), mod.__dict__)
    return mod

def rename(row, mapping):
    out = {}
    for k, v in (row or {}).items():
        out[mapping.get(k, k)] = v
    return out

# ---------------------------------------------------------------- adapters (connector input -> python input)
def adapt_inv04(i):
    return dict(i)

def adapt_inv02(i):
    o = dict(i)
    o['users'] = [rename(u, {'status': 'user_status'}) for u in (i.get('users') or [])]
    return o

def adapt_utl06(i):
    o = dict(i)
    o['suppliers'] = [rename(s, {'supplier_id': 'sup_supplier_id'}) for s in (i.get('suppliers') or [])]
    o['supplier_users'] = [rename(u, {'supplier_id': 'user_supplier_id', 'status': 'user_status'}) for u in (i.get('supplier_users') or [])]
    return o

def adapt_rem02(i):
    o = {'current_time': i.get('current_time'), 'proj_reminder_cadence': i.get('reminder_cadence_days'), 'proj_max_reminders': i.get('max_reminders')}
    o['requests'] = [rename(r, {'supplier_id': 'req_supplier_id', 'supplier_request_id': 'req_id', 'supplier_name': 'req_supplier_name', 'status': 'req_status',
                                'submission_attempt': 'req_submission_attempt', 'reminder_count': 'req_reminder_count',
                                'current_state_entered_at': 'req_state_entered_time', 'last_reminder_sent_at': 'req_last_reminder_sent',
                                'reminders_enabled': 'req_reminders_enabled'}) for r in (i.get('requests') or [])]
    o['supplier_users'] = [rename(u, {'supplier_id': 'user_supplier_id', 'supplier_user_id': 'user_id', 'contact_name': 'user_contact_name',
                                      'primary': 'user_primary', 'status': 'user_status', 'kick_off_email_sent_time': 'user_kickoff_sent_at'})
                           for u in (i.get('supplier_users') or [])]
    return o

def adapt_req01(i):
    return dict(i)

def adapt_mig01(i):
    o = dict(i)
    o['variants'] = [rename(v, {'template_version_id': 'version_id'}) for v in (i.get('variants') or [])]
    return o

ADAPTERS = {'plan_primary_user_change': adapt_inv04, 'plan_task_ensure': adapt_inv02, 'classify_requests_by_task': adapt_utl06,
            'compute_reminders': adapt_rem02, 'build_request_rows': adapt_req01, 'plan_user_migration': adapt_mig01}

# ---------------------------------------------------------------- corrections (python output -> connector contract)
ENV_OK = {'ok': True, 'error': {'code': '', 'message': ''}}
def env_fail(code, message):
    return {'ok': False, 'error': {'code': code, 'message': message}}

BLANK_PLAN_INV04 = {'mode': '', 'disposition': '', 'reassign': False, 'task_action': '', 'skip_reason': '', 'target_record_id': '',
                    'supplier_user_id': '', 'demote_rows': [], 'demote_count': 0, 'drift_detected': False, 'drift_note': '',
                    'old_primary_email': '', 'new_primary_email': '', 'contact_name': '', 'new_user_supplier_user_id': '', 'new_user_created_at': ''}

def correct_inv04(py):
    if not py.get('ok'):
        return dict(env_fail(py.get('error_type', ''), py.get('error_message', '')), noop=False, plan=dict(BLANK_PLAN_INV04))
    if py.get('noop'):
        return dict(ENV_OK, noop=True, plan=dict(BLANK_PLAN_INV04, disposition=py.get('disposition', '')))
    plan = {k: v for k, v in py.items() if k not in ('ok', 'noop')}   # the flat keys ARE the plan (the INV-04 defect)
    return dict(ENV_OK, noop=False, plan=plan)

BLANK_PLAN_INV02 = {'assignee_email': '', 'contact_name': '', 'workflow_app_stage': '', 'is_reassignment': False,
                    'currently_assigned_user_email': '', 'task_name': '', 'days_to_complete_task': 0, 'send_email': False}

def correct_inv02(py):
    if not py.get('ok'):
        return dict(env_fail(py.get('error_type', ''), py.get('reason', '')), mode='refuse', reason=py.get('reason', ''),
                    drift_detected=False, drift_note='', plan=dict(BLANK_PLAN_INV02))
    if py.get('mode') == 'noop':
        return dict(ENV_OK, mode='noop', reason=py.get('reason', ''), drift_detected=False, drift_note='', plan=dict(BLANK_PLAN_INV02))
    return dict(ENV_OK, mode=py['mode'], reason=py['reason'], drift_detected=py['drift_detected'], drift_note=py['drift_note'], plan=py['plan'])

def correct_utl06(py):
    log = py.get('log', '').replace("'sup_supplier_id'", "'supplier_id'").replace("'user_supplier_id'", "'supplier_id'")
    return dict(ENV_OK, matched_count=py['expired_tasks_count'], counts=py['counts'], requests=py['expired_task_detail'], log=log)

def correct_rem02(py):
    return dict(ENV_OK, rows=py['rows'], pending_reminders=py['pending_reminders'], log=py['log'])

def correct_req01(py):
    if not py.get('ok'):
        msg = py.get('error', '')
        code = 'state_inconsistent' if 'template path' in msg else 'recipe_invariant'
        return dict(env_fail(code, msg), supplier_user_row={}, supplier_request_row={}, supplier_user_id='', supplier_request_id='', assignee_email='')
    row = rename(py['supplier_user_row'], {'assignee_email': 'user_email', 'assignee_contact_name': 'contact_name'})   # the REQ-01 drift fix
    return dict(ENV_OK, supplier_user_row=row, supplier_request_row=py['supplier_request_row'], supplier_user_id=py['supplier_user_id'],
                supplier_request_id=py['supplier_request_id'], assignee_email=py['assignee_email'])

def correct_mig01(py):
    if not py.get('ok'):
        msg = py.get('error', '')
        code = 'recipe_invariant' if 'is empty' in msg else 'state_inconsistent'
        return dict(env_fail(code, msg), to_migrate=[], held=[], flagged=[], migrate_count=0, held_count=0, flagged_count=0)
    return dict(ENV_OK, **{k: v for k, v in py.items() if k not in ('ok', 'error')})

CORRECTIONS = {'plan_primary_user_change': correct_inv04, 'plan_task_ensure': correct_inv02, 'classify_requests_by_task': correct_utl06,
               'compute_reminders': correct_rem02, 'build_request_rows': correct_req01, 'plan_user_migration': correct_mig01}

# ---------------------------------------------------------------- main
def main(steps_dir, fixtures_path, out_path):
    fixtures = json.load(open(fixtures_path))
    goldens = {}
    for action, cases in fixtures.items():
        mod = load_step(steps_dir, STEP_FILES[action])
        goldens[action] = []
        for case in cases:
            py_input = json.loads(json.dumps(ADAPTERS[action](case['input'])))
            try:
                raw = mod.main(py_input)
                golden = CORRECTIONS[action](raw)
                goldens[action].append({'name': case['name'], 'output': golden})
            except Exception as e:  # the step raised on purpose (REM-02) or by accident
                goldens[action].append({'name': case['name'], 'raises': '%s: %s' % (type(e).__name__, e)})
    json.dump(goldens, open(out_path, 'w'), indent=1, default=str)
    n = sum(len(v) for v in goldens.values())
    print('goldens written: %d cases across %d actions' % (n, len(goldens)))

if __name__ == '__main__':
    main(*sys.argv[1:4])

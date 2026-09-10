"""
Compares ruby_out.json with goldens.json field by field.
Masks values that are minted at run time (UUIDs, "now" timestamps) so only decisions are compared.

Usage: python3 compare.py <goldens.json> <ruby_out.json>
"""
import json, re, sys

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

# Differences that are decisions, not bugs. Each entry: (action, case) -> {path prefix: reason}. Listed in WAVE1_GUIDE.md.
EXPECTED_DIVERGENCES = {
    ('compute_reminders', 'no_users_no_emails_default_cap'): {
        '.log': "reminders_enabled arrives as '' (an empty pill): Python's _is_true treats only None as unset and reads '' as false, "
                "so it skipped req-1 silently; the connector's to_bool reads blank as unset (default true), evaluates the request, and logs why it was skipped.",
        '.rows[1].users[0].user_email': "Python echoes the raw '  '; the connector cleans every string field of a user row.",
    },
}
NOW_KEYS = {'new_user_created_at', 'created_at', 'current_state_entered_at'}
MINTED_KEYS = {'new_user_supplier_user_id', 'supplier_user_id', 'supplier_request_id'}

def mask(v, key=None, path=''):
    if isinstance(v, dict):
        return {k: mask(x, k, path + '.' + k) for k, x in v.items()}
    if isinstance(v, list):
        return [mask(x, key, path + '[]') for x in v]
    if isinstance(v, str):
        if key in MINTED_KEYS and UUID.match(v):
            return '<uuid>'
        if key in NOW_KEYS and v:
            return '<now>'
    return v

def diff(a, b, path='', out=None):
    out = [] if out is None else out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a: out.append('%s.%s: missing in golden (ruby has %r)' % (path, k, b[k]))
            elif k not in b: out.append('%s.%s: missing in ruby (golden has %r)' % (path, k, a[k]))
            else: diff(a[k], b[k], path + '.' + k, out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b): out.append('%s: length %d vs %d' % (path, len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)): diff(x, y, '%s[%d]' % (path, i), out)
    else:
        if a != b: out.append('%s: golden %r != ruby %r' % (path, a, b))
    return out

def main(golden_path, ruby_path):
    g = json.load(open(golden_path)); r = json.load(open(ruby_path))
    total = passed = 0
    for action in g:
        gcases = {c['name']: c for c in g[action]}; rcases = {c['name']: c for c in r.get(action, [])}
        for name, gc in gcases.items():
            total += 1
            rc = rcases.get(name)
            if rc is None:
                print('FAIL %s/%s: no ruby result' % (action, name)); continue
            if 'raises' in gc or 'raises' in rc:
                ok = ('raises' in gc) == ('raises' in rc)
                if ok and 'raises' in gc:
                    gm = gc['raises'].split(': ', 1)[-1]; rm = rc['raises'].split(': ', 1)[-1]
                    ok = gm == rm
                print(('PASS' if ok else 'FAIL') + ' %s/%s  raises: golden=%r ruby=%r' % (action, name, gc.get('raises'), rc.get('raises')))
                passed += ok; continue
            d = diff(mask(gc['output']), mask(rc['output']))
            allowed = EXPECTED_DIVERGENCES.get((action, name), {})
            unexplained = [line for line in d if not any(line.startswith(p) for p in allowed)]
            if unexplained:
                print('FAIL %s/%s' % (action, name))
                for line in unexplained[:12]: print('     ' + line)
            elif d:
                print('PASS %s/%s  (documented divergence: %s)' % (action, name, '; '.join(sorted(allowed)))); passed += 1
            else:
                print('PASS %s/%s' % (action, name)); passed += 1
    print('\n%d/%d cases match' % (passed, total))
    sys.exit(0 if passed == total else 1)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

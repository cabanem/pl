"""SDC form renderer — implements render-contract v1.0.

Pure function: render(config, values, errors) -> str (complete HTML document).
No I/O, no clock, no randomness. Stdlib only, so this file pastes into a
Workato Python action unchanged.

Raises RenderContractError on contract violations (config shape, graph,
options completeness, version mismatch). Never raises on bad *data* — data
judgments belong to VAL-01.
"""

import html
import json
import re

CONTRACT_VERSION = "1.0"

FIELD_TYPES = ("text", "textarea", "number", "date", "dropdown")

CONSTRAINT_KEYS = {
    "text": {"max_length", "pattern"},
    "textarea": {"max_length"},
    "number": {"min", "max", "step"},
    "date": {"min", "max"},
    "dropdown": set(),
}

FIELD_KEYS = {
    "field_id", "label", "type", "required", "help_text",
    "parent_field_id", "sort_order", "constraints",
}

FIELD_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class RenderContractError(Exception):
    """Config/shape violation. Maps to a 500-class apology page, never to
    supplier-visible detail."""


def _fail(msg):
    raise RenderContractError(msg)


def _esc(value):
    """HTML-escape for element and attribute context."""
    return html.escape("" if value is None else str(value), quote=True)


def _json_embed(obj):
    """Deterministic JSON for embedding inside a <script> block.

    sort_keys gives determinism (L1); escaping < > & closes the </script>
    breakout and any HTML-significant character in string values (L3).
    """
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"))
    return (text.replace("&", "\\u0026")
                .replace("<", "\\u003c")
                .replace(">", "\\u003e"))


def _num_attr(value):
    """Deterministic serialization of a numeric constraint for an attribute."""
    return json.dumps(value)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_config(config):
    """Enforce contract §1 (config shape), L6 (graph), L7 (version match),
    L8 (options completeness). Returns the fields in render order and the
    dropdown chain in dependency order, both deterministic."""
    if not isinstance(config, dict):
        _fail("config must be an object")
    if config.get("contract_version") != CONTRACT_VERSION:
        _fail("unsupported contract_version: %r (renderer speaks %s)"
              % (config.get("contract_version"), CONTRACT_VERSION))

    request = config.get("request")
    template = config.get("template")
    if not isinstance(request, dict):
        _fail("config.request must be an object")
    if not isinstance(template, dict):
        _fail("config.template must be an object")

    for key in ("correlation_token", "action_url", "template_version_id"):
        val = request.get(key)
        if not isinstance(val, str) or not val:
            _fail("request.%s must be a non-empty string" % key)
    display = request.get("display", {})
    if display is None:
        display = {}
    if not isinstance(display, dict):
        _fail("request.display must be an object when present")
    for key, val in display.items():
        if val is not None and not isinstance(val, str):
            _fail("request.display.%s must be a string or null" % key)

    if not isinstance(template.get("template_version_id"), str):
        _fail("template.template_version_id must be a string")
    if request["template_version_id"] != template["template_version_id"]:
        _fail("template version mismatch: request expects %r, template is %r"
              % (request["template_version_id"],
                 template["template_version_id"]))
    if not isinstance(template.get("title"), str) or not template["title"]:
        _fail("template.title must be a non-empty string")

    fields = template.get("fields")
    if not isinstance(fields, list) or not fields:
        _fail("template.fields must be a non-empty array")

    by_id = {}
    for i, field in enumerate(fields):
        if not isinstance(field, dict):
            _fail("fields[%d] must be an object" % i)
        extra = set(field) - FIELD_KEYS
        if extra:
            _fail("fields[%d] has unknown keys: %s"
                  % (i, ", ".join(sorted(extra))))
        missing = FIELD_KEYS - set(field)
        if missing:
            _fail("fields[%d] is missing keys: %s"
                  % (i, ", ".join(sorted(missing))))
        fid = field["field_id"]
        if not isinstance(fid, str) or not FIELD_ID_RE.match(fid):
            _fail("fields[%d].field_id %r must match %s"
                  % (i, fid, FIELD_ID_RE.pattern))
        if fid in by_id:
            _fail("duplicate field_id: %s" % fid)
        if not isinstance(field["label"], str) or not field["label"]:
            _fail("field %s: label must be a non-empty string" % fid)
        if field["type"] not in FIELD_TYPES:
            _fail("field %s: unknown type %r" % (fid, field["type"]))
        if not isinstance(field["required"], bool):
            _fail("field %s: required must be a boolean" % fid)
        if field["help_text"] is not None and not isinstance(field["help_text"], str):
            _fail("field %s: help_text must be a string or null" % fid)
        if not isinstance(field["sort_order"], int):
            _fail("field %s: sort_order must be an integer" % fid)
        by_id[fid] = field

    for fid, field in by_id.items():
        parent = field["parent_field_id"]
        if parent is not None:
            if field["type"] != "dropdown":
                _fail("field %s: parent_field_id is only legal on dropdowns" % fid)
            if not isinstance(parent, str) or parent not in by_id:
                _fail("field %s: parent_field_id %r does not resolve" % (fid, parent))
            if by_id[parent]["type"] != "dropdown":
                _fail("field %s: parent %s must be a dropdown" % (fid, parent))
            if parent == fid:
                _fail("field %s: cannot be its own parent" % fid)
        _validate_constraints(fid, field)

    _validate_graph(by_id)
    chain = _dropdown_chain(by_id)
    _validate_options(template.get("options"), by_id, chain)

    ordered = sorted(fields, key=lambda f: (f["sort_order"], f["field_id"]))
    return ordered, chain


def _validate_constraints(fid, field):
    constraints = field["constraints"]
    if not isinstance(constraints, dict):
        _fail("field %s: constraints must be an object" % fid)
    allowed = CONSTRAINT_KEYS[field["type"]]
    extra = set(constraints) - allowed
    if extra:
        _fail("field %s: constraints %s not allowed for type %s"
              % (fid, ", ".join(sorted(extra)), field["type"]))
    for key, val in constraints.items():
        if key == "max_length":
            if not isinstance(val, int) or val <= 0:
                _fail("field %s: max_length must be a positive integer" % fid)
        elif key == "pattern":
            if not isinstance(val, str) or not val:
                _fail("field %s: pattern must be a non-empty string" % fid)
        elif key in ("min", "max", "step"):
            if field["type"] == "date":
                if not isinstance(val, str) or not ISO_DATE_RE.match(val):
                    _fail("field %s: %s must be an ISO 8601 date" % (fid, key))
            else:
                if isinstance(val, bool) or not isinstance(val, (int, float)):
                    _fail("field %s: %s must be a number" % (fid, key))


def _validate_graph(by_id):
    """L6: parent edges must form a forest — acyclic, all resolvable."""
    for fid in by_id:
        seen = set()
        cursor = fid
        while cursor is not None:
            if cursor in seen:
                _fail("dependency cycle detected through field %s" % fid)
            seen.add(cursor)
            cursor = by_id[cursor]["parent_field_id"]


def _dropdown_chain(by_id):
    """Dropdown field_ids with parents, in dependency order (Kahn's algorithm
    with a sorted ready list for determinism). The same topological pass the
    graph tooling uses on recipe DAGs, applied to field edges."""
    dropdowns = {fid: f for fid, f in by_id.items() if f["type"] == "dropdown"}
    resolved = []
    resolved_set = set()
    remaining = dict(dropdowns)
    while remaining:
        ready = sorted(
            fid for fid, f in remaining.items()
            if f["parent_field_id"] is None or f["parent_field_id"] in resolved_set
        )
        if not ready:
            _fail("dependency cycle detected among dropdown fields")
        for fid in ready:
            resolved.append((fid, remaining[fid]["parent_field_id"]))
            resolved_set.add(fid)
            del remaining[fid]
    return resolved


def _validate_options(options, by_id, chain):
    """L8: completeness over reachable parent values; empty arrays legal."""
    if not isinstance(options, dict):
        _fail("template.options must be an object")

    dropdown_ids = {fid for fid, _parent in chain}
    for key, opts in options.items():
        if not isinstance(key, str) or "|" not in key:
            _fail("options key %r must be 'field_id|parent_value'" % key)
        key_fid = key.split("|", 1)[0]
        if key_fid not in dropdown_ids:
            _fail("options key %r references unknown dropdown %r" % (key, key_fid))
        if not isinstance(opts, list):
            _fail("options[%r] must be an array" % key)
        seen = set()
        for opt in opts:
            if not isinstance(opt, str) or not opt:
                _fail("options[%r] must contain non-empty strings" % key)
            if opt in seen:
                _fail("options[%r] contains duplicate value %r" % (key, opt))
            seen.add(opt)

    reachable = {}
    for fid, parent in chain:
        if parent is None:
            key = fid + "|"
            if key not in options:
                _fail("missing options key %r for root dropdown %s" % (key, fid))
            reachable[fid] = list(options[key])
        else:
            values = []
            for parent_value in reachable[parent]:
                key = fid + "|" + parent_value
                if key not in options:
                    _fail("missing options key %r (reachable via %s=%r)"
                          % (key, parent, parent_value))
                values.extend(options[key])
            reachable[fid] = values


def _validate_values(values, by_id):
    if not isinstance(values, dict):
        _fail("values must be an object")
    for key, val in values.items():
        if val is not None and not isinstance(val, str):
            _fail("values.%s must be a string or null" % key)
    return {k: v for k, v in values.items() if k in by_id}


def _validate_errors(errors):
    if not isinstance(errors, dict):
        _fail("errors must be an object")
    extra = set(errors) - {"field_errors", "form_errors"}
    if extra:
        _fail("errors has unknown keys: %s" % ", ".join(sorted(extra)))
    field_errors = errors.get("field_errors", {})
    form_errors = errors.get("form_errors", [])
    if not isinstance(field_errors, dict):
        _fail("errors.field_errors must be an object")
    for key, msgs in field_errors.items():
        if not isinstance(msgs, list) or not all(isinstance(m, str) for m in msgs):
            _fail("errors.field_errors.%s must be an array of strings" % key)
    if not isinstance(form_errors, list) or not all(
            isinstance(m, str) for m in form_errors):
        _fail("errors.form_errors must be an array of strings")
    return field_errors, form_errors


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

_CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px;
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: #f4f5f7; color: #1c2530; font-size: 16px; line-height: 1.5; }
main { max-width: 640px; margin: 0 auto; }
header { margin: 0 0 20px; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
.meta { font-size: 14px; color: #5c6873; margin: 0; }
.meta span + span::before { content: " \\00b7 "; }
form { background: #ffffff; border: 1px solid #d8dde3; border-radius: 8px;
  padding: 24px 24px 28px; }
.form-errors { background: #fdf1f0; border: 1px solid #c8564a;
  border-radius: 6px; padding: 12px 16px; margin: 0 0 20px; }
.form-errors p { margin: 0 0 4px; font-weight: 600; color: #8f2f26; font-size: 15px; }
.form-errors ul { margin: 0; padding-left: 20px; color: #8f2f26; font-size: 14px; }
.field { margin: 0 0 20px; }
label { display: block; font-size: 14px; font-weight: 600; margin: 0 0 6px; }
.req { color: #8f2f26; }
input, select, textarea { width: 100%; padding: 9px 12px; font-size: 15px;
  font-family: inherit; color: inherit; background: #ffffff;
  border: 1px solid #c3cad2; border-radius: 6px; }
textarea { min-height: 96px; resize: vertical; }
select:disabled { background: #eef0f3; color: #7a8590; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: 2px solid #2b5d9c; outline-offset: 1px; }
.invalid { border-color: #c8564a; }
.help { font-size: 13px; color: #5c6873; margin: 6px 0 0; }
.errors { list-style: none; margin: 6px 0 0; padding: 0;
  font-size: 13px; color: #8f2f26; }
.actions { margin: 28px 0 0; }
button { padding: 11px 24px; font-size: 15px; font-weight: 600;
  color: #ffffff; background: #24476f; border: 1px solid #24476f;
  border-radius: 6px; cursor: pointer; width: auto; }
button:hover { background: #1c3a5c; }
footer { max-width: 640px; margin: 16px auto 0; font-size: 12px;
  color: #7a8590; }
""".strip()

_JS = """
(function () {
  function byId(fid) { return document.getElementById("fld_" + fid); }
  function fill(sel, opts, saved) {
    while (sel.firstChild) { sel.removeChild(sel.firstChild); }
    var ph = document.createElement("option");
    ph.value = "";
    if (opts === null || opts === undefined) {
      ph.textContent = "Select\\u2026";
      sel.appendChild(ph);
      sel.disabled = true;
      return;
    }
    if (opts.length === 0) {
      ph.textContent = "Not applicable";
      sel.appendChild(ph);
      sel.disabled = true;
      return;
    }
    ph.textContent = "Select\\u2026";
    sel.appendChild(ph);
    for (var i = 0; i < opts.length; i++) {
      var el = document.createElement("option");
      el.value = opts[i];
      el.textContent = opts[i];
      sel.appendChild(el);
    }
    sel.disabled = false;
    if (saved !== null && saved !== undefined && opts.indexOf(saved) !== -1) {
      sel.value = saved;
    }
  }
  function childrenOf(fid) {
    var out = [];
    for (var i = 0; i < SDC_CHAIN.length; i++) {
      if (SDC_CHAIN[i][1] === fid) { out.push(SDC_CHAIN[i][0]); }
    }
    return out;
  }
  function refreshChild(cid, saved) {
    var child = byId(cid);
    var parentValue = byId(child.getAttribute("data-parent")).value;
    var opts = parentValue === "" ? null : SDC_OPTIONS[cid + "|" + parentValue];
    fill(child, opts === undefined ? null : opts, saved);
  }
  function clearDown(fid) {
    var kids = childrenOf(fid);
    for (var i = 0; i < kids.length; i++) {
      fill(byId(kids[i]), null, null);
      clearDown(kids[i]);
    }
  }
  function initCascade() {
    for (var i = 0; i < SDC_CHAIN.length; i++) {
      var fid = SDC_CHAIN[i][0];
      var parent = SDC_CHAIN[i][1];
      if (parent !== null) {
        refreshChild(fid, SDC_VALUES[fid]);
      }
      (function (id) {
        byId(id).addEventListener("change", function () {
          clearDown(id);
          var kids = childrenOf(id);
          for (var k = 0; k < kids.length; k++) { refreshChild(kids[k], null); }
        });
      })(fid);
    }
  }
  initCascade();
})();
""".strip()


def _render_control(field, value, has_error, options):
    fid = field["field_id"]
    ftype = field["type"]
    constraints = field["constraints"]
    described = []
    if field["help_text"]:
        described.append("help_" + fid)
    if has_error:
        described.append("err_" + fid)

    common = ['id="fld_%s"' % _esc(fid), 'name="%s"' % _esc(fid)]
    if field["required"]:
        common.append("required")
    if has_error:
        common.append('aria-invalid="true"')
        common.append('class="invalid"')
    if described:
        common.append('aria-describedby="%s"' % _esc(" ".join(described)))

    if ftype == "textarea":
        attrs = list(common)
        if "max_length" in constraints:
            attrs.append('maxlength="%d"' % constraints["max_length"])
        return "<textarea %s>%s</textarea>" % (" ".join(attrs), _esc(value))

    if ftype == "dropdown":
        attrs = list(common)
        if field["parent_field_id"] is not None:
            attrs.append('data-parent="%s"' % _esc(field["parent_field_id"]))
            attrs.append("disabled")
            return ('<select %s><option value="">Select\u2026</option></select>'
                    % " ".join(attrs))
        parts = ["<select %s>" % " ".join(attrs),
                 '<option value="">Select\u2026</option>']
        for opt in options[fid + "|"]:
            selected = " selected" if value == opt else ""
            parts.append('<option value="%s"%s>%s</option>'
                         % (_esc(opt), selected, _esc(opt)))
        parts.append("</select>")
        return "".join(parts)

    attrs = list(common)
    input_type = {"text": "text", "number": "number", "date": "date"}[ftype]
    attrs.insert(0, 'type="%s"' % input_type)
    if value is not None:
        attrs.append('value="%s"' % _esc(value))
    if ftype == "text":
        if "max_length" in constraints:
            attrs.append('maxlength="%d"' % constraints["max_length"])
        if "pattern" in constraints:
            attrs.append('pattern="%s"' % _esc(constraints["pattern"]))
    elif ftype == "number":
        for key in ("min", "max", "step"):
            if key in constraints:
                attrs.append('%s="%s"' % (key, _num_attr(constraints[key])))
    elif ftype == "date":
        for key in ("min", "max"):
            if key in constraints:
                attrs.append('%s="%s"' % (key, _esc(constraints[key])))
    return "<input %s>" % " ".join(attrs)


def _render_field(field, value, messages, options):
    fid = field["field_id"]
    out = ['<div class="field" id="field_%s">' % _esc(fid)]
    req = ' <span class="req" aria-hidden="true">*</span>' if field["required"] else ""
    out.append('<label for="fld_%s">%s%s</label>' % (_esc(fid), _esc(field["label"]), req))
    out.append(_render_control(field, value, bool(messages), options))
    if field["help_text"]:
        out.append('<p class="help" id="help_%s">%s</p>'
                   % (_esc(fid), _esc(field["help_text"])))
    if messages:
        out.append('<ul class="errors" id="err_%s">' % _esc(fid))
        for msg in messages:
            out.append("<li>%s</li>" % _esc(msg))
        out.append("</ul>")
    out.append("</div>")
    return "".join(out)


def render(config, values, errors):
    ordered_fields, chain = validate_config(config)
    by_id = {f["field_id"]: f for f in ordered_fields}
    known_values = _validate_values(values, by_id)
    field_errors, form_errors = _validate_errors(errors)

    request = config["request"]
    template = config["template"]
    options = template["options"]

    banner_messages = list(form_errors)
    stray_keys = sorted(k for k in field_errors if k not in by_id)
    for key in stray_keys:
        for msg in field_errors[key]:
            banner_messages.append("%s: %s" % (key, msg))

    dropdown_values = {
        fid: known_values.get(fid) for fid, _parent in sorted(chain)
    }

    doc = []
    doc.append("<!DOCTYPE html>")
    doc.append('<html lang="en">')
    doc.append("<head>")
    doc.append('<meta charset="utf-8">')
    doc.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    doc.append('<meta name="robots" content="noindex">')
    doc.append("<title>%s</title>" % _esc(template["title"]))
    doc.append("<style>%s</style>" % _CSS)
    doc.append("</head>")
    doc.append("<body>")
    doc.append("<main>")

    doc.append("<header>")
    doc.append("<h1>%s</h1>" % _esc(template["title"]))
    display = request.get("display") or {}
    meta = []
    for key in ("project_name", "supplier_name"):
        if display.get(key):
            meta.append("<span>%s</span>" % _esc(display[key]))
    if display.get("due_date"):
        meta.append("<span>Due %s</span>" % _esc(display["due_date"]))
    if meta:
        doc.append('<p class="meta">%s</p>' % "".join(meta))
    doc.append("</header>")

    doc.append('<form method="POST" action="%s" data-template-version="%s" '
               'data-contract-version="%s">'
               % (_esc(request["action_url"]),
                  _esc(template["template_version_id"]),
                  _esc(CONTRACT_VERSION)))
    doc.append('<input type="hidden" name="token" value="%s">'
               % _esc(request["correlation_token"]))

    if banner_messages:
        doc.append('<div class="form-errors" role="alert">')
        doc.append("<p>Fix the following to submit:</p>")
        doc.append("<ul>")
        for msg in banner_messages:
            doc.append("<li>%s</li>" % _esc(msg))
        doc.append("</ul>")
        doc.append("</div>")

    for field in ordered_fields:
        fid = field["field_id"]
        doc.append(_render_field(field, known_values.get(fid),
                                 field_errors.get(fid, []), options))

    doc.append('<div class="actions"><button type="submit">Submit rate card'
               "</button></div>")
    doc.append("</form>")
    doc.append("</main>")
    doc.append("<footer>Submitted data is reviewed before acceptance. "
               "Reply to the request email with any questions.</footer>")

    doc.append("<script>")
    doc.append("var SDC_OPTIONS = %s;" % _json_embed(options))
    doc.append("var SDC_VALUES = %s;" % _json_embed(dropdown_values))
    doc.append("var SDC_CHAIN = %s;" % _json_embed(
        [[fid, parent] for fid, parent in chain]))
    doc.append(_JS)
    doc.append("</script>")

    doc.append("</body>")
    doc.append("</html>")
    return "\n".join(doc)


if __name__ == "__main__":
    import sys

    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        fixture = json.load(handle)
    sys.stdout.write(render(fixture["config"], fixture["values"],
                            fixture["errors"]))

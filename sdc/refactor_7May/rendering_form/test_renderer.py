"""Contract-law tests for the SDC form renderer (render-contract v1.0).

One test class per law, L1 through L9, plus golden-file regression. Stdlib
unittest only — runs anywhere the renderer does:  python3 -m unittest -v
"""

import copy
import json
import os
import re
import unittest
from html.parser import HTMLParser

from renderer import RenderContractError, render, validate_config

HERE = os.path.dirname(os.path.abspath(__file__))


def load_fixture():
    with open(os.path.join(HERE, "fixture.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def render_fixture(fixture=None):
    fixture = fixture or load_fixture()
    return render(fixture["config"], fixture["values"], fixture["errors"])


def extract_embed(html_text, name):
    """Pull an embedded JSON constant (SDC_OPTIONS / SDC_VALUES / SDC_CHAIN)
    back out of the script block and parse it."""
    match = re.search(r"var %s = (.*?);\n" % name, html_text, re.S)
    assert match, "embedded constant %s not found" % name
    return json.loads(match.group(1))


class ControlCollector(HTMLParser):
    """Collects form controls: {name: {"tag", "type", "value", "attrs"}}."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.controls = {}
        self.occurrences = {}
        self._open_textarea = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("input", "select", "textarea") and "name" in attrs:
            name = attrs["name"]
            self.occurrences[name] = self.occurrences.get(name, 0) + 1
            self.controls[name] = {
                "tag": tag,
                "type": attrs.get("type"),
                "value": attrs.get("value"),
                "attrs": attrs,
            }
            if tag == "textarea":
                self._open_textarea = name
                self.controls[name]["value"] = ""

    def handle_data(self, data):
        if self._open_textarea is not None:
            self.controls[self._open_textarea]["value"] += data

    def handle_endtag(self, tag):
        if tag == "textarea":
            self._open_textarea = None


def collect_controls(html_text):
    parser = ControlCollector()
    parser.feed(html_text)
    return parser.controls, parser.occurrences


def minimal_config():
    """Smallest legal config: one root dropdown, one text field."""
    return {
        "contract_version": "1.0",
        "request": {
            "correlation_token": "tok-123",
            "action_url": "https://example.invalid/exec",
            "template_version_id": "9.9",
            "display": {},
        },
        "template": {
            "template_version_id": "9.9",
            "title": "Minimal",
            "fields": [
                {"field_id": "family", "label": "Family", "type": "dropdown",
                 "required": True, "help_text": None, "parent_field_id": None,
                 "sort_order": 10, "constraints": {}},
                {"field_id": "notes", "label": "Notes", "type": "text",
                 "required": False, "help_text": None, "parent_field_id": None,
                 "sort_order": 20, "constraints": {}},
            ],
            "options": {"family|": ["A", "B"]},
        },
    }


EMPTY_ERRORS = {"field_errors": {}, "form_errors": []}


class L1Purity(unittest.TestCase):
    def test_same_inputs_byte_identical(self):
        fixture = load_fixture()
        first = render(fixture["config"], fixture["values"], fixture["errors"])
        second = render(fixture["config"], fixture["values"], fixture["errors"])
        self.assertEqual(first, second)

    def test_inputs_not_mutated(self):
        fixture = load_fixture()
        snapshot = copy.deepcopy(fixture)
        render(fixture["config"], fixture["values"], fixture["errors"])
        self.assertEqual(fixture, snapshot)


class L2RoundTrip(unittest.TestCase):
    """Posting the rendered form unchanged must yield fields ≡ values.

    Offline proxy for a browser: control names are asserted to be exactly the
    field_ids plus the hidden token; server-rendered values are asserted to
    round-trip; dropdown state is asserted via the embedded SDC_VALUES the
    init script applies. Step 6's adversarial matrix covers the live-browser
    version of this law.
    """

    def test_control_names_are_field_ids_plus_token(self):
        fixture = load_fixture()
        html_text = render_fixture(fixture)
        controls, _ = collect_controls(html_text)
        field_ids = {f["field_id"]
                     for f in fixture["config"]["template"]["fields"]}
        self.assertEqual(set(controls), field_ids | {"token"})

    def test_token_round_trips(self):
        fixture = load_fixture()
        controls, _ = collect_controls(render_fixture(fixture))
        self.assertEqual(controls["token"]["value"],
                         fixture["config"]["request"]["correlation_token"])

    def test_server_rendered_values_round_trip(self):
        fixture = load_fixture()
        controls, _ = collect_controls(render_fixture(fixture))
        self.assertEqual(controls["bill_rate"]["value"], "612.50")
        self.assertEqual(controls["effective_date"]["value"], "2027-02-01")

    def test_dropdown_values_round_trip_via_embed(self):
        html_text = render_fixture()
        values = extract_embed(html_text, "SDC_VALUES")
        self.assertEqual(values, {"job_family": "Engineering",
                                  "role": "Integration developer",
                                  "seniority": None})


class L3EscapeTotality(unittest.TestCase):
    PAYLOAD = "<script>alert('pwn')</script>"

    def poisoned_fixture(self):
        config = minimal_config()
        config["template"]["title"] = "Title " + self.PAYLOAD
        config["template"]["fields"][0]["label"] = "Fam " + self.PAYLOAD
        config["template"]["fields"][1]["label"] = "Notes " + self.PAYLOAD
        config["template"]["fields"][1]["help_text"] = "Help " + self.PAYLOAD
        config["template"]["options"] = {
            "family|": ["A " + self.PAYLOAD, "B"]}
        config["request"]["display"] = {
            "project_name": "Proj " + self.PAYLOAD,
            "supplier_name": "Supp " + self.PAYLOAD,
            "due_date": None,
        }
        values = {"family": "A " + self.PAYLOAD,
                  "notes": "Val " + self.PAYLOAD}
        errors = {"field_errors": {"notes": ["Err " + self.PAYLOAD]},
                  "form_errors": ["Form " + self.PAYLOAD]}
        return config, values, errors

    def test_payload_never_survives_unescaped(self):
        config, values, errors = self.poisoned_fixture()
        html_text = render(config, values, errors)
        self.assertNotIn(self.PAYLOAD, html_text)
        self.assertNotIn("<script>alert", html_text)
        self.assertIn("&lt;script&gt;", html_text)

    def test_script_embed_escapes_angle_brackets(self):
        config, values, errors = self.poisoned_fixture()
        html_text = render(config, values, errors)
        options_src = re.search(r"var SDC_OPTIONS = (.*?);\n", html_text, re.S)
        self.assertIsNotNone(options_src)
        self.assertNotIn("<", options_src.group(1))
        self.assertNotIn(">", options_src.group(1))
        self.assertIn("\\u003c", options_src.group(1))


class L4FieldCompleteness(unittest.TestCase):
    def test_every_field_renders_exactly_once(self):
        fixture = load_fixture()
        _, occurrences = collect_controls(render_fixture(fixture))
        for field in fixture["config"]["template"]["fields"]:
            self.assertEqual(occurrences.get(field["field_id"]), 1,
                             "field %s" % field["field_id"])


class L5ErrorAdjacency(unittest.TestCase):
    def field_block(self, html_text, fid):
        start = html_text.index('id="field_%s"' % fid)
        end = html_text.find('<div class="field"', start + 1)
        return html_text[start:end if end != -1 else len(html_text)]

    def test_field_errors_render_adjacent(self):
        html_text = render_fixture()
        self.assertIn("Required.", self.field_block(html_text, "seniority"))
        self.assertIn("Must be at most 500.",
                      self.field_block(html_text, "bill_rate"))
        self.assertIn("Must be on or before 2026-12-31.",
                      self.field_block(html_text, "effective_date"))

    def test_errored_controls_marked_invalid(self):
        html_text = render_fixture()
        block = self.field_block(html_text, "bill_rate")
        self.assertIn('aria-invalid="true"', block)

    def test_stray_keys_surface_in_form_errors(self):
        fixture = load_fixture()
        fixture["errors"]["field_errors"]["ghost_field"] = ["Boo."]
        html_text = render_fixture(fixture)
        banner = html_text[html_text.index('class="form-errors"'):
                           html_text.index("</div>",
                                           html_text.index('class="form-errors"'))]
        self.assertIn("ghost_field: Boo.", banner)


class L6GraphValidity(unittest.TestCase):
    def test_cycle_raises(self):
        config = minimal_config()
        config["template"]["fields"] = [
            {"field_id": "a", "label": "A", "type": "dropdown",
             "required": True, "help_text": None, "parent_field_id": "b",
             "sort_order": 10, "constraints": {}},
            {"field_id": "b", "label": "B", "type": "dropdown",
             "required": True, "help_text": None, "parent_field_id": "a",
             "sort_order": 20, "constraints": {}},
        ]
        config["template"]["options"] = {}
        with self.assertRaises(RenderContractError):
            validate_config(config)

    def test_dangling_parent_raises(self):
        config = minimal_config()
        config["template"]["fields"][0]["parent_field_id"] = "no_such_field"
        with self.assertRaises(RenderContractError):
            validate_config(config)

    def test_parent_on_non_dropdown_raises(self):
        config = minimal_config()
        config["template"]["fields"][1]["parent_field_id"] = "family"
        with self.assertRaises(RenderContractError):
            validate_config(config)


class L7VersionMatch(unittest.TestCase):
    def test_mismatch_raises(self):
        config = minimal_config()
        config["request"]["template_version_id"] = "1.2"
        with self.assertRaises(RenderContractError):
            validate_config(config)

    def test_unknown_contract_version_raises(self):
        config = minimal_config()
        config["contract_version"] = "2.0"
        with self.assertRaises(RenderContractError):
            validate_config(config)


class L8OptionCompleteness(unittest.TestCase):
    def chained_config(self):
        config = minimal_config()
        config["template"]["fields"].append(
            {"field_id": "sub", "label": "Sub", "type": "dropdown",
             "required": True, "help_text": None, "parent_field_id": "family",
             "sort_order": 15, "constraints": {}})
        config["template"]["options"] = {
            "family|": ["A", "B"],
            "sub|A": ["A1", "A2"],
            "sub|B": [],
        }
        return config

    def test_complete_options_validate(self):
        validate_config(self.chained_config())

    def test_empty_array_is_legal(self):
        html_text = render(self.chained_config(), {}, EMPTY_ERRORS)
        options = extract_embed(html_text, "SDC_OPTIONS")
        self.assertEqual(options["sub|B"], [])

    def test_missing_reachable_key_raises(self):
        config = self.chained_config()
        del config["template"]["options"]["sub|B"]
        with self.assertRaises(RenderContractError):
            validate_config(config)

    def test_missing_root_key_raises(self):
        config = self.chained_config()
        del config["template"]["options"]["family|"]
        with self.assertRaises(RenderContractError):
            validate_config(config)

    def test_duplicate_option_values_raise(self):
        config = minimal_config()
        config["template"]["options"]["family|"] = ["A", "A"]
        with self.assertRaises(RenderContractError):
            validate_config(config)


class L9CascadeRehydration(unittest.TestCase):
    def test_child_dropdowns_carry_parent_wiring(self):
        html_text = render_fixture()
        controls, _ = collect_controls(html_text)
        self.assertEqual(controls["role"]["attrs"].get("data-parent"),
                         "job_family")
        self.assertEqual(controls["seniority"]["attrs"].get("data-parent"),
                         "role")

    def test_root_dropdown_server_rendered_selected(self):
        html_text = render_fixture()
        match = re.search(r'<option value="Engineering"([^>]*)>', html_text)
        self.assertIsNotNone(match)
        self.assertIn("selected", match.group(1))

    def test_chain_is_topological(self):
        html_text = render_fixture()
        chain = extract_embed(html_text, "SDC_CHAIN")
        order = [fid for fid, _parent in chain]
        self.assertLess(order.index("job_family"), order.index("role"))
        self.assertLess(order.index("role"), order.index("seniority"))

    def test_init_script_present(self):
        html_text = render_fixture()
        self.assertIn("initCascade()", html_text)
        self.assertIn("Not applicable", html_text)


class GoldenFile(unittest.TestCase):
    """Regression pin. Regenerate deliberately with:
    python3 renderer.py fixture.json > golden.html
    """

    def test_matches_golden(self):
        path = os.path.join(HERE, "golden.html")
        if not os.path.exists(path):
            self.skipTest("golden.html not generated yet")
        with open(path, "r", encoding="utf-8") as fh:
            golden = fh.read()
        self.assertEqual(render_fixture(), golden)


if __name__ == "__main__":
    unittest.main(verbosity=2)

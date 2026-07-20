# Spike /submit echo - paste into the Python action of the spike POST recipe.
# Trigger must be raw-text content type; map the raw request body to input "body".
# Output schema: html (string).

import html
import json


def main(input):
    raw = input.get("body") or ""
    try:
        envelope = json.loads(raw)
        pretty = json.dumps(envelope, indent=2, sort_keys=True)
        status = "Seam 4 PASS &mdash; /submit parsed the envelope"
    except Exception as exc:
        pretty = "raw body:\n" + raw + "\n\nerror: " + repr(exc)
        status = "Seam 4 FAIL &mdash; could not parse body as JSON"
    page = ("<!DOCTYPE html><html><body style=\"font-family:monospace;padding:24px\">"
            "<h2>%s</h2><pre>%s</pre>"
            "<p>Compare against the Seam 1 echo &mdash; they should match.</p>"
            "</body></html>" % (status, html.escape(pretty)))
    return {"html": page}

/**
 * @file 31_DiagramService.js
 * @description
 *   Renders the Mermaid text already stored in an Output_Process_Maps row as an
 *   actual SVG diagram, in a pan/zoom modal. No new data and no API calls: the
 *   graph string is pulled from the selected row and handed to mermaid.js inside
 *   an HtmlService dialog (the same door as showLinkModal, just a bigger room).
 *
 *   Safety: the Mermaid text is injected as DATA, not markup. The payload is
 *   JSON-encoded and every "<" is escaped to \u003c, so nothing in a recipe name
 *   or label can close the <script> tag or otherwise be parsed as page
 *   structure. Rendering uses mermaid.render(id, text), so the definition is
 *   passed as a string argument and never enters the DOM as HTML.
 */

class DiagramService {
  /**
   * Entry point: read the selected Output_Process_Maps row and open the viewer.
   */
  static viewFromSelection() {
    const cfg = AppConfig.get();
    const ui = SpreadsheetApp.getUi();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getActiveSheet();
    const pmName = cfg.SHEETS.PROCESS_MAPS;

    if (sheet.getName() !== pmName) {
      ui.alert("View diagram", `Select a row in "${pmName}" first, then run this again.`, ui.ButtonSet.OK);
      return;
    }

    const rng = sheet.getActiveRange();
    if (!rng) {
      ui.alert("View diagram", "Select a data row first.", ui.ButtonSet.OK);
      return;
    }
    const row = rng.getRow();
    if (row < 2) {
      ui.alert("View diagram", "Select a data row (not the header row).", ui.ButtonSet.OK);
      return;
    }

    // Columns: A id, B name, C mode, D depth, E call mermaid, F process mermaid,
    //          G notes, H call link, I full link, J timestamp.
    const vals = sheet.getRange(row, 1, 1, 10).getValues()[0];
    const fmls = sheet.getRange(row, 1, 1, 10).getFormulas()[0];

    const payload = {
      rootId: String(vals[0] || ""),
      rootName: String(vals[1] || ""),
      call: this._graph_(vals[4], fmls[7]),     // E mermaid, H link
      process: this._graph_(vals[5], fmls[8])    // F mermaid, I link
    };

    ui.showModalDialog(this._buildHtml_(payload), "Process diagram");
  }

  // --- INTERNALS ---------------------------------------------------------------------------------------
  /** Shape one graph column into { mermaid, truncated, driveUrl }. */
  static _graph_(mermaidCell, linkFormula) {
    const text = String(mermaidCell || "");
    const truncated = /\.\.\.\(TRUNCATED\)/.test(text);
    return {
      mermaid: truncated ? "" : text,       // truncated cells aren't renderable; point at Drive instead
      truncated: truncated,
      driveUrl: this._urlFromFormula_(linkFormula)
    };
  }

  /** Pull the URL out of a =HYPERLINK("url","label") cell formula. */
  static _urlFromFormula_(formula) {
    const m = String(formula || "").match(/HYPERLINK\("([^"]+)"/i);
    return m ? m[1] : "";
  }

  /** Build the dialog HTML with the payload injected as escaped JSON. */
  static _buildHtml_(payload) {
    // JSON is safe to embed in a <script> once every "<" is neutralized.
    const json = JSON.stringify(payload).replace(/</g, "\\u003c");

    const html = `
<style>
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; height: 100vh;
         font-family: Arial, Helvetica, sans-serif; color: #202124; }
  #bar { display: flex; gap: 6px; align-items: center; padding: 8px;
         border-bottom: 1px solid #e0e0e0; flex: 0 0 auto; flex-wrap: wrap; }
  #bar button { font: inherit; padding: 6px 10px; border: 1px solid #dadce0;
                background: #fff; border-radius: 6px; cursor: pointer; }
  #bar button:hover:not(:disabled) { background: #f1f3f4; }
  #bar button:disabled { opacity: .4; cursor: default; }
  #bar button.active { background: #e8f0fe; border-color: #4285f4; color: #1967d2; }
  #title { font-weight: bold; margin-right: auto; white-space: nowrap;
           overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
  #stage { flex: 1 1 auto; position: relative; overflow: hidden;
           background: #fafafa; cursor: grab; }
  #stage.dragging { cursor: grabbing; }
  #canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  #canvas svg { display: block; }
  #msg { position: absolute; left: 0; top: 0; padding: 20px; color: #5f6368; }
  #msg .lnk { color: #1967d2; margin-left: 6px; }
  #src { flex: 0 0 auto; display: none; height: 130px; box-sizing: border-box;
         border: 0; border-top: 1px solid #e0e0e0; padding: 8px;
         font-family: monospace; font-size: 12px; resize: none; }
</style>

<div id="bar">
  <span id="title">Process diagram</span>
  <button id="btnCall">Call graph</button>
  <button id="btnProc">Process graph</button>
  <button id="zoomOut">Zoom -</button>
  <button id="zoomIn">Zoom +</button>
  <button id="fit">Fit</button>
  <button id="copy">Copy source</button>
</div>
<div id="stage">
  <div id="canvas"></div>
  <div id="msg" style="display:none"></div>
</div>
<textarea id="src" readonly></textarea>

<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
  var DATA = /*__PAYLOAD__*/;
  var mermaidReady = !!(window.mermaid && typeof window.mermaid.render === 'function');
  if (mermaidReady) { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }); }

  var scale = 1, tx = 0, ty = 0, idc = 0;
  var stage = document.getElementById('stage');
  var canvas = document.getElementById('canvas');
  var msg = document.getElementById('msg');
  var src = document.getElementById('src');

  function apply() { canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }

  function showMsg(text, url) {
    canvas.innerHTML = '';
    msg.style.display = 'block';
    msg.textContent = '';
    var p = document.createElement('div');
    p.textContent = text;
    msg.appendChild(p);
    if (url) {
      var a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.className = 'lnk';
      a.textContent = 'Open full .mmd in Drive';
      msg.appendChild(a);
    }
  }

  function fit() {
    scale = 1; tx = 0; ty = 0; apply();
    var svg = canvas.querySelector('svg');
    if (!svg) return;
    var sr = stage.getBoundingClientRect();
    var cr = svg.getBoundingClientRect();
    var s = Math.min(sr.width / cr.width, sr.height / cr.height, 1);
    scale = s > 0 ? s * 0.95 : 1;
    tx = (sr.width - cr.width * scale) / 2;
    ty = (sr.height - cr.height * scale) / 2;
    apply();
  }

  function render(which) {
    var g = DATA[which];
    document.getElementById('btnCall').classList.toggle('active', which === 'call');
    document.getElementById('btnProc').classList.toggle('active', which === 'process');
    document.getElementById('title').textContent =
      (which === 'call' ? 'Call graph' : 'Process graph') + ' - ' + (DATA.rootName || DATA.rootId || '');
    src.value = g.mermaid || '';
    canvas.innerHTML = ''; msg.style.display = 'none';

    if (g.truncated) { showMsg('This graph was too large to store in the cell.', g.driveUrl); return; }
    if (!g.mermaid) { showMsg('No ' + which + ' graph on this row.'); return; }
    if (!mermaidReady) { showMsg('Diagram library did not load (network). Use Copy source below.'); return; }

    idc++;
    mermaid.render('d' + idc, g.mermaid).then(function (res) {
      canvas.innerHTML = res.svg;
      fit();
    }).catch(function (e) {
      showMsg('Could not render this graph: ' + ((e && e.message) ? e.message : e));
    });
  }

  function zoomAt(mx, my, factor) {
    var ns = Math.min(Math.max(scale * factor, 0.05), 20);
    tx = mx - (mx - tx) * (ns / scale);
    ty = my - (my - ty) * (ns / scale);
    scale = ns; apply();
  }

  document.getElementById('btnCall').onclick = function () { render('call'); };
  document.getElementById('btnProc').onclick = function () { render('process'); };
  document.getElementById('zoomIn').onclick = function () { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.2); };
  document.getElementById('zoomOut').onclick = function () { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.2); };
  document.getElementById('fit').onclick = function () { fit(); };
  document.getElementById('copy').onclick = function () {
    src.style.display = 'block'; src.focus(); src.select();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(src.value || ''); }
      else { document.execCommand('copy'); }
    } catch (e) {}
  };

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  var drag = false, lx = 0, ly = 0;
  stage.addEventListener('mousedown', function (e) { drag = true; lx = e.clientX; ly = e.clientY; stage.classList.add('dragging'); });
  window.addEventListener('mousemove', function (e) { if (!drag) return; tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply(); });
  window.addEventListener('mouseup', function () { drag = false; stage.classList.remove('dragging'); });

  (function () {
    var hasCall = !!(DATA.call.mermaid) || DATA.call.truncated;
    var hasProc = !!(DATA.process.mermaid) || DATA.process.truncated;
    document.getElementById('btnCall').disabled = !hasCall;
    document.getElementById('btnProc').disabled = !hasProc;
    if (hasCall && !hasProc) render('call');
    else if (hasProc && !hasCall) render('process');
    else if (hasCall && hasProc) showMsg('Pick a graph to view: Call graph or Process graph.');
    else showMsg('This row has no diagram to show.');
  })();
</script>
`;

    // Function replacer so a "$" in the graph source can't be read as a
    // replacement pattern ($&, $1, ...).
    const out = html.replace("/*__PAYLOAD__*/", function () { return json; });
    return HtmlService.createHtmlOutput(out).setWidth(940).setHeight(680);
  }
}

// ---------------------------------------------------------------------------------------
// Manual entrypoint (wired to the menu)
// ---------------------------------------------------------------------------------------
function viewProcessDiagramSelected() {
  DiagramService.viewFromSelection();
}

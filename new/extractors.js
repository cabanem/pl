/**
 * Extractors.gs — deterministic rules that turn a field Description into proposals.
 *
 * Pure functions only. No SpreadsheetApp calls. Testable in Node (see Tests.gs).
 *
 * Contract
 * --------
 *   dpExtract(description, ctx) -> Proposal[]
 *
 *   ctx = {
 *     fieldName:    'Employment type',
 *     dataType:     'string' | '' ...,           // current cell values on the row
 *     dataFormat:   'dropdown' | '' ...,
 *     lookupName:   '' | 'yes_no',
 *     fieldNames:   ['Worker status', ...],      // every Field name in 4_fields
 *     fieldsByName: { 'Worker status': { lookup: 'active_or_leaver', type: 'string' } },
 *     lookupTables: { yes_no: { values: ['Yes','No'], codes: ['Yes','No'] } },
 *     vocab:        { dataTypes: [...], dataFormats: [...], rules: [...], flags: [...] }
 *   }
 *
 *   Proposal = {
 *     sheet:      'fields' | 'lookups' | 'rules',
 *     column:     '4_fields header text'  |  'table'  |  'Required if' (rule name),
 *     value:      string | boolean | { conditionField, conditionValue } ,
 *     values:     string[]            (lookups only — the new table's values),
 *     confidence: 'high' | 'medium' | 'low' | 'ai',
 *     rule:       'allowed_values' | 'numeric' | ...   (which extractor produced it),
 *     evidence:   'the matched text',
 *     note:       'anything the reviewer should know'
 *   }
 *
 * Adding a rule: push one object onto DP_EXTRACTORS. Each has { id, run(text, sentences, ctx) }.
 */

var DP_RANK = { high: 3, medium: 2, ai: 1.5, low: 1 };

/** Header text of the 4_fields columns we write to. Matched by text, not letter. */
var DP_COL = {
  NAME: 'Field name', TYPE: 'Data type', FORMAT: 'Data format', DESC: 'Description',
  REQUIRED: 'Required', READONLY: 'Read-only', UNIQUE: 'Unique',
  LOOKUP: 'Lookup name', DEPENDS: 'Depends on',
  LENGTH: 'Field length validation', NUMERIC: 'Numeric field validation',
  DATE: 'Date field validation', REGEX: 'Field input validation',
  FLAGS: 'Data cleaning flags', STRICT: 'Strict?', HIDDEN: 'Hidden'
};

/** Fallback vocabulary, used only when _mapping cannot be read. Order matches the sheet. */
var DP_VOCAB_DEFAULT = {
  dataTypes:   ['boolean', 'date', 'float (2)', 'integer', 'string', 'none'],
  dataFormats: ['currency', 'date (dd/mm)', 'date (mm/dd)', 'date (YYYY-MM-DD)', 'date (yyyy/mm/dd)',
                'dropdown (dependent)', 'dropdown', 'email address', 'percentage'],
  rules:       ['Required if', 'Must be empty if', 'At least one required', 'Mutually exclusive',
                'Must be greater than', 'Must be greater than or equal to', 'Must be less than',
                'Must be less than or equal to', 'Must match', 'Must not match', 'Combined fields must be unique'],
  flags:       ['trim_whitespace', 'remove_control_chars', 'normalize_spaces', 'force_upper', 'force_lower', 'strip_non_numeric']
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function dpExtract(description, ctx) {
  var text = dpCleanText_(description);
  if (!text) return [];
  ctx = ctx || {};
  ctx.vocab = ctx.vocab || DP_VOCAB_DEFAULT;
  var sentences = dpSentences_(text);
  var out = [];
  DP_EXTRACTORS.forEach(function (ex) {
    var got;
    try { got = ex.run(text, sentences, ctx) || []; }
    catch (e) { got = [dpP_('fields', DP_COL.DESC, '', 'low', ex.id, '', 'extractor threw: ' + e)]; }
    got.forEach(function (p) { if (!p.rule) p.rule = ex.id; out.push(p); });
  });
  return dpMerge_(out);
}

/** Does the description look like it carries a rule at all? Used to decide whether AI is worth a call. */
function dpHasRuleSignal(description) {
  var t = dpCleanText_(description);
  return /\b(must|only|unless|if|when|required|mandatory|optional|allowed|valid|maximum|minimum|max|min|at least|at most|up to|between|exactly|format|digits?|characters?|unique|blank|empty|one of|either|or|yes\/no|percent|before|after|past|future|uppercase|lowercase|email|iso|code)\b|%|\d/i.test(t);
}

// ---------------------------------------------------------------------------
// Proposal helpers
// ---------------------------------------------------------------------------

function dpP_(sheet, column, value, confidence, rule, evidence, note, extra) {
  var p = { sheet: sheet, column: column, value: value, confidence: confidence, rule: rule || '',
            evidence: evidence || '', note: note || '' };
  if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
  return p;
}

/** One winner per target. Losers are folded into the winner's note so nothing is silently lost. */
function dpMerge_(proposals) {
  var byKey = {};
  var order = [];
  proposals.forEach(function (p) {
    var key = p.sheet + '|' + p.column + '|' + (p.sheet === 'lookups' ? p.value : '');
    if (p.sheet === 'rules') key += '|' + JSON.stringify(p.value);      // distinct rules never collide
    if (!byKey[key]) { byKey[key] = p; order.push(key); return; }
    var cur = byKey[key];
    if (dpSameValue_(cur.value, p.value)) return;                        // same answer twice: keep one
    if (DP_RANK[p.confidence] > DP_RANK[cur.confidence]) { p.note = dpJoinNote_(p.note, 'also proposed: ' + dpFmt_(cur.value) + ' (' + cur.rule + ')'); byKey[key] = p; }
    else { cur.note = dpJoinNote_(cur.note, 'also proposed: ' + dpFmt_(p.value) + ' (' + p.rule + ')'); }
  });
  return order.map(function (k) { return byKey[k]; });
}

function dpSameValue_(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function dpJoinNote_(a, b) { return a ? a + '; ' + b : b; }
function dpFmt_(v) { return typeof v === 'object' ? JSON.stringify(v) : String(v); }

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function dpCleanText_(s) {
  return String(s == null ? '' : s)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\be\.g\./gi, 'e.g').replace(/\bi\.e\./gi, 'i.e')          // keep abbreviations inside one sentence
    .replace(/\s+/g, ' ').trim();
}

function dpSentences_(text) {
  return text.replace(/([.!?;])\s+/g, '$1\n').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
}

function dpNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function dpSlug_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'values'; }
function dpStripQuotes_(s) { return String(s || '').replace(/^["'`]+|["'`.,;:]+$/g, '').trim(); }
function dpNum_(s) { return Number(String(s).replace(/,/g, '')); }
function dpIsExampleSentence_(s) { return /\b(e\.?g\b|for example|for instance|such as|examples?\b)/i.test(s); }

/** "Worker status" ~ "status"? Exact normalized match first, then a unique partial match. */
function dpResolveField_(text, ctx) {
  var norm = dpNorm_(text);
  var names = ctx.fieldNames || [];
  var exact = names.filter(function (n) { return dpNorm_(n) === norm; });
  if (exact.length) return { name: exact[0], match: 'exact' };
  if (norm.length >= 3) {
    var partial = names.filter(function (n) { var nn = dpNorm_(n); return nn.indexOf(norm) >= 0 || norm.indexOf(nn) >= 0; });
    if (partial.length === 1) return { name: partial[0], match: 'partial' };
  }
  return { name: text, match: 'none' };
}

/** Find an existing lookup table whose value set (or code set) equals `items`. */
function dpFindLookupTable_(items, ctx) {
  var want = items.map(dpNorm_).sort().join('|');
  var tables = ctx.lookupTables || {};
  var names = Object.keys(tables);
  for (var i = 0; i < names.length; i++) {
    var t = tables[names[i]];
    var vals = (t.values || []).map(dpNorm_).filter(Boolean).sort();
    var codes = (t.codes || []).map(dpNorm_).filter(Boolean).sort();
    if (dpUnique_(vals).join('|') === want || dpUnique_(codes).join('|') === want) return names[i];
  }
  return '';
}
function dpUnique_(arr) { var seen = {}; return arr.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; }); }

function dpIsNumericType_(t) { return /^(integer|float)/i.test(String(t || '')); }
function dpTypeIsEmpty_(t) { return !t || /^none$/i.test(String(t)); }

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

var DP_EXTRACTORS = [];

// --- 1. Allowed values -> dropdown + lookup table ---------------------------

var DP_LIST_TRIGGERS = [
  /(?:allowed|accepted|acceptable|valid|permitted|possible|available|supported) (?:values|options|entries|inputs|choices|responses|answers)(?: are| include| is)?\s*[:\-–—]?\s*(.+)/i,
  /\b(?:options|values|choices)\s*[:\-–—]\s*(.+)/i,
  /(?:must|should|can|may|needs? to|has to|is to) (?:only )?be (?:one of|either)(?: the following| of the following)?\s*[:\-–—]?\s*(.+)/i,
  /\b(?:one of the following|one of|either)\s*[:\-–—]?\s*(.+)/i,
  /(?:select|choose|pick|enter) (?:one |a value )?(?:from|between|of)(?: the following)?\s*[:\-–—]?\s*(.+)/i
];

function dpSplitList_(raw) {
  var s = String(raw || '').replace(/\.\s*$/, '').trim()
    .replace(/^(?:the following\s+)?(?:values|options|entries|choices|answers)\s*[:\-–—]?\s*/i, '');
  var pieces = s.split(/\s*[,;\/|]\s*/);
  if (pieces.length === 1) pieces = s.split(/\s+or\s+/i);
  else { var last = pieces.pop(); pieces = pieces.concat(last.split(/\s+(?:or|and)\s+/i)); }
  pieces = pieces
    .map(function (x) { return dpStripQuotes_(x.replace(/^(?:or|and)\s+/i, '')); })
    .filter(Boolean);
  var bad = pieces.some(function (x) {
    return x.length > 40 || x.split(/\s+/).length > 5 || /^(if|when|the|a|an|to|for|which|that|this|it|they|you)\b/i.test(x);
  });
  if (bad || pieces.length < 2) return null;
  return dpUnique_(pieces);
}

DP_EXTRACTORS.push({
  id: 'allowed_values',
  run: function (text, sentences, ctx) {
    var found = null, evidence = '', conf = 'high';
    for (var i = 0; i < sentences.length && !found; i++) {
      var s = sentences[i];
      if (dpIsExampleSentence_(s)) continue;
      for (var j = 0; j < DP_LIST_TRIGGERS.length; j++) {
        var m = s.match(DP_LIST_TRIGGERS[j]);
        if (!m) continue;
        var items = dpSplitList_(m[1]);
        if (items) { found = items; evidence = m[0]; break; }
      }
      if (found) break;
      var par = s.match(/\(([^()]*?(?:\/|\bor\b)[^()]*?)\)/i);           // (Yes/No)  (EUR or GBP)
      if (par && !/^\s*-?\d[\d.,]*\s*(?:-|to)\s*-?\d/.test(par[1])) {
        var pi = dpSplitList_(par[1]);
        if (pi) { found = pi; evidence = par[0]; conf = 'medium'; }
      }
    }
    if (!found) {
      var yn = text.match(/\b(yes\s*(?:\/|or)\s*no|y\s*\/\s*n)\b/i);
      if (yn) { found = yn[1].split(/\s*(?:\/|or)\s*/i); evidence = yn[0]; conf = 'medium'; }
    }
    if (!found) return [];
    return dpLookupProposals(found, ctx, conf, 'allowed_values', evidence);
  }
});

/**
 * Shared by the allowed_values extractor and the AI adapter.
 * Given a list of values: set Data format = dropdown, point Lookup name at an existing table
 * whose values match, or propose a new table named after the field.
 */
function dpLookupProposals(items, ctx, conf, rule, evidence) {
  var out = [];
  if (!/dependent/i.test(ctx.dataFormat || ''))
    out.push(dpP_('fields', DP_COL.FORMAT, 'dropdown', conf, rule, evidence));

  var existing = dpFindLookupTable_(items, ctx);
  if (existing) {
    out.push(dpP_('fields', DP_COL.LOOKUP, existing, conf, rule, evidence, 'matches existing table'));
    return out;
  }
  var name = dpSlug_(ctx.fieldName);
  var note = 'new table (' + items.length + ' values)';
  var newConf = conf === 'high' ? 'medium' : conf;                     // a brand-new table always deserves a look
  if (ctx.lookupTables && ctx.lookupTables[name]) { name += '_2'; note += '; a table named ' + dpSlug_(ctx.fieldName) + ' already exists with different values'; newConf = 'low'; }
  out.push(dpP_('fields', DP_COL.LOOKUP, name, newConf, rule, evidence, note));
  out.push(dpP_('lookups', 'table', name, newConf, rule, evidence, note, { values: items }));
  return out;
}

// --- 2. Conditional rules -> 4_complex_validations ---------------------------

var DP_COND_EMPTY = /^(?:.*?\b)?(?:leave (?:it )?(?:blank|empty)|must be (?:blank|empty|left blank)|should be (?:blank|empty|left blank)|do not (?:fill|complete|populate|enter)|must not be (?:provided|populated|filled(?: in)?|entered)|not applicable)\s+(?:if|when|where)\s+(.+)$/i;
var DP_COND_OPTIONAL_UNLESS = /^(?:.*?\b)?(?:optional|not required|not mandatory|may be (?:left )?blank|can be (?:left )?blank|leave (?:it )?blank)\s+(?:unless|except (?:when|if|where))\s+(.+)$/i;
var DP_COND_REQUIRED_IF = /^(?:.*?\b)?(?:only\s+)?(?:required|mandatory|compulsory|must be (?:provided|completed|filled(?: in)?|populated|entered|supplied)|needs? to be (?:provided|completed|filled(?: in)?|entered))\s+(?:only\s+)?(?:if|when|where)\s+(.+)$/i;

function dpParseCondition_(clause, ctx) {
  clause = String(clause || '').replace(/[.;]\s*$/, '').trim();
  var m = clause.match(/^(?:the\s+)?(.+?)\s+(?:is set to|is selected as|is equal to|is marked as|is marked|equals|equal to|==|=|is|contains|has (?:the )?value(?: of)?)\s+(.+)$/i);
  if (!m) return { ok: false, fieldText: clause, value: '', note: 'could not split the condition into field and value' };
  var fieldText = dpStripQuotes_(m[1]), value = dpStripQuotes_(m[2]);
  if (/\s+(?:and|or)\s+.+\s+(?:is|=|equals|contains)\s+/i.test(value))
    return { ok: false, fieldText: fieldText, value: value, note: 'compound condition (and/or); the rule form takes one field + one value per row' };
  if (/^(?:not\s+)?(?:blank|empty|provided|populated|filled(?: in)?|completed|present|missing|set|null|given)$/i.test(value))
    return { ok: false, fieldText: fieldText, value: value, note: 'condition is a presence test ("' + value + '"); the rule form needs a literal value' };
  var res = dpResolveField_(fieldText, ctx);
  var note = res.match === 'none' ? 'condition field "' + fieldText + '" not found in 4_fields'
           : res.match === 'partial' ? 'condition field matched "' + res.name + '" by partial match' : '';
  // canonicalise the value against the condition field's lookup table, if it has one
  var meta = (ctx.fieldsByName || {})[res.name];
  if (meta && meta.lookup && ctx.lookupTables && ctx.lookupTables[meta.lookup]) {
    var t = ctx.lookupTables[meta.lookup];
    var hit = (t.values || []).concat(t.codes || []).filter(function (v) { return dpNorm_(v) === dpNorm_(value); })[0];
    if (hit) value = hit; else note = dpJoinNote_(note, 'value "' + value + '" is not in lookup table ' + meta.lookup);
  }
  return { ok: res.match !== 'none', fieldText: fieldText, field: res.name, match: res.match, value: value, note: note };
}

DP_EXTRACTORS.push({
  id: 'conditional',
  run: function (text, sentences, ctx) {
    var out = [];
    sentences.forEach(function (s) {
      var rule = '', m;
      if ((m = s.match(DP_COND_EMPTY))) rule = 'Must be empty if';
      else if ((m = s.match(DP_COND_OPTIONAL_UNLESS))) rule = 'Required if';
      else if ((m = s.match(DP_COND_REQUIRED_IF))) rule = 'Required if';
      if (!rule) return;
      var c = dpParseCondition_(m[1], ctx);
      var conf = !c.ok ? 'low' : c.match === 'exact' && !/not in lookup/.test(c.note) ? 'high' : 'medium';
      out.push(dpP_('rules', rule, { conditionField: c.field || c.fieldText, conditionValue: c.value }, conf, 'conditional', s, c.note));
    });
    return out;
  }
});

// --- 3. Flags: required / unique / hidden / read-only / strict ----------------

DP_EXTRACTORS.push({
  id: 'flags',
  run: function (text, sentences, ctx) {
    var out = [];
    var conditional = sentences.some(function (s) { return DP_COND_EMPTY.test(s) || DP_COND_OPTIONAL_UNLESS.test(s) || DP_COND_REQUIRED_IF.test(s); });
    sentences.forEach(function (s) {
      var negated = /\b(?:not|isn't|is not|never|no longer)\s+(?:mandatory|required|compulsory)\b/i.test(s);
      var hedged = /\b(?:if|when|unless|where|only|except|depending)\b/i.test(s);
      var soft = /\bfor\b/i.test(s);
      if (!negated && !hedged && !conditional && /\b(?:mandatory|required|compulsory|must be (?:provided|completed|filled(?: in)?|populated|entered|supplied))\b/i.test(s))
        out.push(dpP_('fields', DP_COL.REQUIRED, true, soft ? 'medium' : 'high', 'flags', s.match(/\b(?:mandatory|required|compulsory|must be \w+)\b/i)[0], soft ? 'check the sentence — "for" may scope this to some rows only' : ''));
      if (/\b(?:must be unique|unique (?:per|across|for each|value|identifier)|no duplicates|cannot be duplicated|must not (?:be )?repeat)/i.test(s))
        out.push(dpP_('fields', DP_COL.UNIQUE, true, 'high', 'flags', s.match(/\b(?:unique|duplicat\w+|repeat\w*)\b/i)[0]));
      if (/\b(?:hidden (?:from|to) suppliers?|not (?:shown|visible) to suppliers?|internal use only|do not show to suppliers?)\b/i.test(s))
        out.push(dpP_('fields', DP_COL.HIDDEN, true, 'medium', 'flags', s));
      if (/\b(?:read[- ]only|pre-?filled|pre-?populated|cannot be edited|not editable|do not edit)\b/i.test(s))
        out.push(dpP_('fields', DP_COL.READONLY, true, 'medium', 'flags', s));
      if (/\brejects? the (?:entire |whole )?row\b/i.test(s))
        out.push(dpP_('fields', DP_COL.STRICT, true, 'medium', 'flags', s));
    });
    return out;
  }
});

// --- 4. Data format and data type ---------------------------------------------

DP_EXTRACTORS.push({
  id: 'format',
  run: function (text, sentences, ctx) {
    var out = [], m;
    var blob = (ctx.fieldName || '') + ' :: ' + text;
    var typeEmpty = dpTypeIsEmpty_(ctx.dataType);

    // date shapes
    var dateFmt = '';
    if ((m = text.match(/\bdd[\/\-.]mm[\/\-.]yy(?:yy)?\b/i)))      dateFmt = 'date (dd/mm)';
    else if ((m = text.match(/\bmm[\/\-.]dd[\/\-.]yy(?:yy)?\b/i))) dateFmt = 'date (mm/dd)';
    else if ((m = text.match(/\byyyy-mm-dd\b/i)))                   dateFmt = 'date (YYYY-MM-DD)';
    else if ((m = text.match(/\byyyy\/mm\/dd\b/i)))                 dateFmt = 'date (yyyy/mm/dd)';
    if (dateFmt) {
      out.push(dpP_('fields', DP_COL.FORMAT, dateFmt, 'high', 'format', m[0]));
      if (typeEmpty) out.push(dpP_('fields', DP_COL.TYPE, 'date', 'high', 'format', m[0]));
    } else if (typeEmpty && /\b(?:date|dob|date of birth)\b/i.test(blob) && !/\bupdate\b/i.test(blob)) {
      out.push(dpP_('fields', DP_COL.TYPE, 'date', 'medium', 'format', (blob.match(/\b(?:date of birth|date|dob)\b/i) || [''])[0]));
    }

    if ((m = text.match(/\be-?mail\b/i)))
      out.push(dpP_('fields', DP_COL.FORMAT, 'email address', 'high', 'format', m[0]));
    if ((m = text.match(/\b(?:percentage|percent|per cent)\b|%/i)))
      out.push(dpP_('fields', DP_COL.FORMAT, 'percentage', 'medium', 'format', m[0]));
    if ((m = text.match(/\b(?:currency|monetary|amount in [A-Z]{3}|in (?:EUR|GBP|USD|CHF|PLN)\b|€|£|\$)/)))
      out.push(dpP_('fields', DP_COL.FORMAT, 'currency', 'medium', 'format', m[0]));

    // primitive types (only when the cell is empty — never fight a human's choice)
    if (typeEmpty) {
      if ((m = text.match(/\b(?:true\s*(?:\/|or)\s*false|boolean)\b/i)))
        out.push(dpP_('fields', DP_COL.TYPE, 'boolean', 'high', 'format', m[0]));
      else if ((m = text.match(/\b(?:whole number|integer)\b/i)))
        out.push(dpP_('fields', DP_COL.TYPE, 'integer', 'high', 'format', m[0]));
      else if ((m = text.match(/\b(?:decimal|two decimal|2 decimal|float)\b/i)))
        out.push(dpP_('fields', DP_COL.TYPE, 'float (2)', 'high', 'format', m[0]));
    }
    return out;
  }
});

// --- 5. Numeric bounds -> Numeric field validation (interval notation) --------

var DP_N = '(-?\\d[\\d,]*(?:\\.\\d+)?)';

function dpStripNonNumericNumbers_(s) {
  return s
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(new RegExp('(?:' + DP_N + '\\s*(?:-|–|to|and)\\s*)?' + DP_N + '\\s*(?:characters?|chars?|digits?|letters?|words?|decimal)\\b', 'gi'), ' ');
}

/** Turn {min, minInclusive, max, maxInclusive} into the sheet's interval notation. */
function dpInterval_(b) {
  if (b.exact != null) return 'exact: ' + b.exact;
  if (b.min != null && b.max != null) return (b.minInc ? '[' : '(') + b.min + ', ' + b.max + (b.maxInc ? ']' : ')');
  if (b.min != null) return (b.minInc ? '>= ' : '> ') + b.min;
  if (b.max != null) return (b.maxInc ? '<= ' : '< ') + b.max;
  return '';
}

function dpNumericBounds_(s) {
  var b = {}, ev = [], m;
  var re = function (src) { return new RegExp(src, 'i'); };
  if ((m = s.match(re('\\b(?:between|from)\\s+' + DP_N + '\\s+(?:and|to)\\s+' + DP_N)))) { b.min = dpNum_(m[1]); b.minInc = true; b.max = dpNum_(m[2]); b.maxInc = true; ev.push(m[0]); return { b: b, ev: ev }; }
  if ((m = s.match(re('(?:^|[\\s(])' + DP_N + '\\s*(?:-|–|to)\\s*' + DP_N + '(?=[\\s)]|$)')))) { b.min = dpNum_(m[1]); b.minInc = true; b.max = dpNum_(m[2]); b.maxInc = true; ev.push(m[0].replace(/^[\s(]+/, '').trim()); return { b: b, ev: ev }; }
  if ((m = s.match(re('\\b(?:max(?:imum)?\\.?|at most|up to|no more than|not more than|cannot exceed|must not exceed|may not exceed|not exceeding|less than or equal to|<=)\\s+(?:of\\s+)?' + DP_N)))) { b.max = dpNum_(m[1]); b.maxInc = true; ev.push(m[0]); }
  else if ((m = s.match(re('\\b(?:less than|below|under|lower than|<)\\s+' + DP_N)))) { b.max = dpNum_(m[1]); b.maxInc = false; ev.push(m[0]); }
  else if ((m = s.match(re(DP_N + '\\s+(?:or (?:less|fewer|lower)|and below|maximum|max\\.?)\\b')))) { b.max = dpNum_(m[1]); b.maxInc = true; ev.push(m[0]); }
  if (m) s = s.replace(m[0], ' ');                                       // do not let "not exceed 1,500" also read as "exceeds 1,500"
  if ((m = s.match(re('\\b(?:min(?:imum)?\\.?|at least|no less than|not less than|greater than or equal to|>=)\\s+(?:of\\s+)?' + DP_N)))) { b.min = dpNum_(m[1]); b.minInc = true; ev.push(m[0]); }
  else if ((m = s.match(re('\\b(?:greater than|more than|above|higher than|exceeds?|>)\\s+' + DP_N)))) { b.min = dpNum_(m[1]); b.minInc = false; ev.push(m[0]); }
  else if ((m = s.match(re(DP_N + '\\s+(?:or (?:more|higher|greater|above)|and above|minimum|min\\.?)\\b')))) { b.min = dpNum_(m[1]); b.minInc = true; ev.push(m[0]); }
  else if ((m = s.match(/\b(?:non-?negative|not negative|zero or (?:more|greater|higher|above))\b/i))) { b.min = 0; b.minInc = true; ev.push(m[0]); }
  else if ((m = s.match(/\b(?:positive|greater than zero)\b/i))) { b.min = 0; b.minInc = false; ev.push(m[0]); }
  return { b: b, ev: ev };
}

DP_EXTRACTORS.push({
  id: 'numeric',
  run: function (text, sentences, ctx) {
    var out = [];
    var typeEmpty = dpTypeIsEmpty_(ctx.dataType);
    var numericType = dpIsNumericType_(ctx.dataType);
    var numericWords = /\b(?:number|numeric|amount|rate|quantity|count|hours?|days?|percent(?:age)?|%|value|total|salary|cost|price|fee|age|years?|units?|weeks?|months?|score|budget|headcount|fte|figure)\b/i;
    var blob = (ctx.fieldName || '') + ' :: ' + text;
    if (/^(date|boolean)/i.test(ctx.dataType || '')) return [];

    var merged = {}, evidence = [];
    sentences.forEach(function (s) {
      var r = dpNumericBounds_(dpStripNonNumericNumbers_(s));
      Object.keys(r.b).forEach(function (k) { if (merged[k] == null) merged[k] = r.b[k]; });
      evidence = evidence.concat(r.ev);
    });
    var notation = dpInterval_(merged);
    if (!notation) return [];

    var conf = numericType ? 'high' : (typeEmpty && numericWords.test(blob)) ? 'medium' : 'low';
    var note = numericType ? '' : !typeEmpty ? 'Data type is ' + ctx.dataType + ' — is this a length limit instead?'
             : numericWords.test(blob) ? '' : 'field does not look numeric — check Data type';
    out.push(dpP_('fields', DP_COL.NUMERIC, notation, conf, 'numeric', evidence.join(' / '), note));

    if (typeEmpty) {
      var hasDecimal = /\.\d/.test(notation) || /\b(?:decimal|rate|amount|cost|price|salary|fee|budget|currency|percent)/i.test(blob);
      var wholeWords = /\b(?:whole number|integer|count|number of|quantity|headcount|units?|hours?|days?|weeks?|months?|years?|age)\b/i.test(blob);
      if (wholeWords && !hasDecimal) out.push(dpP_('fields', DP_COL.TYPE, 'integer', 'medium', 'numeric', evidence[0]));
      else if (hasDecimal)           out.push(dpP_('fields', DP_COL.TYPE, 'float (2)', 'medium', 'numeric', evidence[0]));
    }
    return out;
  }
});

// --- 6. Length bounds -> Field length validation -------------------------------

var DP_LEN_UNIT = '\\s*(?:characters?|chars?|letters?)\\b';

function dpLengthBounds_(s) {
  var b = {}, ev = [], m;
  var re = function (src) { return new RegExp(src, 'i'); };
  if ((m = s.match(re('\\b(?:between\\s+)?' + DP_N + '\\s*(?:-|–|to|and)\\s*' + DP_N + DP_LEN_UNIT)))) { b.min = dpNum_(m[1]); b.minInc = true; b.max = dpNum_(m[2]); b.maxInc = true; ev.push(m[0]); return { b: b, ev: ev }; }
  if ((m = s.match(re('\\bexactly\\s+' + DP_N + DP_LEN_UNIT))) || (m = s.match(re('\\b(?:must be|of|is)\\s+' + DP_N + DP_LEN_UNIT + '\\s*(?:long|in length|exactly)')))) { b.exact = dpNum_(m[1]); ev.push(m[0]); return { b: b, ev: ev }; }
  if ((m = s.match(re('\\b(?:max(?:imum)?\\.?(?: length(?: of)?| of)?|up to|no (?:more|longer) than|not (?:more|longer) than|limited to|at most|cannot exceed|must not exceed|less than or equal to)\\s+' + DP_N + DP_LEN_UNIT)))) { b.max = dpNum_(m[1]); b.maxInc = true; ev.push(m[0]); }
  else if ((m = s.match(re(DP_N + DP_LEN_UNIT + '\\s*(?:max(?:imum)?\\.?|or (?:less|fewer|shorter)|limit|at most)')))) { b.max = dpNum_(m[1]); b.maxInc = true; ev.push(m[0]); }
  else if ((m = s.match(re('\\b(?:less than|shorter than|under)\\s+' + DP_N + DP_LEN_UNIT)))) { b.max = dpNum_(m[1]); b.maxInc = false; ev.push(m[0]); }
  else if ((m = s.match(re('\\bmax(?:imum)?\\.? length(?: of| is|:)?\\s*' + DP_N)))) { b.max = dpNum_(m[1]); b.maxInc = true; ev.push(m[0]); }
  if ((m = s.match(re('\\b(?:min(?:imum)?\\.?(?: length(?: of)?| of)?|at least|no (?:less|fewer|shorter) than|not (?:less|fewer|shorter) than)\\s+' + DP_N + DP_LEN_UNIT)))) { b.min = dpNum_(m[1]); b.minInc = true; ev.push(m[0]); }
  else if ((m = s.match(re(DP_N + DP_LEN_UNIT + '\\s*(?:or more|minimum|min\\.?)\\b')))) { b.min = dpNum_(m[1]); b.minInc = true; ev.push(m[0]); }
  else if ((m = s.match(re('\\b(?:more than|longer than|over)\\s+' + DP_N + DP_LEN_UNIT)))) { b.min = dpNum_(m[1]); b.minInc = false; ev.push(m[0]); }
  return { b: b, ev: ev };
}

DP_EXTRACTORS.push({
  id: 'length',
  run: function (text, sentences, ctx) {
    var merged = {}, evidence = [];
    sentences.forEach(function (s) {
      var r = dpLengthBounds_(s);
      Object.keys(r.b).forEach(function (k) { if (merged[k] == null) merged[k] = r.b[k]; });
      evidence = evidence.concat(r.ev);
    });
    var notation = dpInterval_(merged);
    if (!notation) return [];
    var note = dpIsNumericType_(ctx.dataType) ? 'Data type is numeric but the description talks about characters' : '';
    return [dpP_('fields', DP_COL.LENGTH, notation, note ? 'low' : 'high', 'length', evidence.join(' / '), note)];
  }
});

// --- 7. Date bounds -> Date field validation ------------------------------------

DP_EXTRACTORS.push({
  id: 'date',
  run: function (text, sentences, ctx) {
    var blob = (ctx.fieldName || '') + ' :: ' + text;
    var dateish = /^date/i.test(ctx.dataType || '') || /^date/i.test(ctx.dataFormat || '') || /\b(?:date|dob|birth|deadline|expiry|expires?|start|end)\b/i.test(blob);
    if (!dateish) return [];
    var m, v = '';
    var ISO = '(\\d{4}-\\d{2}-\\d{2})';
    if ((m = text.match(/\b(?:cannot|can't|must not|may not|should not|shouldn't|can not) be (?:in the )?future\b|\bno future dates?\b|\bnot (?:a |in the )?future\b|\btoday or (?:earlier|before|in the past)\b|\bon or before today\b|\bup to (?:and including )?today\b/i))) v = '<= TODAY';
    else if ((m = text.match(/\b(?:must|should|has to|needs to) be (?:in the )?past\b|\bpast dates? only\b|\b(?:must|should) be (?:before|earlier than|prior to) today\b|\bbefore today\b|\bin the past\b/i))) v = '< TODAY';
    else if ((m = text.match(/\btoday or (?:later|after|in the future)\b|\bon or after today\b|\btoday onwards\b|\bnot (?:in the )?past\b|\b(?:cannot|can't|must not|may not) be (?:in the )?past\b|\bno past dates?\b/i))) v = '>= TODAY';
    else if ((m = text.match(/\b(?:must|should|has to|needs to) be (?:a |in the )?future\b|\bfuture dates? only\b|\b(?:must|should) be after today\b|\bafter today\b|\bin the future\b/i))) v = '> TODAY';
    else if ((m = text.match(new RegExp('\\b(?:on or after|from|not before|no earlier than|at least|>=)\\s+' + ISO, 'i')))) v = '>= ' + m[1];
    else if ((m = text.match(new RegExp('\\b(?:after|later than|>)\\s+' + ISO, 'i')))) v = '> ' + m[1];
    else if ((m = text.match(new RegExp('\\b(?:on or before|no later than|not after|up to|until|<=)\\s+' + ISO, 'i')))) v = '<= ' + m[1];
    else if ((m = text.match(new RegExp('\\b(?:before|earlier than|prior to|<)\\s+' + ISO, 'i')))) v = '< ' + m[1];
    if (!v) return [];
    var out = [dpP_('fields', DP_COL.DATE, v, 'high', 'date', m[0])];
    if (dpTypeIsEmpty_(ctx.dataType)) out.push(dpP_('fields', DP_COL.TYPE, 'date', 'medium', 'date', m[0]));
    return out;
  }
});

// --- 8. Character shape -> regex, cleaning flags -------------------------------

DP_EXTRACTORS.push({
  id: 'pattern',
  run: function (text, sentences, ctx) {
    var out = [], m;
    if ((m = text.match(/\b(\d+)\s*(?:-|–|to)\s*(\d+)\s*-?\s*digits?\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, '^\\d{' + m[1] + ',' + m[2] + '}$', 'high', 'pattern', m[0]));
    else if ((m = text.match(/\b(\d+)\s*-?\s*digits?\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, '^\\d{' + m[1] + '}$', 'high', 'pattern', m[0]));
    else if ((m = text.match(/\b(?:numbers only|digits only|numeric only|only (?:numbers|digits)|numeric characters only)\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, '^\\d+$', 'medium', 'pattern', m[0]));
    if ((m = text.match(/\b(?:letters only|alphabetic only|only letters|alpha only)\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, '^[A-Za-z\\s]+$', 'medium', 'pattern', m[0]));
    if ((m = text.match(/\balphanumeric\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, '^[A-Za-z0-9]+$', 'medium', 'pattern', m[0]));
    if ((m = text.match(/\bno special characters\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, "^[A-Za-z0-9\\s.,'-]+$", 'medium', 'pattern', m[0]));
    if ((m = text.match(/\biso\b.{0,20}\b(2|two)[- ]letter\b|\b(2|two)[- ]letter\b.{0,20}\biso\b/i))) {
      out.push(dpP_('fields', DP_COL.REGEX, '^[A-Z]{2}$', 'high', 'pattern', m[0]));
      if (ctx.lookupTables && ctx.lookupTables.country_iso && /countr/i.test((ctx.fieldName || '') + text)) {
        var cn = 'existing table country_iso — check whether the dropdown should show codes or names';
        out.push(dpP_('fields', DP_COL.LOOKUP, 'country_iso', 'medium', 'pattern', m[0], cn));
        if (!/dependent/i.test(ctx.dataFormat || '')) out.push(dpP_('fields', DP_COL.FORMAT, 'dropdown', 'medium', 'pattern', m[0], cn));
      }
    } else if ((m = text.match(/\biso\b.{0,20}\b(3|three)[- ]letter\b|\b(3|three)[- ]letter\b.{0,20}\biso\b/i)))
      out.push(dpP_('fields', DP_COL.REGEX, '^[A-Z]{3}$', 'high', 'pattern', m[0]));
    if ((m = text.match(/\b(?:upper ?case|capital letters|in capitals|all caps)\b/i)))
      out.push(dpP_('fields', DP_COL.FLAGS, 'force_upper', 'high', 'pattern', m[0]));
    else if ((m = text.match(/\blower ?case\b/i)))
      out.push(dpP_('fields', DP_COL.FLAGS, 'force_lower', 'high', 'pattern', m[0]));
    return out;
  }
});

// ---------------------------------------------------------------------------
// Validation of proposal values against the sheet's notation (shared with the AI adapter)
// ---------------------------------------------------------------------------

var DP_RE_INTERVAL = /^(?:exact:\s*-?\d+(?:\.\d+)?|[\[(]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[\])]|(?:<=|>=|<|>)\s*-?\d+(?:\.\d+)?)$/;
var DP_RE_DATE = /^(?:<=|>=|<|>)\s*(?:TODAY|\d{4}-\d{2}-\d{2})$/i;

/** Returns '' when the value is acceptable for the column, otherwise the reason. Canonicalises vocabulary casing in place. */
function dpValidateFieldValue(p, vocab) {
  vocab = vocab || DP_VOCAB_DEFAULT;
  var v = p.value;
  var pick = function (list) { var hit = list.filter(function (x) { return dpNorm_(x) === dpNorm_(v); })[0]; if (hit) p.value = hit; return !!hit; };
  switch (p.column) {
    case DP_COL.TYPE:    return pick(vocab.dataTypes) ? '' : 'unknown data type "' + v + '"';
    case DP_COL.FORMAT:  return pick(vocab.dataFormats) ? '' : 'unknown data format "' + v + '"';
    case DP_COL.REQUIRED: case DP_COL.READONLY: case DP_COL.UNIQUE: case DP_COL.STRICT: case DP_COL.HIDDEN:
      if (typeof v === 'boolean') return '';
      if (/^(true|yes|1)$/i.test(String(v))) { p.value = true; return ''; }
      if (/^(false|no|0)$/i.test(String(v))) { p.value = false; return ''; }
      return 'not a boolean: "' + v + '"';
    case DP_COL.LENGTH: case DP_COL.NUMERIC:
      return DP_RE_INTERVAL.test(String(v).trim()) ? '' : 'not interval notation: "' + v + '"';
    case DP_COL.DATE:
      if (!DP_RE_DATE.test(String(v).trim())) return 'not date notation: "' + v + '"';
      p.value = String(v).trim().replace(/today/i, 'TODAY'); return '';
    case DP_COL.REGEX:
      try { new RegExp(String(v)); return ''; } catch (e) { return 'regex does not compile: ' + e; }
    case DP_COL.FLAGS: {
      var flags = String(v).split(/\s*,\s*/).filter(Boolean);
      var bad = flags.filter(function (f) { return vocab.flags.indexOf(f) < 0; });
      return bad.length ? 'unknown cleaning flag(s): ' + bad.join(', ') : '';
    }
    case DP_COL.LOOKUP: case DP_COL.DEPENDS:
      return /^[a-z0-9_]+$/i.test(String(v)) ? '' : 'lookup name must be a plain identifier: "' + v + '"';
    default:
      return 'column "' + p.column + '" is not writable by this tool';
  }
}

if (typeof module !== 'undefined') module.exports = {
  dpExtract: dpExtract, dpHasRuleSignal: dpHasRuleSignal, dpValidateFieldValue: dpValidateFieldValue,
  dpLookupProposals: dpLookupProposals, dpResolveField_: dpResolveField_, dpMerge_: dpMerge_, dpP_: dpP_, dpNorm_: dpNorm_,
  DP_COL: DP_COL, DP_VOCAB_DEFAULT: DP_VOCAB_DEFAULT, dpSplitList_: dpSplitList_, dpParseCondition_: dpParseCondition_
};

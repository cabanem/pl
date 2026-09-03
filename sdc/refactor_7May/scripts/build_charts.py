"""Supplier test charts.

Usage:  python build_charts.py <responses.xlsx> [output_dir]

Reads the Google Forms response sheet (as exported to .xlsx), codes each
choice answer as positive / negative / N/A, and writes three PNGs:
  1_scorecard_by_stage.png  - answers by journey stage, Round 1 vs Round 2
  2_question_grid.png       - traffic-light grid, one cell per tester/round/question
  3_freetext_themes.png     - hand-coded free-text issue themes (see THEMES below)
plus choice_coding.csv, the per-answer coding behind charts 1 and 2.

Requires: pandas, openpyxl, matplotlib.
"""
import sys, os
import pandas as pd, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

SRC = sys.argv[1] if len(sys.argv) > 1 else 'Supplier_test_responses.xlsx'
OUT = sys.argv[2] if len(sys.argv) > 2 else '.'
os.makedirs(OUT, exist_ok=True)

df = pd.read_excel(SRC)
df.columns = [c.strip() for c in df.columns]
cols = list(df.columns)
df['round'] = df['Test Scenario'].str.startswith('E1').map({True: 'Round 1', False: 'Round 2'})
tester_map = {'Csaba László': 'Tester 1', 'Péter Kovács': 'Tester 2', 'Hanna Tóth-Lederhaas': 'Tester 3'}
df['tester'] = df['Tester Name'].str.strip().map(tester_map)

# ---- choice questions: (label, column index, stage, kind) ----
# kind: 'yes' = positive iff answer starts with Yes; 'expect:<prefix>' = positive iff starts with prefix; 'no' = positive iff starts with No
Q = [
 ("Invitation email clear",            5,  "Invitation & access", "yes"),
 ("Portal link worked",                6,  "Invitation & access", "yes"),
 ("Found task unaided",                7,  "Invitation & access", "yes"),
 ("Data-entry instructions clear",     10, "Excel template",      "yes"),
 ("Template downloaded",               11, "Excel template",      "yes"),
 ("Locked cells protected",            12, "Excel template",      "expect:The cell refused"),
 ("Dropdown sub-menus cascade",        13, "Excel template",      "yes"),
 ("Free text rejected in dropdowns",   14, "Excel template",      "expect:The form rejected"),
 ("Dates & amounts display cleanly",   15, "Excel template",      "yes"),
 ("Required fields marked",            16, "Web form",            "yes"),
 ("Missing field flagged on submit",   17, "Web form",            "expect:The form stopped"),
 ("Input guidance while typing",       18, "Web form",            "yes"),
 ("Submit confirmation shown",         19, "Web form",            "yes"),
 ("Form locked after submit",          20, "Web form",            "expect:It is locked"),
 ("Upload succeeded first try",        21, "Upload & status",     "yes"),
 ("Status updated after upload",       22, "Upload & status",     "expect:\"Received\""),
 ("No internal codes exposed",         24, "Upload & status",     "no"),
 ("Noticed change request unaided",    25, "Rework & error msgs", "expect:I saw"),
 ("Corrected upload accepted",         27, "Rework & error msgs", "yes"),
 ("Bad-file error message clear",      31, "Rework & error msgs", "yes"),
 ("Knew what to fix from error",       32, "Rework & error msgs", "yes"),
 ("Blank-form error message clear",    37, "Rework & error msgs", "yes"),
 ("Completion was clear",              28, "Completion",          "yes"),
 ("No leftover upload buttons",        30, "Completion",          "no"),
]
def classify(v, kind):
    if pd.isna(v): return 'na'
    s = str(v).strip()
    if s.startswith('N/A'): return 'na'
    if kind == 'yes':   return 'pos' if s.startswith('Yes') else 'neg'
    if kind == 'no':    return 'pos' if s.startswith('No') else 'neg'
    pref = kind.split(':',1)[1]
    return 'pos' if s.startswith(pref) else 'neg'

rows = []
for label, ci, stage, kind in Q:
    for _, r in df.iterrows():
        rows.append(dict(q=label, stage=stage, round=r['round'], tester=r['tester'],
                         result=classify(r[cols[ci]], kind), answer=r[cols[ci]]))
res = pd.DataFrame(rows)
res.to_csv(os.path.join(OUT, 'choice_coding.csv'), index=False)

stages = ["Invitation & access","Excel template","Web form","Upload & status","Rework & error msgs","Completion"]
sc = res[res.result!='na'].groupby(['stage','round','result']).size().unstack(fill_value=0).reindex(
        pd.MultiIndex.from_product([stages, ['Round 1','Round 2']]), fill_value=0)
print(sc)

POS, NEG, NA = '#3B7DD8', '#E8833A', '#D5D5D5'
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':12})

# ---------- Chart 1: stage scorecard ----------
fig, ax = plt.subplots(figsize=(12, 6.2))
y = np.arange(len(stages))[::-1] * 2.0
h = 0.72
for i, rnd in enumerate(['Round 1','Round 2']):
    yy = y + (0.42 if i == 0 else -0.42)
    pos = [sc.loc[(s, rnd)].get('pos', 0) for s in stages]
    neg = [sc.loc[(s, rnd)].get('neg', 0) for s in stages]
    ax.barh(yy, pos, h, color=POS, edgecolor='white')
    ax.barh(yy, neg, h, left=pos, color=NEG, edgecolor='white', hatch='///' )
    for j, (p, n) in enumerate(zip(pos, neg)):
        if p: ax.text(p/2, yy[j], str(p), ha='center', va='center', color='white', fontweight='bold')
        if n: ax.text(p + n + 0.15, yy[j], f'{n} problem' + ('s' if n>1 else ''), ha='left', va='center', color='#B85A16', fontweight='bold', fontsize=11)
        if p + n == 0: ax.text(0.15, yy[j], 'not tested', va='center', color='#888', fontsize=10, style='italic')
        ax.text(-0.25, yy[j], rnd, ha='right', va='center', fontsize=10, color='#555')
ax.set_yticks(y); ax.set_yticklabels(stages, fontsize=13, fontweight='bold')
ax.tick_params(axis='y', length=0, pad=62)
ax.set_xlabel('Answers from 3 testers (one answer per question per tester)')
ax.set_xlim(0, 21); ax.set_xticks(range(0, 21, 4))
for s in ['top','right','left']: ax.spines[s].set_visible(False)
ax.set_title('Onboarding and error handling worked for everyone;\ntemplate formats and "am I done?" did not',
             fontsize=16, fontweight='bold', loc='left', pad=14)
ax.legend(handles=[Patch(color=POS, label='Worked as expected'), Patch(facecolor=NEG, hatch='///', label='Problem reported')],
          loc='lower right', frameon=False)
fig.text(0.01, 0.01, 'Round 1 = E1 clean upload (26 Aug). Round 2 = E2 rework after deliberate validation failure (31 Aug–1 Sep). '
         'Web-form questions were only answered by 2 testers in Round 1.', fontsize=9, color='#666')
plt.tight_layout(rect=(0,0.03,1,1))
plt.savefig(os.path.join(OUT, '1_scorecard_by_stage.png'), dpi=200, facecolor='white')
plt.close()

# ---------- Chart 2: traffic-light grid ----------
testers = ['Tester 1','Tester 2','Tester 3']
colkeys = [(r, t) for r in ['Round 1','Round 2'] for t in testers]
labels = [q[0] for q in Q]
fig, ax = plt.subplots(figsize=(11, 10.5))
color = {'pos': POS, 'neg': NEG, 'na': NA}
mark  = {'pos': '✓', 'neg': '✗', 'na': '–'}
for i, lab in enumerate(labels):
    for j, (r, t) in enumerate(colkeys):
        v = res[(res.q==lab)&(res['round']==r)&(res.tester==t)].result.iloc[0]
        x = j + (0.35 if j >= 3 else 0)
        ax.add_patch(plt.Rectangle((x, -i), 0.92, 0.92, color=color[v]))
        ax.text(x+0.46, -i+0.46, mark[v], ha='center', va='center',
                color='white' if v!='na' else '#777', fontsize=14, fontweight='bold')
# stage separators + labels
prev = None
for i, q in enumerate(Q):
    if q[2] != prev:
        if i: ax.axhline(-i+0.96, color='#999', lw=0.8, xmin=0.0, xmax=1.0)
        prev = q[2]
ax.set_xlim(-0.1, 6.5); ax.set_ylim(-len(labels)+0.9, 1.9)
ax.set_yticks([-i+0.46 for i in range(len(labels))]); ax.set_yticklabels(labels, fontsize=11)
ax.set_xticks([j + (0.35 if j>=3 else 0) + 0.46 for j in range(6)])
ax.set_xticklabels(['T1','T2','T3','T1','T2','T3'], fontsize=11)
ax.xaxis.tick_top(); ax.tick_params(length=0)
ax.text(1.46, 1.35, 'Round 1 · E1 clean upload', ha='center', fontsize=12, fontweight='bold')
ax.text(4.81, 1.35, 'Round 2 · E2 rework', ha='center', fontsize=12, fontweight='bold')
for s in ax.spines.values(): s.set_visible(False)
ax.set_title('Start of the journey was clean for every tester;\nrepeat problems cluster around formats, exposed codes and completion',
             fontsize=14, fontweight='bold', loc='left', pad=40)
ax.legend(handles=[Patch(color=POS, label='✓ worked'), Patch(color=NEG, label='✗ problem'), Patch(color=NA, label='– not tested / N/A')],
          loc='lower center', bbox_to_anchor=(0.5, -0.05), ncol=3, frameon=False, fontsize=11)
plt.tight_layout()
plt.savefig(os.path.join(OUT, '2_question_grid.png'), dpi=200, facecolor='white')
plt.close()

# ---------- Chart 3: free-text issue themes ----------
# Free-text comments were coded by hand; see issue_coding.md for the item-level list.
# Edit these counts if you recode.
themes = [  # (theme, round1, round2)
 ("Date, number & currency formats", 5, 2),
 ("Template guidance & wording",     6, 1),
 ("Status & deadline clarity",       3, 3),
 ("Links & login",                   1, 3),
 ("Rework feedback clarity",         1, 2),
 ("Validation rule gaps",            1, 2),
]
themes.sort(key=lambda t: -(t[1]+t[2]))
fig, ax = plt.subplots(figsize=(12, 5.8))
y = np.arange(len(themes))[::-1]
r1 = [t[1] for t in themes]; r2 = [t[2] for t in themes]
ax.barh(y+0.2, r1, 0.38, color='#5B6B7C', label='Round 1 (17 issues)')
ax.barh(y-0.2, r2, 0.38, color='#C9A227', label='Round 2 (13 issues)', hatch='..')
for i in range(len(themes)):
    ax.text(r1[i]+0.12, y[i]+0.2, str(r1[i]), va='center', fontsize=11)
    ax.text(r2[i]+0.12, y[i]-0.2, str(r2[i]), va='center', fontsize=11)
ax.set_yticks(y); ax.set_yticklabels([t[0] for t in themes], fontsize=13)
ax.tick_params(axis='y', length=0)
ax.set_xlim(0, 7.5); ax.set_xlabel('Distinct issues raised in free-text comments')
for s in ['top','right','left']: ax.spines[s].set_visible(False)
ax.set_title('30 distinct issues in 6 comment fields:\ntemplate formats and wording lead; status, links and rework follow',
             fontsize=14, fontweight='bold', loc='left', pad=14)
ax.legend(loc='lower right', frameon=False)
fig.text(0.01, 0.01, 'Same 3 testers in both rounds, so Round 2 comments mostly add new issues rather than repeat Round 1 ones. '
         'Counts are distinct issues, not testers.', fontsize=9, color='#666')
plt.tight_layout(rect=(0,0.03,1,1))
plt.savefig(os.path.join(OUT, '3_freetext_themes.png'), dpi=200, facecolor='white')
plt.close()
print('done')

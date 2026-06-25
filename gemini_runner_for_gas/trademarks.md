# Trademark Clearance — Source Checklist & Runner Config

A defined source set per market, plus the config that makes the runner screen every
proposed name against that same set. This is a **preliminary screen**, not a legal
clearance opinion; depth (how many states, how deep into common-law) is a dial that
counsel calibrates to risk and budget.

How the pieces fit: the checklist below names the *target* sources. The config at the
bottom embeds those names into the prompt, so the model is told exactly what to consult
and is required to flag any register finding it could not directly verify. With grounding
on, the model genuinely covers the open-web / common-law layer; the official registers
(behind JS apps, anti-bot, or APIs) are the parts to confirm manually or via API later.

---

## United States

US rights flow from **use**, not just registration — so the common-law layer is
non-negotiable, not optional.

| Layer | Source | Access point | Covers / notes |
|---|---|---|---|
| Federal register | USPTO Trademark Search ("TESS II") | tmsearch.uspto.gov | All federal applications + registrations (Principal + Supplemental), live and dead. The spine. JS app with anti-bot; no real-time API — bulk XML via data.uspto.gov. |
| Status / file history | USPTO TSDR | tsdr.uspto.gov (API: tsdrapi.uspto.gov) | Status, prosecution history, documents, images by serial or registration number. API by key. |
| Disputes | USPTO TTAB — TTABVUE | ttabvue.uspto.gov | Oppositions, cancellations, and proceedings — a mark in active dispute changes the risk read. |
| State registers | State Secretaries of State | per-state portals (50) | Marks registered only at state level never appear federally yet still carry in-state rights. |
| Common law / unregistered | Open web + business, domain, social, marketplace | Google; SoS business-entity search; DBA / fictitious-name filings; WHOIS / domain registrations; social handles; app stores; marketplaces (Amazon); HR-tech & B2B SaaS trade directories | Unregistered prior users can block or geographically limit a federal registration. This is the grounding-friendly layer. |

## Europe

Largely **first-to-file**, so the registers dominate — but "the register" is plural, and
the UK now sits outside the EU system entirely.

| Layer | Source | Access point | Covers / notes |
|---|---|---|---|
| EU register | EUIPO (EUTM) | euipo.europa.eu (eSearch plus; REST API) | EU Trade Marks + Madrid designations of the EU. Unitary across 27 states → blockable by an earlier right in **any one** member state. |
| Multi-office aggregator | TMview | tmview.tmdn.org | EUIPO + all EU national offices + many non-EU offices in one search. The practical definitive European sweep. |
| Key national registers | e.g. DPMA (DE), INPI (FR) | national office portals | Deeper national dives for priority markets or where TMview coverage is thin. |
| International | WIPO Global Brand Database | branddb.wipo.int | Madrid International Registrations, Lisbon appellations, 6ter emblems, plus national collections. |
| United Kingdom | UKIPO | trademarks.ipo.gov.uk / gov.uk/search-for-trademark | Separate since Brexit — mandatory if the UK matters. Include the cloned "comparable UK rights": **UK009** (from EUTMs) and **UK008** (from EU designations of IRs). |
| Unregistered | UK passing-off; well-known marks; trade names; domains | Open web; Companies House (UK); ccTLDs (.co.uk, .de, .fr, .eu) | Thinner than the US but real — especially UK passing-off (goodwill in an unregistered mark) and Paris Convention 6bis well-known marks. |

## Cross-cutting search dimensions (apply to every source)

- **Identical + variants:** phonetic, alternate spellings, and translations — not just the exact string.
- **Figurative elements:** if the brand includes a logo, design-code / image search, not only word search.
- **Classes:** the relevant Nice classes (9, 42, 35) **plus coordinated / related classes**, since confusion is judged across related goods and services.
- **Status & ownership:** distinguish live vs dead marks; capture the owner/applicant.
- **Per-jurisdiction reporting:** organize findings by jurisdiction (US / EU / UK) so coverage gaps are visible.

---

## Runner config

Keep the existing five `output_fields`; the checklist lives in the prompt, so every name
is screened against the same set with no code change. Grounding adds the `Sources` column
automatically.

### output_fields (one per line)

```
Exact Matches
Similar / Phonetic
Common Law & Marketplace
Risk Level
Recommendation
```

### system_instruction

```
You are an experienced Intellectual Property and Trademark Attorney specializing in B2B software, HR technology, and corporate enterprise tools. You produce careful, well-structured preliminary clearance screens.

Screen each proposed name against the defined source set for each market. For every finding, distinguish clearly between (a) results you could verify against a source and (b) results that require manual confirmation in the official register. Never invent registration or application numbers — if you cannot confirm a specific filing, say so explicitly and label it "requires manual confirmation."

Organize findings by jurisdiction (US, EU, UK). Treat this as a preliminary screen, not a legal opinion.
```

### prompt_template

```
Conduct a preliminary trademark clearance screen for a new B2B data-collection / HR-tech software tool. The owner and applicant will be REDACTED (along with its groups and affiliates).

Proposed name to analyze: "{{ProposedName}}"

Screen against these sources, and within each section organize findings by jurisdiction (US / EU / UK). Where you cannot directly verify a register entry, state the finding and mark it "requires manual confirmation in <source>".

US sources:
- USPTO federal register (Trademark Search / TESS II), including Principal and Supplemental registers
- USPTO TTAB (TTABVUE) for oppositions and cancellations
- US state trademark registers (Secretaries of State)
- US common-law use: general web, business-entity and DBA filings, domain registrations, social handles, app stores, marketplaces, and HR-tech / B2B SaaS directories

Europe sources:
- EUIPO (EU Trade Mark register)
- National registers of EU member states (via TMview)
- WIPO Global Brand Database (Madrid International Registrations)
- UKIPO, including comparable UK rights (UK009 / UK008 prefixes)
- European unregistered rights: UK passing-off, well-known marks, trade names, and key ccTLD domains

For every source, search the exact name plus phonetic, spelling, and translation variants, and weigh the relevant Nice classes — Class 9 (Software), Class 42 (SaaS / Data Services), and Class 35 (Employment / HR Services) — together with their coordinated and related classes.

Structure your response in these sections:

[[Exact Matches]] Active, pending, or recently abandoned marks matching this exact name, by jurisdiction. Give owner and registration/application number where confirmable; otherwise mark "requires manual confirmation".

[[Similar / Phonetic]] Marks that sound alike, are spelled similarly, or share meaning within software, data, or HR/staffing, by jurisdiction.

[[Common Law & Marketplace]] Unregistered tools, SaaS platforms, startups, domains, or social/marketplace usage that could pose prior-use or passing-off risk.

[[Risk Level]] A single rating — Low, Moderate, High, or Very High — for REDACTED's ability to safely use, register, and defend this mark in the US and UK, with brief reasoning.

[[Recommendation]] Pursue as-is, modify (prefix / descriptive word), or abandon — with a one-line rationale.

Note any limits on your confidence. This is a preliminary screen, not a definitive legal opinion.
```

---

## Optional: per-market fields variant

If you'd rather have findings split into their own columns for sorting or side-by-side
review, swap the field list for a per-jurisdiction layout and adjust the section labels in
the prompt to match:

```
US Register
US Common Law
EU Register (EUIPO / TMview)
UK Register (UKIPO)
EU/UK Unregistered
Risk Level
Recommendation
```

This trades a wider sheet for cleaner per-market comparison; the single-list version above
keeps the report compact. Either works with the same runner.

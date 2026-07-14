# Data Validation in Supplier Templates: What Excel Can Enforce, and What Actually Enforces Our Rules

## Summary

We regularly receive requests to add validation rules and cell locking to the supplier data collection workbooks. This note explains why those measures cannot guarantee data quality no matter how many we add, identifies where enforcement genuinely lives in our process, and recommends where further investment will actually move the defect rate. The short version: everything inside a workbook is a guide rail, not a gate. Guide rails are worth having because they reduce honest errors, but the gate is our intake validation, and the highest-leverage improvements are the ones that make that gate faster, friendlier, and smarter — not additional rules inside a file we no longer control.

## Why workbook rules cannot enforce anything

An Excel file is a document, not a program. When we add a validation rule to a column, we are writing a note into the file that says "values here should look like this." Nothing in the file runs or watches the cells. The note is read by whatever application the supplier opens the file in, and it is consulted at exactly one moment: when a person types into a cell and presses Enter.

Paste bypasses this entirely, and it is worse than a simple bypass. A standard paste replaces the destination cell wholesale — value, formatting, and the validation rule itself. After pasting from an unvalidated source, the cell no longer even carries our rule. Pasting values only preserves the rule but never evaluates it, so the invalid value lands anyway. Since suppliers overwhelmingly fill these templates by pasting from their own systems, the validation rules are effectively not present on the path most data actually travels.

Cell locking has the same character. Locking only operates while sheet protection is on, and protection is honored by the application rather than enforced by the file — it can be removed by anyone with the file in hand, no password cracking required. More fundamentally, the cells suppliers fill in must be unlocked for them to work at all, and unlocked cells accept pastes. Locking protects our headers and formulas from accidents; it does nothing for the data we are collecting.

Finally, we do not control which application opens the file. Google Sheets, LibreOffice, and Apple Numbers each support these features partially and differently, and can silently drop rules on import.

The practical conclusion: once the file leaves our hands, we cannot inspect quality into it. In-file rules remain useful as error-proofing for suppliers acting in good faith — a dropdown genuinely reduces typos — but each additional rule adds template complexity and maintenance cost while the assurance level stays exactly the same, because assurance was never coming from the workbook.

## Where enforcement actually lives

Enforcement requires a system we control evaluating the data. In our process, that is the intake validation pipeline: every submitted file is checked against the full rule set on our side, regardless of what happened inside the workbook. Enforcement already exists — its weakness is latency. A supplier who pastes bad data finds out after submission, sometimes days later, and that slow correction loop is the real source of the pain that prompts requests for more in-file rules.

The improvements that follow from this are about tightening the loop rather than adding rules. A pre-flight self-check would let suppliers upload a draft file and receive a cell-by-cell error report within seconds, then formally submit once clean — the same enforcement, but the supplier experiences it as instant feedback instead of a rejection letter. Returning failed submissions with errors annotated directly in the offending cells shortens the correction cycle further.

For data that is not bulk tabular — contacts, attestations, configuration choices — the supplier portal is the strongest option available: values are entered into controlled fields validated at the moment of entry, so an invalid value never comes into existence. The reason we do not move everything there is that web forms are a poor experience for pasting hundreds of rows of tabular data. The sensible division is portal fields for scalar and low-volume data (absolute enforcement), file upload for the bulk payload (enforced at intake, with the feedback loop tightened as above).

## What about Microsoft 365?

Hosting the workbook in SharePoint rather than emailing it changes who owns the document, which is meaningful, but it does not change how Excel treats a paste — the same rules are consulted at the same moments, so the core problem is untouched. Browser-only editing can prevent suppliers from stripping sheet protection, but making that stick requires access policies configured and governed at the tenant level, which in a client-facing context is a governance negotiation rather than a template fix. Automated monitoring of a hosted workbook is possible but runs on a delay measured in minutes, not keystrokes. (What adopting this would actually involve — the mechanisms, the governance, the timeline, and what is and is not gained — is laid out in the appendix.)

The one M365 capability that genuinely changes the picture is Microsoft Lists. A List is not a file; it is a database table with a spreadsheet-style editing surface. Column types and validation rules are enforced on the server at the moment of writing, there is no local copy where the rules cease to exist, and bulk paste from Excel is supported with failing rows flagged and blocked rather than silently accepted — precisely the property a workbook can never provide. The trade-offs are that external suppliers need guest access set up and governed, and the built-in rule language is simpler than our intake engine, so complex cross-record checks would remain at intake. For engagements where the tabular data is regular enough for Lists' validation to cover it, this is a credible middle option between file upload and full portal entry, and worth evaluating per client.

Building a separate data-entry application in Power Apps or similar would duplicate the portal we already operate, at additional licensing cost for external users, without adding enforcement the portal does not already provide.

## Making the gate smarter: reference data

Everything above concerns where checks run. There is a second, independent question: what the checks know. Today our validation is largely syntactic — it confirms that a value is shaped like a date, that a code matches an allowed list, that required fields are present. A curated reference database behind the intake gate makes validation semantic: it can confirm that a cost center actually exists in the client's structure, that a rate is plausible for that role and market, that a supplier or worker matches one we have seen before rather than creating a duplicate under a new spelling.

To be clear about what this does and does not change: a database is not real-time enforcement. It does not alter when checks run or reach into a supplier's spreadsheet — a supplier can still paste anything into the file. What it changes is what happens at the moments we already control. Combined with the pre-flight self-check, the practical experience is that a supplier submits a draft and learns within a minute not just that a field is malformed, but that the value does not exist or does not make sense — which is where much of our costly bad data actually lives, since "syntactically valid but wrong" is invisible to any format rule.

This investment compounds across every option in this note, because the same reference data feeds all of them. It populates the dropdowns in the workbook templates, so the courtesy rails are generated from truth rather than maintained by hand. It gives the pre-flight check its depth. It backs the portal's fields with live lookups. It generates the choice columns in any Microsoft Lists pilot. One source of truth strengthening every layer at once, instead of the same lists maintained separately in each place.

Two conditions keep this from backfiring. First, reference data is a governance commitment: every table implicitly claims to be complete and current, and a stale table produces false rejections — the supplier is right, our data is wrong — which erodes trust in the gate faster than a missing check would. Each reference table therefore needs a named owner and an update path before it is allowed to reject anything, and checks against client-furnished data (which drifts) should warn and route to analyst review rather than hard-block, reserving hard failure for data we fully control. Second, we should grow this table by table, driven by observed defects rather than designed up front: each recurring class of bad data justifies exactly one reference table, with its owner attached. A handful of tables that each eliminate a known defect is worth more than a comprehensive data model waiting for use cases.

## Recommendation

Keep the existing in-file dropdowns and masks as a courtesy to suppliers, but treat them as user experience, not control — and stop adding new ones by default, since each carries cost and adds no assurance. Invest instead in the intake feedback loop, starting with a pre-flight self-check so suppliers catch and fix errors in seconds rather than days. Migrate scalar fields into the portal, where enforcement is absolute. Evaluate Microsoft Lists for specific clients whose tabular data fits its validation model. And grow a reference data layer behind the intake gate, one owned table per recurring defect, so that over time the same checks stop merely confirming that values are well-formed and start confirming that they are true.

Going forward, the most productive form for a data-quality request is: "here is the bad data we are seeing." From that, we can guarantee the intake gate catches it, add a courtesy rule in the template where it helps suppliers get it right the first time, and be honest about which of those two is doing the enforcing.

## Appendix: What SharePoint hosting would involve

If we pursued hosted workbooks, the shape would be this: the file lives in a SharePoint site in our tenant, suppliers access it as invited guests, and they edit it in the browser — the file never leaves our control as a copy. This appendix covers how that is enforced, what it requires organizationally, what it buys us, what it does not, and how long it would take.

### How browser-only editing is enforced

There are two mechanisms, and which one is available depends on licensing we may already hold. The first is SharePoint's block download policy: a per-site setting that gives users browser-only access with no ability to download, print, or sync, while still allowing editing in the browser (download-blocking and read-only are separate switches, so suppliers can work in the file without ever being able to take a copy of it). This is part of the SharePoint Advanced Management license tier, which is also included when the organization holds Copilot licensing — so it may already be available to us. The second mechanism is a Conditional Access policy with app-enforced restrictions, which achieves the same browser-only outcome through identity policy rather than a site setting; it requires Entra ID P1 licensing and is administered by the identity team as tenant-level policy. The per-site mechanism is the better fit for our model, because each engagement's site can carry the policy as part of provisioning rather than requiring tenant-wide policy work per client.

### How suppliers get in

Suppliers authenticate as business guests through Microsoft Entra. A common concern here — "our suppliers won't have Microsoft accounts" — no longer applies: when an invited guest has no existing account of any kind, they receive a one-time passcode at their email address and enter it to sign in. Email plus a code is the entry requirement, and this fallback is on by default. Microsoft has also consolidated all external SharePoint sharing onto this guest model, so building on it aligns with the platform's direction rather than a legacy path. The governance obligations that come with guests are lifecycle ones: restricting who (or what automation) can send invitations, deciding whether guests face multi-factor authentication, and defining how access is reviewed and removed when an engagement closes.

### Isolation between suppliers

Supplier lists are competitively sensitive, so each supplier must be unable to see, list, or infer any other supplier's presence. In SharePoint this is a permission architecture: per-supplier files or folders with unique permissions and no shared site-level access for guests. This is mechanical, can be automated as part of the same provisioning step that creates the files, and is fully auditable — every access is logged against a named guest identity, a property emailed attachments can never have.

### What is gained — and what is not

The gains are custody and integrity, not validation. Custody: with download blocked, no copy of the file exists outside our tenant — significant given the confidential seeded data these templates carry, which today sits indefinitely in supplier inboxes and drives. Integrity: a browser-only supplier cannot strip sheet protection, so structural locking becomes real for the first time. Process: there is one live document rather than a chain of attachments — submission becomes a state change instead of a file transfer, version history is complete, expiring-link problems disappear, and access can be revoked instantly. What is not gained: any improvement to data validation. Pasting into Excel in the browser behaves exactly as it does on the desktop, so data quality still comes entirely from the intake gate and the reference data layer. Hosted workbooks should be justified as a data-protection and process-integrity measure, not a data-quality one.

### Timeline

The engineering is small — extending provisioning to create sites and permissions is days of build plus testing. The elapsed time is governance, and it forks on one factual question: do we already hold the necessary licenses and an external-sharing posture that permits guests? If yes, the path is internal change control — a security review of the guest-access design, policy configuration, and a pilot with one supplier — realistically four to eight weeks elapsed, most of it review rather than work. If licensing must be procured or external sharing is currently disabled, the honest planning horizon is a quarter. Which world we are in can be established with a single inquiry to IT covering three questions: do we hold SharePoint Advanced Management (or Copilot) licensing; do we hold Entra ID P1; and what is our current external-sharing and guest-invitation policy.

None of this competes with the reference data work. The two sit on different axes — custody versus knowledge — involve different teams, and can proceed in parallel: the licensing inquiry can be sent immediately, and the reference data pilot runs while governance review proceeds.

## Sources

**Excel validation and protection behavior**

1. Microsoft Support — *More on data validation*. States that data validation is designed to show messages and prevent invalid entries only when users type directly into a cell, and that messages do not appear when data is copied or filled.
https://support.microsoft.com/en-us/office/more-on-data-validation-f38dee73-9900-4ca6-9301-8a5f6e1f0c4c

2. Microsoft Support — *Protect a worksheet*. States that worksheet-level protection is not intended as a security feature and only prevents modification of locked cells.
https://support.microsoft.com/en-us/office/protect-a-worksheet-3179efdb-1285-4d49-a9c3-f4ca36276de6

3. Microsoft Support — *Protection and security in Excel*. Distinguishes file-level encryption from workbook- and worksheet-level protection and cautions against assuming a protected workbook is secure.
https://support.microsoft.com/en-us/office/protection-and-security-in-excel-be0b34db-8cb6-44dd-a673-0b3e3475ac2d

4. Microsoft Q&A — *Excel Data validation: copy and paste can bypass data validation*. Community thread with Microsoft-hosted confirmation that a normal paste carries the source cell's validation settings over the destination's.
https://learn.microsoft.com/en-us/answers/questions/4911368/excel-data-validation-copy-and-paster-can-over-pas

5. Ecma International — *ECMA-376, Office Open XML file formats*. The standard defining .xlsx as a zip package of XML parts (the basis for the "document, not a program" point).
https://ecma-international.org/publications-and-standards/standards/ecma-376/

**Hosted-workbook access controls**

6. Microsoft Learn — *Block download policy for SharePoint sites and OneDrive*. Site-level policy giving users browser-only access with no download, print, or sync; requires SharePoint Advanced Management licensing.
https://learn.microsoft.com/en-us/sharepoint/block-download-from-sites

7. Microsoft Learn — *Use app-enforced restrictions*. Conditional Access session controls that limit SharePoint access to the browser.
https://learn.microsoft.com/en-us/sharepoint/app-enforced-restrictions

8. Microsoft Learn — *Control access from unmanaged devices*. Browser-only access enforcement via Microsoft Entra Conditional Access, including blocking editing in desktop apps.
https://learn.microsoft.com/en-us/sharepoint/control-access-from-unmanaged-devices

**Microsoft Lists**

9. Microsoft Support — *Add, edit, or delete list items*. Documents grid-view editing, including pasting multiple items from an Excel range, with values required to match column types.
https://support.microsoft.com/en-us/sharepoint/lists/data-and-lists/add-edit-or-delete-list-items

10. Microsoft Support — *Examples of common formulas in lists*. The validation formula language available to list columns, including the limitation that calculated fields operate only on their own row and cannot reference other lists.
https://support.microsoft.com/en-us/office/examples-of-common-formulas-in-lists-d81f5f21-2b4e-45ce-b170-bf7ebf6988b3

**External guest access**

11. Microsoft Learn — *Email one-time passcode authentication* (Microsoft Entra External ID). Fallback authentication for guests without a Microsoft, Entra, or federated account; enabled by default.
https://learn.microsoft.com/en-us/entra/external-id/one-time-passcode

12. Microsoft Learn — *Microsoft Entra B2B integration for SharePoint and OneDrive*. Guest authentication for shared files, list items, and sites via Entra B2B, with one-time passcode used when the guest has no existing account.
https://learn.microsoft.com/en-us/sharepoint/sharepoint-azureb2b-integration

 # Contract Intake — Quick Guide

*Before sharing: replace everything in [square brackets] with your links and names, then delete this line.*

Contract Intake reads a contract, pulls out the key terms, and lets you check and correct them before they are sent to Salesforce. You never type data into Salesforce yourself. You drop a file in a folder, review a short sheet, and tick a box.

---

## How it works

**1. Add a contract.**
Drop the file into the **Intake folder**: [link]. PDFs (including scans), Google Docs, and Word files all work. PDFs need to be under 15 MB.

**2. Wait for the Chat message.**
Within a few minutes a message appears in the **[Chat space name]** space: *"Contract staged for review"* with an **Open review sheet** button. The original file moves to the Processed folder automatically. If you don't get a message within about ten minutes, see *When something goes wrong* below.

**3. Review the sheet.**
The review sheet is a small Google Sheet named *Contract Review: [your file name]*. It has two parts:

- **The details at the top** — a link to the original contract, when it was read, its status, and the **Approved?** checkbox. You don't need to change anything here except the checkbox.
- **The field list** — three columns: **Field**, **Extracted**, and **Approved**.
  - **Extracted** is what the AI found in the contract. Leave this column alone; it's kept as a record.
  - **Approved** starts out as a copy of Extracted. **This is the only column you edit.** Fix anything that's wrong, fill in anything that's missing, and leave a cell blank if the contract truly doesn't say.

  Open the original contract (the link at the top) and check each value against it. Long values may spill past the cell edge — click into the cell to see the whole thing.

**4. Tick Approved?**
When every value in the Approved column is right, tick the **Approved?** checkbox at the top. That's it. Within about five minutes the contract is sent to Salesforce, the sheet's **Status** changes to **Pushed**, and the sheet moves to the **Pushed folder**: [link].

Only the Approved column is sent. Your corrections are kept alongside the original extraction, so there's always a record of what changed and why.

---

## Checking on things: the home base

**[Dashboard URL]** is a live view of the whole pipeline. It refreshes on its own every minute and is read-only, so you can't break anything by looking.

- **Awaiting review** — how many contracts are waiting on someone, and whether any need attention.
- **Staged / Pushed / Errors today** — what has happened so far today.
- **In the queue** — every contract waiting for review, with a link to each sheet, how long it has been waiting, and any error.
- **Errors, last 2 days** and **Today** — what went wrong recently and what happened today, newest first.
- **Ingestion / Approvals** at the top right are the system's heartbeats. **OK** means the automation is running normally. **Stale** means it hasn't run in more than fifteen minutes — nothing is lost, but nothing is moving either. Let [owner name] know.

---

## When something goes wrong

**I dropped a file and got a "Contract extraction FAILED" message instead of a review sheet.**
The file moved to the **Failed folder**: [link]. The Chat message says why. The usual reasons are a file type the tool doesn't read (only PDF, Google Docs, and Word), or a PDF over 15 MB. Fix the file and drop it into the Intake folder again.

**I ticked Approved? and got a "Push FAILED" message.**
The sheet stays in the Pending folder, its Status shows **Error**, and a **Last Error** line on the sheet gives the reason. Two kinds:

- *The message is about the data* (for example, a value in the wrong format or a required field that's blank). Untick **Approved?**, fix the Approved column, and tick it again.
- *The message is about the system* (a timeout, or a number like 502). The tool retries automatically every few minutes for as long as the box is ticked, so a temporary hiccup clears on its own. If the same error keeps appearing on the dashboard, tell [owner name].

**I ticked the box before I was finished.**
If the Status still says *Pending Review*, just untick it — nothing has been sent yet. If it already says *Pushed*, follow *Fixing something after it was sent* below.

**Two review sheets appeared for the same contract.**
Rare, but possible. Review one and delete the other.

**The dashboard shows a heartbeat as Stale, or the "Awaiting review" number isn't moving.**
The automation has paused. Your sheets and files are safe where they are. Tell [owner name].

---

## Fixing something after it was sent

Every contract carries a **Correlation ID** (shown at the top of its sheet). Salesforce uses it to recognise the same contract, so re-sending a corrected sheet **updates** the existing record rather than creating a duplicate.

1. Open the sheet in the **Pushed folder** and correct the Approved column.
2. Make sure **Approved?** is still ticked.
3. Move the sheet back into the **Pending folder**: [link].

Within about five minutes it's re-sent, the Status shows **Pushed** again with a new *Pushed At* time, and the sheet moves back to the Pushed folder.

---

## Please don't

- Don't edit the **Extracted** column or the labels in the left-hand column. The tool reads the sheet by those labels.
- Don't add or delete rows in the field list, and don't change the Correlation ID.
- Don't move review sheets anywhere other than described above. A sheet is only picked up while it's in the Pending folder.
- Don't rename the sheet's **Review** tab.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Send a new contract to Salesforce | Drop it in the Intake folder, review the sheet, tick **Approved?** |
| Find a sheet I was sent | Click the button in the Chat message, or the link in **In the queue** on the dashboard |
| See what's waiting or what failed | Open the dashboard: [Dashboard URL] |
| Retry a contract that failed to read | Fix the file, drop it in the Intake folder again |
| Retry a contract that failed to send | Fix the Approved column if the error is about the data; otherwise wait — it retries by itself |
| Change something already in Salesforce | Fix the sheet in Pushed, keep the box ticked, move it to Pending |
| Get help | [owner name / contact] |

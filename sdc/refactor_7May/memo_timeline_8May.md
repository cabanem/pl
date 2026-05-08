# SDC Platform — Status

**Date:** 8 May 2026
**From:** Emily, Automation Center of Excellence
**Subject:** Status of the Supplier Data Collection platform

## Where the work stands

The platform has been redesigned before launch.

The first round of development produced a working implementation, but the team did not get the chance to test it end-to-end before issues with its design surfaced. Rather than ship and patch, the platform has been put through a structured redesign phase. That phase is now closing.

Concrete deliverables produced during the redesign:

- A workflow inventory covering all ten workflows the platform supports.
- A new data model, reduced from 22 tables to 18, with cleaner relationships.
- Four capability deep dives covering the core of what the platform does (configuration validation, template generation, supplier invitation, supplier input validation).
- A callable triage of the first-round implementation, identifying what is reusable and what is not.
- Resolutions for the open design questions surfaced by the deep dives.
- A close-read of the first-round template-generation code that identified a silent bug — dependent dropdowns produce blank lists for parent values containing certain characters. The fix is part of the redesign. The bug would have shipped if the platform had gone live as originally built.

The redesign has produced more documentation than is typical for a project of this size. This is deliberate. It allows the build phase to proceed without re-deciding things, and it gives anyone who picks up the work a complete picture of what was decided and why.

## What remains

Eleven capabilities to build, varying in size from small wrappers around platform primitives to substantial work. The build sequence is dependency-ordered and starts with the foundational pieces (schema, cross-cutting utilities, and the two capabilities that have no upstream dependencies).

The work is structured in three phases:

- **Phase 0 — Design.** Closing. Two small items remain (data model finalization and sibling capability scoping).
- **Phase 1 — Foundational build.** Schema, status-change handler, event emission, and the first two capabilities. This phase ends with a working demonstration of configuration validation end-to-end, which an analyst can run against a real configuration workbook.
- **Phase 2 — Completion build.** The remaining capabilities, ending with first production use.

There is no separate migration phase. The platform has not been live, so there are no clients to move and no system to decommission.

## On timeline

I am deliberately not committing to a single end-date at this point. The honest position: the work has eleven distinct capabilities of varying size, and the implementation rate for the redesigned architecture is not yet measured. Any number given now would be a guess.

The first defensible total estimate will be available after Phase 1's foundational build. At that point I will have built two complete capabilities against the new design and will know the actual implementation rate, which can be applied to the remaining nine. Until then, ranges given would be wide enough to be unhelpful.

What I can commit to now: a Phase 1 completion checkpoint with a working demonstration. I will provide a target date for that checkpoint once Phase 1 starts and the first two weeks of work establish a baseline pace.

What I will not commit to: a number drawn from the first-round development experience. The first round took three months, but most of that time was spent discovering the design problems the redesign now addresses. That is not a useful predictor of how long the redesigned architecture takes to build.

## If timeline is fixed

If there is a fixed external date the platform needs to meet, the conversation that produces a workable plan is about scope, not pace. Of the eleven capabilities, six are core; three are operational quality-of-life improvements that can ship in a follow-on release; two operate on error paths or have transitional fallbacks available. A reduced-scope first release is feasible against an aggressive date if the trade-offs are explicitly accepted.

I would rather have that conversation now than discover it is needed later.

## What I need

Two things from stakeholders at this point:

1. Acknowledgement of the phased approach and the rationale for not committing to a total timeline yet.
2. Visibility into any fixed date dependencies (client commitments, budget cycles, internal milestones) that would shape the scope conversation above.

## Reference materials

The following design documents are available for review:

- Workflow inventory and stages
- Data model
- Four capability deep dives
- Callable triage with cluster resolutions

Happy to walk through any of these in detail.

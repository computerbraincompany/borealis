# M07 — Small-team platform: sharing snapshots, audit plane, automations

**Horizon:** 3 — *Sharing snapshots inside a trust boundary. An administration
and audit plane that fits a desktop-and-cluster deployment. Automations with
human review for work that already has artifacts and evidence.*

**Status:** PLANNED (blocked on M02/M04/M05 substrate being real in practice)

## Sketch

- Shareable artifact snapshots (report/chart bundles) with an explicit policy
  — never a public paste.
- An audit view of "what left the building" built on the M03 consent ledger.
- Automations only after artifacts + evidence are durable in daily use; every
  automation step must produce inspectable, bounded work with human review.

## Guardrails

- Vision order applies: artifacts before sharing; agents before automations;
  governance when there is more than one person to govern.

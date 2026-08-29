# M06 — Contained-model lifecycle on macOS

**Horizon:** 1 ("the object on the desk") — *Contained-model lifecycle on
macOS as a first-class path beside "paste a cluster origin."*

**Status:** PLANNED (heavy; spec to be finalized before implementation)

## Sketch

- A "Contained" provider mode inside Borealis.app: download, verify, and
  lifecycle chat/embedding weights under `userData`, serve an
  OpenAI-compatible surface on loopback, and show download/health state in the
  chrome beside the M01 strip.
- The rest of Borealis must not change: contained mode is just another
  OpenAI-compatible endpoint satisfying the existing contract.

## Guardrails

- Weights are large; download must be resumable, checksum-verified, and
  cancellable, and must never block the ledger.
- Contained mode is offline-capable by definition: no egress, no consent gate
  interaction, telemetry-free.
- Desktop-only; browser development keeps the plain-endpoint story.

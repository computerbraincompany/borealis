
-- Schema v27 — per-recipe notification preference for reviewed briefs (M16
-- stage 2 step 8: "Users can disable local notifications per recipe").
-- Contiguous at merge: schema v26 (the M16 reviewed-brief ledger) precedes
-- this entry in the ordered migration array, and v1..v26 all ship historical
-- fixtures; this is the next free slot.
--
-- notifications_enabled is a head-only mutable knob, NOT recipe revision
-- content: toggling it appends no revision, changes no frozen content hash,
-- and reschedules nothing. While 0, the brief run store suppresses NEW
-- brief_notifications rows for that recipe's runs (first_draft,
-- meaningful_change, attention, and paused alike) with the existing
-- (run, kind) dedupe untouched; the five-failure pause transition itself
-- still happens — pausing is durable scheduling state, never a notification.
-- Existing rows are never retro-deleted.
ALTER TABLE brief_recipes
  ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (notifications_enabled IN (0,1));

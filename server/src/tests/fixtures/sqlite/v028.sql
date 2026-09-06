
-- Schema v28 — nullable failed-publication indicator for reviewed-brief runs
-- (M16 stage 3 step 7: "A render failure returns the review to
-- awaiting_review with a failed-publication indicator and bounded error").
-- Contiguous at merge: schema v27 (the per-recipe notification preference)
-- precedes this entry in the ordered migration array, and v1..v27 all ship
-- historical fixtures; this is the next free slot.
--
-- publication_error_code records the bounded, content-free code of the last
-- failed publication render for the run's stable publication operation UUID
-- (reused unchanged across approval retries). It is set when a run returns
-- from 'publishing' to 'awaiting_review' after a failed render and cleared
-- by the next accepted approval decision (a new review attempt) — never by
-- time passing. It carries no content: the full attempt detail stays on the
-- document publication intent ledger, and the run row only proves whether
-- the review inbox must show the failed-publication indicator. Nullable
-- default NULL leaves every historical run unindicated.
ALTER TABLE brief_runs
  ADD COLUMN publication_error_code TEXT
  CHECK (publication_error_code IS NULL OR length(publication_error_code) BETWEEN 1 AND 64);

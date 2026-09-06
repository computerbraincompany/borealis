-- Committed aggregate for the M16 weekly-brief fixture.
-- `brief_inputs` is the table name for the loaded CSV (see manifest.json).
-- Integer-cent amounts keep SUM exact in IEEE-754.
SELECT SUM(amount) AS total FROM brief_inputs WHERE category = 'Office';

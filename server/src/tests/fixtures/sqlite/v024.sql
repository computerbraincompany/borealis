
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  account_id UNINDEXED,
  source_id UNINDEXED,
  generation UNINDEXED
);

CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, content, chunk_id, account_id, source_id, generation)
  VALUES (new.rowid, new.content, new.id, new.account_id, new.source_id, CAST(new.generation AS TEXT));
END;

CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.rowid;
  INSERT INTO chunks_fts (rowid, content, chunk_id, account_id, source_id, generation)
  VALUES (new.rowid, new.content, new.id, new.account_id, new.source_id, CAST(new.generation AS TEXT));
END;

INSERT INTO chunks_fts (rowid, content, chunk_id, account_id, source_id, generation)
  SELECT rowid, content, id, account_id, source_id, CAST(generation AS TEXT) FROM chunks ORDER BY rowid;
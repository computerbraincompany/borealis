import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { openSqliteLedger } from "../db/sqlite.js";

export interface WaveFixture {
  accountId: string;
  mcpReadyId: string;
  mcpUntestedId: string;
  captureId: string;
  analysisId: string;
  documentId: string;
  revisionId: string;
  publicationId: string;
  publicationDirectory: string;
  publicationHtml: string;
  publicationPdf: string;
  renderingIntentId: string;
  renderingDirectory: string;
  cleanupJobId: string;
  cleanupDirectory: string;
  deletedDocumentId: string;
  templateId: string;
  webdavReadyId: string;
  webdavUntestedId: string;
  folderReadyId: string;
  grantedRoot: string;
  itemId: string;
  stagedItemId: string;
  stagedSourceId: string;
  readyDocSourceId: string;
  candidateFile: string;
  previewId: string;
  refreshId: string;
  secretRecord: string;
  keyFile: string;
}

export async function populateWaveLedger(
  workspace: string,
  tabular: { accountId: string; sourceId: string }
): Promise<WaveFixture> {
  const accountId = tabular.accountId;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const fixture: WaveFixture = {
    accountId,
    mcpReadyId: randomUUID(),
    mcpUntestedId: randomUUID(),
    captureId: randomUUID(),
    analysisId: randomUUID(),
    documentId: randomUUID(),
    revisionId: randomUUID(),
    publicationId: randomUUID(),
    publicationDirectory: "",
    publicationHtml: "",
    publicationPdf: "",
    renderingIntentId: randomUUID(),
    renderingDirectory: "",
    cleanupJobId: randomUUID(),
    cleanupDirectory: "",
    deletedDocumentId: randomUUID(),
    templateId: randomUUID(),
    webdavReadyId: randomUUID(),
    webdavUntestedId: randomUUID(),
    folderReadyId: randomUUID(),
    grantedRoot: "",
    itemId: randomUUID(),
    stagedItemId: randomUUID(),
    stagedSourceId: randomUUID(),
    readyDocSourceId: randomUUID(),
    candidateFile: "",
    previewId: randomUUID(),
    refreshId: randomUUID(),
    secretRecord: "",
    keyFile: "",
  };
  // M13 publication artifacts ride the report directory's private `documents`
  // namespace; M14 refresh staging rides the uploads namespace. The rendering
  // intent's directory and the cleanup job's directory intentionally do not
  // exist (crash states), so the assertions cover the ledger columns alone.
  fixture.publicationDirectory = path.join(
    workspace,
    "reports",
    "documents",
    accountId,
    fixture.documentId,
    fixture.publicationId
  );
  fixture.renderingDirectory = path.join(workspace, "reports", "documents", accountId, fixture.documentId, "pending");
  fixture.cleanupDirectory = path.join(
    workspace,
    "reports",
    "documents",
    accountId,
    fixture.deletedDocumentId,
    "interrupted"
  );
  fixture.publicationHtml = path.join(fixture.publicationDirectory, "index.html");
  fixture.publicationPdf = path.join(fixture.publicationDirectory, "index.pdf");
  fixture.candidateFile = path.join(workspace, "uploads", accountId, fixture.stagedSourceId, "staged-candidate.bin");
  const externalParent = await fs.realpath(path.dirname(workspace));
  fixture.grantedRoot = path.join(externalParent, "granted-external-folder");
  await fs.mkdir(fixture.publicationDirectory, { recursive: true });
  await fs.mkdir(path.dirname(fixture.candidateFile), { recursive: true });
  await fs.mkdir(fixture.grantedRoot, { recursive: true });
  await fs.writeFile(fixture.publicationHtml, "<html>wave publication</html>");
  await fs.writeFile(fixture.publicationPdf, "%PDF-wave-publication");
  await fs.writeFile(fixture.candidateFile, "staged knowledge bytes\n");
  // Machine-bound custody: encrypted records plus the operator key file that
  // archives must exclude (mirrors the real browser-development layout).
  const secretsDirectory = path.join(workspace, "secrets", accountId);
  await fs.mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(workspace, "secrets"), 0o700);
  fixture.secretRecord = path.join(secretsDirectory, `${fixture.mcpReadyId}.json`);
  await fs.writeFile(
    fixture.secretRecord,
    `${JSON.stringify({ v: 1, alg: "AES-256-GCM", iv: "aWd", tag: "dGFn", ct: "Y3Q" })}\n`,
    { mode: 0o600 }
  );
  fixture.keyFile = path.join(workspace, "connections.key");
  await fs.writeFile(fixture.keyFile, `${"0f".repeat(32)}\n`, { mode: 0o600 });

  const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
  try {
    await ledger.run(
      `INSERT INTO connections (id,account_id,name,kind,discovery_revision,config,status)
       VALUES (?,?,'mcp ready','mcp_http',1,?,'ready')`,
      [fixture.mcpReadyId, accountId, JSON.stringify({ kind: "mcp_http", url: "https://mcp.example.test/mcp" })]
    );
    await ledger.run(
      `INSERT INTO connections (id,account_id,name,kind,config,status)
       VALUES (?,?,'mcp untested','mcp_stdio',?,'untested')`,
      [
        fixture.mcpUntestedId,
        accountId,
        JSON.stringify({ kind: "mcp_stdio", command: "/usr/local/bin/wave-server", args: ["--stdio"], cwd: null }),
      ]
    );
    await ledger.run(
      `INSERT INTO connection_tool_snapshots
         (connection_id,account_id,discovery_revision,position,tool_id,name,description,input_schema)
       VALUES (?, ?,1,0,'tool-1','wave_tool','wave discovery tool','{"type":"object"}')`,
      [fixture.mcpReadyId, accountId]
    );
    const chatId = randomUUID();
    const runId = randomUUID();
    await ledger.run(
      "INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,'Wave chat','wave-model','all')",
      [chatId, accountId]
    );
    await ledger.run("INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'completed')", [
      runId,
      accountId,
      chatId,
    ]);
    await ledger.run("INSERT INTO query_captures (id,account_id,run_id,sql,sources) VALUES (?,?,?,?,?)", [
      fixture.captureId,
      accountId,
      runId,
      "SELECT month, amount FROM ledger ORDER BY month",
      JSON.stringify([tabular.sourceId]),
    ]);
    await ledger.run("INSERT INTO analyses (id,account_id,title,current_revision) VALUES (?,?,'Wave analysis',1)", [
      fixture.analysisId,
      accountId,
    ]);
    await ledger.run(
      `INSERT INTO analysis_revisions (analysis_id,revision,account_id,title,sql,source_ids,origin_capture_id)
       VALUES (?,1,?,'Wave analysis','SELECT month FROM ledger',?,?)`,
      [fixture.analysisId, accountId, JSON.stringify([tabular.sourceId]), fixture.captureId]
    );
    await ledger.run(
      `INSERT INTO analysis_sources (analysis_id,source_id,account_id,ready_generation,content_identity)
       VALUES (?,?,?,1,'wave-identity')`,
      [fixture.analysisId, tabular.sourceId, accountId]
    );
    const analysisRunId = randomUUID();
    await ledger.run(
      "INSERT INTO analysis_runs (id,account_id,analysis_id,revision,status,parameter_values) VALUES (?,?,?,1,'succeeded','[]')",
      [analysisRunId, accountId, fixture.analysisId]
    );
    await ledger.run(
      `INSERT INTO analysis_run_sources (run_id,source_id,account_id,ready_generation,content_identity)
       VALUES (?,?,?,1,'wave-identity')`,
      [analysisRunId, tabular.sourceId, accountId]
    );
    await ledger.run(
      `INSERT INTO analysis_results
         (id,account_id,analysis_id,run_id,revision,columns,rows,returned_rows,row_count_exact)
       VALUES (?,?,?,?,1,'["month","amount"]','[["2026-01",42]]',1,1)`,
      [randomUUID(), accountId, fixture.analysisId, analysisRunId]
    );
    await ledger.run("INSERT INTO documents (id,account_id,title,current_revision) VALUES (?,?,'Wave document',1)", [
      fixture.documentId,
      accountId,
    ]);
    await ledger.run(
      `INSERT INTO document_revisions (id,document_id,revision,account_id,title,payload,author_kind)
       VALUES (?, ?,1,?,'Wave document','{"blocks":[]}','user')`,
      [fixture.revisionId, fixture.documentId, accountId]
    );
    await ledger.run(
      `INSERT INTO document_publications
         (id,account_id,document_id,revision_id,revision,version,title,html_path,pdf_path)
       VALUES (?,?,?,?,1,1,'Wave document',?,?)`,
      [
        fixture.publicationId,
        accountId,
        fixture.documentId,
        fixture.revisionId,
        fixture.publicationHtml,
        fixture.publicationPdf,
      ]
    );
    await ledger.run(
      `INSERT INTO document_publication_intents
         (id,account_id,document_id,revision_id,revision,operation_id,status,artifact_directory,html_path,pdf_path,publication_id)
       VALUES (?,?,?,?,1,'wave-operation-completed','completed',?,?,?,?)`,
      [
        randomUUID(),
        accountId,
        fixture.documentId,
        fixture.revisionId,
        fixture.publicationDirectory,
        fixture.publicationHtml,
        fixture.publicationPdf,
        fixture.publicationId,
      ]
    );
    await ledger.run(
      `INSERT INTO document_publication_intents
         (id,account_id,document_id,revision_id,revision,operation_id,status,artifact_directory)
       VALUES (?,?,?,?,1,'wave-operation-pending','rendering',?)`,
      [fixture.renderingIntentId, accountId, fixture.documentId, fixture.revisionId, fixture.renderingDirectory]
    );
    await ledger.run("INSERT INTO document_artifact_cleanup_jobs (document_id,account_id) VALUES (?,?)", [
      fixture.deletedDocumentId,
      accountId,
    ]);
    await ledger.run(
      "INSERT INTO document_publication_cleanup_jobs (id,account_id,document_id,artifact_directory) VALUES (?,?,?,?)",
      [fixture.cleanupJobId, accountId, fixture.documentId, fixture.cleanupDirectory]
    );
    await ledger.run(
      `INSERT INTO document_templates (id,account_id,name,snapshot) VALUES (?,?,'Wave template','{"headings":[]}')`,
      [fixture.templateId, accountId]
    );
    await ledger.run(
      `INSERT INTO knowledge_connections (id,account_id,kind,name,config,credential_configured,status)
       VALUES (?,?,'webdav','Wave WebDAV','{"url":"https://dav.example.test/files"}',1,'ready')`,
      [fixture.webdavReadyId, accountId]
    );
    await ledger.run(
      `INSERT INTO knowledge_connections (id,account_id,kind,name,config,credential_configured,status)
       VALUES (?,?,'webdav','Wave WebDAV untested','{"url":"https://dav2.example.test/files"}',1,'untested')`,
      [fixture.webdavUntestedId, accountId]
    );
    await ledger.run(
      `INSERT INTO knowledge_connections (id,account_id,kind,name,config,watch_enabled,status)
       VALUES (?,?,'desktop_folder','Wave folder',?,1,'ready')`,
      [
        fixture.folderReadyId,
        accountId,
        JSON.stringify({ root_path: fixture.grantedRoot, display_label: "Granted Folder" }),
      ]
    );
    await ledger.run(
      `INSERT INTO sources (id,account_id,name,kind,display_name,mime,size_bytes,status,meta)
       VALUES (?,?,'wave-doc-a','document','Wave Doc A','text/markdown',12,'ready','{}')`,
      [fixture.readyDocSourceId, accountId]
    );
    await ledger.run(
      `INSERT INTO sources (id,account_id,name,kind,display_name,mime,size_bytes,status,meta)
       VALUES (?,?,'wave-doc-b','document','Wave Doc B','text/markdown',12,'ready','{}')`,
      [fixture.stagedSourceId, accountId]
    );
    await ledger.run(
      `INSERT INTO knowledge_items
         (id,account_id,connection_id,relative_path,source_id,content_hash,ingested_hash,size_bytes)
       VALUES (?,?,?, 'finance/notes.md',?,?,?,12)`,
      [fixture.itemId, accountId, fixture.webdavReadyId, fixture.readyDocSourceId, hash("notes"), hash("notes")]
    );
    await ledger.run(
      `INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash,size_bytes)
       VALUES (?,?,?, 'finance/staged.md',?,?,21)`,
      [fixture.stagedItemId, accountId, fixture.webdavReadyId, fixture.stagedSourceId, hash("staged")]
    );
    await ledger.run(
      `INSERT INTO knowledge_previews
         (id,account_id,connection_id,status,scan_limit_entries,scan_limit_depth,scan_limit_visited,scan_limit_bytes,expires_at)
       VALUES (?,?,?,'complete',100,5,100,1048576,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`,
      [fixture.previewId, accountId, fixture.webdavReadyId]
    );
    await ledger.run(
      `INSERT INTO knowledge_preview_entries
         (preview_id,account_id,entry_id,ordinal,relative_path,classification,content_hash,size_bytes,selection_token)
       VALUES (?,?, 'entry-1',0,'finance/notes.md','new',?,12,?)`,
      [fixture.previewId, accountId, hash("notes"), hash("selection-a")]
    );
    await ledger.run(
      `INSERT INTO knowledge_preview_entries
         (preview_id,account_id,entry_id,ordinal,relative_path,classification,content_hash,size_bytes,selection_token)
       VALUES (?,?, 'entry-2',1,'finance/staged.md','new',?,21,?)`,
      [fixture.previewId, accountId, hash("staged"), hash("selection-b")]
    );
    await ledger.run(
      `INSERT INTO knowledge_refreshes (id,account_id,connection_id,expected_connection_revision,status,finished_at)
       VALUES (?,?,?,1,'completed',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [fixture.refreshId, accountId, fixture.webdavReadyId]
    );
    await ledger.run(
      `INSERT INTO knowledge_refresh_items
         (refresh_id,account_id,item_id,connection_id,source_id,relative_path,status,target_hash,expected_generation,promoted_generation)
       VALUES (?,?,?, ?, ?, 'finance/notes.md','committed',?,2,1)`,
      [fixture.refreshId, accountId, fixture.itemId, fixture.webdavReadyId, fixture.readyDocSourceId, hash("notes")]
    );
    await ledger.run(
      `INSERT INTO knowledge_refresh_items
         (refresh_id,account_id,item_id,connection_id,source_id,relative_path,status,target_hash,candidate_path,candidate_size_bytes)
       VALUES (?,?,?, ?, ?, 'finance/staged.md','staged',?,?,21)`,
      [
        fixture.refreshId,
        accountId,
        fixture.stagedItemId,
        fixture.webdavReadyId,
        fixture.stagedSourceId,
        hash("staged"),
        fixture.candidateFile,
      ]
    );
  } finally {
    await ledger.close();
  }
  return fixture;
}

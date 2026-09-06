import { MAX_API_KEY_CHARS, MAX_ENDPOINT_CHARS, MODEL_ID_MAX_CHARS } from "../settingsStore.js";
import {
  MAX_CONNECTION_NAME_CHARS,
  MAX_CONNECTION_URL_CHARS,
  MAX_STDIO_ARGS,
  MAX_STDIO_ARG_CHARS,
  MAX_STDIO_COMMAND_CHARS,
} from "../connections/store.js";
import {
  MAX_SECRET_ENV_ENTRIES,
  MAX_SECRET_HEADER_ENTRIES,
  MAX_SECRET_NAME_CHARS,
  MAX_SECRET_VALUE_CHARS,
} from "../connections/secrets.js";
import {
  CONNECTOR_DISPLAY_NAME_MAX_CHARS,
  CONNECTOR_TABLE_MAX_CHARS,
  CONNECTOR_URL_MAX_CHARS,
  PREFERENCE_MODEL_MAX_CHARS,
} from "./schemas.js";
import {
  ANALYSIS_COMPARISON_KEY_MAX_COLUMNS,
  ANALYSIS_DESCRIPTION_MAX_CHARS,
  ANALYSIS_LABEL_MAX_CHARS,
  ANALYSIS_PARAMETER_MAX_COUNT,
  ANALYSIS_PARAMETER_STRING_MAX_CHARS,
  ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS,
  ANALYSIS_SOURCE_MAX_COUNT,
  ANALYSIS_SQL_MAX_CHARS,
  ANALYSIS_TITLE_MAX_CHARS,
} from "../analysisTypes.js";
import { MAX_KNOWLEDGE_RELATIVE_PATH_CHARS } from "../db/stores/knowledgeStore.js";
import { MAX_DIRECTORY_IMPORT_ITEMS } from "../db/stores/directoryImportStore.js";

import { DOCUMENT_REVISION_PAYLOAD_MAX_CHARS } from "../documentTypes.js";
/**
 * Request-body ceilings used at the Fastify parser boundary.
 *
 * A JSON string can consume twelve transport bytes per decoded code point
 * when an astral scalar is represented as a UTF-16 surrogate pair. The long
 * text and contained-config ceilings include that expansion plus object and
 * array overhead. Compact contracts contain only short labels, identifiers,
 * or fixed enums. Routes with configurable large payloads keep their own
 * limits next to the corresponding resource budget.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024;
export const BODYLESS_MUTATION_LIMIT_BYTES = 1024;
export const COMPACT_JSON_BODY_LIMIT_BYTES = 8 * 1024;
// One hundred UUIDs, an optional title, and an optional agent UUID remain
// below this ceiling even when every character is carried as a JSON Unicode
// escape. This covers both source-scope replacement and chat creation.
export const IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES = 32 * 1024;
// Library search: a 1,000-codepoint query (worst case JSON-escaped) plus up
// to 100 filter UUIDs and two short enum fields, with syntax headroom.
export const SOURCE_SEARCH_JSON_BODY_LIMIT_BYTES = 48 * 1024;
export const LONG_TEXT_JSON_BODY_LIMIT_BYTES = 128 * 1024;
export const CONTAINED_DOWNLOAD_BODY_LIMIT_BYTES = 32 * 1024;
export const CONTAINED_CONFIG_BODY_LIMIT_BYTES = 256 * 1024;

const MAX_JSON_BYTES_PER_CODE_POINT = 12;
const MAX_JSON_BYTES_PER_ASCII_CHARACTER = 6;
const OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES = 4 * 1024;

/** Full Settings draft or model-qualification draft, including escaped astral scalars. */
export const SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES =
  (MAX_ENDPOINT_CHARS * 2 + MAX_API_KEY_CHARS + MODEL_ID_MAX_CHARS * 2) * MAX_JSON_BYTES_PER_CODE_POINT +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

/** Connector create contract, including a maximally escaped URL and display name. */
export const CONNECTOR_JSON_BODY_LIMIT_BYTES =
  (CONNECTOR_DISPLAY_NAME_MAX_CHARS + CONNECTOR_URL_MAX_CHARS) * MAX_JSON_BYTES_PER_CODE_POINT +
  (CONNECTOR_TABLE_MAX_CHARS + "url_json".length) * MAX_JSON_BYTES_PER_ASCII_CHARACTER +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

/** Account model preference, including an escaped astral model identifier. */
export const PREFERENCE_JSON_BODY_LIMIT_BYTES = PREFERENCE_MODEL_MAX_CHARS * MAX_JSON_BYTES_PER_CODE_POINT + 1024;

/**
 * Browser directory-import manifest (M14 stage 2): one hundred items of a
 * UUID plus a maximally escaped 1,024-character managed relative path, plus
 * the operation UUID and revision fields. The durable semantic limits live
 * in `db/stores/directoryImportStore.ts`.
 */
export const DIRECTORY_IMPORT_JSON_BODY_LIMIT_BYTES =
  MAX_DIRECTORY_IMPORT_ITEMS *
    (MAX_KNOWLEDGE_RELATIVE_PATH_CHARS * MAX_JSON_BYTES_PER_CODE_POINT + 36 * MAX_JSON_BYTES_PER_CODE_POINT + 128) +
  (36 + 24) * MAX_JSON_BYTES_PER_CODE_POINT +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

/**
 * Connection create/edit contract: bounded name, endpoint URL or absolute
 * command/arguments/working directory, and the maximum credential material
 * the secret store itself accepts (headers plus environment entries), all
 * escaped astrally. The secret-store budget, not the transport, is the real
 * bound; the durable semantic limits live in `connections/store.ts` and
 * `connections/secrets.ts`.
 */
/**
 * Document draft/revision save contract. The decoded tree is bounded by the
 * evidence-inclusive 400,000-character revision snapshot in
 * `documentTypes.ts`; this transport ceiling covers the worst-case astral
 * escape expansion of that decoded budget (one UTF-16 code unit escaped to
 * at most six JSON transport bytes) plus structural headroom. The
 * normalizer, not the parser, remains the semantic bound — an oversize tree
 * is rejected with `DOCUMENT_OVERSIZE`, not just a transport 413.
 */
export const DOCUMENT_REVISION_JSON_BODY_LIMIT_BYTES =
  DOCUMENT_REVISION_PAYLOAD_MAX_CHARS * MAX_JSON_BYTES_PER_ASCII_CHARACTER + 128 * 1024;

/** Template save/edit contract: bounded name/description and small bodies. */
export const DOCUMENT_TEMPLATE_JSON_BODY_LIMIT_BYTES = COMPACT_JSON_BODY_LIMIT_BYTES;

export const CONNECTION_JSON_BODY_LIMIT_BYTES =
  (MAX_CONNECTION_NAME_CHARS +
    MAX_CONNECTION_URL_CHARS +
    MAX_STDIO_COMMAND_CHARS * 2 +
    MAX_STDIO_ARGS * MAX_STDIO_ARG_CHARS +
    MAX_SECRET_NAME_CHARS * (MAX_SECRET_HEADER_ENTRIES + MAX_SECRET_ENV_ENTRIES) +
    MAX_SECRET_VALUE_CHARS * (MAX_SECRET_HEADER_ENTRIES + MAX_SECRET_ENV_ENTRIES)) *
    MAX_JSON_BYTES_PER_CODE_POINT +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

/**
 * Saved-analysis definition create/edit contract (M12): full SQL, description,
 * comparison key, 100 UUID source ids, and up to 20 parameter declarations
 * (each carrying a name, label, description, and typed default), all escaped
 * astrally. The durable semantic bounds live in `analysisTypes.ts`; this is
 * the transport ceiling derived from them.
 */
export const ANALYSIS_DEFINITION_JSON_BODY_LIMIT_BYTES =
  (ANALYSIS_TITLE_MAX_CHARS +
    ANALYSIS_DESCRIPTION_MAX_CHARS +
    ANALYSIS_SQL_MAX_CHARS +
    ANALYSIS_COMPARISON_KEY_MAX_COLUMNS * ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS +
    ANALYSIS_SOURCE_MAX_COUNT * 36 +
    ANALYSIS_PARAMETER_MAX_COUNT *
      (64 + ANALYSIS_LABEL_MAX_CHARS + ANALYSIS_DESCRIPTION_MAX_CHARS + ANALYSIS_PARAMETER_STRING_MAX_CHARS)) *
    MAX_JSON_BYTES_PER_CODE_POINT +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

/**
 * Saved-analysis run acceptance: at most 20 typed parameter values (string
 * values bounded at the durable limit) plus the operation UUID, escaped
 * astrally.
 */
export const ANALYSIS_RUN_JSON_BODY_LIMIT_BYTES =
  (ANALYSIS_PARAMETER_MAX_COUNT * ANALYSIS_PARAMETER_STRING_MAX_CHARS + 64) * MAX_JSON_BYTES_PER_CODE_POINT +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

/** Query-capture promotion contract: bounded title/description plus the key. */
export const ANALYSIS_PROMOTION_JSON_BODY_LIMIT_BYTES =
  (ANALYSIS_TITLE_MAX_CHARS + ANALYSIS_DESCRIPTION_MAX_CHARS + 36 + 600) * MAX_JSON_BYTES_PER_CODE_POINT +
  OBJECT_KEYS_AND_SYNTAX_HEADROOM_BYTES;

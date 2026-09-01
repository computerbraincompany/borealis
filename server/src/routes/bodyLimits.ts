import { MAX_API_KEY_CHARS, MAX_ENDPOINT_CHARS, MODEL_ID_MAX_CHARS } from "../settingsStore.js";
import {
  CONNECTOR_DISPLAY_NAME_MAX_CHARS,
  CONNECTOR_TABLE_MAX_CHARS,
  CONNECTOR_URL_MAX_CHARS,
  PREFERENCE_MODEL_MAX_CHARS,
} from "./schemas.js";

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

import { currentRequestId } from "./requestContext.js";

export interface SafeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const noop = () => {};
let logger: SafeLogger = { info: noop, warn: noop, error: noop };

export function setAppLogger(value: SafeLogger): void {
  logger = value;
}

export function safeLogContext(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { request_id: currentRequestId(), ...fields };
}

export const appLog: SafeLogger = {
  info(fields, message) {
    logger.info(safeLogContext(fields), message);
  },
  warn(fields, message) {
    logger.warn(safeLogContext(fields), message);
  },
  error(fields, message) {
    logger.error(safeLogContext(fields), message);
  },
};

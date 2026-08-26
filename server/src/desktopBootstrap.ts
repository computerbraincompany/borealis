import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";

import { signToken } from "./auth.js";
import { DuplicateEmailError, type StoredUser } from "./db/stores/chatStore.js";
import { storageRuntime } from "./storageRuntime.js";

export const DESKTOP_ACCOUNT_EMAIL = "local@borealis.app";

export interface DesktopBootstrapSession {
  readonly token: string;
  readonly user: Readonly<{ id: string; email: string }>;
}

async function desktopUser(): Promise<StoredUser> {
  const chats = storageRuntime().chats;
  const existing = await chats.findUserByEmail(DESKTOP_ACCOUNT_EMAIL);
  if (existing) return existing;

  // The generated password is intentionally discarded. Desktop access is
  // handed to the trusted preload over Electron IPC, never through this login.
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 10);
  try {
    return await chats.createUser({ email: DESKTOP_ACCOUNT_EMAIL, passwordHash });
  } catch (error) {
    if (!(error instanceof DuplicateEmailError)) throw error;
    const raced = await chats.findUserByEmail(DESKTOP_ACCOUNT_EMAIL);
    if (!raced) throw error;
    return raced;
  }
}

/** Ensure the single local profile exists and mint a fresh, short-lived handoff. */
export async function createDesktopBootstrapSession(): Promise<DesktopBootstrapSession> {
  const user = await desktopUser();
  return Object.freeze({
    token: signToken({ userId: user.id, email: user.email }),
    user: Object.freeze({ id: user.id, email: user.email }),
  });
}

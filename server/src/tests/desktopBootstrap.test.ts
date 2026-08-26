import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ storageRuntime: vi.fn() }));
vi.mock("../storageRuntime.js", () => ({ storageRuntime: mocks.storageRuntime }));

import { verifyToken } from "../auth.js";
import { ChatStore } from "../db/stores/chatStore.js";
import { createDesktopBootstrapSession, DESKTOP_ACCOUNT_EMAIL } from "../desktopBootstrap.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

let temporary: TempSqliteLedger;
let chats: ChatStore;

beforeEach(async () => {
  temporary = await createTempSqliteLedger();
  chats = new ChatStore(temporary.ledger);
  mocks.storageRuntime.mockReset();
  mocks.storageRuntime.mockReturnValue({ chats });
});

afterEach(async () => {
  await temporary.cleanup();
});

describe("desktop bootstrap session", () => {
  it("creates exactly one password-inaccessible local account under concurrent first launch", async () => {
    const sessions = await Promise.all([
      createDesktopBootstrapSession(),
      createDesktopBootstrapSession(),
      createDesktopBootstrapSession(),
    ]);

    const userIds = new Set(sessions.map((session) => session.user.id));
    expect(userIds.size).toBe(1);
    expect(sessions.every((session) => session.user.email === DESKTOP_ACCOUNT_EMAIL)).toBe(true);
    expect(await temporary.ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM users")).toEqual({ count: 1n });

    const stored = await chats.findUserByEmail(DESKTOP_ACCOUNT_EMAIL);
    expect(stored).toBeDefined();
    expect(stored?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare("local@borealis.app", stored?.password_hash ?? "")).toBe(false);
  });

  it("reuses the stable local identity while minting valid signed handoffs", async () => {
    const first = await createDesktopBootstrapSession();
    const second = await createDesktopBootstrapSession();

    expect(second.user).toEqual(first.user);
    for (const session of [first, second]) {
      expect(verifyToken(session.token)).toMatchObject({ userId: session.user.id, email: DESKTOP_ACCOUNT_EMAIL });
      const decoded = jwt.decode(session.token) as { iat?: number; exp?: number } | null;
      expect(decoded?.iat).toEqual(expect.any(Number));
      expect((decoded?.exp ?? 0) - (decoded?.iat ?? 0)).toBe(7 * 24 * 60 * 60);
      expect(Object.isFrozen(session)).toBe(true);
      expect(Object.isFrozen(session.user)).toBe(true);
    }
    expect(await temporary.ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM users")).toEqual({ count: 1n });
  });

  it("does not reuse or mutate an unrelated account", async () => {
    const unrelated = await chats.createUser({
      email: "person@example.com",
      passwordHash: await bcrypt.hash("unrelated-secret", 4),
    });

    const session = await createDesktopBootstrapSession();
    expect(session.user.id).not.toBe(unrelated.id);
    expect((await chats.findUserByEmail("person@example.com"))?.id).toBe(unrelated.id);
    expect(await temporary.ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM users")).toEqual({ count: 2n });
  });
});

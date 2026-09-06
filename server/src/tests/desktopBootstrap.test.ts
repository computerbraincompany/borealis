import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ storageRuntime: vi.fn() }));
vi.mock("../storageRuntime.js", () => ({ storageRuntime: mocks.storageRuntime }));

import { signToken, verifyToken } from "../auth.js";
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
      // The bootstrap handoff is the only session that carries the literal
      // desktop-operator capability (plan 007).
      expect(verifyToken(session.token)).toEqual({
        userId: session.user.id,
        email: DESKTOP_ACCOUNT_EMAIL,
        desktopOperator: true,
      });
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

describe("desktop-operator capability", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";

  it("minting is confined to the bootstrap handoff", async () => {
    const session = await createDesktopBootstrapSession();
    expect(verifyToken(session.token).desktopOperator).toBe(true);

    // Registration/login mint the same plain shape they always did: the
    // capability is absent, not false.
    const normal = verifyToken(signToken({ userId: USER_ID, email: "person@example.com" }));
    expect(normal).toEqual({ userId: USER_ID, email: "person@example.com" });
    expect("desktopOperator" in normal).toBe(false);
  });

  it("the desktop email alone grants nothing", () => {
    const forged = verifyToken(signToken({ userId: USER_ID, email: DESKTOP_ACCOUNT_EMAIL }));
    expect(forged.desktopOperator).toBeUndefined();
  });

  it("only the exact literal true claim is preserved", () => {
    const falseClaim = signToken({ userId: USER_ID, email: "person@example.com", desktopOperator: false } as never);
    const stringClaim = signToken({ userId: USER_ID, email: "person@example.com", desktopOperator: "true" } as never);
    const arrayClaim = signToken({ userId: USER_ID, email: "person@example.com", desktopOperator: [true] } as never);
    const oneClaim = signToken({ userId: USER_ID, email: "person@example.com", desktopOperator: 1 } as never);

    for (const token of [falseClaim, stringClaim, arrayClaim, oneClaim]) {
      const payload = verifyToken(token);
      expect(payload.userId).toBe(USER_ID);
      expect(payload.desktopOperator).toBeUndefined();
      expect("desktopOperator" in payload).toBe(false);
    }
  });

  it("preserves the seven-day expiry and HS256 restriction", () => {
    const token = signToken({ userId: USER_ID, email: "person@example.com", desktopOperator: true });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe("HS256");
    const payload = verifyToken(token);
    expect(payload.desktopOperator).toBe(true);
  });
});

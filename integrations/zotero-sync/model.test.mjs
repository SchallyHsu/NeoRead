import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import m from "./model.js";
const digest = async (text) => createHash("sha256").update(text).digest("hex");
test("only finished replies and the correct personal library cross over", async () => {
  const c = {
    session: {
      id: "s1",
      paper: { libraryKey: "user:42", itemKey: "12345678" },
    },
    events: [
      { id: "1", event: { t: "user", text: "question", chips: [] } },
      { id: "2", event: { t: "thought", turn: "t", delta: "private" } },
      { id: "3", event: { t: "text", turn: "t", delta: "yes" } },
      { id: "4", event: { t: "turn_end", turn: "t" } },
      { id: "5", event: { t: "user", text: "streaming", chips: [] } },
    ],
  };
  assert.equal(m.paperKey(c, "user:42"), "12345678");
  assert.equal(m.paperKey(c, "user:9"), undefined);
  const [round] = m.visibleRounds(c);
  assert.equal(round.answer, "yes");
  assert.equal(m.visibleRounds(c).length, 1);
  const sid = await m.identity(c, "a".repeat(64), digest);
  assert.match(sid, m.neoID);
  assert.notEqual(sid, await m.identity(c, "b".repeat(64), digest));
  assert.deepEqual(
    await m.messageIDs(sid, round, digest),
    await m.messageIDs(sid, round, digest),
  );
});
test("mirrored turns never echo and repeated delivery is idempotent", () => {
  const chat = { session: { updatedAt: 0 }, events: [] },
    uid = "a".repeat(32),
    aid = "b".repeat(32);
  const t = {
    Messages: [
      {
        id: uid,
        role: "user",
        content: "q",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: aid,
        role: "assistant",
        content: "a",
        createdAt: "2026-01-01T00:00:01Z",
      },
    ],
  };
  assert.equal(m.appendTurn(chat, t, new Set([uid])), false);
  assert.equal(m.appendTurn(chat, t, new Set()), true);
  assert.equal(m.appendTurn(chat, t, new Set()), false);
  assert.equal(m.visibleRounds(chat)[0].user.id, "neo-u-" + uid);
});

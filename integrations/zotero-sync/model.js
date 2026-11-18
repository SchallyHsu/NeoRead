/* Bridge between the published NeoRead and Zotero Agent WebDAV formats. */
var BridgeModel = (() => {
  const neoID = /^[a-f0-9]{32}$/;
  const fullHash = /^[a-f0-9]{64}$/;
  const backends = new Set([
    "claude-code",
    "codex",
    "deepseek-harness",
    "antigravity",
  ]);
  const native = (name) => (backends.has(name) ? "native:" + name : "api");
  const backend = (provider) =>
    backends.has(provider?.slice(7)) && provider.startsWith("native:")
      ? provider.slice(7)
      : "pi";
  function paperKey(chat, library) {
    const refs = [chat.session.paper];
    for (const { event } of chat.events)
      if (event.t === "user") {
        refs.push(...(event.chips || []).map((c) => c.ref));
        break;
      }
    const paper = refs.find((r) => r?.libraryKey === library && r.itemKey);
    const attachment =
      paper &&
      refs.find(
        (r) =>
          r?.libraryKey === library &&
          r.itemKey === paper.itemKey &&
          r.attachmentKey,
      );
    return attachment?.attachmentKey || paper?.itemKey;
  }
  function visibleRounds(chat) {
    const rounds = [];
    let user,
      replies = new Map();
    for (const { event: e, id } of chat.events) {
      if (e.t === "user") {
        user = { id, text: e.text };
        replies = new Map();
      }
      if (!user) continue;
      if (e.t === "text")
        replies.set(e.turn, (replies.get(e.turn) || "") + e.delta);
      if (e.t === "turn_end" && replies.get(e.turn)) {
        rounds.push({ user, answer: replies.get(e.turn), end: id });
        user = undefined;
      }
    }
    return rounds;
  }
  async function identity(chat, hash, digest) {
    if (
      chat.session.id.startsWith("neoread-") &&
      neoID.test(chat.session.id.slice(8))
    )
      return chat.session.id.slice(8);
    return (
      await digest(JSON.stringify(["zotero-session", hash, chat.session.id]))
    ).slice(0, 32);
  }
  async function messageIDs(session, round, digest) {
    const id = async (type, key) =>
      (await digest(JSON.stringify([session, type, key]))).slice(0, 32);
    return [await id("user", round.user.id), await id("assistant", round.end)];
  }
  function appendTurn(chat, turn, known) {
    const ms = turn.Messages;
    if (!ms.length || ms[0].role !== "user" || !neoID.test(ms[0].id))
      return false;
    const msgs = ms
      .slice(1)
      .filter((m) => m.role === "assistant" && neoID.test(m.id));
    if (!msgs.length || known.has(ms[0].id)) return false;
    const uid = "neo-u-" + ms[0].id;
    if (chat.events.some((e) => e.id === uid)) return false;
    const events = [
      {
        id: uid,
        event: {
          t: "user",
          id: ms[0].id,
          text: ms[0].content || "",
          chips: [],
        },
      },
    ];
    for (const m of msgs) {
      events.push(
        { id: "neo-start-" + m.id, event: { t: "turn_start", turn: m.id } },
        {
          id: "neo-text-" + m.id,
          event: { t: "text", turn: m.id, delta: m.content || "" },
        },
        {
          id: "neo-end-" + m.id,
          event: { t: "turn_end", turn: m.id, stop: "end_turn" },
        },
      );
    }
    chat.events.push(...events);
    chat.session.updatedAt = Math.max(
      chat.session.updatedAt,
      ...ms.map((m) => Date.parse(m.createdAt)).filter(Number.isFinite),
    );
    known.add(ms[0].id);
    return true;
  }
  return {
    neoID,
    fullHash,
    native,
    backend,
    paperKey,
    visibleRounds,
    identity,
    messageIDs,
    appendTurn,
  };
})();
if (typeof module !== "undefined") module.exports = BridgeModel;

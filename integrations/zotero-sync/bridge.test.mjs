import { test } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path").posix;
const __dirname = require("node:path").dirname(
  require("node:url").fileURLToPath(import.meta.url),
);
const vm = require("node:vm");
const { createHash, webcrypto } = require("node:crypto");
const { JSDOM } = require("jsdom");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const xml = (rows = []) =>
  '<multistatus xmlns="DAV:">' +
  rows
    .map(
      (n) => "<response><href>/zotero/neoread-v1/" + n + "</href></response>",
    )
    .join("") +
  "</multistatus>";
test("paired apps exchange new originals and complete replies, retry conditional writes without duplication", async () => {
  const library = "user:42",
    rawZ = Buffer.from("%PDF-zotero"),
    rawN = Buffer.from("%PDF-neoread"),
    zHash = hash(rawZ),
    nHash = hash(rawN);
  const nativeSID = "b".repeat(32),
    nua = "1".repeat(32),
    naa = "2".repeat(32),
    time = Date.parse("2026-01-01T00:00:00Z");
  const bytes = new Map([
    ["/zotero/original.pdf", rawZ],
    ["/apps/NeoRead/library/papers/" + nHash.slice(0, 32) + ".pdf", rawN],
  ]);
  const item = (key, p, title) => ({
    key,
    isAttachment: () => true,
    attachmentContentType: "application/pdf",
    attachmentFilename: "original.pdf",
    getFilePathAsync: async () => p,
    getDisplayTitle: () => title,
  });
  const items = [item("Z2345678", "/zotero/original.pdf", "Zotero paper")],
    docs = [{ id: nHash.slice(0, 32), type: "pdf", title: "NeoRead paper" }],
    local = new Map();
  const webdav = new Map(),
    chat = {
      format: "zotero-agent-chat",
      version: 1,
      chats: {
        alpha: {
          session: {
            id: "alpha",
            backend: "codex",
            title: "conversation",
            updatedAt: time,
            paper: { libraryKey: library, itemKey: "Z2345678" },
          },
          events: [
            {
              id: "u",
              event: { t: "user", id: "u", text: "Z question", chips: [] },
            },
            { id: "s", event: { t: "turn_start", turn: "a" } },
            { id: "t", event: { t: "text", turn: "a", delta: "Z answer" } },
            { id: "e", event: { t: "turn_end", turn: "a", stop: "end_turn" } },
          ],
        },
      },
    };
  const record = (kind, obj) => {
    const body = JSON.stringify(obj);
    webdav.set("neoread-v1/" + kind + "-" + hash(body) + ".json", body);
  };
  record("session", {
    ID: nativeSID,
    Hash: nHash,
    Title: "N conversation",
    Provider: "native:codex",
    CreatedAt: new Date(time).toISOString(),
    UpdatedAt: new Date(time).toISOString(),
  });
  record("turn", {
    Session: nativeSID,
    Hash: nHash,
    Messages: [
      {
        id: nua,
        role: "user",
        content: "N question",
        createdAt: new Date(time).toISOString(),
      },
      {
        id: naa,
        role: "assistant",
        content: "N answer",
        createdAt: new Date(time + 1).toISOString(),
      },
    ],
  });
  webdav.set("zotero-agent-chat/v1.json", JSON.stringify(chat));
  let failOnce = true,
    imports = 0;
  const json = (o) => Response.json(o),
    ok = (body, status = 200, headers = {}) =>
      new Response(body, { status, headers });
  const fetch = async (u, options = {}) => {
    if (u === "fixture:read.html") return ok("<html></html>");
    if (u.startsWith("http://127.0.0.1:9999/api/")) {
      assert.equal(options.headers.Authorization, "Bearer pair");
      if (u.endsWith("/webdav"))
        return json({
          enabled: true,
          url: "https://fixture.invalid/zotero",
          username: "reader",
        });
      assert.ok(u.endsWith("/documents"));
      if (options.method === "POST") {
        const content = Buffer.from(
          await options.body.get("file").arrayBuffer(),
        );
        assert.equal(hash(content), zHash);
        const result = {
          id: zHash.slice(0, 32),
          type: "pdf",
          title: "Zotero paper",
        };
        docs.push(result);
        return json(result);
      }
      return json(docs);
    }
    assert.ok(u.startsWith("https://fixture.invalid/zotero/"));
    assert.equal(options.redirect, "error");
    const p = u.slice("https://fixture.invalid/zotero/".length),
      method = options.method;
    if (method === "PROPFIND")
      return ok(
        xml(
          p === "neoread-v1/"
            ? [...webdav.keys()]
                .filter((n) => n.startsWith(p))
                .map((k) => k.slice(p.length))
            : [],
        ),
        207,
      );
    if (method === "MKCOL") return ok("", 405);
    if (method === "GET")
      return webdav.has(p)
        ? ok(webdav.get(p), 200, { ETag: '"current"' })
        : ok("", 404);
    assert.equal(method, "PUT");
    if (p === "zotero-agent-chat/v1.json") {
      assert.equal(options.headers["If-Match"], '"current"');
      if (failOnce) {
        failOnce = false;
        return ok("", 412);
      }
    }
    if (options.headers["If-None-Match"] === "*" && webdav.has(p))
      return ok("", 412);
    webdav.set(p, options.body);
    return ok("", 201);
  };
  const sandbox = {
    win: {
      URL,
      fetch,
      TextDecoder,
      TextEncoder,
      DOMParser: new JSDOM("").window.DOMParser,
      crypto: webcrypto,
      btoa,
      Blob,
      FormData,
    },
    Services: { dirsvc: { get: () => ({ path: "/apps" }) } },
    Ci: { nsIFile: 1 },
    PathUtils: path,
    IOUtils: {
      exists: async (p) =>
        p.endsWith("/server.json") || local.has(p) || bytes.has(p),
      readJSON: async (p) =>
        p.endsWith("/server.json")
          ? { url: "http://127.0.0.1:9999", token: "pair" }
          : structuredClone(local.get(p)),
      writeJSON: async (p, v) => local.set(p, structuredClone(v)),
      read: async (p) => bytes.get(p),
      stat: async (p) => ({ size: bytes.get(p).length, lastModified: 1 }),
    },
    Zotero: {
      Prefs: {
        get: (k) =>
          ({
            "sync.storage.scheme": "https",
            "sync.storage.url": "fixture.invalid",
            "sync.storage.username": "reader",
            "sync.storage.protocol": "webdav",
            "extensions.zotero-chat.settings": JSON.stringify({
              chatSync: {
                enabled: true,
                username: "reader",
                url: "https://fixture.invalid/zotero/",
              },
            }),
          })[k],
      },
      Users: { getCurrentUserID: () => 42 },
      Profile: { dir: "/profile" },
      Sync: {
        Runner: {
          getStorageController: () => ({ getPassword: async () => "fixture" }),
        },
      },
      Libraries: { userLibraryID: 1 },
      Items: { getAll: async () => items },
      File: { pathToFile: (p) => p, getValidFileName: (s) => s },
      Attachments: {
        importFromFile: async ({ file, libraryID, title }) => {
          assert.equal(libraryID, 1);
          imports++;
          const a = item("N2345678", file, title);
          items.push(a);
          return a;
        },
      },
      debug: () => {},
    },
  };
  vm.createContext(sandbox);
  for (const file of ["model.js", "bridge.js"])
    vm.runInContext(readFileSync(path.join(__dirname, file), "utf8"), sandbox);
  const service = sandbox.createBridge("fixture:");
  await assert.rejects(service.run(), /chat-write-412/);
  await service.run();
  await service.run();
  assert.equal(imports, 1);
  assert.equal(docs.length, 2);
  const result = JSON.parse(webdav.get("zotero-agent-chat/v1.json")).chats;
  assert.deepEqual(Object.keys(result).sort(), [
    "alpha",
    "neoread-" + nativeSID,
  ]);
  assert.equal(result["neoread-" + nativeSID].events.length, 4);
  assert.equal(
    result["neoread-" + nativeSID].session.paper.itemKey,
    "N2345678",
  );
  const converted = [...webdav].filter(
    ([n, b]) =>
      n.startsWith("neoread-v1/turn-") && JSON.parse(b).Hash === zHash,
  );
  assert.equal(converted.length, 1);
  assert.equal(JSON.parse(converted[0][1]).Messages[1].content, "Z answer");
  assert.ok(webdav.has("zotero-agent-chat/read.html"));
});

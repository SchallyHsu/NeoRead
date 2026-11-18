/* Uses the two running apps and the configured personal WebDAV. Only completed
 * public messages cross formats. Zotero remains responsible for mobile files. */
function createBridge(rootURI) {
  const M = BridgeModel;
  const enc = new win.TextEncoder();
  const digest = async (value) =>
    Array.from(
      new Uint8Array(
        await win.crypto.subtle.digest(
          "SHA-256",
          typeof value === "string" ? enc.encode(value) : value,
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  let stopped = false,
    state,
    statePath,
    stage;
  const log = (name) => Zotero.debug("NeoRead sync: " + name);
  const check = (ok, code) => {
    if (!ok) throw Object.assign(new Error(code), { bridgeStage: code });
  };
  const save = () =>
    IOUtils.writeJSON(statePath, state, { tmpPath: statePath + ".tmp" });
  const encoder = (s) => win.btoa(String.fromCharCode(...enc.encode(s)));
  const filePath = (root, d) =>
    PathUtils.join(
      root,
      d.type === "pdf" ? "papers" : "books",
      d.id + "." + d.type,
    );
  const active = () => check(!stopped, "stopped");
  const stamp = (ms) => new Date(ms).toISOString();
  async function connection() {
    const baseDir = Services.dirsvc.get("AppData", Ci.nsIFile).path;
    const app = PathUtils.join(baseDir, "NeoRead");
    const location = PathUtils.join(app, "library-location.json");
    const root = (await IOUtils.exists(location))
      ? (await IOUtils.readJSON(location)).directory
      : PathUtils.join(app, "library");
    const discovery = PathUtils.join(root, "server.json");
    if (!(await IOUtils.exists(discovery))) return;
    const server = await IOUtils.readJSON(discovery);
    check(
      /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(server.url) &&
        typeof server.token === "string",
      "local-discovery",
    );
    async function local(path, options = {}) {
      active();
      const r = await win.fetch(server.url + "/api/" + path, {
        ...options,
        headers: { Authorization: "Bearer " + server.token },
        credentials: "omit",
        redirect: "error",
      });
      check(r.ok, "local-" + r.status);
      return r.json();
    }
    const cfg = await local("webdav");
    if (!cfg.enabled) return;
    const prefs = (key) => Zotero.Prefs.get("sync.storage." + key);
    const url =
      prefs("scheme") + "://" + prefs("url").replace(/\/+$/, "") + "/zotero";
    const chat = JSON.parse(
      Zotero.Prefs.get("extensions.zotero-chat.settings", true) || "{}",
    ).chatSync;
    const user = Zotero.Users.getCurrentUserID();
    if (
      !user ||
      prefs("protocol") !== "webdav" ||
      !chat?.enabled ||
      chat.url.replace(/\/+$/, "") !== url ||
      chat.username !== cfg.username ||
      prefs("username") !== cfg.username ||
      cfg.url !== url
    )
      return;
    const parsed = new win.URL(url);
    check(
      parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash,
      "webdav-url",
    );
    const password =
      await Zotero.Sync.Runner.getStorageController("webdav").getPassword();
    check(password, "webdav-login");
    const auth = "Basic " + encoder(cfg.username + ":" + password);
    async function dav(method, path, options = {}) {
      active();
      check(
        (method === "PROPFIND" && path === "") ||
          (method === "GET" && /^[A-Z0-9]{8}\.prop$/.test(path)) ||
          /^(?:neoread-v1\/(?:[a-z0-9-]+\.json)?|zotero-agent-chat\/(?:v1\.json|read\.html)?)$/.test(
            path,
          ),
        "invalid-record-path",
      );
      return win.fetch(url + "/" + path, {
        method,
        body: options.body,
        headers: { ...options.headers, Authorization: auth },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
    }
    const library = "user:" + user;
    const path = PathUtils.join(
      Zotero.Profile.dir,
      "neoread-bridge-" +
        (
          await digest(JSON.stringify([url, cfg.username, library, root]))
        ).slice(0, 24) +
        ".json",
    );
    if (statePath !== path) {
      const loaded = (await IOUtils.exists(path))
        ? await IOUtils.readJSON(path)
        : { files: {}, seenFiles: {}, heads: {}, received: {}, published: {} };
      state = loaded;
      statePath = path;
    }
    return { local, root, dav, library };
  }
  async function documentMap(c) {
    const docs = await c.local("documents"),
      nr = new Map(
        docs
          .filter((d) => M.neoID.test(d.id) && ["pdf", "epub"].includes(d.type))
          .map((d) => [d.id, d]),
      );
    const byKey = new Map(),
      byHash = new Map(),
      linkedIDs = new Set(),
      attachments = new Map(),
      all = await Zotero.Items.getAll(
        Zotero.Libraries.userLibraryID,
        false,
        false,
      );
    const statistics = { linked: 0, toNeoRead: 0, toZotero: 0, missing: 0 };
    const bind = (item, hash) => {
      const parent = item.parentItem || item;
      const ref = {
        key: parent.key,
        attachment: item.key,
        title: parent.getDisplayTitle() || item.attachmentFilename || "",
      };
      byKey.set(item.key, hash);
      if (!byKey.has(parent.key)) byKey.set(parent.key, hash);
      if (!byHash.has(hash)) byHash.set(hash, ref);
      linkedIDs.add(hash.slice(0, 32));
      attachments.set(item.key, { item, hash });
      state.seenFiles[hash] = true;
    };
    for (const a of all) {
      active();
      if (
        !a.isAttachment() ||
        !["application/pdf", "application/epub+zip"].includes(
          a.attachmentContentType,
        ) ||
        a.deleted ||
        a.parentItem?.deleted
      )
        continue;
      const path = await a.getFilePathAsync();
      if (!path) {
        statistics.missing++;
        continue;
      }
      const f = await IOUtils.stat(path);
      if (f.size > 512 * 1024 * 1024) continue;
      let cached = state.files[a.key];
      if (
        !cached ||
        cached.size !== f.size ||
        cached.time !== f.lastModified ||
        cached.path !== path
      ) {
        cached = {
          size: f.size,
          time: f.lastModified,
          path,
          hash: await digest(await IOUtils.read(path)),
        };
        state.files[a.key] = cached;
      }
      const hash = cached.hash,
        existed = !!state.seenFiles[hash];
      bind(a, hash);
      if (nr.has(hash.slice(0, 32))) {
        statistics.linked++;
        continue;
      }
      // Once tracked, a local removal stays local. Retry interrupted first imports.
      if (existed && cached.imported) continue;
      const ext =
        a.attachmentContentType === "application/pdf" ? "pdf" : "epub";
      const form = new win.FormData();
      const title =
        a.parentItem?.getDisplayTitle() ||
        a.getDisplayTitle() ||
        a.attachmentFilename ||
        a.key;
      const filename =
        Zotero.File.getValidFileName(title).replace(/\.(pdf|epub)$/i, "") +
        "." +
        ext;
      form.append(
        "file",
        new win.Blob([await IOUtils.read(path)], {
          type: a.attachmentContentType,
        }),
        filename,
      );
      form.append(
        "library",
        ext === "epub" || a.parentItem?.itemType === "book"
          ? "books"
          : "papers",
      );
      form.append("allowLarge", "1");
      const result = await c.local("documents", { method: "POST", body: form });
      check(result.id === hash.slice(0, 32), "file-changed");
      nr.set(result.id, result);
      cached.imported = true;
      statistics.toNeoRead++;
    }
    for (const d of nr.values()) {
      active();
      if (linkedIDs.has(d.id)) continue;
      const path = filePath(c.root, d);
      if (!(await IOUtils.exists(path))) continue;
      const info = await IOUtils.stat(path);
      if (info.size > 512 * 1024 * 1024) continue;
      const hash = await digest(await IOUtils.read(path));
      check(hash.slice(0, 32) === d.id, "file-integrity");
      if (state.seenFiles[hash]) continue;
      // Personal library is explicit even if the user has selected a group.
      const att = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(path),
        libraryID: Zotero.Libraries.userLibraryID,
        title: d.title,
        fileBaseName: Zotero.File.getValidFileName(d.title || d.id),
      });
      bind(att, hash);
      statistics.toZotero++;
      await save();
    }
    for (const a of Object.values(state.files))
      if (nr.has(a.hash.slice(0, 32))) a.imported = true;
    return { byKey, byHash, attachments, statistics };
  }
  async function sources(c, links) {
    const signature = await digest(
      JSON.stringify(
        Array.from(links.attachments, ([key, v]) => [key, v.hash]).sort(),
      ),
    );
    if (
      state.sourceSignature === signature &&
      Date.now() - (state.sourceChecked || 0) < 3600000
    )
      return;
    const listing = await c.dav("PROPFIND", "", {
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
    });
    check(listing.status === 207, "source-directory");
    const xml = new win.DOMParser().parseFromString(
      await listing.text(),
      "application/xml",
    );
    check(xml.documentElement.localName === "multistatus", "source-list");
    const tags = new Map();
    for (const row of xml.getElementsByTagNameNS("DAV:", "response")) {
      const name = row
        .getElementsByTagNameNS("DAV:", "href")[0]
        ?.textContent.split("/")
        .pop();
      const tag = row.getElementsByTagNameNS("DAV:", "getetag")[0]?.textContent;
      if (name && /^"[^"\r\n]+"$/.test(tag || "")) tags.set(name, tag);
    }
    const path = "neoread-v1/zotero-sources-v1.json",
      result = await c.dav("GET", path);
    check(result.ok || result.status === 404, "source-read");
    const json = result.ok ? await result.json() : { version: 1, sources: {} };
    check(
      json.version === 1 && json.sources && typeof json.sources === "object",
      "source-schema",
    );
    let changed = false;
    for (const [k, { item, hash }] of links.attachments) {
      if (!/^[A-Z0-9]{8}$/.test(k)) continue;
      const etag = tags.get(k + ".zip"),
        propETag = tags.get(k + ".prop");
      if (!etag || !propETag) continue;
      const refs = json.sources[hash] || [];
      if (
        refs.some(
          (v) => v.key === k && v.etag === etag && v.propETag === propETag,
        )
      )
        continue;
      const p = await c.dav("GET", k + ".prop");
      if (!p.ok) continue;
      const prop = new win.DOMParser().parseFromString(
        await p.text(),
        "application/xml",
      );
      const md5 = prop.getElementsByTagName("hash")[0]?.textContent;
      if (
        !/^[a-f\d]{32}$/.test(md5 || "") ||
        (await item.attachmentHash) !== md5
      )
        continue;
      json.sources[hash] = [
        ...refs.filter((v) => v.key !== k),
        { key: k, etag, propETag },
      ];
      changed = true;
    }
    if (changed) {
      const current = result.headers.get("ETag");
      check(
        result.status === 404 || /^"[^"\r\n]+"$/.test(current || ""),
        "source-etag",
      );
      const saved = await c.dav("PUT", path, {
        headers: {
          "Content-Type": "application/json",
          ...(current ? { "If-Match": current } : { "If-None-Match": "*" }),
        },
        body: JSON.stringify(json),
      });
      check(saved.ok, "source-write-" + saved.status);
    }
    state.sourceSignature = signature;
    state.sourceChecked = Date.now();
  }
  async function names(dav) {
    const r = await dav("PROPFIND", "neoread-v1/", {
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
    });
    check(r.status === 207, "list-" + r.status);
    const xml = new win.DOMParser().parseFromString(
      await r.text(),
      "application/xml",
    );
    check(xml.documentElement.localName === "multistatus", "file-list");
    return new Set(
      Array.from(xml.getElementsByTagNameNS("DAV:", "href"), (n) =>
        n.textContent.split("/").pop(),
      ).filter((n) => /^(session|turn)-[0-9a-f]{64}\.json$/.test(n)),
    );
  }
  async function record(c, n) {
    const r = await c.dav("GET", "neoread-v1/" + n);
    check(r.ok, "record-" + r.status);
    const bytes = await r.arrayBuffer();
    check(
      bytes.byteLength <= 16 * 1024 * 1024 &&
        (await digest(bytes)) === n.split("-")[1].slice(0, -5),
      "record-integrity",
    );
    return JSON.parse(new win.TextDecoder().decode(bytes));
  }
  async function publish(c, list, kind, value) {
    const body = JSON.stringify(value),
      name = kind + "-" + (await digest(body)) + ".json";
    check(enc.encode(body).length <= 16 * 1024 * 1024, "record-size");
    if (list.has(name)) return;
    const res = await c.dav("PUT", "neoread-v1/" + name, {
      headers: { "Content-Type": "application/json", "If-None-Match": "*" },
      body,
    });
    check([200, 201, 204, 412].includes(res.status), "publish-" + res.status);
    list.add(name);
  }
  async function clockFor(c, sid, chat, rounds) {
    const path = "neoread-v1/bridge-clock-" + sid + ".json";
    if (state.published["clock-" + sid]) return state.published["clock-" + sid];
    let res = await c.dav("GET", path);
    if (res.status === 404) {
      const time = Math.max(1, chat.session.updatedAt - rounds.length * 2);
      const wrote = await c.dav("PUT", path, {
        headers: { "If-None-Match": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ time }),
      });
      check([200, 201, 204, 412].includes(wrote.status), "clock-write");
      res = await c.dav("GET", path);
    }
    check(res.ok, "clock-read");
    const { time } = await res.json();
    check(Number.isSafeInteger(time) && time > 0 && time < 8.64e15, "clock");
    return (state.published["clock-" + sid] = time);
  }
  async function chats(c, links) {
    const mk = await c.dav("MKCOL", "neoread-v1/");
    check([201, 405].includes(mk.status), "sync-directory");
    const list = await names(c.dav);
    const old = await c.dav("GET", "zotero-agent-chat/v1.json");
    check(old.ok || old.status === 404, "chat-list-" + old.status);
    const etag = old.headers.get("ETag");
    if (old.ok) check(/^"[^"\r\n]+"$/.test(etag || ""), "strong-etag");
    let document = { format: "zotero-agent-chat", version: 1, chats: {} };
    if (old.ok) {
      const text = await old.text();
      check(enc.encode(text).length <= 32 * 1024 * 1024, "chat-size");
      document = JSON.parse(text);
    }
    check(
      document.format === "zotero-agent-chat" &&
        document.version === 1 &&
        document.chats &&
        typeof document.chats === "object" &&
        !Array.isArray(document.chats),
      "chat-format",
    );
    const sessions = new Map(),
      mirrored = new Map(),
      done = [];
    for (const chat of Object.values(document.chats)) {
      const key = M.paperKey(chat, c.library),
        hash = links.byKey.get(key);
      if (!hash) continue;
      const sid = await M.identity(chat, hash, digest);
      sessions.set(sid, chat);
      if (chat.deleted) continue;
      const rounds = M.visibleRounds(chat);
      const known = new Set();
      mirrored.set(sid, known);
      let base;
      for (const [i, t] of rounds.entries()) {
        if (t.user.id.startsWith("neo-u-")) continue;
        const [u, a] = await M.messageIDs(sid, t, digest);
        known.add(u);
        if (base === undefined) base = await clockFor(c, sid, chat, rounds);
        const cache = sid + "/" + u + "/" + a;
        if (state.published[cache]) continue;
        await publish(c, list, "session", {
          Hash: hash,
          ID: sid,
          Title: chat.session.title.slice(0, 240),
          Provider: M.native(chat.session.backend),
          CreatedAt: stamp(base),
          UpdatedAt: stamp(chat.session.updatedAt),
        });
        const msg = (id, role, content, delta) => ({
          id,
          documentId: "",
          role,
          content,
          createdAt: stamp(base + i * 2 + delta),
        });
        await publish(c, list, "turn", {
          Hash: hash,
          Session: sid,
          Messages: [
            msg(u, "user", t.user.text, 0),
            msg(a, "assistant", t.answer, 1),
          ],
        });
        state.published[cache] = true;
      }
    }
    const pulls = [];
    for (const n of list) {
      if (state.received[n]) continue;
      if (n.startsWith("session-")) {
        const h = await record(c, n);
        if (!M.neoID.test(h.ID) || !M.fullHash.test(h.Hash)) continue;
        const prev = state.heads[h.ID];
        if (!prev || Date.parse(h.UpdatedAt) > Date.parse(prev.UpdatedAt))
          state.heads[h.ID] = h;
        done.push(n);
      } else if (n.startsWith("turn-")) {
        const t = await record(c, n);
        if (
          M.neoID.test(t.Session) &&
          M.fullHash.test(t.Hash) &&
          Array.isArray(t.Messages) &&
          t.Messages.length
        )
          pulls.push({ n, t });
      }
    }
    pulls.sort(
      (a, b) =>
        a.t.Messages[0].createdAt.localeCompare(b.t.Messages[0].createdAt) ||
        a.n.localeCompare(b.n),
    );
    let changed = false;
    for (const { n, t } of pulls) {
      const ref = links.byHash.get(t.Hash),
        h = state.heads[t.Session];
      if (!ref || !h || h.Hash !== t.Hash) continue;
      let chat = sessions.get(t.Session);
      if (!chat) {
        const id = "neoread-" + t.Session;
        chat = document.chats[id] || {
          session: {
            id,
            title: h.Title,
            backend: M.backend(h.Provider),
            updatedAt: Date.parse(h.UpdatedAt),
            paper: {
              libraryKey: c.library,
              libraryID: 0,
              itemKey: ref.key,
              title: ref.title,
            },
          },
          events: [],
        };
        sessions.set(t.Session, chat);
      }
      if (
        !chat.deleted &&
        M.appendTurn(chat, t, mirrored.get(t.Session) || new Set())
      ) {
        document.chats[chat.session.id] = chat;
        changed = true;
      }
      done.push(n);
    }
    if (changed) {
      const body = JSON.stringify(document);
      check(enc.encode(body).length <= 32 * 1024 * 1024, "chat-size");
      if (old.status === 404) {
        const mk = await c.dav("MKCOL", "zotero-agent-chat/");
        check([201, 405].includes(mk.status), "chat-directory");
      }
      const res = await c.dav("PUT", "zotero-agent-chat/v1.json", {
        headers: {
          "Content-Type": "application/json",
          ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
        },
        body,
      });
      check([200, 201, 204].includes(res.status), "chat-write-" + res.status);
    }
    for (const n of done) state.received[n] = true;
    if (!state.mobileView) {
      const res = await c.dav("PUT", "zotero-agent-chat/read.html", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "If-None-Match": "*",
        },
        body: await (await win.fetch(rootURI + "read.html")).text(),
      });
      if ([200, 201, 204, 412].includes(res.status)) state.mobileView = true;
    }
    return { paperChats: sessions.size, received: done.length };
  }
  return {
    stop() {
      stopped = true;
    },
    async run() {
      try {
        stage = "connection";
        const c = await connection();
        if (!c) return;
        stage = "files";
        const links = await documentMap(c);
        await save();
        stage = "chats";
        const result = await chats(c, links);
        stage = "sources";
        await sources(c, links);
        state.status = {
          at: new Date().toISOString(),
          ...links.statistics,
          ...result,
        };
        await save();
        log("complete");
      } catch (e) {
        if (statePath && state) {
          state.status = {
            at: new Date().toISOString(),
            error: e.bridgeStage || stage,
          };
          await save();
        }
        throw e;
      }
    },
  };
}

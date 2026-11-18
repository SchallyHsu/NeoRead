import { readAccountUsage } from "./zotero/agent/account-usage";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { AcpClient } from "./zotero/agent/acp";
import { AcpAgentSession } from "./zotero/agent/session";
import { backendOf, findCli } from "./zotero/agent/backends";
import { ensureBridge } from "./zotero/agent/bridges";
import { bridgeEnv, cleanEnv, stripApiKeys } from "./zotero/agent/env";
import { syncSessionMetadata } from "./zotero/agent/session-metadata";
import { createNodeSpawner } from "./zotero/node-spawner";
import type { BackendId, PromptInput, Usage } from "./zotero/types";

type Request = {
  runId: string;
  backend: Exclude<BackendId, "pi">;
  cwd: string;
  projectName: string;
  title: string;
  executable?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  resume?: string;
  projectId?: string;
  bridgeDir: string;
  prompt: string;
  images: PromptInput["images"];
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let session: AcpAgentSession | undefined;
let stopping = false;
async function stop() {
  stopping = true;
  if (session) await session.cancel().catch(() => {});
}
lines.on("close", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
const helper = (name: string) =>
  import(new URL("./helpers/" + name + ".mjs", import.meta.url).href);
let started = false;
lines.on("line", async (line) => {
  if (started) return;
  started = true;
  const { type: operation, input: r }: { type: string; input: Request } =
    JSON.parse(line);
  const send = (event: Record<string, unknown>) =>
    process.stdout.write(
      JSON.stringify({ version: 1, runId: r.runId, ...event }) + "\n",
    );
  let phase = "executable";
  try {
    const spec = backendOf(r.backend);
    const base = cleanEnv(process.env as Record<string, string>);
    base.PATH = process.env.PATH || "";
    delete base.NEOREAD_TOKEN;
    delete base.ELECTRON_RUN_AS_NODE;
    const spawner = createNodeSpawner({ baseEnv: base });
    const env = stripApiKeys(
      base,
      spec.id === "deepseek-harness" ? [] : spec.apiKeyVars,
    );
    if (operation === "native-quota") {
      const account =
        r.backend === "codex"
          ? await readAccountUsage(
              spawner,
              r.backend,
              "subscription",
              r.executable,
            )
          : await (
              await helper("account-usage")
            ).readOtherAccountUsage({
              backend: r.backend,
              ...(r.backend === "deepseek-harness" && {
                cli: await findCli(spawner, env, spec, r.executable),
                model: r.model || "deepseek-official/default",
              }),
            });
      send({ type: "complete", quota: { account } });
      return;
    }
    const cli = await findCli(spawner, env, spec, r.executable);
    if (!cli) throw Error();
    const catalog = operation === "native-catalog";
    const translation = operation === "native-translation";
    const temporary = catalog || translation;
    if (!temporary) await mkdir(r.cwd, { recursive: true, mode: 0o700 });
    const cwd = temporary ? process.cwd() : await realpath(r.cwd);
    const node = process.execPath;
    let args = spec.directArgs ? [...spec.directArgs] : [];
    let command = cli,
      resume = r.resume,
      projectId = r.projectId || "",
      pending = "";
    const project = { cwd, projectName: r.projectName, title: r.title };
    if (temporary && r.backend === "antigravity") {
      if (translation) args.push("--sandbox");
      args.push(
        "--gemini-dir",
        path.resolve(
          process.env.ZOTERO_AGENT_GEMINI_DIR ||
            path.join(homedir(), ".gemini"),
        ),
        "--app-data-dir",
        "antigravity",
      );
    } else if (r.backend === "antigravity") {
      try {
        const { prepareSession } = await helper(
          "antigravity-project-integration",
        );
        const info = await prepareSession({
          ...project,
          agentSessionId: resume,
          operation: "resume",
          confirmedProjectId: projectId,
        });
        args.push(
          "--gemini-dir",
          info.geminiDir,
          "--app-data-dir",
          "antigravity",
        );
        resume = info.agentSessionId;
        projectId = info.backendProjectId;
      } catch {
        if (r.projectId) {
          phase = "project";
          throw Error();
        }
        pending = "Antigravity App 项目登记待重试，请检查 App 是否已安装。";
      }
    }
    if (!spec.directArgs) {
      phase = "bridge";
      const bridge = await ensureBridge({
        spawner,
        env,
        node,
        bridgeDir: r.bridgeDir,
        spec,
      });
      command = node;
      args = [bridge.entry];
    }
    phase = "handshake";
    if (stopping) throw Error();
    const childEnv = bridgeEnv(env, {
      node,
      claudeExecutable: r.backend === "claude-code" ? cli : undefined,
    });
    if (translation && r.backend === "deepseek-harness")
      childEnv.DSH_PERMISSION_MODE = "read-only";
    if (r.backend === "codex") {
      // Without CODEX_PATH the bridge runs its bundled CLI, which can have an older model catalog.
      childEnv.CODEX_PATH = cli;
      childEnv.CODEX_CONFIG = JSON.stringify({
        sandbox_mode: "read-only",
        approval_policy: "never",
        web_search: "disabled",
      });
    }
    const client = await AcpClient.spawn({
      spawner,
      command,
      args,
      initTimeoutMs: 90_000,
      cwd,
      env: childEnv,
    });
    session = await AcpAgentSession.open(client, spec, {
      backend: r.backend,
      cwd,
      brief: translation
        ? r.systemPrompt || "你是翻译助手。按照请求翻译资料，不调用工具。"
        : catalog
          ? ""
          : "你在 NeoRead 阅读侧栏中回答问题。",
      ephemeral: temporary,
      locked: translation,
      resumeSessionId: resume,
      freshNativeSession: !!resume && !r.resume,
    });
    if (stopping) throw Error();
    send({ type: "activity", phase: "native_ready" });
    if (catalog) {
      const current = session.currentModel();
      const models = [...session.models()];
      if (current && !models.some((model) => model.id === current)) {
        models.unshift({ id: current, name: current });
      }
      // Each backend can change its offered levels when the model changes.
      if (
        r.model &&
        r.model !== current &&
        models.some((m) => m.id === r.model)
      ) {
        phase = "model";
        await session.setModel(r.model);
      }
      const target = r.model || current;
      const levels = session.efforts().map(({ id, name }) => ({ id, name }));
      send({
        type: "complete",
        models: models.map((model) => ({
          ...model,
          isDefault: model.id === current,
          ...(model.id === target && { nativeEfforts: levels }),
        })),
      });
      return;
    }
    if (r.model && r.model !== session.currentModel()) {
      phase = "model";
      await session.setModel(r.model);
    }
    if (r.effort && r.effort !== session.currentEffort()) {
      phase = "effort";
      if (!session.efforts().some((level) => level.id === r.effort))
        throw Error();
      await session.setEffort(r.effort);
    }
    phase = "answer";
    if (r.images?.length && !session.supportsImages) {
      phase = "images";
      throw Error();
    }
    let answer = "",
      reasoning = "",
      completed = false;
    let turnUsage: Usage | undefined;
    let translationTool = false;
    session.on((event) => {
      if (event.t === "text") {
        answer += event.delta;
        send({ type: "delta", text: event.delta });
      }
      if (event.t === "thought") {
        reasoning += event.delta;
        send({ type: "reasoning", text: event.delta });
      }
      if (event.t === "permission") session!.respondPermission(event.id, null);
      if (translation && event.t === "tool" && !translationTool) {
        translationTool = true;
        void session!.cancel().catch(() => {});
      }
      if (event.t === "turn_end") {
        completed = event.stop === "end_turn";
        turnUsage = event.usage;
      }
    });
    await session.prompt({ text: r.prompt, images: r.images });
    if (translationTool || !completed || !answer.trim() || stopping) throw Error();
    const agentSessionId = session.sessionId;
    const model = session.currentModel();
    const effort = session.currentEffort();
    await session.close();
    session = undefined;
    if (translation) {
      send({
        type: "complete",
        text: answer,
        entries: reasoning,
        turnUsage: { ...turnUsage, model, effort },
      });
      return;
    }
    try {
      let info;
      if (r.backend === "deepseek-harness") {
        info = await (
          await helper("dsh-project-integration")
        ).enqueueProject({ ...project, agentSessionId });
      } else if (r.backend === "antigravity") {
        if (projectId)
          info = await (
            await helper("antigravity-project-integration")
          ).prepareSession({ ...project, agentSessionId });
      } else {
        info = await syncSessionMetadata(
          spawner,
          r.bridgeDir,
          {
            ...project,
            backend: r.backend,
            id: r.runId,
            updatedAt: Date.now(),
            agentSessionId,
          },
          { codexExecutable: r.executable },
        );
        if (r.backend === "codex" && info.backendProjectId) {
          info = {
            ...info,
            ...(await (
              await helper("codex-desktop-projects")
            ).registerDesktopProject({
              ...project,
              backendProjectId: info.backendProjectId,
              roots: info.backendProjectRoots || [cwd],
              sessionIds: [agentSessionId],
            })),
          };
        }
      }
      if (info) {
        projectId = info.backendProjectId || projectId;
        pending = info.syncPending
          ? info.syncReason || "请重启原生客户端以完成项目登记。"
          : "";
      }
    } catch {
      pending = "原生客户端的项目登记尚未确认，下轮回复后重试。";
    }
    send({
      type: "complete",
      id: agentSessionId,
      text: answer,
      message: pending,
      code: projectId,
      entries: reasoning,
      turnUsage: { ...turnUsage, model, effort },
    });
  } catch {
    send({ type: "error", code: phase });
    process.exitCode = 1;
  } finally {
    await session?.close().catch(() => {});
    lines.close();
    process.stdin.destroy();
  }
});

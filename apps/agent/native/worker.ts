import { createInterface } from "node:readline";
import { mkdir, realpath } from "node:fs/promises";
import { AcpClient } from "./zotero/agent/acp";
import { AcpAgentSession } from "./zotero/agent/session";
import { backendOf, findCli } from "./zotero/agent/backends";
import { ensureBridge } from "./zotero/agent/bridges";
import { bridgeEnv, cleanEnv, stripApiKeys } from "./zotero/agent/env";
import { syncSessionMetadata } from "./zotero/agent/session-metadata";
import { createNodeSpawner } from "./zotero/node-spawner";
import type { BackendId, PromptInput } from "./zotero/types";

type Request = {
  runId: string;
  backend: Exclude<BackendId, "pi">;
  cwd: string;
  projectName: string;
  title: string;
  executable?: string;
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
  const { input: r }: { input: Request } = JSON.parse(line);
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
    const cli = await findCli(spawner, env, spec, r.executable);
    if (!cli) throw Error();
    await mkdir(r.cwd, { recursive: true, mode: 0o700 });
    const cwd = await realpath(r.cwd);
    const node = process.execPath;
    let args = spec.directArgs ? [...spec.directArgs] : [];
    let command = cli,
      resume = r.resume,
      projectId = r.projectId || "",
      pending = "";
    const project = { cwd, projectName: r.projectName, title: r.title };
    if (r.backend === "antigravity") {
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
    if (r.backend === "codex")
      childEnv.CODEX_CONFIG = JSON.stringify({
        sandbox_mode: "read-only",
        approval_policy: "never",
        web_search: "disabled",
      });
    const client = await AcpClient.spawn({
      spawner,
      command,
      args,
      cwd,
      env: childEnv,
    });
    session = await AcpAgentSession.open(client, spec, {
      backend: r.backend,
      cwd,
      brief: "你在 NeoRead 阅读侧栏中回答问题。",
      resumeSessionId: resume,
      freshNativeSession: !!resume && !r.resume,
    });
    if (stopping) throw Error();
    phase = "answer";
    if (r.images?.length && !session.supportsImages) {
      phase = "images";
      throw Error();
    }
    let answer = "",
      reasoning = "",
      completed = false;
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
      if (event.t === "turn_end") completed = event.stop === "end_turn";
    });
    await session.prompt({ text: r.prompt, images: r.images });
    if (!completed || !answer.trim() || stopping) throw Error();
    const agentSessionId = session.sessionId;
    await session.close();
    session = undefined;
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

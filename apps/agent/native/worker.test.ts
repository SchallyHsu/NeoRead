import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
  readFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { backendOf } from "./zotero/agent/backends";
import { cp } from "node:fs/promises";

it("streams a DSH turn over ACP and queues the same project session on resume", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "neoread native-"));
  try {
    const src = path.dirname(fileURLToPath(import.meta.url));
    const worker = path.join(tmp, "worker.mjs");
    await build({
      entryPoints: [path.join(src, "worker.ts")],
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    await cp(path.join(src, "zotero/helpers"), path.join(tmp, "helpers"), {
      recursive: true,
    });
    const js = path.join(tmp, "fake.mjs");
    await writeFile(
      js,
      `#!/usr/bin/env node
import readline from "node:readline";
let model="dsh-default",effort="low";
const offers=()=>[{id:"model",category:"model",currentValue:model,options:[{value:"dsh-default",name:"Default model"},{value:"dsh-alt",name:"Alternate"}]},{id:"reasoning_effort",category:"thought_level",currentValue:effort,options:(model==="dsh-alt"?["off","high"]:["low"]).map(value=>({value,name:value}))}];
const out=x=>console.log(JSON.stringify({jsonrpc:"2.0",...x}));
readline.createInterface({input:process.stdin}).on("line",line=>{
 const {id,method,params}=JSON.parse(line);let result={};
 if(method==="initialize") result={protocolVersion:1,agentCapabilities:{}};
 if(method==="session/new")result={sessionId:"session-42",configOptions:offers()};
 if(method==="session/resume"&&params.sessionId!=="session-42")process.exit(4);
 if(method==="session/set_config_option"){if(params.configId==="model")model=params.value;else effort=params.value;result={configOptions:offers()}}\n if(method==="session/prompt"){if(model!=="dsh-alt"||effort!=="high")process.exit(5);out({method:"session/update",params:{sessionId:params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"test answer"}}}});result={stopReason:"end_turn"}}
 if(id!==undefined)out({id,result});
});`,
    );
    let executable = js;
    if (process.platform === "win32") {
      executable = path.join(tmp, "dsh.cmd");
      await writeFile(executable, '@node "%dp0%\\fake.mjs" %*\r\n');
    } else await chmod(js, 0o700);
    const dsh = path.join(tmp, "DSH");
    await mkdir(dsh);
    async function run(resume?: string, operation = "native") {
      const r = {
        runId: "test",
        backend: "deepseek-harness",
        projectName: "Test Reading",
        title: "Paper",
        cwd: path.join(tmp, "project"),
        bridgeDir: tmp,
        executable,
        prompt: "synthetic",
        model: "dsh-alt",
        effort: "high",
        images: [],
        resume,
      };
      const child = spawn(process.execPath, [worker], {
        env: { ...process.env, DSH_HOME: dsh },
        stdio: "pipe",
        windowsHide: true,
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (s) => (output += s));
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      child.stdin.write(JSON.stringify({ type: operation, input: r }) + "\n");
      expect(await closed).toBe(0);
      const events = output
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      if (operation === "native-catalog") {
        expect(events.at(-1)).toMatchObject({ type: "complete", models: [
          { id: "dsh-default", isDefault: true }, { id: "dsh-alt", isDefault: false, nativeEfforts:[{id:"off"},{id:"high"}] },
        ] });
        expect(events.some((event) => event.type === "delta")).toBe(false);
        return;
      }
      if (operation === "native-translation") {
        expect(events.at(-1)).toMatchObject({type:"complete",text:"test answer",turnUsage:{model:"dsh-alt",effort:"high"}});
        return;
      }
      expect(events.find((e) => e.type === "delta")).toMatchObject({
        type: "delta",
        text: "test answer",
      });
      expect(events.at(-1)).toMatchObject({
        type: "complete",
        id: "session-42",
        text: "test answer",
      });
      return events.at(-1).id;
    }
    await run(undefined, "native-catalog");
    await run(undefined, "native-translation");
    await expect(readFile(path.join(dsh, "cordis.patch.yml"))).rejects.toMatchObject({code:"ENOENT"});
    await run(await run());
    expect(
      await readFile(path.join(dsh, "cordis.patch.yml"), "utf8"),
    ).toContain("Zotero Agent native projects");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 30000);

it("discovers Codex efforts with the selected executable, including when the parent names another CLI", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "neoread-codex-"));
  try {
    const worker = path.join(tmp, "worker.mjs");
    const spec = backendOf("codex");
    const bridge = path.join(tmp, "node_modules", spec.pkg);
    await mkdir(bridge, { recursive: true });
    await build({
      entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    await writeFile(path.join(bridge, "package.json"), JSON.stringify({ version: spec.version, bin: "acp.mjs" }));
    await writeFile(path.join(bridge, "acp.mjs"), `
import { createInterface } from "node:readline";
const levels = process.env.CODEX_PATH === process.execPath ? ["low", "high", "ultra"] : ["high"];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  const result = method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} }
    : method === "session/new" ? { sessionId: "catalog", models: { currentModelId: "sample[high]",
      availableModels: levels.map(level => ({ modelId: "sample[" + level + "]", name: "Sample" })) } } : {};
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}`);
    const child = spawn(process.execPath, [worker], {
      cwd: tmp,
      env: { ...process.env, CODEX_PATH: "older-codex" },
      windowsHide: true,
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stdin.write(JSON.stringify({
      type: "native-catalog",
      input: { runId: "test", backend: "codex", bridgeDir: tmp, executable: process.execPath },
    }) + "\n");
    expect(await closed).toBe(0);
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    expect(result).toMatchObject({ type: "complete", models: [
      { id: "sample", nativeEfforts: [{ id: "low" }, { id: "high" }, { id: "ultra" }] },
    ] });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 30_000);

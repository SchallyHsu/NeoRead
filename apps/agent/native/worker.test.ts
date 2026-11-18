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
const out=x=>console.log(JSON.stringify({jsonrpc:"2.0",...x}));
readline.createInterface({input:process.stdin}).on("line",line=>{
 const {id,method,params}=JSON.parse(line);let result={};
 if(method==="initialize") result={protocolVersion:1,agentCapabilities:{}};
 if(method==="session/new")result={sessionId:"session-42"};
 if(method==="session/resume"&&params.sessionId!=="session-42")process.exit(4);
 if(method==="session/prompt"){out({method:"session/update",params:{sessionId:params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"test answer"}}}});result={stopReason:"end_turn"}}
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
    async function run(resume?: string) {
      const r = {
        runId: "test",
        backend: "deepseek-harness",
        projectName: "Test Reading",
        title: "Paper",
        cwd: path.join(tmp, "project"),
        bridgeDir: tmp,
        executable,
        prompt: "synthetic",
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
      child.stdin.write(JSON.stringify({ type: "native", input: r }) + "\n");
      expect(await closed).toBe(0);
      const events = output
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
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
    await run(await run());
    expect(
      await readFile(path.join(dsh, "cordis.patch.yml"), "utf8"),
    ).toContain("Zotero Agent native projects");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 30000);

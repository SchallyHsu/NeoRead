import { useEffect, useState } from "react";
import { api, type NativeAgentSettings } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";

export const nativeAgentLabels: Record<string, string> = {
  "native:claude-code": "Claude Code",
  "native:codex": "Codex",
  "native:antigravity": "Antigravity",
  "native:deepseek-harness": "DeepSeek Harness",
};
export function NativeAgentSettingsPanel({ open }: { open: boolean }) {
  const [cfg, setCfg] = useState<NativeAgentSettings>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (open)
      api
        .nativeAgent?.()
        .then((v) => {
          if (alive) setCfg(v);
        })
        .catch((e) => {
          if (alive) setStatus(e.message);
        });
    return () => {
      alive = false;
    };
  }, [open]);
  async function save() {
    if (!cfg) return;
    setBusy(true);
    try {
      setCfg(await api.saveNativeAgent(cfg));
      window.dispatchEvent(new Event("native-agent-changed"));
      setStatus("已保存");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-5 grid gap-2">
      <h3 className="text-sm font-medium">阅读侧栏助手</h3>
      {cfg && (
        <>
          <label>
            对话方式{" "}
            <select
              value={cfg.provider}
              onChange={(e) => {
                setCfg({ ...cfg, provider: e.target.value });
                setStatus("");
              }}
            >
              <option value="">内置模型连接</option>
              {Object.entries(nativeAgentLabels).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {cfg.provider && (
            <>
              <label>
                原生项目名称
                <Input
                  value={cfg.projectName}
                  onChange={(e) =>
                    setCfg({ ...cfg, projectName: e.target.value })
                  }
                />
              </label>
              <label>
                项目工作目录
                <Input
                  placeholder="留空使用书库内的独立项目目录"
                  value={cfg.directory}
                  onChange={(e) =>
                    setCfg({ ...cfg, directory: e.target.value })
                  }
                />
              </label>
              <label>
                助手程序路径
                <Input
                  placeholder="留空自动检测"
                  value={cfg.executables[cfg.provider] || ""}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      executables: {
                        ...cfg.executables,
                        [cfg.provider]: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <p className="text-xs text-muted-foreground">
                使用本机已登录的 CLI，按项目保存会话。首次使用 Claude Code 或
                Codex 会安装对应的 ACP 桥接组件。
              </p>
            </>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={save}>
            保存对话设置
          </Button>
        </>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

import { useEffect, useState } from "react";
import { api, type WebDAVConfig, type WebDAVStatus } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";

export function WebDAVSettings({ open }: { open: boolean }) {
  const [config, setConfig] = useState<WebDAVConfig>();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<WebDAVStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const fetchStatus = (initial: boolean) =>
      api
        .webdav?.()
        .then(({ enabled, url, username, status }) => {
          if (alive) {
            if (initial) setConfig({ enabled, url, username });
            setStatus(status);
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    void fetchStatus(true);
    const timer = setInterval(() => void fetchStatus(false), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
      setPassword("");
    };
  }, [open]);
  async function save() {
    if (!config) return;
    setError("");
    setBusy(true);
    try {
      await api.saveWebdav(config, password);
      setPassword("");
      if (config.enabled) {
        const next = await api.syncWebdav();
        setStatus(next);
        window.dispatchEvent(new Event("neoread-webdav-sync"));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="my-5 grid gap-2">
      <h3 className="text-sm font-medium">跨设备同步</h3>
      {config && (
        <>
          <label>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) =>
                setConfig({ ...config, enabled: e.target.checked })
              }
            />{" "}
            通过 WebDAV 同步原文件和聊天
          </label>
          <label>
            WebDAV 目录地址
            <Input
              value={config.url}
              placeholder="https://主机/目录"
              onChange={(e) => setConfig({ ...config, url: e.target.value })}
            />
          </label>
          <label>
            用户名
            <Input
              autoComplete="off"
              value={config.username}
              onChange={(e) =>
                setConfig({ ...config, username: e.target.value })
              }
            />
          </label>
          <label>
            密码
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="留空使用本机已保存的密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            各设备填写同一个现有目录。NeoRead 打开期间每分钟同步 PDF、EPUB
            和会话，在主机的 neoread-v1 子目录保留副本。删除仅作用于当前设备。
          </p>
          <Button variant="outline" size="sm" onClick={save} disabled={busy}>
            {busy
              ? "正在处理…"
              : config.enabled
                ? "保存并同步"
                : "保存同步设置"}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        config?.enabled &&
        status?.at && (
          <p role="status">
            {status.error || "上次同步完成"} ·{" "}
            {new Date(status.at).toLocaleTimeString()}
          </p>
        )
      )}
    </section>
  );
}

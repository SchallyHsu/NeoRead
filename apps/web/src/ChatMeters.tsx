import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@neoread/api";
import type { Message } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import { RefreshCw } from "lucide-react";
import { cn } from "@neoread/ui/lib/utils";

type Quota = Awaited<ReturnType<typeof api.agentQuota>>;
export function contextFill(messages: Message[], provider: string) {
  for (const m of [...messages].reverse()) {
    if (m.role !== "assistant") continue;
    if (m.usage?.provider && m.usage.provider !== provider) return;
    const u = m.usage;
    if (
      u?.provider === provider &&
      u.contextUsed != null &&
      u.contextUsed >= 0 &&
      u.contextSize &&
      u.contextSize > 0
    ) {
      return {
        used: u.contextUsed,
        size: u.contextSize,
        pct: Math.min(100, Math.round((100 * u.contextUsed) / u.contextSize)),
        estimated: u.estimated,
      };
    }
  }
}
export function meterLevel(kind: "quota" | "context", pct?: number) {
  if (pct == null) return "";
  if (kind === "context") return pct >= 85 ? "high" : pct >= 70 ? "warm" : "";
  return pct <= 10 ? "high" : pct <= 30 ? "warm" : "";
}
export function quotaSummary(data: Quota | undefined, now: number) {
  const windows =
    data?.account?.windows ??
    (data?.remaining != null
      ? [
          {
            id: "main",
            label: "账号额度",
            usedPercent: 100 - data.remaining,
            resetsAt: data.resetsAt ? Date.parse(data.resetsAt) : undefined,
          },
        ]
      : []);
  const live = windows.filter((w) => !w.resetsAt || w.resetsAt > now);
  const tight = live.reduce<(typeof live)[number] | undefined>(
    (prev, w) => (!prev || w.usedPercent > prev.usedPercent ? w : prev),
    undefined,
  );
  return {
    windows,
    tight,
    left: tight
      ? Math.max(0, Math.min(100, Math.round(100 - tight.usedPercent)))
      : undefined,
  };
}
function Ring({
  kind,
  pct,
  stale,
}: {
  kind: "context" | "quota";
  pct?: number;
  stale?: boolean;
}) {
  const level = stale ? "" : meterLevel(kind, pct);
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 -rotate-90",
        level === "high"
          ? "text-destructive"
          : level === "warm"
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
      )}
      fill="none"
    >
      <circle
        cx="9"
        cy="9"
        r="7"
        stroke="currentColor"
        strokeWidth="2"
        opacity=".24"
      />
      {pct != null && (
        <circle
          cx="9"
          cy="9"
          r="7"
          stroke="currentColor"
          strokeWidth="2"
          pathLength="100"
          strokeDasharray={String(pct) + " 100"}
        />
      )}
    </svg>
  );
}
const number = (v?: number) => (v == null ? "未报告" : v.toLocaleString());
const date = (n: number) => new Date(n).toLocaleString();
type QuotaSnapshot = { data?: Quota; error?: string; at: number };
// Account limits are shared by all papers. Reopening the reader reuses the
// in-memory snapshot and provider cooldown, never a previous connection's data.
const quotaCache = new Map<string, { snapshot: QuotaSnapshot; next: number }>();
export function ChatMeters({
  provider,
  connectionKey,
  messages,
  active = true,
  onNewChat,
}: {
  provider: string;
  connectionKey: string;
  messages: Message[];
  active?: boolean;
  onNewChat?: () => void;
}) {
  const route =
    provider === "native:deepseek-harness"
      ? [...messages]
          .reverse()
          .find((m) => m.usage?.provider === provider && m.usage.model)?.usage
          ?.model || ""
      : "";
  const capable =
    provider === "codex" ||
    provider === "claude" ||
    provider.startsWith("native:");
  const accountKey = JSON.stringify([provider, connectionKey, route]);
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>({ at: 0 });
  const [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  const run = useRef<AbortController | null>(null),
    next = useRef(0);
  const refresh = useCallback(
    async (manual = false) => {
      if (
        !active ||
        !capable ||
        document.hidden ||
        run.current ||
        (!manual && Date.now() < next.current)
      )
        return;
      const controller = new AbortController();
      run.current = controller;
      setBusy(true);
      next.current =
        Date.now() + (provider.includes("claude") ? 300000 : 30000);
      try {
        const data = await api.agentQuota(provider, controller.signal, route);
        if (controller.signal.aborted) return;
        next.current = Math.max(next.current, data.account?.retryAt || 0);
        const error =
          data.error ||
          (data.account?.status === "unavailable"
            ? data.account.message || "额度暂不可用"
            : "");
        const previous = quotaCache.get(accountKey)?.snapshot ?? { at: 0 };
        const fresh = error
          ? { ...previous, error }
          : { data, at: data.account?.checkedAt || Date.now() };
        quotaCache.set(accountKey, { snapshot: fresh, next: next.current });
        setSnapshot(fresh);
      } catch {
        if (!controller.signal.aborted) {
          const fresh = {
            ...(quotaCache.get(accountKey)?.snapshot ?? { at: 0 }),
            error: "额度查询失败",
          };
          quotaCache.set(accountKey, { snapshot: fresh, next: next.current });
          setSnapshot(fresh);
        }
      } finally {
        if (run.current === controller) {
          run.current = null;
          setBusy(false);
          setNow(Date.now());
        }
      }
    },
    [provider, active, capable, accountKey, route],
  );
  useEffect(() => {
    const cached = quotaCache.get(accountKey);
    setSnapshot(cached?.snapshot ?? { at: 0 });
    next.current = cached?.next || 0;
    setBusy(false);
    void refresh();
    const check = () => {
      setNow(Date.now());
      void refresh();
    };
    const timer = window.setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      run.current?.abort();
      run.current = null;
    };
  }, [refresh, accountKey]);
  useEffect(() => {
    void refresh();
  }, [messages.length, refresh]);
  const { windows, tight, left } = quotaSummary(snapshot.data, now);
  const account = snapshot.data?.account,
    balance = account?.balances?.[0];
  const stale =
    !!snapshot.at && (!!snapshot.error || now - snapshot.at > 120000);
  const quotaText = tight
    ? tight.label + "剩余 " + left + "%"
    : balance
      ? balance.label + " " + balance.remaining + " " + (balance.currency ?? "")
      : windows.length
        ? "额度待刷新"
        : capable
          ? busy
            ? "额度查询中"
            : "额度未报告"
          : "对话用量";
  const ctx = contextFill(messages, provider);
  const answers = messages.filter((m) => m.role === "assistant");
  const usages = answers
    .map((m) => m.usage)
    .filter((u) => u?.inputTokens != null || u?.outputTokens != null);
  const sum = (field: "inputTokens" | "outputTokens") => {
    const vals = usages.flatMap((u) => (u?.[field] != null ? [u[field]!] : []));
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
  };
  const last = answers.at(-1)?.usage;
  const contextText = ctx ? "上下文已用 " + ctx.pct + "%" : "上下文未报告";
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={"额度与用量：" + quotaText}
              title={(stale ? "上次数据 · " : "") + quotaText}
            />
          }
        >
          <Ring kind="quota" pct={left} stale={stale} />
        </PopoverTrigger>
        <PopoverContent className="max-h-80 w-72 overflow-auto p-3 text-xs">
          <div className="flex items-center justify-between">
            <PopoverTitle>额度与用量</PopoverTitle>
            {capable && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="刷新额度"
                disabled={busy}
                onClick={() => void refresh(true)}
              >
                <RefreshCw />
              </Button>
            )}
          </div>
          <p role="status">
            {stale ? "上次数据 · " : ""}
            {quotaText}
            {account?.plan ? " · " + account.plan : ""}
          </p>
          {windows.map((w) => (
            <p key={w.id}>
              {w.label} ·{" "}
              {w.resetsAt && w.resetsAt <= now
                ? "等待刷新"
                : "剩余 " + Math.round(100 - w.usedPercent) + "%"}
              {w.resetsAt ? " · " + date(w.resetsAt) + " 重置" : ""}
            </p>
          ))}
          {account?.balances?.map((b, i) => (
            <p key={i}>
              {b.label} · {b.remaining} {b.currency}
            </p>
          ))}
          {(snapshot.error || account?.message) && (
            <p>{snapshot.error || account?.message}</p>
          )}
          {snapshot.at > 0 && (
            <p className="text-muted-foreground">
              最近查询 {date(snapshot.at)}
            </p>
          )}
          <p>
            本轮输入 / 输出：{number(last?.inputTokens)} /{" "}
            {number(last?.outputTokens)} Tokens
          </p>
          <p>
            本会话输入 / 输出：{number(sum("inputTokens"))} /{" "}
            {number(sum("outputTokens"))} Tokens
          </p>
          <p>
            已报告用量的轮次：{usages.length} / {answers.length}
          </p>
          {last?.costUsd != null && <p>本轮后端估算费用：USD {last.costUsd}</p>}
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              title={contextText}
              aria-label={contextText}
            />
          }
        >
          <Ring kind="context" pct={ctx?.pct} />
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3 text-xs">
          <PopoverTitle>会话上下文</PopoverTitle>
          <p role="status">{contextText}</p>
          {ctx && (
            <p>
              {ctx.estimated ? "SDK 估算" : "后端报告"}：{number(ctx.used)} /{" "}
              {number(ctx.size)} Tokens
            </p>
          )}
          {ctx && ctx.pct >= 70 && (
            <p>
              {ctx.pct >= 85 ? "上下文即将用满。" : "上下文占用较高。"}
              可以新建会话继续阅读。
            </p>
          )}
          {onNewChat && (
            <Button variant="outline" size="sm" onClick={onNewChat}>
              新建会话
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

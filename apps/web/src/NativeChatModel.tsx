import { useEffect, useState } from "react";
import { api } from "@neoread/api";
import type { AgentModel } from "@neoread/core";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import { toast } from "sonner";
import { ProviderIcon, providerLabel } from "./ProviderIdentity";
import { readingAgent } from "./NativeAgentSettings";
import { useReaderStore } from "./store";

const AUTO = "";

// A native agent offers models during its own ACP handshake. Open the catalog
// on demand so merely reading a PDF does not start a CLI or create a session.
export function NativeChatModel({
  provider,
  disabled,
  discover = false,
  lastModel,
}: {
  provider: string;
  disabled: boolean;
  discover?: boolean;
  lastModel?: string;
}) {
  const { aiConfig, aiModelSaving, setAIConfig, setAIModelSaving } =
    useReaderStore();
  const executable = aiConfig?.nativeAgent?.executables[provider] || "";
  const selected = aiConfig?.models[provider] || AUTO;
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setModels([]);
    setError("");
    const probe = open || discover;
    setLoading(probe);
    void api
      .agentModels(provider, controller.signal, probe, !probe)
      .then((list) => {
        if (!controller.signal.aborted) setModels(list);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [provider, executable, open, discover]);

  const choose = async (value: string | null) => {
    if (
      value === null ||
      value === selected ||
      useReaderStore.getState().aiModelSaving
    )
      return;
    setAIModelSaving(true);
    try {
      const latest = await api.aiConfig();
      if (
        readingAgent(latest) !== provider ||
        (latest.nativeAgent?.executables[provider] || "") !== executable
      ) {
        setAIConfig(latest);
        throw new Error("Agent 连接已改变，请重新选择模型");
      }
      setAIConfig(
        await api.saveAIConfig({
          ...latest,
          models: { ...latest.models, [provider]: value },
        }),
      );
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setAIModelSaving(false);
    }
  };
  const name = providerLabel(provider);
  const chosen = models.find((model) => model.id === selected);
  const defaultModel = models.find((model) => model.isDefault)?.name;
  const automaticLabel = lastModel
    ? "跟随会话 · " +
      (models.find((model) => model.id === lastModel)?.name || lastModel)
    : defaultModel
      ? "默认 · " + defaultModel
      : "跟随会话模型";
  return (
    <Select
      value={selected}
      disabled={disabled || aiModelSaving}
      onOpenChange={setOpen}
      onValueChange={(value) => void choose(value)}
    >
      <SelectTrigger
        className="min-w-0 max-w-full"
        aria-label={name + " 问答模型"}
      >
        <ProviderIcon provider={provider} size={18} />
        <SelectValue className="min-w-0 truncate">
          {name} · {chosen?.name || selected || automaticLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectItem value={AUTO}>跟随 Agent 会话模型</SelectItem>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id} label={model.name}>
            {model.name}
            {model.isDefault ? "（新会话默认）" : ""}
          </SelectItem>
        ))}
        {open && selected && !chosen && !loading && !error && (
          <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
            已选模型未出现在本次列表中
          </p>
        )}
        {loading && (
          <p className="px-2 py-1 text-xs" role="status">
            正在读取 {name} 的模型…
          </p>
        )}
        {error && (
          <p className="px-2 py-1 text-xs" role="alert">
            {error}。重新打开可重试。
          </p>
        )}
        {open && !loading && !error && models.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
            此连接未报告可选模型
          </p>
        )}
      </SelectContent>
    </Select>
  );
}

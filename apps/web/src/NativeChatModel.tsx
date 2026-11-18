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
  task = "chat",
  lastModel,
}: {
  provider: string;
  disabled: boolean;
  discover?: boolean;
  task?: "chat" | "translation";
  lastModel?: string;
}) {
  const { aiConfig, aiModelSaving, setAIConfig, setAIModelSaving } =
    useReaderStore();
  const executable = aiConfig?.nativeAgent?.executables[provider] || "";
  const label = task === "chat" ? "问答" : "翻译";
  const modelField = task === "chat" ? "models" : "translationModels";
  const effortField = task === "chat" ? "efforts" : "translationEfforts";
  const selected = aiConfig?.[modelField]?.[provider] || AUTO;
  const effortModel =
    selected ||
    (task === "translation" ? aiConfig?.models[provider] : "") ||
    "";
  const effort = aiConfig?.[effortField]?.[provider]?.[effortModel] || AUTO;
  const target = effortModel || lastModel || "";
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
      .agentModels(
        provider,
        controller.signal,
        probe,
        !probe,
        target || undefined,
      )
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
  }, [provider, executable, open, discover, target]);

  const choose = async (kind: "model" | "effort", value: string | null) => {
    if (
      value === null ||
      value === (kind === "model" ? selected : effort) ||
      useReaderStore.getState().aiModelSaving
    )
      return;
    setAIModelSaving(true);
    try {
      const latest = await api.aiConfig();
      if (
        readingAgent(latest) !== provider ||
        (latest.nativeAgent?.executables[provider] || "") !== executable ||
        (kind === "effort" &&
          (latest[modelField]?.[provider] ||
            (task === "translation" ? latest.models[provider] : "") ||
            AUTO) !== effortModel)
      ) {
        setAIConfig(latest);
        throw new Error("Agent 连接已改变，请重新选择模型");
      }
      setAIConfig(
        await api.saveAIConfig({
          ...latest,
          ...(kind === "model"
            ? { [modelField]: { ...latest[modelField], [provider]: value } }
            : {
                [effortField]: {
                  ...latest[effortField],
                  [provider]: {
                    ...latest[effortField]?.[provider],
                    [effortModel]: value,
                  },
                },
              }),
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
  const current = target
    ? models.find((model) => model.id === target)
    : models.find((model) => model.isDefault);
  const levels = current?.nativeEfforts ?? [];
  const automaticLabel = lastModel
    ? "跟随会话 · " +
      (models.find((model) => model.id === lastModel)?.name || lastModel)
    : defaultModel
      ? "默认 · " + defaultModel
      : "跟随会话模型";
  return (
    <>
      <Select
        value={selected}
        disabled={disabled || aiModelSaving}
        onOpenChange={setOpen}
        onValueChange={(value) => void choose("model", value)}
      >
        <SelectTrigger
          className="model-select-trigger min-w-0 max-w-full"
          aria-label={name + " " + label + "模型"}
        >
          <ProviderIcon provider={provider} size={18} />
          <SelectValue className="min-w-0 truncate">
            {name} ·{" "}
            {chosen?.name ||
              selected ||
              (task === "translation"
                ? "跟随问答 · " +
                  (current?.name || target || defaultModel || "默认模型")
                : automaticLabel)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          <SelectItem value={AUTO}>
            {task === "translation" ? "跟随问答模型" : "跟随 Agent 会话模型"}
          </SelectItem>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id} label={model.name}>
              {model.name}
              {model.isDefault ? "（新会话默认）" : ""}
            </SelectItem>
          ))}
          {open && selected && !chosen && !loading && !error && (
            <p
              className="px-2 py-1 text-xs text-muted-foreground"
              role="status"
            >
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
            <p
              className="px-2 py-1 text-xs text-muted-foreground"
              role="status"
            >
              此连接未报告可选模型
            </p>
          )}
        </SelectContent>
      </Select>
      <Select
        value={effort}
        disabled={disabled || aiModelSaving}
        onOpenChange={setOpen}
        onValueChange={(value) => void choose("effort", value)}
      >
        <SelectTrigger
          className="shrink-0"
          aria-label={name + " " + label + "推理强度"}
          title="推理强度"
        >
          <SelectValue>
            {levels.find((option) => option.id === effort)?.name ||
              effort ||
              "自动强度"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          <SelectItem value={AUTO}>跟随 Agent 强度</SelectItem>
          {levels.map(({ id, name }) => (
            <SelectItem key={id} value={id} label={name}>
              {name}
            </SelectItem>
          ))}
          {loading && (
            <p role="status" className="px-2 py-1 text-xs">
              正在读取推理强度…
            </p>
          )}
          {error && (
            <p role="alert" className="px-2 py-1 text-xs">
              {error}。重新打开可重试。
            </p>
          )}
          {!loading && !error && levels.length === 0 && (
            <p role="status" className="px-2 py-1 text-xs">
              当前模型未报告可调强度
            </p>
          )}
        </SelectContent>
      </Select>
    </>
  );
}

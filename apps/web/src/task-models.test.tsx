// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { AIConfig, AgentModel } from "@neoread/core";
import { NativeChatModel } from "./NativeChatModel";
import { TaskModels, taskChoice } from "./TaskModels";
import { useReaderStore } from "./store";
vi.mock("@neoread/api", () => ({
  api: { agentModels: vi.fn(), aiConfig: vi.fn(), saveAIConfig: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// The first Base UI select also pays jsdom warm-up; CI runners exceed 5 s.
vi.setConfig({ testTimeout: 20_000 });
const models: AgentModel[] = [
  { id: "opus", name: "Opus", description: "", isDefault: true },
  {
    id: "fable",
    name: "Fable",
    description: "",
    isDefault: false,
    recommendedFor: ["chat"],
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description: "",
    isDefault: false,
    recommendedFor: ["translation"],
  },
];
let root: Root;
let host: HTMLDivElement;
let config: AIConfig;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  config = {
    primary: "claude",
    models: { claude: "opus" },
    efforts: { claude: { opus: "high" } },
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.agentModels).mockResolvedValue(models);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.saveAIConfig).mockImplementation(async (value) => {
    config = value;
    return value;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const trigger = (label: string) =>
  host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
async function choose(label: string, text: string) {
  const button = trigger(label);
  await act(async () => button.click());
  const list = document.getElementById(button.getAttribute("aria-controls")!);
  expect(list).toBeTruthy();
  const option = Array.from(list!.querySelectorAll('[role="option"]')).find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === text,
  ) as HTMLElement;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option.click();
  });
}
it("defaults effort to medium and keys choices per task", () => {
  expect(taskChoice(config, "chat")).toEqual({ model: "opus", effort: "high" });
  expect(taskChoice(config, "translation")).toEqual({
    model: "",
    effort: "medium",
  });
});
it("saves the translation model without touching chat", async () => {
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译模型", "Fable");
  expect(config.translationModels).toEqual({ claude: "fable" });
  expect(config.models).toEqual({ claude: "opus" });
});
it("saves the translation effort without touching chat", async () => {
  config.translationModels = { claude: "fable" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译 Effort", "Low");
  expect(config.translationEfforts).toEqual({ claude: { fable: "low" } });
  expect(config.efforts).toEqual({ claude: { opus: "high" } });
});
it("returns translation to automatic selection", async () => {
  config.translationModels = { claude: "fable" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<TaskModels disabled={false} />));
  await choose("翻译模型", "Sonnet");
  expect(config.translationModels).toEqual({ claude: "" });
});
const checked = { checkedAt: "2026-10-09" };
const apiModels: AgentModel[] = [
  {
    id: "deepseek-flash",
    name: "Flash",
    description: "",
    isDefault: false,
    recommendedFor: ["translation", "vision"],
    capability: { text: true, vision: true, ...checked },
  },
  {
    id: "deepseek-v4-pro",
    name: "Pro",
    description: "",
    isDefault: false,
    recommendedFor: ["chat"],
    capability: { text: true, vision: false, ...checked },
  },
  {
    id: "broken",
    name: "Broken",
    description: "",
    isDefault: false,
    custom: true,
    capability: { text: false, vision: false, ...checked },
  },
];
it("leaves the API image model empty when no model passed vision", async () => {
  config = { ...config, primary: "api", models: {}, efforts: {} };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue(
    apiModels.slice(1).map((model) => ({
      ...model,
      recommendedFor: model.recommendedFor?.filter((t) => t !== "vision"),
    })),
  );
  await act(async () => root.render(<TaskModels disabled={false} />));
  expect(trigger("图片模型").textContent).toContain("无可用模型");
  expect(trigger("图片模型").disabled).toBe(false);
  expect(host.textContent).toContain("没有通过图片理解检测的模型");
});

it("disables effort for fixed models and keeps tunable models selectable", async () => {
  config.primary = "api";
  config.models = { api: "fixed" };
  config.translationModels = { api: "tunable" };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue([
    {
      id: "fixed",
      name: "Fixed",
      description: "",
      isDefault: true,
      capability: { text: true, vision: false, checkedAt: "now" },
      effortInfo: { mode: "fixed", note: "固定模式" },
    },
    {
      id: "tunable",
      name: "Tunable",
      description: "",
      isDefault: false,
      capability: { text: true, vision: false, checkedAt: "now" },
      effortInfo: {
        mode: "levels",
        note: "官方映射",
        mappings: { medium: "high" },
      },
    },
  ]);
  await act(async () => root.render(<TaskModels disabled={false} />));
  expect(trigger("问答 Effort").disabled).toBe(true);
  expect(trigger("问答 Effort").textContent).toContain("固定／自动");
  expect(trigger("翻译 Effort").disabled).toBe(false);
});
it.each(["codex", "claude", "kimi"])(
  "checks expiry only when the settings picker opens for %s",
  async (provider) => {
    config = { ...config, primary: provider, models: { [provider]: "opus" } };
    useReaderStore.setState({ aiConfig: config });
    await act(async () => root.render(<TaskModels disabled={false} />));
    expect(api.agentModels).toHaveBeenCalledExactlyOnceWith(
      provider,
      expect.any(AbortSignal),
      false,
      true,
    );
    await choose("翻译模型", "Fable");
    expect(
      vi.mocked(api.agentModels).mock.calls.filter((call) => call[2]),
    ).toHaveLength(1);
    await act(async () =>
      useReaderStore.setState({
        aiConfig: {
          ...config,
          capabilities: {
            [provider]: { text: true, vision: false, checkedAt: "updated" },
          },
        },
      }),
    );
    expect(
      vi.mocked(api.agentModels).mock.calls.filter((call) => call[2]),
    ).toHaveLength(1);
    await choose("问答模型", "Sonnet");
    expect(
      vi.mocked(api.agentModels).mock.calls.filter((call) => call[2]),
    ).toHaveLength(2);
  },
);

it("reloads the catalog after detection while retaining the selected model", async () => {
  await act(async () =>
    root.render(<TaskModels disabled={false} refreshKey={0} />),
  );
  vi.mocked(api.agentModels).mockClear();
  let resolve!: (models: AgentModel[]) => void;
  vi.mocked(api.agentModels).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(<TaskModels disabled={false} refreshKey={1} />),
  );
  expect(api.agentModels).toHaveBeenCalledTimes(1);
  expect(api.agentModels).toHaveBeenCalledWith(
    "claude",
    expect.any(AbortSignal),
    false,
    true,
  );
  expect(trigger("问答模型").textContent).toContain("Opus");
  expect(useReaderStore.getState().aiConfig?.primary).toBe("claude");
  await act(async () => resolve(models));
  expect(api.saveAIConfig).not.toHaveBeenCalled();
});

it("uses the CLI's own default and saves and resets its model without changing another agent", async () => {
  const provider = "native:claude-code";
  config.nativeAgent = { provider, executables: {}, projectName: "Reading", directory: "" };
  useReaderStore.setState({ aiConfig: config });
  await act(async () => root.render(<NativeChatModel provider={provider} disabled={false} discover />));
  expect(trigger("Claude Code 问答模型").textContent).toContain("默认 · Opus");
  await choose("Claude Code 问答模型", "Sonnet");
  expect(config.models).toEqual({ claude: "opus", [provider]: "sonnet" });
  await choose("Claude Code 问答模型", "跟随 Agent 会话模型");
  expect(config.models).toEqual({ claude: "opus", [provider]: "" });
  expect(config.primary).toBe("claude");
});

it("keeps separate native chat and translation effort per effective model", async () => {
  const provider = "native:deepseek-harness";
  config.nativeAgent = { provider, executables: {}, projectName: "Reading", directory: "" };
  config.models[provider] = "opus";
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockImplementation(async (_provider, _signal, _refresh, _cached, selected) =>
    models.map(m => ({...m, nativeEfforts: m.id === selected ? [{id:"off",name:"Off"},{id:"max",name:"Max"}] : []})));
  await act(async () => root.render(<><NativeChatModel provider={provider} disabled={false} discover /><NativeChatModel task="translation" provider={provider} disabled={false} discover /></>));
  expect(trigger("DeepSeek Harness 翻译模型").textContent).toContain("跟随问答 · Opus");
  await choose("DeepSeek Harness 问答推理强度","Off");
  await choose("DeepSeek Harness 翻译推理强度","Max");
  expect(config.efforts?.[provider]).toEqual({opus:"off"});
  expect(config.translationEfforts?.[provider]).toEqual({opus:"max"});
  await choose("DeepSeek Harness 翻译模型","Sonnet");
  expect(config.translationModels?.[provider]).toBe("sonnet");
  expect(trigger("DeepSeek Harness 翻译推理强度").textContent).toContain("自动强度");
  await choose("DeepSeek Harness 翻译模型","跟随问答模型");
  expect(trigger("DeepSeek Harness 翻译推理强度").textContent).toContain("Max");
});


it("keeps the clicked sidebar model when its effort catalog has not been cached", async () => {
  const provider = "native:deepseek-harness";
  config.nativeAgent = {
    provider,
    executables: {},
    projectName: "Reading",
    directory: "",
  };
  useReaderStore.setState({ aiConfig: config });
  let resolveRefresh!: (list: AgentModel[]) => void;
  vi.mocked(api.agentModels).mockImplementation(
    async (_provider, _signal, _refresh, cached, target) => {
      if (!target) return models;
      if (cached) return [];
      return new Promise<AgentModel[]>((resolve) => {
        resolveRefresh = resolve;
      });
    },
  );
  await act(async () =>
    root.render(<NativeChatModel provider={provider} disabled={false} />),
  );
  await choose("DeepSeek Harness 问答模型", "Sonnet");
  const button = trigger("DeepSeek Harness 问答模型");
  expect(config.models[provider]).toBe("sonnet");
  expect(button.textContent).toContain("Sonnet");
  await act(async () => button.click());
  expect(
    document.querySelector('[role="option"][aria-selected="true"]')
      ?.textContent,
  ).toContain("Sonnet");
  await act(async () => resolveRefresh(models));
  expect(config.models[provider]).toBe("sonnet");
  expect(api.saveAIConfig).toHaveBeenCalledTimes(1);
});

it("distinguishes identical DSH names and saves the exact route the reader clicked", async () => {
  const provider = "native:deepseek-harness";
  const official = JSON.stringify(["deepseek-official", "m"]);
  const account = JSON.stringify(["deepseek-account", "m"]);
  config.nativeAgent = {
    provider,
    executables: {},
    projectName: "Reading",
    directory: "",
  };
  config.models[provider] = official;
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue(
    [official, account].map((id) => ({
      id,
      name: "DeepSeek Pro",
      description: "",
      isDefault: id === official,
    })),
  );
  await act(async () =>
    root.render(<NativeChatModel provider={provider} disabled={false} />),
  );
  await choose("DeepSeek Harness 问答模型", "DeepSeek Pro · deepseek-account");
  expect(trigger("DeepSeek Harness 问答模型").textContent).toContain(
    "DeepSeek Pro · deepseek-account",
  );
  expect(config.models[provider]).toBe(account);
});

it("never writes the initial model back when an open menu receives a partial catalog", async () => {
  const provider = "native:claude-code";
  config.nativeAgent = {
    provider,
    executables: {},
    projectName: "Reading",
    directory: "",
  };
  config.models[provider] = "opus";
  useReaderStore.setState({ aiConfig: config });
  let finish!: (list: AgentModel[]) => void;
  vi.mocked(api.agentModels).mockImplementation(
    async (_provider, _signal, _refresh, _cached, target) => {
      if (target === "sonnet")
        return new Promise<AgentModel[]>((resolve) => {
          finish = resolve;
        });
      return models;
    },
  );
  await act(async () =>
    root.render(<NativeChatModel provider={provider} disabled={false} />),
  );
  await choose("Claude Code 问答模型", "Sonnet");
  await act(async () => trigger("Claude Code 问答模型").click());
  await act(async () =>
    finish(models.filter((model) => model.id !== "sonnet")),
  );
  expect(config.models[provider]).toBe("sonnet");
  expect(api.saveAIConfig).toHaveBeenCalledTimes(1);
});

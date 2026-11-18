import { useState } from "react";
import type {
  AIConfig,
  AgentProject,
  NativeAgentSettings,
} from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Checkbox } from "@neoread/ui/components/checkbox";
import { providerLabel } from "./ProviderIdentity";

export const nativeAgentIds = [
  "native:codex",
  "native:claude-code",
  "native:antigravity",
  "native:deepseek-harness",
];
export const isNativeAgent = (id: string) => nativeAgentIds.includes(id);
export const readingAgent = (config?: AIConfig) =>
  config?.nativeAgent?.provider || config?.primary || "";
export const defaultNativeSettings: NativeAgentSettings = {
  provider: "",
  projectName: "NeoRead",
  directory: "",
  executables: {},
};
export function selectReadingAgent(config: AIConfig, id: string): AIConfig {
  const prefs = config.nativeAgent ?? defaultNativeSettings;
  return isNativeAgent(id)
    ? { ...config, nativeAgent: { ...prefs, provider: id } }
    : {
        ...config,
        primary: id,
        ...(config.nativeAgent && { nativeAgent: { ...prefs, provider: "" } }),
      };
}
export function AgentProjectForm({
  provider,
  settings,
  disabled,
  onSave,
}: {
  provider: string;
  settings: NativeAgentSettings;
  disabled: boolean;
  onSave: (project: AgentProject, executable: string) => Promise<boolean>;
}) {
  const native = isNativeAgent(provider);
  const [project, setProject] = useState<AgentProject>(
    () =>
      settings.projects?.[provider] ?? {
        name: settings.projectName,
        directory: settings.directory,
        archive: false,
      },
  );
  const [executable, setExecutable] = useState(
    settings.executables[provider] || "",
  );
  const [status, setStatus] = useState("");
  const changed = (patch: Partial<AgentProject>) => {
    setProject({ ...project, ...patch });
    setStatus("");
  };
  return (
    <form
      className="grid gap-3 p-4"
      aria-label={providerLabel(provider) + " 项目对话"}
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onSave(
          {
            ...project,
            name: project.name.trim(),
            directory: project.directory.trim(),
          },
          executable.trim(),
        );
        setStatus(ok ? "项目设置已保存" : "项目设置保存失败");
      }}
    >
      <h3 className="text-sm font-medium">项目对话</h3>
      {native && (
        <p className="text-xs text-muted-foreground">
          使用本机已登录的 {providerLabel(provider)}，完成的对话自动保存到对应的
          Agent 项目。
        </p>
      )}
      {native && (
        <label className="grid gap-1 text-sm">
          助手程序路径
          <Input
            value={executable}
            placeholder="留空自动检测"
            onChange={(e) => {
              setExecutable(e.target.value);
              setStatus("");
            }}
          />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={project.archive}
          onCheckedChange={(v) => changed({ archive: !!v })}
        />
        将完成的问答另存为项目 Markdown
      </label>
      {(native || project.archive) && (
        <>
          <label className="grid gap-1 text-sm">
            项目名称
            <Input
              required
              maxLength={120}
              value={project.name}
              onChange={(e) => changed({ name: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            项目工作目录
            <Input
              value={project.directory}
              placeholder="留空使用当前书库的 agent-projects 目录"
              onChange={(e) => changed({ directory: e.target.value })}
            />
          </label>
        </>
      )}
      {project.archive && (
        <p className="text-xs text-muted-foreground">
          每轮问答保存到工作目录下的 NeoRead Chats 文件夹。
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" type="submit" disabled={disabled}>
          保存项目设置
        </Button>
        <span role="status" className="text-xs">
          {status}
        </span>
      </div>
    </form>
  );
}

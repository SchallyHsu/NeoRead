package neoread

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type agentProject struct {
	Name      string `json:"name"`
	Directory string `json:"directory"`
	Archive   bool   `json:"archive"`
}
type nativeSettings struct {
	Projects    map[string]agentProject `json:"projects,omitempty"`
	Provider    string                  `json:"provider"`
	ProjectName string                  `json:"projectName"`
	Directory   string                  `json:"directory"`
	Executables map[string]string       `json:"executables"`
}

func nativeProvider(p string) bool {
	switch p {
	case "native:codex", "native:claude-code", "native:deepseek-harness", "native:antigravity":
		return true
	}
	return false
}
func (s *Server) legacyNativeSettings() *nativeSettings {
	cfg := nativeSettings{ProjectName: "NeoRead", Executables: map[string]string{}}
	if s.legacyNativeJSON != "" {
		_ = json.Unmarshal([]byte(s.legacyNativeJSON), &cfg)
	}
	return &cfg
}

// Older clients still use this endpoint. Both interfaces edit the same config.
func (s *Server) nativeConfig(w http.ResponseWriter, r *http.Request) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	c := s.readAIConfig()
	if r.Method == "PUT" {
		if !decode(w, r, c.NativeAgent) {
			return
		}
		if err := c.NativeAgent.validate(); err != nil {
			fail(w, 400, err.Error())
			return
		}
		if err := s.writeAIConfig(c); err != nil {
			fail(w, 500, "无法保存 Agent 连接")
			return
		}
	}
	respond(w, 200, c.NativeAgent)
}
func (cfg *nativeSettings) validate() error {
	cfg.ProjectName = strings.TrimSpace(cfg.ProjectName)
	if cfg.ProjectName == "" || len(cfg.ProjectName) > 200 || cfg.Directory != "" && !filepath.IsAbs(cfg.Directory) || cfg.Provider != "" && !nativeProvider(cfg.Provider) {
		return errors.New("请输入项目名称和有效的绝对目录")
	}
	for key, exe := range cfg.Executables {
		if !nativeProvider(key) || exe != "" && !filepath.IsAbs(exe) {
			return errors.New("Agent 程序需要绝对路径")
		}
	}
	for key, p := range cfg.Projects {
		if (!nativeProvider(key) && !validAgent(key)) || strings.TrimSpace(p.Name) == "" || len(p.Name) > 200 || p.Directory != "" && !filepath.IsAbs(p.Directory) {
			return errors.New("项目名称或项目工作目录无效")
		}
	}
	return nil
}
func (cfg nativeSettings) project(provider string) agentProject {
	if p, ok := cfg.Projects[provider]; ok {
		return p
	}
	return agentProject{Name: cfg.ProjectName, Directory: cfg.Directory}
}

var nativeCommands = []struct{ id, command string }{
	{"native:codex", "codex"}, {"native:claude-code", "claude"}, {"native:antigravity", "agy"}, {"native:deepseek-harness", "dsh"},
}

func nativeInstalled(command, override string) bool {
	if override != "" {
		command = override
	}
	found, err := exec.LookPath(command)
	if err != nil && override == "" && command == "claude" {
		home, _ := os.UserHomeDir()
		found, err = exec.LookPath(filepath.Join(home, ".local", "bin", "claude"))
	}
	if err != nil || !filepath.IsAbs(found) {
		return false
	}
	if runtime.GOOS == "windows" {
		switch strings.ToLower(filepath.Ext(found)) {
		case ".exe", ".com", ".cmd", ".bat":
		default:
			return false
		}
	}
	return true
}

// Native workers share a bridge installation until the ACP handshake completes.
func (s *Server) lockNativeStartup(backend string) func() {
	var index int
	switch backend {
	case "codex":
	case "claude-code":
		index = 1
	default:
		return func() {}
	}
	lock := &s.nativeStartup[index]
	lock.Lock()
	return sync.OnceFunc(lock.Unlock)
}

func (s *Server) nativeModelCatalog(ctx context.Context, provider, model string) ([]AgentModel, error) {
	backend := strings.TrimPrefix(provider, "native:")
	executable := s.aiConfig().NativeAgent.Executables[provider]
	return s.cachedCatalog(ctx, provider+":"+jsonText([]string{executable, model}), func(ctx context.Context) ([]AgentModel, error) {
		release := s.lockNativeStartup(backend)
		defer release()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		runID := id()
		result, err := runPiOperation(ctx, s.Store.Root, "native-catalog", runID, map[string]string{
			"runId": runID, "backend": backend, "executable": executable, "model": model,
			"bridgeDir": filepath.Join(s.Store.Root, "native-bridges", backend),
		}, false, func(e piEvent) error {
			if e.Type == "activity" {
				release()
			}
			return nil
		}, nil)
		if err != nil {
			return nil, err
		}
		models := make([]AgentModel, 0, len(result.Models))
		for _, entry := range result.Models {
			models = append(models, entry.AgentModel)
		}
		return models, nil
	})
}

func (s *Server) nativeAnswer(ctx context.Context, cfg nativeSettings, model, effort string, in AIInput, emit func(ProviderEvent) error, notice func(string) error) (AIResult, error) {
	chat := in.Chat
	project := cfg.project(cfg.Provider)
	cfg.ProjectName = project.Name
	cwd := project.path(s.Store.Root)
	key := sourceKey(cwd + "\x00" + cfg.ProjectName)
	c, err := s.Store.documentConversation(ctx, chat.DocumentID, conversationProvider(chat.SessionID, cfg.Provider), key)
	if err != nil {
		return AIResult{}, err
	}
	session, err := s.Store.chatSession(chat.DocumentID, chat.SessionID)
	if err != nil {
		return AIResult{}, err
	}
	prompt := in.Prompt
	if c.NativeID != "" && len(chat.History) > 0 && chat.History[len(chat.History)-1].ID == c.LastMessageID {
		prompt = chat.incremental(c.SeenSources)
	} else {
		c.NativeID = ""
		c.NativeProjectID = ""
		c.SeenSources = nil
	}
	images := []map[string]string{}
	for _, data := range in.Images {
		images = append(images, map[string]string{"mime": "image/png", "data": base64.StdEncoding.EncodeToString(data)})
	}
	backend := strings.TrimPrefix(cfg.Provider, "native:")
	req := map[string]any{"runId": chat.piRunID, "backend": backend, "model": model, "effort": effort, "cwd": cwd, "projectName": cfg.ProjectName, "title": session.Title, "resume": c.NativeID, "projectId": c.NativeProjectID, "prompt": prompt, "images": images, "executable": cfg.Executables[cfg.Provider], "bridgeDir": filepath.Join(s.Store.Root, "native-bridges", backend)}
	done, err := s.nativeTurn(ctx, backend, "native", chat.piRunID, req, emit)
	if err != nil {
		return AIResult{}, err
	}
	if done.ID == "" || strings.TrimSpace(done.Text) == "" {
		return AIResult{}, generationError(ErrorProtocol, "原生会话没有返回完整回答")
	}
	var reasoning string
	if err = json.Unmarshal(done.Entries, &reasoning); err != nil {
		return AIResult{}, err
	}
	if done.TurnUsage != nil {
		done.TurnUsage.Provider = cfg.Provider
		chat.Usage = done.TurnUsage
	}
	c.NativeID = done.ID
	c.NativeProjectID = done.Code
	c.ProjectNotice = done.Message
	if c.SeenSources == nil {
		c.SeenSources = map[string]bool{}
	}
	for _, src := range chat.Sources {
		c.SeenSources[src.ID] = true
	}
	chat.piConversation = &c
	chat.piProvider = cfg.Provider
	if done.Message != "" {
		_ = notice(done.Message)
	}
	return AIResult{Provider: cfg.Provider, Text: done.Text, Reasoning: reasoning}, nil
}

func (p agentProject) path(root string) string {
	cwd := p.Directory
	if cwd == "" {
		folder := p.Name
		if !filepath.IsLocal(folder) || folder == "." || strings.ContainsAny(folder, `/\\<>:"|?*`) || strings.HasSuffix(folder, ".") || strings.HasSuffix(folder, " ") {
			folder = "project-" + sourceKey(folder)[:16]
		}
		cwd = filepath.Join(root, "agent-projects", folder)
	}
	return cwd
}

// Only a completed visible turn is archived. Generated keys keep document text
// out of filenames and make a repeated write of the same run idempotent.
func (s *Server) archiveProjectTurn(p agentProject, provider string, chat *chatInput, answer string) error {
	session, err := s.Store.chatSession(chat.DocumentID, chat.SessionID)
	if err != nil {
		return err
	}
	dir := filepath.Join(p.path(s.Store.Root), "NeoRead Chats", strings.ReplaceAll(provider, ":", "-"), sourceKey(chat.DocumentID + "\x00" + chat.SessionID)[:20])
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if chat.piRunID == "" {
		return errors.New("missing turn identity")
	}
	text := fmt.Sprintf("# %s · %s\n\n## 提问\n\n%s\n\n## 回答\n\n%s\n", chat.Title, session.Title, chat.Question, answer)
	return atomicFile(filepath.Join(dir, sourceKey(chat.piRunID)[:24]+".md"), []byte(text))
}

// Chat and translation use the same startup lock and streaming protocol.
func (s *Server) nativeTurn(ctx context.Context, backend, operation, runID string, req map[string]any, emit func(ProviderEvent) error) (piEvent, error) {
	release := s.lockNativeStartup(backend)
	defer release()
	if err := ctx.Err(); err != nil {
		return piEvent{}, err
	}
	return runPiOperation(ctx, s.Store.Root, operation, runID, req, false, func(e piEvent) error {
		switch e.Type {
		case "activity":
			release()
		case "delta":
			return emit(ProviderEvent{Text: e.Text})
		case "reasoning":
			return emit(ProviderEvent{Reasoning: e.Text})
		}
		return nil
	}, nil)
}

type nativeTranslationAdapter struct {
	server                              *Server
	provider, executable, model, effort string
}

func (a nativeTranslationAdapter) Stream(ctx context.Context, request GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	backend := strings.TrimPrefix(a.provider, "native:")
	runID := id()
	result, err := a.server.nativeTurn(ctx, backend, "native-translation", runID, map[string]any{
		"runId": runID, "backend": backend, "executable": a.executable, "bridgeDir": filepath.Join(a.server.Store.Root, "native-bridges", backend),
		"model": a.model, "effort": a.effort, "prompt": request.Input.Prompt, "systemPrompt": request.Input.SystemPrompt,
	}, emit)
	if err != nil {
		return GenerateResult{}, err
	}
	if u := result.TurnUsage; u != nil {
		m := ModelTokens{Model: u.Model}
		if u.Input != nil && u.Output != nil {
			m.Tokens = &TokenCounts{InputTokens: *u.Input, OutputTokens: *u.Output, TotalTokens: *u.Input + *u.Output}
		}
		if err := emit(ProviderEvent{Metrics: []ModelTokens{m}}); err != nil {
			return GenerateResult{}, err
		}
	}
	return GenerateResult{Text: result.Text, FinishReason: "stop"}, nil
}

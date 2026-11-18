package neoread

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
)

type nativeSettings struct {
	Provider    string            `json:"provider"`
	ProjectName string            `json:"projectName"`
	Directory   string            `json:"directory"`
	Executables map[string]string `json:"executables"`
}

func nativeProvider(p string) bool {
	switch p {
	case "native:codex", "native:claude-code", "native:deepseek-harness", "native:antigravity":
		return true
	}
	return false
}
func (s *Server) nativeSettings() (nativeSettings, error) {
	cfg := nativeSettings{ProjectName: "NeoRead", Executables: map[string]string{}}
	var raw string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='native-agent'").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return cfg, nil
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &cfg)
	}
	return cfg, err
}
func (s *Server) nativeConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.nativeSettings()
	if r.Method == "PUT" {
		if !decode(w, r, &cfg) {
			return
		}
		cfg.ProjectName = strings.TrimSpace(cfg.ProjectName)
		if cfg.ProjectName == "" || len(cfg.ProjectName) > 200 || cfg.Directory != "" && !filepath.IsAbs(cfg.Directory) || cfg.Provider != "" && !nativeProvider(cfg.Provider) {
			fail(w, 400, "请输入项目名称和有效的绝对目录")
			return
		}
		for key, exe := range cfg.Executables {
			if !nativeProvider(key) || exe != "" && !filepath.IsAbs(exe) {
				fail(w, 400, "Agent 程序需要绝对路径")
				return
			}
		}
		_, err = s.Store.DB.Exec("INSERT OR REPLACE INTO settings VALUES('native-agent',?)", jsonText(cfg))
	}
	if err != nil {
		fail(w, 500, "无法读写原生 Agent 设置")
		return
	}
	respond(w, 200, cfg)
}
func (s *Server) nativeAnswer(ctx context.Context, cfg nativeSettings, in AIInput, emit func(ProviderEvent) error, notice func(string) error) (AIResult, error) {
	chat := in.Chat
	cwd := cfg.Directory
	if cwd == "" {
		folder := cfg.ProjectName
		if !filepath.IsLocal(folder) || folder == "." || strings.ContainsAny(folder, `/\\<>:"|?*`) || strings.HasSuffix(folder, ".") || strings.HasSuffix(folder, " ") {
			folder = "project-" + sourceKey(folder)[:16]
		}
		cwd = filepath.Join(s.Store.Root, "agent-projects", folder)
	}
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
	req := map[string]any{"runId": chat.piRunID, "backend": backend, "cwd": cwd, "projectName": cfg.ProjectName, "title": session.Title, "resume": c.NativeID, "projectId": c.NativeProjectID, "prompt": prompt, "images": images, "executable": cfg.Executables[cfg.Provider], "bridgeDir": filepath.Join(s.Store.Root, "native-bridges", backend)}
	// Each worker has its own JS runtime. Serialize startup for a shared npm
	// prefix until the worker has loaded its bridge, then allow parallel turns.
	var release = func() {}
	if backend == "codex" || backend == "claude-code" {
		slot := 0
		if backend == "claude-code" {
			slot = 1
		}
		lock := &s.nativeStartup[slot]
		lock.Lock()
		released := false
		release = func() {
			if !released {
				released = true
				lock.Unlock()
			}
		}
		defer release()
		if err := ctx.Err(); err != nil {
			return AIResult{}, err
		}
	}
	done, err := runPiOperation(ctx, s.Store.Root, "native", chat.piRunID, req, false, func(e piEvent) error {
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

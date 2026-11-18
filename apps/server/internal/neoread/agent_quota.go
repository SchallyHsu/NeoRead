package neoread

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type quotaWindow struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    int64   `json:"resetsAt,omitempty"`
}
type quotaBalance struct {
	Label     string `json:"label"`
	Remaining string `json:"remaining"`
	Currency  string `json:"currency,omitempty"`
}
type accountQuota struct {
	Status    string         `json:"status"`
	CheckedAt int64          `json:"checkedAt"`
	RetryAt   int64          `json:"retryAt,omitempty"`
	Plan      string         `json:"plan,omitempty"`
	Message   string         `json:"message,omitempty"`
	Windows   []quotaWindow  `json:"windows"`
	Balances  []quotaBalance `json:"balances,omitempty"`
}
type agentQuota struct {
	Account   *accountQuota `json:"account,omitempty"`
	Remaining *float64      `json:"remaining,omitempty"`
	ResetsAt  string        `json:"resetsAt,omitempty"`
	Error     string        `json:"error,omitempty"`
}

func (s *Server) agentQuota(w http.ResponseWriter, r *http.Request) {
	provider := r.URL.Query().Get("provider")
	if provider != "codex" && provider != "claude" && !nativeProvider(provider) {
		fail(w, http.StatusBadRequest, "不支持此 Agent 的额度查询")
		return
	}
	timeout := 15 * time.Second
	if nativeProvider(provider) {
		timeout = 32 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	started := time.Now()
	var quota agentQuota
	var err error
	if nativeProvider(provider) {
		model := r.URL.Query().Get("model")
		if len(model) > 256 {
			fail(w, 400, "模型名称过长")
			return
		}
		cfg := s.aiConfig().NativeAgent
		runID := id()
		result, e := runPiOperation(ctx, s.Store.Root, "native-quota", runID, map[string]string{"runId": runID, "backend": strings.TrimPrefix(provider, "native:"), "model": model, "executable": cfg.Executables[provider]}, false, nil, nil)
		err = e
		if err == nil {
			if result.Quota == nil || result.Quota.Account == nil {
				err = generationError(ErrorProtocol, "额度查询未返回结果")
			} else {
				quota = *result.Quota
			}
		}
	} else {
		quota, err = s.readPiQuota(ctx, provider)
	}
	outcome, level := "success", slog.LevelInfo
	var kind ErrorKind
	if err != nil {
		kind = errorKind(err)
		outcome, level = "failed", slog.LevelError
		quota = agentQuota{Error: "暂时无法读取额度，请检查账号连接或稍后重试"}
		if r.Context().Err() != nil {
			outcome, level = "cancelled", slog.LevelInfo
		}
	} else if quota.Error != "" {
		outcome = "unavailable"
	}
	s.diagnosticEvent(level, "agent.quota.read", "requestId", requestID(r.Context()), "provider", provider, "outcome", outcome, "errorCode", kind, "durationMs", time.Since(started).Milliseconds())
	respond(w, http.StatusOK, quota)
}

func (s *Server) readPiQuota(ctx context.Context, provider string) (agentQuota, error) {
	if err := ctx.Err(); err != nil {
		return agentQuota{}, err
	}
	connection, ok := s.piAPIConnection(provider)
	if !ok {
		return agentQuota{Error: "请先连接账号后查看额度"}, nil
	}
	runID := id()
	result, err := runPiOperation(ctx, s.Store.Root, "quota", runID, map[string]any{
		"runId": runID, "connection": connection.pi,
	}, false, nil, nil)
	if err != nil {
		return agentQuota{}, err
	}
	current, ok := s.piAPIConnection(provider)
	if !ok || current.pi.AuthPath != connection.pi.AuthPath {
		return agentQuota{Error: "账号连接已改变，请刷新额度"}, nil
	}
	quota := result.Quota
	if quota == nil || (quota.Remaining == nil && quota.Error == "") ||
		(quota.Remaining != nil && (quota.Error != "" || *quota.Remaining < 0 || *quota.Remaining > 100)) {
		return agentQuota{}, generationError(ErrorProtocol, "额度查询返回无效状态")
	}
	if quota.ResetsAt != "" {
		if _, err := time.Parse(time.RFC3339, quota.ResetsAt); err != nil {
			return agentQuota{}, generationError(ErrorProtocol, "额度重置时间无效")
		}
	}
	return *quota, nil
}

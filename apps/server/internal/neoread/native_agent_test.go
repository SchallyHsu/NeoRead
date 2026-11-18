package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeReaderContinuation(t *testing.T) {
	s := testServer(t)
	_, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at) VALUES('doc','pdf','Paper','',1,?,?)", now(), now())
	if err != nil {
		t.Fatal(err)
	}
	sid, err := s.Store.ensureDefaultChatSession("doc", "native:codex")
	if err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(t.TempDir(), "worker.mjs")
	err = os.WriteFile(worker, []byte(`import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin});rl.once('line',line=>{const {input:r}=JSON.parse(line);const send=e=>console.log(JSON.stringify({version:1,runId:r.runId,...e}));send({type:'delta',text:'ok'});send({type:'complete',id:r.resume||'first',text:r.resume?'resumed':'fresh',entries:'',code:'project',turnUsage:{inputTokens:14,outputTokens:5,contextUsed:70,contextSize:100}});rl.close();process.stdin.destroy()});`), 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NATIVE_AGENT", worker)
	cfg := nativeSettings{Provider: "native:codex", ProjectName: "Test"}
	chat := &chatInput{DocumentID: "doc", SessionID: sid, piRunID: id(), Question: "hello"}
	run := func(want string) {
		t.Helper()
		got, err := s.nativeAnswer(context.Background(), cfg, AIInput{Chat: chat, Prompt: chat.legacyPrompt()}, func(ProviderEvent) error { return nil }, func(string) error { return nil })
		if err != nil || got.Text != want {
			t.Fatalf("%+v %v", got, err)
		}
		if err = s.Store.saveChatAnswer(context.Background(), chat, got.Text, ""); err != nil {
			t.Fatal(err)
		}
	}
	run("fresh")
	chat.History, err = s.Store.chatHistory("doc", sid)
	if err != nil {
		t.Fatal(err)
	}
	if u := chat.History[len(chat.History)-1].Usage; u == nil || *u.ContextUsed != 70 || *u.Input != 14 || u.Provider != "native:codex" {
		t.Fatal("turn usage lost on reload")
	}
	project := agentProject{Name: "Test", Directory: t.TempDir(), Archive: true}
	for i := 0; i < 2; i++ {
		if err = s.archiveProjectTurn(project, cfg.Provider, chat, "answer"); err != nil {
			t.Fatal(err)
		}
	}
	files, _ := filepath.Glob(filepath.Join(project.Directory, "NeoRead Chats", "native-codex", "*", "*.md"))
	if len(files) != 1 {
		t.Fatal("archive not idempotent")
	}
	md, err := os.ReadFile(files[0])
	if err != nil || !strings.Contains(string(md), "\n## 提问\n\nhello\n\n## 回答\n\nanswer\n") {
		t.Fatal("incomplete archive", string(md))
	}
	run("resumed")
	chat.History = []Message{{ID: "another-device"}}
	run("fresh")
}

func TestUnifiedConnectionMigratesLegacyAndSwitches(t *testing.T) {
	s := testServer(t)
	legacy := nativeSettings{Provider: "native:codex", ProjectName: "Old", Directory: t.TempDir(), Executables: map[string]string{}}
	_, err := s.Store.DB.Exec("insert into settings values('native-agent',?)", jsonText(legacy))
	if err != nil {
		t.Fatal(err)
	}
	s = NewServer(s.Store, s.Token, s.Web)
	cfg := s.aiConfig()
	if cfg.NativeAgent == nil || cfg.NativeAgent.Provider != legacy.Provider || cfg.NativeAgent.project("native:codex").Directory != legacy.Directory {
		t.Fatal("legacy not adopted")
	}
	cfg.Primary = "api"
	cfg.NativeAgent.Provider = "native:antigravity"
	folder := t.TempDir()
	cfg.NativeAgent.Projects = map[string]agentProject{"native:antigravity": {Name: "Research", Directory: folder, Archive: true}}
	save := func() {
		b, _ := json.Marshal(publicConfig(cfg))
		r := request(t, s, "PUT", "/api/ai/config", bytes.NewReader(b))
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	save()
	cfg.NativeAgent.Provider = ""
	save()
	got := NewServer(s.Store, s.Token, s.Web).aiConfig()
	if got.Primary != "api" || got.NativeAgent.Provider != "" || got.NativeAgent.project("native:antigravity").Directory != folder || got.NativeAgent.project("native:codex").Directory != legacy.Directory {
		t.Fatal("selection or projects not preserved")
	}
}

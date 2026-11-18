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
	err = os.WriteFile(worker, []byte(`import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin});rl.once('line',line=>{const {input:r}=JSON.parse(line);if(r.model!=='test-model'||r.effort!=='high')process.exit(3);const send=e=>console.log(JSON.stringify({version:1,runId:r.runId,...e}));send({type:'delta',text:'ok'});send({type:'complete',id:r.resume||'first',text:r.resume?'resumed':'fresh',entries:'',code:'project',turnUsage:{inputTokens:14,outputTokens:5,contextUsed:70,contextSize:100}});rl.close();process.stdin.destroy()});`), 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NATIVE_AGENT", worker)
	cfg := nativeSettings{Provider: "native:codex", ProjectName: "Test"}
	chat := &chatInput{DocumentID: "doc", SessionID: sid, piRunID: id(), Question: "hello"}
	run := func(want string) {
		t.Helper()
		got, err := s.nativeAnswer(context.Background(), cfg, "test-model", "high", AIInput{Chat: chat, Prompt: chat.legacyPrompt()}, func(ProviderEvent) error { return nil }, func(string) error { return nil })
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

func TestNativeTranslationUsesTaskChoicesAndPinnedProvider(t *testing.T) {
	s := testServer(t)
	provider := "native:deepseek-harness"
	cfg := s.aiConfig()
	cfg.NativeAgent.Provider = provider
	cfg.Models[provider] = "reader"
	cfg.TranslationModels = map[string]string{}
	cfg.TranslationEfforts = map[string]map[string]string{provider: {"reader": "low", "translator": "max"}}
	cfg.Primary = "api"
	if selected := snapshotTranslationOptions(cfg); selected.Provider != provider || selected.Model != "reader" || selected.Effort != "low" {
		t.Fatal(selected)
	}
	cfg.TranslationModels[provider] = "translator"
	snapshot := snapshotTranslationOptions(cfg)
	cfg.NativeAgent.Provider = "native:antigravity"
	cfg.TranslationModels[provider] = "changed"
	frozen := snapshot.apply(cfg)
	if translationProvider(frozen) != provider || cfg.NativeAgent.Provider != "native:antigravity" {
		t.Fatal("provider switch changed queued translation")
	}
	worker := filepath.Join(t.TempDir(), "translator.mjs")
	if err := os.WriteFile(worker, []byte(`import readline from "node:readline";
const input = readline.createInterface({input: process.stdin});
input.once("line", line => {
  const {type, input: request} = JSON.parse(line);
  if (type !== "native-translation" || request.model !== "translator" ||
      request.effort !== "max" || request.backend !== "deepseek-harness" ||
      !request.prompt.includes("fixture")) process.exit(4);
  const send = event => console.log(JSON.stringify({version: 1, runId: request.runId, ...event}));
  const text = request.systemPrompt
    ? JSON.stringify({blockId:"block", sentences:[{source:"fixture",target:"译文"}]}) + "\n"
    : "译文";
  send({type:"delta", text});
  send({type:"complete", text});
  input.close();
  process.stdin.destroy();
});`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NATIVE_AGENT", worker)
	got, err := generateSelectionTranslation(t.Context(), s.taskGenerationService(frozen, taskTranslation), selectionTranslationInput{Text: "fixture"})
	if err != nil || got != "译文" {
		t.Fatal(got, err)
	}
	batch := translationBatch{Paragraphs: []translationParagraph{{BlockID: "block", Source: "fixture", SourceHash: translationHash("fixture")}}}
	for _, format := range []string{"pdf", "epub"} {
		var blocks []TranslationBlock
		decoder := newTranslationJSONL(batch, func(block TranslationBlock) error { blocks = append(blocks, block); return nil })
		service := s.taskGenerationService(frozen, taskTranslation)
		input := AIInput{Prompt: translationPrompt(Document{Type: format}, layoutManifest{}, batch, ""), SystemPrompt: translationSystemPrompt}
		if _, err := service.Generate(t.Context(), input, false, func(e ProviderEvent) error { return decoder.feed(e.Text) }); err != nil || len(blocks) != 1 || blocks[0].Sentences[0].Target != "译文" {
			t.Fatalf("%s: %v, %+v", format, err, blocks)
		}
	}

}

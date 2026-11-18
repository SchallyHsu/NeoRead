package neoread

import (
	"context"
	"os"
	"path/filepath"
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
	err = os.WriteFile(worker, []byte(`import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin});rl.once('line',line=>{const {input:r}=JSON.parse(line);const send=e=>console.log(JSON.stringify({version:1,runId:r.runId,...e}));send({type:'delta',text:'ok'});send({type:'complete',id:r.resume||'first',text:r.resume?'resumed':'fresh',entries:'',code:'project'});rl.close();process.stdin.destroy()});`), 0600)
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
	run("resumed")
	chat.History = []Message{{ID: "another-device"}}
	run("fresh")
}

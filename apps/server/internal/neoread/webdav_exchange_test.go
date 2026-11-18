package neoread

import (
	"bytes"
	"context"
	"golang.org/x/net/webdav"
	"net/http/httptest"
	"os"
	"testing"
)

func TestWebDAVTwoLibraries(t *testing.T) {
	remote := os.Getenv("NEOREAD_TEST_WEBDAV")
	if remote == "" {
		srv := httptest.NewServer(&webdav.Handler{FileSystem: webdav.NewMemFS(), LockSystem: webdav.NewMemLS()})
		defer srv.Close()
		remote = srv.URL
	}
	a, b := testServer(t), testServer(t)
	d := newDAV(davConfig{URL: remote}, "")
	syncNow := func(s *Server) {
		t.Helper()
		if err := s.exchangeDAV(context.Background(), d, &davStatus{}); err != nil {
			t.Fatal(err)
		}
	}
	pdf := testPDF(2)
	for name, data := range map[string][]byte{"Paper.pdf": pdf, "Book.epub": bookEPUB(t)} {
		res := upload(t, a, name, data)
		if res.Code != 201 {
			t.Fatalf("upload %s %d %s", name, res.Code, res.Body)
		}
	}
	docs, err := a.Store.Documents()
	if err != nil {
		t.Fatal(err)
	}
	var doc Document
	for _, v := range docs {
		if v.Type == "pdf" {
			doc = v
		}
	}
	sid, err := a.Store.ensureDefaultChatSession(doc.ID, "native:codex")
	if err != nil {
		t.Fatal(err)
	}
	add := func(s *Server, q, answer string) {
		t.Helper()
		for _, m := range []Message{{Role: "user", Content: q}, {Role: "assistant", Content: answer}} {
			m.SessionID = sid
			m.DocumentID = doc.ID
			if err := s.Store.saveMessage(m); err != nil {
				t.Fatal(err)
			}
		}
	}
	add(a, "A1", "answer1")
	syncNow(a)
	syncNow(b)
	actual, err := b.Store.Documents()
	if err != nil || len(actual) != 2 {
		t.Fatalf("documents %d: %v", len(actual), err)
	}
	got, err := os.ReadFile(b.Store.File(doc))
	if err != nil || !bytes.Equal(got, pdf) {
		t.Fatal("PDF mismatch", err)
	}
	add(b, "B2", "answerB")
	add(a, "A2", "answerA")
	syncNow(a)
	syncNow(b)
	syncNow(a)
	syncNow(b)
	for _, s := range []*Server{a, b} {
		ms, err := s.Store.chatHistory(doc.ID, sid)
		if err != nil || len(ms) != 6 {
			t.Fatalf("messages: %d %v", len(ms), err)
		}
		for i := 0; i < len(ms); i += 2 {
			if ms[i].Role != "user" || ms[i+1].Role != "assistant" {
				t.Fatalf("broken turn: %+v", ms)
			}
		}
	}
	if err = b.Store.deleteChatSession(doc.ID, sid); err != nil {
		t.Fatal(err)
	}
	syncNow(b)
	if _, err = b.Store.chatSession(doc.ID, sid); err == nil {
		t.Fatal("local deletion restored")
	}
}

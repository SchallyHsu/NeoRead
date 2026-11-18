package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDAVReusesVerifiedZoteroArchive(t *testing.T) {
	const key = "ABCD2345"
	pdf := testPDF(2)
	hash := sourceKey(string(pdf))
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	m, _ := w.Create("../encoded-name")
	m.Write(pdf)
	w.Close()
	zipETag := "stable"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "MKCOL":
			w.WriteHeader(405)
		case r.Method == "PROPFIND" && r.URL.Path == "/neoread-v1/":
			w.WriteHeader(207)
			fmt.Fprint(w, "<multistatus xmlns='DAV:'><response><href>/neoread-v1/zotero-sources-v1.json</href></response></multistatus>")
		case r.URL.Path == "/neoread-v1/zotero-sources-v1.json":
			json.NewEncoder(w).Encode(map[string]any{"version": 1, "sources": map[string][]zoteroDAVRef{
				hash: {{Key: key, ETag: `"stable"`, PropETag: `"prop"`}},
			}})
		case r.Method == "PROPFIND" && r.URL.Path == "/":
			w.WriteHeader(207)
			fmt.Fprint(w, "<multistatus xmlns='DAV:'>")
			for n, tag := range map[string]string{"zip": zipETag, "prop": "prop"} {
				fmt.Fprintf(w, "<response><href>/%s.%s</href><propstat><prop><getetag>\"%s\"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>", key, n, tag)
			}
			fmt.Fprint(w, "</multistatus>")
		case r.Method == "GET" && r.URL.Path == "/"+key+".zip":
			w.Write(buf.Bytes())
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	client := newDAV(davConfig{URL: srv.URL}, "")
	a, b := testServer(t), testServer(t)
	names, err := client.list(ctx)
	if err != nil || len(client.zotero[hash]) != 1 {
		t.Fatalf("catalog: %v", err)
	}
	if res := upload(t, a, "example.pdf", pdf); res.Code != 201 {
		t.Fatal(res.Code)
	}
	docs, _ := a.Store.Documents()
	report := davStatus{}
	if got, err := a.publishFile(ctx, client, docs[0], names, &report); got != hash || err != nil || report.Uploaded != 0 {
		t.Fatalf("reuse: %s %v %+v", got, err, report)
	}
	ok, err := b.pullDocument(ctx, client, davDocument{hash, "pdf", "same", "papers"}, names)
	if !ok || err != nil {
		t.Fatalf("pull: %v", err)
	}
	docs, _ = b.Store.Documents()
	got, err := os.ReadFile(b.Store.File(docs[0]))
	if err != nil || !bytes.Equal(got, pdf) {
		t.Fatal("wrong original")
	}
	zipETag = "new"
	if _, err := client.list(ctx); err != nil || len(client.zotero[hash]) != 0 {
		t.Fatal("changed ZIP was reused")
	}
	if stream, err := verifiedZipMember(t.TempDir(), strings.Repeat("0", 64), bytes.NewReader(buf.Bytes())); err == nil {
		io.Copy(io.Discard, stream)
		stream.Close()
		t.Fatal("wrong checksum accepted")
	}
}

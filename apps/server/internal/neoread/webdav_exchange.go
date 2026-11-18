package neoread

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const davRecordLimit = 16 << 20

type davDocument struct{ Hash, Type, Title, Library string }
type davSession struct{ Hash, ID, Title, Provider, CreatedAt, UpdatedAt string }
type davTurn struct {
	Hash, Session string
	Messages      []Message
}

func (s *Server) exchangeDAV(ctx context.Context, d *davClient, r *davStatus) error {
	names, err := d.list(ctx)
	if err != nil {
		return err
	}
	docs, err := s.Store.Documents()
	if err != nil {
		return err
	}
	upload := func(prefix string, v any) error {
		body, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if len(body) > davRecordLimit {
			return errors.New("单轮聊天超过 16 MiB 同步上限")
		}
		name := prefix + "-" + sourceKey(string(body)) + ".json"
		if !names[name] {
			if err = d.put(ctx, name, bytes.NewReader(body), int64(len(body))); err != nil {
				return err
			}
			r.Uploaded++
			if turn, ok := v.(davTurn); ok {
				if ok, err := s.pullTurn(turn); err != nil || !ok {
					return err
				}
			}
			_, err = s.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO dav_received VALUES(?,?)", d.cfg.identity(), name)
			return err
		}
		return nil
	}
	for _, doc := range docs {
		if doc.Type != "pdf" && doc.Type != "epub" {
			continue
		}
		hash, err := s.publishFile(ctx, d, doc, names, r)
		if err != nil {
			return err
		}
		if err = upload("doc", davDocument{hash, doc.Type, doc.Title, doc.Library}); err != nil {
			return err
		}
		heads, turns, err := s.portableChats(doc.ID, hash)
		if err != nil {
			return err
		}
		for _, head := range heads {
			if err = upload("session", head); err != nil {
				return err
			}
		}
		for _, turn := range turns {
			if err = upload("turn", turn); err != nil {
				return err
			}
		}
	}
	// Only consume objects visible in the initial listing. Published records are
	// immutable, and a partial upload can be completed on the next pass.
	ordered := make([]string, 0, len(names))
	for name := range names {
		if !strings.HasPrefix(name, "file-") {
			ordered = append(ordered, name)
		}
	}
	sort.Strings(ordered)
	for _, name := range ordered {
		var seen bool
		if err = s.Store.DB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM dav_received WHERE endpoint=? AND name=?)", d.cfg.identity(), name).Scan(&seen); err != nil {
			return err
		}
		if seen {
			continue
		}
		stream, err := d.get(ctx, name)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(stream, davRecordLimit+1))
		stream.Close()
		if err != nil {
			return err
		}
		kind, digest, _ := strings.Cut(name, "-")
		if len(data) > davRecordLimit || sourceKey(string(data)) != strings.TrimSuffix(digest, ".json") {
			return errors.New("WebDAV 记录校验失败，请检查服务器文件")
		}
		var applied bool
		switch kind {
		case "doc":
			var doc davDocument
			if json.Unmarshal(data, &doc) != nil {
				return errors.New("WebDAV 文档记录无效")
			}
			applied, err = s.pullDocument(ctx, d, doc, names)
		case "session":
			var h davSession
			if json.Unmarshal(data, &h) != nil {
				return errors.New("WebDAV 会话记录无效")
			}
			applied, err = s.pullSession(h)
		case "turn":
			var t davTurn
			if json.Unmarshal(data, &t) != nil {
				return errors.New("WebDAV 对话记录无效")
			}
			applied, err = s.pullTurn(t)
		}
		if err != nil {
			return err
		}
		if !applied {
			continue
		}
		if _, err = s.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO dav_received VALUES(?,?)", d.cfg.identity(), name); err != nil {
			return err
		}
		r.Downloaded++
	}
	return nil
}

func (s *Server) publishFile(ctx context.Context, d *davClient, doc Document, names map[string]bool, r *davStatus) (string, error) {
	var hash string
	err := s.Store.DB.QueryRowContext(ctx, "SELECT hash FROM dav_files WHERE document_id=? LIMIT 1", doc.ID).Scan(&hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if hash != "" && names["file-"+hash+"."+doc.Type] {
		return hash, nil
	}
	f, err := os.Open(s.Store.File(doc))
	if err != nil {
		return "", errors.New("书库原文件不可读")
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, io.LimitReader(f, maxImportBytes+1))
	if err != nil || size > maxImportBytes {
		return "", errors.New("无法校验书库原文件或文件超过 512 MiB")
	}
	hash = hex.EncodeToString(h.Sum(nil))
	name := "file-" + hash + "." + doc.Type
	if !names[name] {
		if _, err = f.Seek(0, 0); err != nil {
			return "", err
		}
		if err = d.put(ctx, name, f, size); err != nil {
			return "", err
		}
		r.Uploaded++
	}
	_, err = s.Store.DB.Exec("INSERT OR IGNORE INTO dav_files VALUES(?,?)", hash, doc.ID)
	return hash, err
}
func (s *Server) portableChats(docID, hash string) ([]davSession, []davTurn, error) {
	// Migrate pre-session transcripts exactly as opening the reader does.
	var legacy bool
	if err := s.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM messages WHERE document_id=? AND COALESCE(json_extract(body,'$.sessionId'),'')='')", docID).Scan(&legacy); err != nil {
		return nil, nil, err
	}
	if legacy {
		if _, err := s.ensureChatSession(docID, "api"); err != nil {
			return nil, nil, err
		}
	}
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	rows, err := s.Store.DB.Query("SELECT id,title,provider,created_at,updated_at FROM chat_sessions WHERE document_id=?", docID)
	if err != nil {
		return nil, nil, err
	}
	var heads []davSession
	for rows.Next() {
		h := davSession{Hash: hash}
		if err = rows.Scan(&h.ID, &h.Title, &h.Provider, &h.CreatedAt, &h.UpdatedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if s.chatRuns[h.ID] == nil && !s.chatReservations[h.ID] {
			heads = append(heads, h)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	var turns []davTurn
	for _, h := range heads {
		messages, err := s.Store.chatHistory(docID, h.ID)
		if err != nil {
			return nil, nil, err
		}
		var turn *davTurn
		for _, m := range messages {
			if m.Role == "user" || turn == nil {
				turns = append(turns, davTurn{Hash: hash, Session: h.ID})
				turn = &turns[len(turns)-1]
			}
			m.DocumentID = ""
			m.SessionID = ""
			turn.Messages = append(turn.Messages, m)
		}
	}
	return heads, turns, nil
}
func validDAVHash(hash string) bool {
	b, err := hex.DecodeString(hash)
	return err == nil && len(b) == 32 && strings.ToLower(hash) == hash
}
func (s *Server) pullDocument(ctx context.Context, d *davClient, doc davDocument, names map[string]bool) (bool, error) {
	if !validDAVHash(doc.Hash) || (doc.Type != "pdf" && doc.Type != "epub") || (doc.Library != "books" && doc.Library != "papers") {
		return false, errors.New("无效的 WebDAV 文档说明")
	}
	var exists bool
	if err := s.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM dav_files WHERE hash=?)", doc.Hash).Scan(&exists); err != nil || exists {
		return exists, err
	}
	name := "file-" + doc.Hash + "." + doc.Type
	if !names[name] {
		return false, nil
	}
	stream, err := d.get(ctx, name)
	if err != nil {
		return false, err
	}
	defer stream.Close()
	f, err := os.CreateTemp(s.Store.Root, "dav-import-*")
	if err != nil {
		return false, err
	}
	defer os.Remove(f.Name())
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(stream, maxImportBytes+1))
	closeErr := f.Close()
	if err != nil || closeErr != nil || size > maxImportBytes || hex.EncodeToString(h.Sum(nil)) != doc.Hash {
		return false, errors.New("下载的原文件未通过 SHA-256 校验")
	}
	title := filepath.Base(strings.ReplaceAll(doc.Title, "\\", "/"))
	item, _, err := s.importFile(ctx, f.Name(), title+"."+doc.Type, doc.Library, true)
	if err != nil {
		return false, err
	}
	_, err = s.Store.DB.Exec("INSERT OR IGNORE INTO dav_files VALUES(?,?)", doc.Hash, item.ID)
	if err == nil {
		s.connectorRevision.Add(1)
	}
	return err == nil, err
}

// No incoming record can change the ownership of a local session or message.
func (s *Server) davTarget(hash, sid string) (doc string, skip bool, err error) {
	if !validDAVHash(hash) || !chatMessageIDPattern.MatchString(sid) {
		return "", false, errors.New("无效的同步会话标识")
	}
	err = s.Store.DB.QueryRow("SELECT document_id FROM dav_files WHERE hash=?", hash).Scan(&doc)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return
	}
	var live bool
	err = s.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM documents WHERE id=? AND deleted_at=''),EXISTS(SELECT 1 FROM dav_hidden WHERE session_id=?)", doc, sid).Scan(&live, &skip)
	if !live {
		doc = ""
	}
	return
}
func validStamp(stamp string) bool { _, err := time.Parse(time.RFC3339Nano, stamp); return err == nil }
func (s *Server) pullSession(h davSession) (bool, error) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	doc, skip, err := s.davTarget(h.Hash, h.ID)
	if err != nil || doc == "" || skip {
		return skip, err
	}
	if s.chatRuns[h.ID] != nil || s.chatReservations[h.ID] {
		return false, nil
	}
	if len(h.Title) > 1024 || !validStamp(h.CreatedAt) || !validStamp(h.UpdatedAt) {
		return false, errors.New("同步会话标题或时间无效")
	}
	_, err = s.Store.DB.Exec(`INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,provider=excluded.provider,updated_at=excluded.updated_at WHERE chat_sessions.document_id=excluded.document_id AND (excluded.updated_at>chat_sessions.updated_at OR (excluded.updated_at=chat_sessions.updated_at AND excluded.title>chat_sessions.title))`, h.ID, doc, h.Title, h.Provider, h.CreatedAt, h.UpdatedAt)
	return err == nil, err
}
func (s *Server) pullTurn(t davTurn) (bool, error) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	doc, skip, err := s.davTarget(t.Hash, t.Session)
	if err != nil || doc == "" || skip {
		return skip, err
	}
	if s.chatRuns[t.Session] != nil || s.chatReservations[t.Session] {
		return false, nil
	}
	_, err = s.Store.chatSession(doc, t.Session)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(t.Messages) == 0 {
		return false, errors.New("同步记录缺少消息")
	}
	added := false
	first := t.Messages[0]
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	for i, m := range t.Messages {
		if !chatMessageIDPattern.MatchString(m.ID) || !validStamp(m.CreatedAt) || (m.Role != "assistant" && (i != 0 || m.Role != "user")) {
			return false, errors.New("无效的同步消息")
		}
		m.DocumentID = doc
		m.SessionID = t.Session
		var previous string
		err = tx.QueryRow("SELECT body FROM messages WHERE id=?", m.ID).Scan(&previous)
		if errors.Is(err, sql.ErrNoRows) {
			added = true
			_, err = tx.Exec("INSERT INTO messages VALUES(?,?,?,?)", m.ID, doc, jsonText(m), m.CreatedAt)
		} else if err == nil {
			var existing Message
			if json.Unmarshal([]byte(previous), &existing) != nil || jsonText(existing) != jsonText(m) {
				return false, fmt.Errorf("同步消息标识冲突，本机消息已保留")
			}
		}
		if err != nil {
			return false, err
		}
		_, err = tx.Exec("INSERT OR IGNORE INTO dav_order VALUES(?,?,?,?)", m.ID, first.CreatedAt, first.ID, i)
		if err != nil {
			return false, err
		}
	}
	if added {
		// A foreign turn may sort before our last answer. Seed the next run
		// from the merged transcript instead of reusing a stale local context.
		if _, err = tx.Exec("DELETE FROM document_conversations WHERE document_id=? AND provider LIKE ?", doc, "session:"+t.Session+":%"); err != nil {
			return false, err
		}
	}
	err = tx.Commit()
	return err == nil, err
}

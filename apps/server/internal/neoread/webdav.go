package neoread

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

type davConfig struct {
	Enabled  bool   `json:"enabled"`
	URL      string `json:"url"`
	Username string `json:"username"`
}
type davStatus struct {
	At         string `json:"at,omitempty"`
	Error      string `json:"error,omitempty"`
	Uploaded   int    `json:"uploaded"`
	Downloaded int    `json:"downloaded"`
}

func (s *Server) readDAV() (davConfig, error) {
	var c davConfig
	var raw string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='webdav-v1'").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return c, nil
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &c)
	}
	return c, err
}
func (c davConfig) identity() string { return sourceKey(c.URL + "\x00" + c.Username) }
func (s *Server) davSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == "PUT" {
		s.davMu.Lock()
		defer s.davMu.Unlock()
	}
	cfg, err := s.readDAV()
	if err != nil {
		fail(w, 500, "无法读取同步配置")
		return
	}
	if r.Method == "PUT" {
		var form struct {
			davConfig
			Password string `json:"password"`
		}
		if !decode(w, r, &form) {
			return
		}
		cfg = form.davConfig
		cfg.URL = strings.TrimRight(strings.TrimSpace(cfg.URL), "/")
		if cfg.URL != "" || cfg.Enabled {
			u, e := url.Parse(cfg.URL)
			if e != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
				fail(w, 400, "请输入现有 WebDAV 目录的 HTTP(S) 地址，用户名和密码单独填写")
				return
			}
		}
		if form.Password != "" {
			if err = keyring.Set("NeoRead WebDAV", cfg.identity(), form.Password); err != nil {
				fail(w, 500, "无法写入系统凭据库")
				return
			}
		}
		if cfg.Enabled && cfg.Username != "" {
			if _, err = keyring.Get("NeoRead WebDAV", cfg.identity()); err != nil {
				fail(w, 400, "请填写此地址和用户名对应的 WebDAV 密码")
				return
			}
		}
		if _, err = s.Store.DB.Exec("INSERT OR REPLACE INTO settings VALUES('webdav-v1',?)", jsonText(cfg)); err != nil {
			fail(w, 500, "无法保存同步配置")
			return
		}
	}
	s.davStatusMu.Lock()
	last := s.davLast
	s.davStatusMu.Unlock()
	respond(w, 200, struct {
		davConfig
		Status davStatus `json:"status"`
	}{cfg, last})
}
func (s *Server) davNow(w http.ResponseWriter, r *http.Request) {
	report, err := s.syncDAV(r.Context())
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	respond(w, 200, report)
}
func (s *Server) StartWebDAV(parent context.Context) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTimer(3 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				_, _ = s.syncDAV(ctx)
				timer.Reset(time.Minute)
			}
		}
	}()
	return func() { cancel(); <-done }
}
func (s *Server) syncDAV(ctx context.Context) (davStatus, error) {
	s.davMu.Lock()
	defer s.davMu.Unlock()
	cfg, err := s.readDAV()
	if err != nil {
		return davStatus{}, errors.New("无法读取同步配置")
	}
	if !cfg.Enabled {
		return davStatus{}, errors.New("请先启用 WebDAV 同步")
	}
	password := ""
	if cfg.Username != "" {
		password, err = keyring.Get("NeoRead WebDAV", cfg.identity())
	}
	report := davStatus{}
	if err == nil {
		dav := newDAV(cfg, password)
		err = s.exchangeDAV(ctx, dav, &report)
	} else {
		err = errors.New("无法读取系统凭据库中的 WebDAV 密码")
	}
	report.At = now()
	if err != nil {
		report.Error = err.Error()
		s.diagnosticEvent(slog.LevelWarn, "webdav.sync_failed", "errorCode", "sync")
	} else if report.Uploaded+report.Downloaded > 0 {
		s.diagnosticEvent(slog.LevelInfo, "webdav.sync_completed", "uploaded", report.Uploaded, "downloaded", report.Downloaded)
	}
	s.davStatusMu.Lock()
	s.davLast = report
	s.davStatusMu.Unlock()
	return report, err
}

type davClient struct {
	cfg      davConfig
	password string
	http     *http.Client
	zotero   map[string][]string
}

func newDAV(c davConfig, password string) *davClient {
	return &davClient{cfg: c, password: password, http: &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (d *davClient) request(ctx context.Context, method, name string, body io.Reader, size int64) (*http.Response, error) {
	return d.requestAt(ctx, method, "neoread-v1/"+name, body, size)
}
func (d *davClient) requestAt(ctx context.Context, method, relative string, body io.Reader, size int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.cfg.URL+"/"+relative, body)
	if err != nil {
		return nil, errors.New("WebDAV 地址无效")
	}
	if size >= 0 {
		req.ContentLength = size
	}
	if d.cfg.Username != "" {
		req.SetBasicAuth(d.cfg.Username, d.password)
	}
	if method == "PROPFIND" {
		req.Header.Set("Depth", "1")
		req.Header.Set("Content-Type", "application/xml")
	}
	if method == "PUT" {
		req.Header.Set("If-None-Match", "*")
	}
	res, err := d.http.Do(req)
	if err != nil {
		return nil, errors.New("WebDAV 连接失败，请检查网络、VPN 和目录地址")
	}
	return res, nil
}
func davHTTP(status int) error {
	return fmt.Errorf("WebDAV 返回 HTTP %d，请检查目录地址、读写权限和凭据", status)
}

var davName = regexp.MustCompile(`^(file-[a-f0-9]{64}\.(pdf|epub)|(doc|session|turn)-[a-f0-9]{64}\.json)$`)

func (d *davClient) list(ctx context.Context) (map[string]bool, error) {
	res, err := d.request(ctx, "MKCOL", "", nil, 0)
	if err != nil {
		return nil, err
	}
	res.Body.Close()
	if res.StatusCode != 201 && res.StatusCode != 405 {
		return nil, davHTTP(res.StatusCode)
	}
	q := []byte(`<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>`)
	res, err = d.request(ctx, "PROPFIND", "", bytes.NewReader(q), int64(len(q)))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 207 {
		return nil, davHTTP(res.StatusCode)
	}
	var listing struct {
		XMLName xml.Name `xml:"multistatus"`
		Entries []struct {
			Href string `xml:"href"`
		} `xml:"response"`
	}
	if err = xml.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(&listing); err != nil {
		return nil, errors.New("无法读取 WebDAV 文件列表")
	}
	names := map[string]bool{}
	hasSources := false
	for _, ent := range listing.Entries {
		u, e := url.Parse(ent.Href)
		if e == nil {
			name := path.Base(u.Path)
			if name == "zotero-sources-v1.json" {
				hasSources = true
			}
			if davName.MatchString(name) {
				names[name] = true
			}
		}
	}
	d.zotero = nil
	if hasSources {
		if err := d.readZoteroSources(ctx); err != nil {
			return nil, err
		}
	}
	return names, nil
}
func (d *davClient) put(ctx context.Context, name string, body io.Reader, size int64) error {
	res, err := d.request(ctx, "PUT", name, body, size)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 201 && res.StatusCode != 204 && res.StatusCode != 412 {
		return davHTTP(res.StatusCode)
	}
	return nil
}
func (d *davClient) get(ctx context.Context, name string) (io.ReadCloser, error) {
	res, err := d.request(ctx, "GET", name, nil, 0)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, davHTTP(res.StatusCode)
	}
	return res.Body, nil
}

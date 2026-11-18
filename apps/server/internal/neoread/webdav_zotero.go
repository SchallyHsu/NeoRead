package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
)

type zoteroDAVRef struct {
	Key      string `json:"key"`
	ETag     string `json:"etag"`
	PropETag string `json:"propETag"`
}

var zoteroDAVKey = regexp.MustCompile("^[A-Z0-9]{8}$")

// Zotero stores personal attachment originals as KEY.zip and KEY.prop. The
// bridge identifies their bytes and pins both files' server versions. A
// replacement or removal causes an owner to publish its normal raw fallback.
func (d *davClient) readZoteroSources(ctx context.Context) error {
	stream, err := d.get(ctx, "zotero-sources-v1.json")
	if err != nil {
		return err
	}
	defer stream.Close()
	var catalog struct {
		Version int                       `json:"version"`
		Sources map[string][]zoteroDAVRef `json:"sources"`
	}
	data, err := io.ReadAll(io.LimitReader(stream, (8<<20)+1))
	if err != nil || len(data) > 8<<20 || json.Unmarshal(data, &catalog) != nil || catalog.Version != 1 || catalog.Sources == nil {
		return errors.New("Zotero 附件索引无效")
	}
	q := []byte(`<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`)
	res, err := d.requestAt(ctx, "PROPFIND", "", bytes.NewReader(q), int64(len(q)))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 207 {
		return davHTTP(res.StatusCode)
	}
	var listing struct {
		XMLName xml.Name `xml:"multistatus"`
		Entries []struct {
			Href  string `xml:"href"`
			Props []struct {
				Status string `xml:"status"`
				ETag   string `xml:"prop>getetag"`
			} `xml:"propstat"`
		} `xml:"response"`
	}
	if err = xml.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(&listing); err != nil {
		return errors.New("无法核对 Zotero 附件版本")
	}
	etags := map[string]string{}
	for _, entry := range listing.Entries {
		u, err := url.Parse(entry.Href)
		if err != nil {
			continue
		}
		for _, p := range entry.Props {
			if strings.Contains(p.Status, " 200 ") && strings.HasPrefix(p.ETag, "\"") && strings.HasSuffix(p.ETag, "\"") {
				etags[path.Base(u.Path)] = p.ETag
			}
		}
	}
	d.zotero = map[string][]string{}
	for hash, refs := range catalog.Sources {
		if !validDAVHash(hash) {
			continue
		}
		for _, ref := range refs {
			if zoteroDAVKey.MatchString(ref.Key) && ref.ETag != "" && ref.PropETag != "" && etags[ref.Key+".zip"] == ref.ETag && etags[ref.Key+".prop"] == ref.PropETag {
				d.zotero[hash] = append(d.zotero[hash], ref.Key)
			}
		}
	}
	return nil
}

type zoteroZipMember struct {
	io.ReadCloser
	archive *os.File
}

func (m *zoteroZipMember) Close() error {
	err := m.ReadCloser.Close()
	p := m.archive.Name()
	closeErr := m.archive.Close()
	os.Remove(p)
	return errors.Join(err, closeErr)
}

// Never unpack archive paths. Select the document by its full content digest,
// independent of Zotero's encoded filenames. Bound both transfer and inflation.
func (d *davClient) zoteroOriginal(ctx context.Context, dir, hash string) (io.ReadCloser, error) {
	for _, key := range d.zotero[hash] {
		if !zoteroDAVKey.MatchString(key) {
			continue
		}
		res, err := d.requestAt(ctx, "GET", key+".zip", nil, 0)
		if err != nil {
			return nil, err
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			continue
		}
		member, err := verifiedZipMember(dir, hash, res.Body)
		res.Body.Close()
		if err == nil {
			return member, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, errors.New("Zotero 原附件暂不可用或文件校验失败")
}

func verifiedZipMember(dir, hash string, stream io.Reader) (member io.ReadCloser, err error) {
	f, err := os.CreateTemp(dir, "dav-zotero-*.zip")
	if err != nil {
		return nil, err
	}
	defer func() {
		if member == nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	const zipLimit = maxImportBytes + (8 << 20)
	n, err := io.Copy(f, io.LimitReader(stream, zipLimit+1))
	if err != nil || n > zipLimit {
		return nil, errors.New("Zotero 压缩附件超出限制或下载中断")
	}
	z, err := zip.NewReader(f, n)
	if err != nil || len(z.File) > 1024 {
		return nil, errors.New("无效的 Zotero 附件压缩包")
	}
	var expanded uint64
	for _, entry := range z.File {
		if !entry.Mode().IsRegular() {
			continue
		}
		if entry.UncompressedSize64 > maxImportBytes || expanded+entry.UncompressedSize64 > zipLimit {
			return nil, errors.New("Zotero 附件解压大小超出限制")
		}
		expanded += entry.UncompressedSize64
		file, err := entry.Open()
		if err != nil {
			return nil, err
		}
		digest := sha256.New()
		copied, err := io.Copy(digest, io.LimitReader(file, int64(entry.UncompressedSize64)+1))
		file.Close()
		if err != nil || uint64(copied) != entry.UncompressedSize64 {
			return nil, errors.New("Zotero 附件内容不完整")
		}
		if hex.EncodeToString(digest.Sum(nil)) == hash {
			file, err = entry.Open()
			if err != nil {
				return nil, err
			}
			return &zoteroZipMember{file, f}, nil
		}
	}
	return nil, errors.New("未找到内容匹配的 Zotero 原文件")
}

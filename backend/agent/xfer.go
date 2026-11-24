package main

// Large file transfers between devices (via the server's staging area). The source agent uploads in
// blocks of 8 MB, the destination agent downloads with Range requests; both resume after an interruption
// and verify a SHA-256 over the whole file.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const xferBlock = 8 << 20

var xferActive sync.Map // transfer id -> struct{}: one goroutine per transfer and direction

type httpStatusErr struct {
	code int
	msg  string
}

func (e *httpStatusErr) Error() string { return fmt.Sprintf("HTTP %d: %s", e.code, e.msg) }

// permanent: retrying will not help (cancelled, unknown, rejected)
func permanent(err error) bool {
	var h *httpStatusErr
	if errors.As(err, &h) {
		return h.code == 401 || h.code == 403 || h.code == 404 || h.code == 410 || h.code == 422
	}
	return false
}

func xferReq(ctx context.Context, cfg *Config, method, path string, body []byte, hdr map[string]string) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfg.Server+"/api/devices/agent/xfer/"+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("User-Agent", "ClaudeAgent/"+version)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		res.Body.Close()
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		return res, &httpStatusErr{res.StatusCode, msg}
	}
	return res, nil
}

func xferJSON(ctx context.Context, cfg *Config, method, path string, in any, out any) error {
	var b []byte
	hdr := map[string]string{}
	if in != nil {
		b, _ = json.Marshal(in)
		hdr["Content-Type"] = "application/json"
	}
	rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	res, err := xferReq(rctx, cfg, method, path, b, hdr)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

func xferFail(ctx context.Context, cfg *Config, id, msg string) {
	log.Printf("overdracht %s mislukt: %s", id, msg)
	fctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = xferJSON(fctx, cfg, "POST", id+"/fail", map[string]string{"error": msg}, nil)
}

// retry runs one attempt function with back-off; permanent errors and context end stop it.
func retry(ctx context.Context, attempts int, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = fn(); err == nil || permanent(err) || ctx.Err() != nil {
			return err
		}
		log.Printf("overdracht: poging %d mislukt: %v", i+1, err)
		d := time.Duration(2<<uint(min(i, 5))) * time.Second
		sleepCtx(ctx, d)
	}
	return err
}

func startUpload(ctx context.Context, cfg *Config, id, path string) (int64, error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if st.IsDir() {
		return 0, errors.New("is een map, geen bestand")
	}
	if _, loaded := xferActive.LoadOrStore("up:"+id, struct{}{}); loaded {
		return st.Size(), nil // already running (the server re-sent the job): keep going
	}
	go func() {
		defer xferActive.Delete("up:" + id)
		err := retry(ctx, 10, func() error { return uploadOnce(ctx, cfg, id, path) })
		if err != nil && ctx.Err() == nil && !permanent(err) {
			xferFail(ctx, cfg, id, "uploaden mislukt: "+err.Error())
		} else if err != nil && ctx.Err() == nil {
			log.Printf("upload %s gestopt: %v", id, err)
		}
	}()
	return st.Size(), nil
}

func uploadOnce(ctx context.Context, cfg *Config, id, path string) error {
	var stt struct {
		Received int64 `json:"received"`
	}
	if err := xferJSON(ctx, cfg, "GET", id+"/up-status", nil, &stt); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	size := st.Size()
	if stt.Received > size {
		return &httpStatusErr{422, "bron is kleiner dan wat al is ontvangen (bestand gewijzigd)"}
	}
	whole := sha256.New()
	if stt.Received > 0 {
		if _, err := io.CopyN(whole, f, stt.Received); err != nil {
			return err
		}
	}
	buf := make([]byte, xferBlock)
	off := stt.Received
	for off < size {
		n := int64(len(buf))
		if size-off < n {
			n = size - off
		}
		if _, err := io.ReadFull(f, buf[:n]); err != nil {
			return err
		}
		whole.Write(buf[:n])
		sum := sha256.Sum256(buf[:n])
		rctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		res, err := xferReq(rctx, cfg, "PUT", id+"/chunk?offset="+strconv.FormatInt(off, 10), buf[:n],
			map[string]string{"X-Sha256": hex.EncodeToString(sum[:]), "Content-Type": "application/octet-stream"})
		cancel()
		if err != nil {
			return err
		}
		res.Body.Close()
		off += n
	}
	if st2, err := os.Stat(path); err == nil && st2.Size() != size {
		return &httpStatusErr{422, "bestand is tijdens het uploaden gewijzigd"}
	}
	return xferJSON(ctx, cfg, "POST", id+"/up-done", map[string]any{"sha256": hex.EncodeToString(whole.Sum(nil)), "size": size}, nil)
}

func startDownload(ctx context.Context, cfg *Config, id, dst string, overwrite bool) error {
	if dst == "" {
		return errors.New("doelpad ontbreekt")
	}
	if _, err := os.Stat(dst); err == nil && !overwrite {
		return errors.New("doelbestand bestaat al (overwrite niet gezet): " + dst)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if _, loaded := xferActive.LoadOrStore("down:"+id, struct{}{}); loaded {
		return nil
	}
	go func() {
		defer xferActive.Delete("down:" + id)
		err := retry(ctx, 10, func() error { return downloadOnce(ctx, cfg, id, dst) })
		if err != nil && ctx.Err() == nil {
			if permanent(err) {
				log.Printf("download %s gestopt: %v", id, err)
			} else {
				xferFail(ctx, cfg, id, "downloaden mislukt: "+err.Error())
			}
		}
	}()
	return nil
}

func downloadOnce(ctx context.Context, cfg *Config, id, dst string) error {
	var info struct {
		Size   int64  `json:"size"`
		Sha256 string `json:"sha256"`
	}
	if err := xferJSON(ctx, cfg, "GET", id+"/down-info", nil, &info); err != nil {
		return err
	}
	part := dst + ".ccpart"
	have := int64(0)
	if st, err := os.Stat(part); err == nil {
		have = st.Size()
		if have > info.Size {
			_ = os.Remove(part)
			have = 0
		}
	}
	f, err := os.OpenFile(part, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	whole := sha256.New()
	if have > 0 {
		if _, err := io.Copy(whole, f); err != nil { // also leaves the offset at the end
			return err
		}
	}
	if have < info.Size {
		rctx, cancel := context.WithCancel(ctx)
		defer cancel()
		res, err := xferReq(rctx, cfg, "GET", id+"/down", nil, map[string]string{"Range": "bytes=" + strconv.FormatInt(have, 10) + "-"})
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode == 200 && have > 0 { // server ignored Range: start over
			_ = f.Truncate(0)
			_, _ = f.Seek(0, io.SeekStart)
			whole.Reset()
			have = 0
		}
		buf := make([]byte, 1<<20)
		lastReport := time.Now()
		for {
			n, rerr := res.Body.Read(buf)
			if n > 0 {
				if _, err := f.Write(buf[:n]); err != nil {
					return err
				}
				whole.Write(buf[:n])
				have += int64(n)
				if time.Since(lastReport) > 1500*time.Millisecond {
					lastReport = time.Now()
					if err := xferJSON(ctx, cfg, "POST", id+"/down-progress", map[string]int64{"bytes": have}, nil); err != nil {
						if permanent(err) { // cancelled
							f.Close()
							_ = os.Remove(part)
						}
						return err
					}
				}
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				return rerr
			}
		}
	}
	if have != info.Size {
		return fmt.Errorf("onvolledig: %d van %d bytes", have, info.Size)
	}
	got := hex.EncodeToString(whole.Sum(nil))
	if got != info.Sha256 {
		f.Close()
		_ = os.Remove(part)
		return fmt.Errorf("checksum klopt niet (verwacht %s, kreeg %s)", info.Sha256, got)
	}
	f.Close()
	if runtime.GOOS == "windows" {
		_ = os.Remove(dst) // overwrite was already checked in startDownload
	}
	if err := os.Rename(part, dst); err != nil {
		return err
	}
	return xferJSON(ctx, cfg, "POST", id+"/down-done", map[string]any{"sha256": got, "bytes": have}, nil)
}

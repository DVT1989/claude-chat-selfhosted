// Claude Agent: links a Windows or Mac computer to Claude Chat. It keeps one outgoing HTTPS
// long-poll open to the server (no open ports needed), runs the jobs it receives (commands,
// file read/write, inventory) and reports device information periodically.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var version = "dev"

type Config struct {
	Server   string `json:"server"`
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
}

type Job struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Command    string `json:"command,omitempty"`
	Shell      string `json:"shell,omitempty"`
	TimeoutSec int    `json:"timeoutSec,omitempty"`
	RunAs      string `json:"runas,omitempty"`
	Elevated   bool   `json:"elevated,omitempty"`
	Path       string `json:"path,omitempty"`
	DataB64    string `json:"dataB64,omitempty"`
	Session    string `json:"session,omitempty"`
	Key        string `json:"key,omitempty"`
}

type Result struct {
	ID         string `json:"id"`
	OK         bool   `json:"ok"`
	ExitCode   int    `json:"exitCode"`
	Output     string `json:"output,omitempty"`
	Error      string `json:"error,omitempty"`
	DataB64    string `json:"dataB64,omitempty"`
	Data       any    `json:"data,omitempty"`
	DurationMs int64  `json:"durationMs"`
}

var errRevoked = errors.New("apparaat is ontkoppeld of de sleutel is ongeldig")

func configDir() string {
	if runtime.GOOS == "windows" {
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "ClaudeAgent")
	}
	return "/Library/Application Support/ClaudeAgent"
}

func configPath() string { return filepath.Join(configDir(), "config.json") }

func loadConfig() (*Config, error) {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if c.Server == "" || c.Token == "" {
		return nil, errors.New("config onvolledig")
	}
	return &c, nil
}

func saveConfig(c *Config) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath(), b, 0o600)
}

func normalizeServer(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "/")
	if s != "" && !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		s = "https://" + s
	}
	return s
}

// post sends JSON to /api/devices/agent/<path>. With a config it authenticates as the device.
func post(ctx context.Context, server, token, path string, body, out any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server+"/api/devices/agent/"+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ClaudeAgent/"+version)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusGone {
		return errRevoked
	}
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func enroll(server, code string) error {
	server = normalizeServer(server)
	code = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), " ", ""))
	if server == "" || code == "" {
		return errors.New("server en koppelcode zijn nodig")
	}
	host, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var out struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
		Name     string `json:"name"`
	}
	err := post(ctx, server, "", "enroll", map[string]string{
		"code": code, "hostname": host, "os": runtime.GOOS, "arch": runtime.GOARCH,
		"osName": osName(), "version": version,
	}, &out)
	if errors.Is(err, errRevoked) {
		return errors.New("koppelcode ongeldig of verlopen")
	}
	if err != nil {
		return err
	}
	if err := saveConfig(&Config{Server: server, DeviceID: out.DeviceID, Token: out.Token}); err != nil {
		return fmt.Errorf("config opslaan mislukt: %w", err)
	}
	fmt.Printf("Gekoppeld als %s\n", out.Name)
	return nil
}

func unenroll() {
	c, err := loadConfig()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = post(ctx, c.Server, c.Token, "unenroll", map[string]string{}, nil)
	_ = os.Remove(configPath())
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// runLoop is the service body: long-poll for jobs until the context ends.
func runLoop(ctx context.Context) {
	setupLog()
	log.Printf("Claude Agent %s gestart (%s/%s)", version, runtime.GOOS, runtime.GOARCH)
	backoff := 2 * time.Second
	invStarted := false
	for ctx.Err() == nil {
		cfg, err := loadConfig()
		if err != nil {
			log.Printf("geen geldige config (%v); opnieuw over 1 minuut", err)
			sleepCtx(ctx, time.Minute)
			continue
		}
		if !invStarted {
			invStarted = true
			go startPlatformLoops(ctx)
			go inventoryLoop(ctx)
		}
		var resp struct {
			Jobs []Job `json:"jobs"`
		}
		pctx, cancel := context.WithTimeout(ctx, 50*time.Second)
		body := map[string]any{"version": version}
		if p := remotePerms(); p != nil {
			body["perms"] = p
		}
		err = post(pctx, cfg.Server, cfg.Token, "poll", body, &resp)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errRevoked) {
			log.Printf("server weigert de sleutel: %v; opnieuw over 1 uur", err)
			sleepCtx(ctx, time.Hour)
			continue
		}
		if err != nil {
			log.Printf("poll mislukt: %v", err)
			sleepCtx(ctx, backoff)
			// short cap: after sleep or a network change the device should be back within seconds
			if backoff < 15*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 2 * time.Second
		for _, j := range resp.Jobs {
			go handleJob(ctx, cfg, j)
		}
	}
}

func sendResult(ctx context.Context, cfg *Config, r Result) {
	for i := 0; i < 3; i++ {
		rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		err := post(rctx, cfg.Server, cfg.Token, "result", r, nil)
		cancel()
		if err == nil || errors.Is(err, errRevoked) {
			return
		}
		log.Printf("resultaat %s versturen mislukt: %v", r.ID, err)
		sleepCtx(ctx, time.Duration(i+1)*2*time.Second)
	}
}

func inventoryLoop(ctx context.Context) {
	sleepCtx(ctx, 5*time.Second)
	for ctx.Err() == nil {
		if cfg, err := loadConfig(); err == nil {
			if inv, err := collectInventory(ctx); err == nil {
				ictx, cancel := context.WithTimeout(ctx, 60*time.Second)
				if err := post(ictx, cfg.Server, cfg.Token, "inventory", map[string]any{"inventory": inv}, nil); err != nil {
					log.Printf("inventaris versturen mislukt: %v", err)
				}
				cancel()
			} else {
				log.Printf("inventaris mislukt: %v", err)
			}
		}
		sleepCtx(ctx, 6*time.Hour)
	}
}

func setupLog() {
	if runtime.GOOS != "windows" {
		return // launchd writes stderr to /Library/Logs/claude-agent.log
	}
	p := filepath.Join(configDir(), "agent.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 5<<20 {
		_ = os.Remove(p)
	}
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(f)
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Gebruik: claude-agent enroll --server URL --code CODE | run | unenroll | version")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "enroll":
		fs := flag.NewFlagSet("enroll", flag.ExitOnError)
		server := fs.String("server", "", "server-URL")
		code := fs.String("code", "", "koppelcode")
		_ = fs.Parse(os.Args[2:])
		if err := enroll(*server, *code); err != nil {
			fmt.Println(err.Error())
			os.Exit(1)
		}
	case "run":
		runService()
	case "desktop":
		runDesktop(os.Args[2:])
	case "mac-perms":
		runMacPerms(os.Args[2:])
	case "unenroll":
		unenroll()
	case "version":
		fmt.Println(version)
	default:
		fmt.Println("onbekend commando:", os.Args[1])
		os.Exit(2)
	}
}

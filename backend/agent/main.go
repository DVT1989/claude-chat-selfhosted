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
	Xfer       string `json:"xfer,omitempty"`
	Overwrite  bool   `json:"overwrite,omitempty"`
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

// configFile is config.json. The top-level fields hold the first server (older agents read only
// those); Servers holds every server this device is paired with (one device, several installations).
type configFile struct {
	Config
	Servers []Config `json:"servers,omitempty"`
}

// loadConfigs returns every paired server (old single-server files are read as a list of one).
func loadConfigs() ([]*Config, error) {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return nil, err
	}
	var f configFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	list := f.Servers
	if len(list) == 0 {
		list = []Config{f.Config}
	}
	var out []*Config
	for i := range list {
		c := list[i]
		if c.Server != "" && c.Token != "" {
			out = append(out, &c)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("config onvolledig")
	}
	return out, nil
}

// loadConfig returns the first paired server.
func loadConfig() (*Config, error) {
	list, err := loadConfigs()
	if err != nil {
		return nil, err
	}
	return list[0], nil
}

// configFor returns the current entry for a server (nil when it is no longer paired).
func configFor(server string) *Config {
	list, _ := loadConfigs()
	for _, c := range list {
		if sameServer(c.Server, server) {
			return c
		}
	}
	return nil
}

func sameServer(a, b string) bool {
	return strings.EqualFold(normalizeServer(a), normalizeServer(b))
}

func saveConfigs(list []*Config) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	if len(list) == 0 {
		err := os.Remove(configPath())
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	f := configFile{Config: *list[0]}
	for _, c := range list {
		f.Servers = append(f.Servers, *c)
	}
	b, _ := json.MarshalIndent(f, "", "  ")
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
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
	// same server: replace that pairing; another server: add it next to the existing ones
	list, _ := loadConfigs()
	nc := &Config{Server: server, DeviceID: out.DeviceID, Token: out.Token}
	replaced := false
	for i, c := range list {
		if sameServer(c.Server, server) {
			list[i] = nc
			replaced = true
		}
	}
	if !replaced {
		list = append(list, nc)
	}
	if err := saveConfigs(list); err != nil {
		return fmt.Errorf("config opslaan mislukt: %w", err)
	}
	fmt.Printf("Gekoppeld als %s\n", out.Name)
	return nil
}

// unenroll removes one server (server given) or every pairing (uninstall).
func unenroll(server string) {
	list, err := loadConfigs()
	if err != nil {
		return
	}
	var keep []*Config
	for _, c := range list {
		if server != "" && !sameServer(c.Server, server) {
			keep = append(keep, c)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = post(ctx, c.Server, c.Token, "unenroll", map[string]string{}, nil)
		cancel()
	}
	_ = saveConfigs(keep)
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// runLoop is the service body: one long-poll loop per paired server until the context ends.
// The pairings are re-read every 30 seconds, so a server added with "enroll" starts without restart.
func runLoop(ctx context.Context) {
	setupLog()
	log.Printf("Claude Agent %s gestart (%s/%s)", version, runtime.GOOS, runtime.GOARCH)
	started := false
	invSent := false
	running := map[string]bool{}
	done := make(chan string, 8)
	for ctx.Err() == nil {
		list, err := loadConfigs()
		if err != nil {
			log.Printf("geen geldige config (%v); opnieuw over 1 minuut", err)
		} else {
			if !started {
				started = true
				go startPlatformLoops(ctx)
				go inventoryLoop(ctx)
			}
			for _, c := range list {
				c := c
				key := strings.ToLower(normalizeServer(c.Server))
				if !running[key] {
					running[key] = true
					if invSent {
						go sendInventory(ctx, c) // newly added server: inventory now, not after 6 hours
					}
					go func(server, key string) {
						serverLoop(ctx, server)
						done <- key
					}(c.Server, key)
				}
			}
		}
		invSent = started
		wait := 30 * time.Second
		if err != nil {
			wait = time.Minute
		}
		t := time.NewTimer(wait)
	drain:
		for {
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case k := <-done:
				delete(running, k)
			case <-t.C:
				break drain
			}
		}
	}
}

// serverLoop long-polls one server; it ends when that server is no longer in the config.
func serverLoop(ctx context.Context, server string) {
	log.Printf("verbinden met %s", server)
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		cfg := configFor(server)
		if cfg == nil {
			log.Printf("%s is ontkoppeld", server)
			return
		}
		var resp struct {
			Jobs []Job `json:"jobs"`
		}
		pctx, cancel := context.WithTimeout(ctx, 50*time.Second)
		body := map[string]any{"version": version}
		if p := remotePerms(); p != nil {
			body["perms"] = p
		}
		err := post(pctx, cfg.Server, cfg.Token, "poll", body, &resp)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errRevoked) {
			log.Printf("%s weigert de sleutel: %v; opnieuw over 1 uur", cfg.Server, err)
			// wake early when the pairing for this server is renewed
			for i := 0; i < 60 && ctx.Err() == nil; i++ {
				sleepCtx(ctx, time.Minute)
				if n := configFor(server); n == nil || n.Token != cfg.Token {
					break
				}
			}
			continue
		}
		if err != nil {
			log.Printf("poll %s mislukt: %v", cfg.Server, err)
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
		if list, err := loadConfigs(); err == nil {
			if inv, err := collectInventory(ctx); err == nil {
				for _, cfg := range list {
					ictx, cancel := context.WithTimeout(ctx, 60*time.Second)
					if err := post(ictx, cfg.Server, cfg.Token, "inventory", map[string]any{"inventory": inv}, nil); err != nil {
						log.Printf("inventaris naar %s versturen mislukt: %v", cfg.Server, err)
					}
					cancel()
				}
			} else {
				log.Printf("inventaris mislukt: %v", err)
			}
		}
		sleepCtx(ctx, 6*time.Hour)
	}
}

func sendInventory(ctx context.Context, cfg *Config) {
	sleepCtx(ctx, 5*time.Second)
	inv, err := collectInventory(ctx)
	if err != nil {
		return
	}
	ictx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := post(ictx, cfg.Server, cfg.Token, "inventory", map[string]any{"inventory": inv}, nil); err != nil {
		log.Printf("inventaris naar %s versturen mislukt: %v", cfg.Server, err)
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
		fmt.Println("Gebruik: claude-agent enroll --server URL --code CODE | run | servers | unenroll [--server URL] | version")
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
		fs := flag.NewFlagSet("unenroll", flag.ExitOnError)
		server := fs.String("server", "", "alleen deze server ontkoppelen")
		_ = fs.Parse(os.Args[2:])
		unenroll(*server)
	case "servers":
		list, _ := loadConfigs()
		for _, c := range list {
			fmt.Println(c.Server)
		}
	case "version":
		fmt.Println(version)
	default:
		fmt.Println("onbekend commando:", os.Args[1])
		os.Exit(2)
	}
}

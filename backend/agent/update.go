package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// startUpdate downloads the new installer and starts it detached, after a short delay so the
// job result reaches the server before the service is stopped and replaced.
func startUpdate(url string) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return errors.New("ongeldige update-URL")
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("download: HTTP %d", res.StatusCode)
	}
	name := "claude-agent-update.sh"
	if runtime.GOOS == "windows" {
		name = "ClaudeAgentSetup-update.exe"
	}
	path := filepath.Join(os.TempDir(), name)
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, res.Body); err != nil {
		f.Close()
		return err
	}
	f.Close()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
			fmt.Sprintf("Start-Sleep -Seconds 5; Start-Process -FilePath '%s' -ArgumentList '/S' -Wait; Remove-Item '%s' -ErrorAction SilentlyContinue", path, path))
	} else {
		_ = os.Chmod(path, 0o700)
		cmd = exec.Command("/bin/bash", "-c", fmt.Sprintf("sleep 5; /bin/bash '%s' >/tmp/claude-agent-update.log 2>&1; rm -f '%s'", path, path))
	}
	detach(cmd)
	return cmd.Start()
}

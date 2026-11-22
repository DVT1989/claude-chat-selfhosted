package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Same keys on both platforms so the overview can show them side by side.
const windowsInventory = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  @{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1) } })
$enc = @(Get-BitLockerVolume | ForEach-Object {
  @{ drive = $_.MountPoint; status = "$($_.ProtectionStatus)"; percent = $_.EncryptionPercentage } })
$mp = Get-MpComputerStatus
$defender = $null
if ($mp) {
  $scan = $null; if ($mp.QuickScanEndTime) { $scan = $mp.QuickScanEndTime.ToString('o') }
  $defender = @{ enabled = $mp.AntivirusEnabled; realtime = $mp.RealTimeProtectionEnabled; signatureAgeDays = $mp.AntivirusSignatureAge; lastQuickScan = $scan }
}
$hf = Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1
$lastUpdate = $null; if ($hf) { $lastUpdate = $hf.InstalledOn.ToString('o') }
$reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
$apps = @(Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } | Sort-Object DisplayName -Unique |
  ForEach-Object { @{ name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher } })
$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress })
$fw = @(Get-NetFirewallProfile | ForEach-Object { @{ name = "$($_.Name)"; enabled = [bool]$_.Enabled } })
@{
  manufacturer = $cs.Manufacturer; model = $cs.Model; serial = $bios.SerialNumber
  cpu = $cpu.Name; cores = $cpu.NumberOfCores; ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  os = $os.Caption; build = "$($os.Version)"; lastBoot = $os.LastBootUpTime.ToString('o'); user = $cs.UserName
  disks = $disks; encryption = $enc; defender = $defender; firewall = $fw
  lastUpdate = $lastUpdate; lastUpdateId = $hf.HotFixID; rebootPending = $reboot
  ips = $ips; appCount = $apps.Count; apps = $apps
} | ConvertTo-Json -Depth 5 -Compress
`

func collectInventory(ctx context.Context) (map[string]any, error) {
	var inv map[string]any
	if runtime.GOOS == "windows" {
		out, code, err := runCommand(ctx, "powershell", windowsInventory, 3*time.Minute, false, false)
		if err != nil {
			return nil, err
		}
		if code != 0 {
			return nil, errors.New("inventaris-script faalde: " + firstLine(out))
		}
		out = strings.TrimSpace(strings.TrimPrefix(out, "\ufeff"))
		if i := strings.Index(out, "{"); i > 0 {
			out = out[i:]
		}
		if err := json.Unmarshal([]byte(out), &inv); err != nil {
			return nil, errors.New("inventaris onleesbaar: " + firstLine(out))
		}
	} else {
		inv = darwinInventory(ctx)
	}
	inv["agentVersion"] = version
	inv["hostname"], _ = os.Hostname()
	inv["collectedAt"] = time.Now().UTC().Format(time.RFC3339)
	return inv, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func run(ctx context.Context, name string, args ...string) string {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(cctx, name, args...).Output()
	return strings.TrimSpace(string(out))
}

func darwinInventory(ctx context.Context) map[string]any {
	inv := map[string]any{"manufacturer": "Apple"}

	var hw struct {
		Items []map[string]any `json:"SPHardwareDataType"`
	}
	if json.Unmarshal([]byte(run(ctx, "system_profiler", "SPHardwareDataType", "-json")), &hw) == nil && len(hw.Items) > 0 {
		h := hw.Items[0]
		str := func(k string) string { s, _ := h[k].(string); return s }
		inv["model"] = strings.TrimSpace(str("machine_name") + " " + str("machine_model"))
		cpu := str("chip_type")
		if cpu == "" {
			cpu = str("cpu_type")
		}
		inv["cpu"] = cpu
		inv["cores"] = str("number_processors")
		inv["serial"] = str("serial_number")
		if f := strings.Fields(str("physical_memory")); len(f) > 0 {
			if n, err := strconv.ParseFloat(f[0], 64); err == nil {
				inv["ramGB"] = n
			}
		}
	}
	inv["os"] = "macOS " + run(ctx, "sw_vers", "-productVersion")
	inv["build"] = run(ctx, "sw_vers", "-buildVersion")
	if m := regexp.MustCompile(`sec = (\d+)`).FindStringSubmatch(run(ctx, "sysctl", "-n", "kern.boottime")); m != nil {
		if sec, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			inv["lastBoot"] = time.Unix(sec, 0).UTC().Format(time.RFC3339)
		}
	}
	inv["user"] = run(ctx, "stat", "-f%Su", "/dev/console")

	vol := "/System/Volumes/Data"
	if _, err := os.Stat(vol); err != nil {
		vol = "/"
	}
	if lines := strings.Split(run(ctx, "df", "-k", vol), "\n"); len(lines) > 1 {
		if f := strings.Fields(lines[1]); len(f) > 3 {
			size, _ := strconv.ParseFloat(f[1], 64)
			free, _ := strconv.ParseFloat(f[3], 64)
			inv["disks"] = []map[string]any{{"drive": "/", "sizeGB": round1(size / 1048576), "freeGB": round1(free / 1048576)}}
		}
	}
	fv := run(ctx, "fdesetup", "status")
	status := "Off"
	if strings.Contains(fv, "On") {
		status = "On"
	}
	inv["encryption"] = []map[string]any{{"drive": "/", "status": status, "name": "FileVault"}}
	inv["firewall"] = []map[string]any{{"name": "macOS", "enabled": strings.Contains(run(ctx, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"), "enabled")}}

	var ips []string
	for _, ifc := range []string{"en0", "en1", "en2"} {
		if ip := run(ctx, "ipconfig", "getifaddr", ifc); ip != "" {
			ips = append(ips, ip)
		}
	}
	inv["ips"] = ips

	var apps []map[string]any
	if entries, err := os.ReadDir("/Applications"); err == nil {
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".app") {
				apps = append(apps, map[string]any{"name": strings.TrimSuffix(e.Name(), ".app")})
			}
		}
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i]["name"].(string) < apps[j]["name"].(string) })
	inv["apps"] = apps
	inv["appCount"] = len(apps)
	return inv
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

func osName() string {
	if runtime.GOOS == "windows" {
		out, _, _ := runCommand(context.Background(), "powershell", "(Get-CimInstance Win32_OperatingSystem).Caption", 30*time.Second, false, false)
		if s := strings.TrimSpace(out); s != "" {
			return s
		}
		return "Windows"
	}
	return "macOS " + run(context.Background(), "sw_vers", "-productVersion")
}

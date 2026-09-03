import time
import os
import subprocess
import sys
import shutil
import json
import zipfile
import re
import threading
import random
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

# ================================
# CONFIGURATION
# ================================
WORKDIR = "/app"
EXTENSION_DIR = os.path.join(WORKDIR, "claimer")
# Persistent directory so you don't lose Cloudflare clearance
PROFILE_DIR = os.path.join(WORKDIR, "firefox-profile")
INTERNAL_SERVER_PORT = int(os.environ.get("INTERNAL_SERVER_PORT", 17532))
INTERNAL_SERVER_HOST = "127.0.0.1"
MIRROR_SITE = os.environ.get("MIRROR_SITE", "staketr.com.")
TARGET_URL = f"https://{MIRROR_SITE}/"
WARMUP_DELAY = int(os.environ.get("WARMUP_DELAY", 45)) # Time to wait for site to load before loading extension

BOT_START_TIME = time.time()

# Global state
bot_state = {
    "status": "starting",
    "last_heartbeat": None,
    "firefox_pid": None,
}

# ================================
# LIGHTWEIGHT SYSTEM STATS
# ================================
def get_system_stats():
    """Lightweight function to get CPU, RAM, and Uptime without external heavy libraries."""
    stats = {
        "cpu_load_1_5_15": [0, 0, 0],
        "ram_total_mb": 0,
        "ram_free_mb": 0,
        "system_uptime_seconds": 0,
        "bot_uptime_seconds": int(time.time() - BOT_START_TIME)
    }

    # Get CPU Load (1, 5, 15 minute averages)
    try:
        if hasattr(os, 'getloadavg'):
            stats["cpu_load_1_5_15"] = list(os.getloadavg())
    except:
        pass

    # Get RAM usage natively from Linux /proc/meminfo (Zero dependency overhead)
    try:
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                if line.startswith('MemTotal:'):
                    stats["ram_total_mb"] = round(int(line.split()[1]) / 1024, 2)
                elif line.startswith('MemAvailable:') or line.startswith('MemFree:'):
                    stats["ram_free_mb"] = round(int(line.split()[1]) / 1024, 2)
                    if line.startswith('MemAvailable:'):
                        break # MemAvailable is more accurate if present
    except:
        pass

    # Get System Uptime
    try:
        with open('/proc/uptime', 'r') as f:
            stats["system_uptime_seconds"] = float(f.readline().split()[0])
    except:
        pass

    return stats

# ================================
# INTERNAL HTTP SERVER
# ================================
class InternalAPIHandler(BaseHTTPRequestHandler):
    """HTTP handler for extension -> bot communication."""

    def log_message(self, format, *args):
        pass  # Suppress default logging

    def _send_json_response(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            body = self.rfile.read(content_length)
            return json.loads(body.decode())
        return {}

    def do_GET(self):
        if self.path == "/health":
            self._send_json_response({
                "status": bot_state["status"],
                "last_heartbeat": bot_state["last_heartbeat"],
                "firefox_pid": bot_state["firefox_pid"],
            })
        elif self.path == "/stats":
            self._send_json_response(get_system_stats())
        else:
            self._send_json_response({"error": "Not found"}, status=404)

    def do_POST(self):
        if self.path == "/heartbeat":
            bot_state["last_heartbeat"] = datetime.now().isoformat()
            bot_state["status"] = "running"
            self._send_json_response({"ok": True})
            print(f"[INTERNAL API] ♥ Heartbeat received", flush=True)

        elif self.path == "/restart":
            reason = "extension requested"
            try:
                body = self._read_json_body()
                reason = body.get("reason", reason)
            except:
                pass

            print(f"\n{'='*60}", flush=True)
            print(f"[INTERNAL API] 🔄 RESTART REQUESTED: {reason}", flush=True)
            print(f"[INTERNAL API] 🛑 Terminating main process to force Heroku container restart...", flush=True)
            print(f"{'='*60}\n", flush=True)

            self._send_json_response({"restart_scheduled": True})
            threading.Thread(target=self._trigger_restart, daemon=True).start()

        else:
            self._send_json_response({"error": "Not found"}, status=404)

    def _trigger_restart(self):
        time.sleep(2)
        print("[INTERNAL API] 🔌 Exiting immediately...", flush=True)
        # os._exit kills the process violently without cleanup handlers,
        # ensuring the container truly dies and Heroku triggers a fresh boot.
        os._exit(1)


def run_internal_server():
    server = HTTPServer((INTERNAL_SERVER_HOST, INTERNAL_SERVER_PORT), InternalAPIHandler)
    server.serve_forever()


def start_internal_server():
    server_thread = threading.Thread(target=run_internal_server, daemon=True)
    server_thread.start()
    print(f"[INTERNAL SERVER] 🌐 Started on {INTERNAL_SERVER_HOST}:{INTERNAL_SERVER_PORT}", flush=True)

# ================================
# FIREFOX POLICIES SETUP
# ================================
def setup_firefox_policies():
    """Creates the policies.json file to completely disable the welcome screen and telemetry."""
    print("=" * 60, flush=True)
    print("[POLICY SETUP] Creating enterprise policies.json...", flush=True)
    print("=" * 60, flush=True)

    policies = {
        "policies": {
            "DisableTelemetry": True,
            "DisableFirefoxStudies": True,
            "DisableProfileTutorial": True,
            "DisableFirefoxAccounts": True,
            "DontCheckDefaultBrowser": True,
            "OverrideFirstRunPage": "",
            "OverridePostUpdatePage": "",
            "CaptivePortal": False
        }
    }

    # Standard installation paths for Firefox/Developer Edition in Linux containers
    paths = [
        "/usr/lib/firefox/distribution",
        "/usr/lib/firefox-developer-edition/distribution",
        "/etc/firefox/policies"
    ]

    for path in paths:
        try:
            os.makedirs(path, exist_ok=True)
            policy_file = os.path.join(path, "policies.json")
            with open(policy_file, "w") as f:
                json.dump(policies, f, indent=4)
            print(f"[POLICY SETUP] ✓ Wrote policies to {policy_file}", flush=True)
        except Exception as e:
            print(f"[POLICY SETUP] ⚠️ Could not write to {path} (might need root permissions): {e}", flush=True)
    print("=" * 60, flush=True)

# ================================
# SETTINGS INJECTION HELPERS
# ================================
def _parse_env_bool(value):
    """Parse a Heroku config var string into True/False, or None if unset/invalid."""
    if value is None:
        return None
    v = str(value).strip().lower()
    if v in ("true", "1", "yes", "on"):
        return True
    if v in ("false", "0", "no", "off"):
        return False
    return None

def _parse_env_drops(value):
    """Parse the DROPS config var - accepts JSON array or comma-separated list."""
    if value is None:
        return None
    v = str(value).strip()
    if not v:
        return None
    # Try JSON first (this is what heroku_deploy_api.py writes)
    try:
        parsed = json.loads(v)
        if isinstance(parsed, list):
            return [str(x) for x in parsed]
    except Exception:
        pass
    # Fallback: comma-separated
    return [item.strip() for item in v.split(",") if item.strip()]

def _js_literal(value):
    """Render a Python value as a JavaScript literal (string / bool / array / null)."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    # String
    return json.dumps(str(value), ensure_ascii=False)

def inject_hardcoded_constant(content, const_name, js_literal_value):
    """
    Replace the `const <const_name> = ...;` line in the claimer script with the
    supplied JS-literal value. Falls through unchanged if the constant isn't found.
    """
    pattern = r"const\s+" + re.escape(const_name) + r"\s*=\s*[^;]*;"
    replacement = f"const {const_name} = {js_literal_value};"
    new_content, count = re.subn(pattern, replacement, content, count=1)
    if count == 0:
        print(f"[EXTENSION SETUP] ⚠️ Could not find `const {const_name}` in claim.js — skipping.", flush=True)
        return content
    return new_content

# ================================
# EXTENSION SETUP
# ================================
def prepare_sideload_extension():
    """Zips the claimer folder and places it in the profile's extension directory."""
    print("=" * 60, flush=True)
    print("[EXTENSION SETUP] Preparing extension for sideloading...", flush=True)
    print("=" * 60, flush=True)

    if not os.path.exists(EXTENSION_DIR):
        print(f"[EXTENSION SETUP] ❌ ERROR: Directory {EXTENSION_DIR} not found!", flush=True)
        sys.exit(1)

    # --- START: SESSION TOKEN + SETTINGS INJECTION ---
    claim_js_path = os.path.join(EXTENSION_DIR, "claim.js")
    if os.path.exists(claim_js_path):
        session_token = os.environ.get("SESSION_TOKEN", "")

        # Read the raw config-var values (all optional - unset = keep claimer defaults)
        currency_raw = os.environ.get("CURRENCY")
        vault_raw = os.environ.get("VAULT")
        process_all_raw = os.environ.get("PROCESS_ALL")
        drops_raw = os.environ.get("DROPS")

        # Normalize into real Python values (None = leave as-is / claimer default)
        currency_val = currency_raw.strip() if currency_raw and currency_raw.strip() else None
        vault_val = _parse_env_bool(vault_raw)
        process_all_val = _parse_env_bool(process_all_raw)
        drops_val = _parse_env_drops(drops_raw)

        print(f"[EXTENSION SETUP] Injecting session token into claim.js...", flush=True)
        print(f"[EXTENSION SETUP] Settings from env -> "
              f"CURRENCY={currency_val!r} VAULT={vault_val!r} "
              f"PROCESS_ALL={process_all_val!r} DROPS={drops_val!r}", flush=True)

        with open(claim_js_path, "r") as f:
            content = f.read()

        # Session token (same pattern as before)
        pattern = r"const HARDCODED_SESSION_TOKEN = '.*?';"
        replacement = f"const HARDCODED_SESSION_TOKEN = '{session_token}';"
        content = re.sub(pattern, replacement, content)

        # Claimer settings — only overwrite when the env var is set, otherwise keep
        # whatever default is in the file so the claimer falls back to saved/UI value.
        if currency_val is not None:
            content = inject_hardcoded_constant(content, "HARDCODED_CURRENCY", _js_literal(currency_val))
        if vault_val is not None:
            content = inject_hardcoded_constant(content, "HARDCODED_VAULT", _js_literal(vault_val))
        if process_all_val is not None:
            content = inject_hardcoded_constant(content, "HARDCODED_PROCESS_ALL", _js_literal(process_all_val))
        if drops_val is not None:
            content = inject_hardcoded_constant(content, "HARDCODED_DROPS", _js_literal(drops_val))

        with open(claim_js_path, "w") as f:
            f.write(content)

        print(f"[EXTENSION SETUP] ✓ Session token + settings injected.", flush=True)
    else:
        print(f"[EXTENSION SETUP] ⚠️ claim.js not found at {claim_js_path}. Skipping token injection.", flush=True)
    # --- END: SESSION TOKEN + SETTINGS INJECTION ---

    manifest_path = os.path.join(EXTENSION_DIR, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"[EXTENSION SETUP] ❌ ERROR: manifest.json not found in {EXTENSION_DIR}!", flush=True)
        sys.exit(1)

    try:
        with open(manifest_path, "r") as f:
            manifest = json.load(f)

        ext_id = manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
        if not ext_id:
            ext_id = "kust-claimer@local.host"
            print(f"[EXTENSION SETUP] ⚠️ No Gecko ID found. Using fallback: {ext_id}", flush=True)
    except Exception as e:
        print(f"[EXTENSION SETUP] ❌ ERROR reading manifest: {e}", flush=True)
        sys.exit(1)

    ext_dest_path = os.path.join(PROFILE_DIR, "extensions")
    os.makedirs(ext_dest_path, exist_ok=True)

    xpi_file = os.path.join(ext_dest_path, f"{ext_id}.xpi")

    with zipfile.ZipFile(xpi_file, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(EXTENSION_DIR):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, EXTENSION_DIR)
                zipf.write(file_path, arcname)

    print(f"[EXTENSION SETUP] ✓ Extension packed and sideloaded: {ext_id}.xpi", flush=True)
    print("=" * 60, flush=True)

def main():
    print("\n" + "=" * 60, flush=True)
    print("🤖 BOT STARTING", flush=True)
    print("=" * 60, flush=True)
    print(f"Working Directory: {WORKDIR}", flush=True)
    print(f"Profile Directory: {PROFILE_DIR}", flush=True)
    print(f"Internal API: http://{INTERNAL_SERVER_HOST}:{INTERNAL_SERVER_PORT}", flush=True)
    print(f"Mirror Site: {MIRROR_SITE}", flush=True)
    print(f"Target URL: {TARGET_URL}", flush=True)
    print("=" * 60 + "\n", flush=True)

    start_internal_server()
    bot_state["status"] = "initializing"

    print("[MAIN] Waiting for Xvfb...", flush=True)
    time.sleep(5)
    print("[MAIN] ✓ Xvfb should be ready", flush=True)

    # Build and inject the Firefox Enterprise Policies to nuke the welcome screen
    setup_firefox_policies()

    if not os.path.exists(PROFILE_DIR):
        os.makedirs(PROFILE_DIR)
        print("[MAIN] Created new profile directory.", flush=True)
    else:
        print("[MAIN] Using existing profile. Preserving cookies/session data.", flush=True)

    # Clean existing extensions out of the profile so we start fresh with the new zip
    ext_dest_path = os.path.join(PROFILE_DIR, "extensions")
    if os.path.exists(ext_dest_path):
        shutil.rmtree(ext_dest_path)
        print("[MAIN] Cleaned existing extensions before sideloading.", flush=True)

    prefs_path = os.path.join(PROFILE_DIR, "user.js")
    print(f"[MAIN] Writing Firefox preferences...", flush=True)

    # ==========================================
    # RANDOMIZATION ENGINE (STEALTH SPOOFING)
    # ==========================================
    firefox_versions = ["123.0", "124.0", "125.0", "126.0", "127.0", "128.0"]
    selected_version = random.choice(firefox_versions)
    REAL_UA = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:{selected_version}) Gecko/20100101 Firefox/{selected_version}"

    gpus = [
        ("NVIDIA Corporation", "NVIDIA GeForce RTX 3060"),
        ("NVIDIA Corporation", "NVIDIA GeForce RTX 3070"),
        ("NVIDIA Corporation", "NVIDIA GeForce RTX 3080"),
        ("NVIDIA Corporation", "NVIDIA GeForce RTX 4070"),
        ("Advanced Micro Devices, Inc.", "AMD Radeon RX 6700 XT"),
        ("Advanced Micro Devices, Inc.", "AMD Radeon RX 6800 XT")
    ]
    gpu_vendor, gpu_renderer = random.choice(gpus)

    cores = random.choice([4, 6, 8, 12, 16])
    ram = random.choice([8, 16, 32])

    print(f"[MAIN] 🎭 Spoofing Hardware: {cores} Cores | {ram}GB RAM | {gpu_renderer}", flush=True)
    print(f"[MAIN] 🎭 Spoofing User-Agent: {REAL_UA}", flush=True)

    prefs_content = f"""
    // Extension logic
    user_pref("xpinstall.signatures.required", false);
    user_pref("extensions.autoDisableScopes", 0);
    user_pref("extensions.enabledScopes", 15);
    user_pref("extensions.startupScanScopes", 15);

    // Disable First-Run, Terms, and Telemetry Prompts
    user_pref("datareporting.healthreport.service.firstRun", false);
    user_pref("datareporting.policy.dataSubmissionEnabled", false);
    user_pref("datareporting.policy.dataSubmissionPolicyAcceptedVersion", 2);
    user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
    user_pref("browser.aboutwelcome.enabled", false);
    user_pref("browser.rights.3.shown", true);
    user_pref("browser.EULA.override", true);
    user_pref("browser.EULA.3.accepted", true);

    // Anti-detection & Hardware Spoofing
    user_pref("dom.webdriver.enabled", false);
    user_pref("usePrivilegedMozillaProcess", true);
    user_pref("privacy.resistFingerprinting", false);

    // Hardware Fixes (RAM & CPU Cores)
    user_pref("dom.maxHardwareConcurrency", {cores});
    user_pref("dom.processorCoreCount", {cores});
    user_pref("dom.deviceMemory", {ram});

    // Hardware Rendering Spoof
    user_pref("webgl.enable-debug-renderer-info", true);
    user_pref("webgl.renderer-string-override", "{gpu_renderer}");
    user_pref("webgl.vendor-string-override", "{gpu_vendor}");
    user_pref("webgl.force-enabled", true);
    user_pref("webgl.disabled", false);

    // Fix Platform Mismatch (Screamer Fix: Sets navigator.platform to Win32)
    user_pref("general.useragent.override", "{REAL_UA}");
    user_pref("general.platform.override", "Win32");
    user_pref("general.appversion.override", "5.0 (Windows NT 10.0; Win64; x64)");
    user_pref("general.oscpu.override", "Windows NT 10.0; Win64; x64");

    // Silence Remote Security errors
    user_pref("security.remote_settings.intermediates.enabled", false);
    user_pref("security.remote_settings.crlite_filters.enabled", false);
    user_pref("app.normandy.enabled", false);
    user_pref("app.shield.optoutstudies.enabled", false);

    // Resolution & UI consistency
    user_pref("layout.css.devPixelsPerPx", "1.0");

    // Developer mode / Debugging
    user_pref("devtools.chrome.enabled", true);
    user_pref("extensions.logging.enabled", true);
    user_pref("browser.dom.window.dump.enabled", true);

    // STARTUP
    user_pref("browser.startup.homepage", "{TARGET_URL}");
    user_pref("browser.startup.page", 1);
    user_pref("browser.startup.homepage_override.mstone", "ignore");
    """

    with open(prefs_path, "w") as f:
        f.write(prefs_content)
    print("[MAIN] ✓ Preferences written.", flush=True)

    cmd = [
        "firefox",
        "--display=:0",
        f"--profile={PROFILE_DIR}",
        "--no-remote",
        "--no-sandbox"
    ]

    custom_env = {
        **os.environ,
        "DISPLAY": ":0",
        "MOZ_FORCE_HWACCEL": "1",
        "LIBGL_ALWAYS_SOFTWARE": "0",
        "GDK_BACKEND": "x11"
    }

    # ==========================================
    # PREPARE AND LOAD EXTENSION
    # ==========================================
    print("\n" + "=" * 60, flush=True)
    print("[MAIN] 🧩 Preparing and loading the extension...", flush=True)
    print("=" * 60, flush=True)

    prepare_sideload_extension()

    print("\n" + "=" * 60, flush=True)
    print("[MAIN] 🚀 Launching Firefox WITH extension...", flush=True)
    print("=" * 60, flush=True)
    print(f"[MAIN] Firefox command: {' '.join(cmd)}", flush=True)

    process = subprocess.Popen(cmd, env=custom_env)

    bot_state["firefox_pid"] = process.pid
    bot_state["status"] = "running"

    print("\n" + "=" * 60, flush=True)
    print("🔥 FIREFOX LAUNCHED SUCCESSFULLY (WITH EXTENSION)", flush=True)
    print("=" * 60, flush=True)

    try:
        counter = 0
        while True:
            time.sleep(60)
            counter += 1
            if process.poll() is not None:
                print(f"[MAIN] ⚠️ Firefox process ended with code: {process.returncode}", flush=True)
                break
            print(f"[MAIN] Bot running for {counter} minute(s) - PID: {process.pid}", flush=True)
    except KeyboardInterrupt:
        print("\n[MAIN] Received interrupt signal, killing Firefox...", flush=True)
        process.kill()
        print("[MAIN] ✓ Firefox killed. Exiting.", flush=True)

if __name__ == "__main__":
    main()

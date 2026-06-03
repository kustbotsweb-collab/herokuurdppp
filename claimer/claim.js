// =============================================================================
// CHROME EXTENSION COMPATIBILITY LAYER
// These shims allow the Tampermonkey script to run natively in Chrome (MV3)
// =============================================================================

const unsafeWindow = window;
const GM_addStyle = (css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
};
const GM_getValue = (key, defaultValue) => {
    const value = localStorage.getItem(key);
    if (value === null) return defaultValue;
    try {
        return JSON.parse(value);
    } catch (e) {
        return value;
    }
};
const GM_setValue = (key, value) => {
    localStorage.setItem(key, JSON.stringify(value));
};
const GM_xmlhttpRequest = (details) => {
    const { method, url, headers, data, onload, onerror } = details;
    // Filter out headers that cause "Refused to set unsafe header" errors in Chrome
    // This prevents the debugger from pausing on exceptions.
    const safeHeaders = headers ? { ...headers } : {};
    
    const unsafeHeaders = ['Referer', 'Origin', 'User-Agent', 'Content-Length', 'Host', 'Connection', 'Cookie'];
    unsafeHeaders.forEach(header => delete safeHeaders[header]);
    
    fetch(url, {
        method: method || 'GET',
        headers: safeHeaders,
        body: data,
        mode: 'cors'
    })
    .then(async response => {
        const text = await response.text();
        if (onload) {
            onload({
                responseText: text,
                status: response.status,
                statusText: response.statusText,
                readyState: 4
            });
        }
    })
    .catch(error => {
        if (onerror) {
            onerror(error);
        }
    });
};

// =============================================================================
// ORIGINAL SCRIPT STARTS HERE
// =============================================================================

// ==UserScript==
// @name         kust-code-claimer-lite
// @namespace    http://tampermonkey.net/
// @version      2.5-lite
// @description  Lightweight WebSocket listener & Auto Bonus Claimer for Stake.com (Optimized for VPS/XRDP)
// @author       Kust
// @match        *://*stake*/settings/offers*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      stake.com
// @connect      stake*.com
// @connect      stake*.in
// @connect      stake*.pet
// @connect      backend.tenopno.workers.dev
// @connect      kust-bots-129c234bbe49.herokuapp.com
// @connect      chat-auth-75bd02aa400a.herokuapp.com
// @connect      velocity.kustbotsweb.workers.dev
// @connect      code.hh123.site
// @connect      cdn.socket.io
// @connect      api.telegram.org
// @connect      code-dash-ba59fe89410e.herokuapp.com
// @connect      health.kustbotsweb.workers.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    // ================================
    // ⚙️ CONFIGURATION
    // ================================
    
    // =============================================================================
    // INTERNAL API CONFIGURATION (for bot health reporting)
    // =============================================================================
    const INTERNAL_API_URL = 'http://127.0.0.1:17532';
    
    // Track turnstile failure timestamp
    let turnstileFailureStart = null;
    let healthReported = false;
    
    // Internal API helper functions
    async function reportHealth(status, details = {}) {
        try {
            await fetch(`${INTERNAL_API_URL}/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, ...details })
            });
        } catch (e) {
            // Silent fail - internal server may not be running
        }
    }
    
    // =============================================================================
    // PAGE RESTART FUNCTION - Force browser refresh instead of API call
    // =============================================================================
    function requestRestart(reason) {
        console.log(`[PAGE RESTART] Triggering page refresh. Reason: ${reason}`);
        try {
            // Firefox-compatible force reload
            // Using true parameter to force reload from server (bypass cache)
            window.location.reload(true);
        } catch (e) {
            // Fallback for browsers that don't support the parameter
            window.location.reload();
        }
    }
    // =============================================================================
    
    // =============================================================================
    // TOKEN CACHE WATCHER - Separate watcher to detect stuck token generation
    // This runs independently every 15 seconds and checks if cache is empty for 30+ seconds
    // =============================================================================
    let tokenCacheEmptySince = null; // Timestamp when cache first became empty
    let tokenCacheWatcherInterval = null;
    
    function startTokenCacheWatcher() {
        // Prevent multiple watchers
        if (tokenCacheWatcherInterval) return;
        
        tokenCacheWatcherInterval = setInterval(() => {
            // Check if turnstileManager exists and is initialized
            if (!turnstileManager || !turnstileManager.initialized) {
                return;
            }
            
            const cacheLength = turnstileManager.tokenCache ? turnstileManager.tokenCache.length : 0;
            
            if (cacheLength === 0) {
                // Cache is empty
                if (tokenCacheEmptySince === null) {
                    // First time we notice it's empty
                    tokenCacheEmptySince = Date.now();
                    console.log('[TOKEN WATCHER] Cache empty, starting timer...');
                } else {
                    // Check how long it's been empty
                    const emptyDuration = Date.now() - tokenCacheEmptySince;
                    console.log(`[TOKEN WATCHER] Cache empty for ${Math.round(emptyDuration / 1000)} seconds`);
                    
                    if (emptyDuration >= 30000) {
                        // Empty for 30+ seconds - force refresh
                        console.log('[TOKEN WATCHER] Cache empty for 30+ seconds! Forcing page refresh...');
                        requestRestart('token_cache_empty_for_30_seconds');
                    }
                }
            } else {
                // Cache has tokens - reset the empty tracker
                if (tokenCacheEmptySince !== null) {
                    console.log('[TOKEN WATCHER] Cache recovered. Resetting timer.');
                }
                tokenCacheEmptySince = null;
            }
        }, 15000); // Check every 15 seconds
    }
    // =============================================================================
    
    // =============================================================================
    // HARDCODED SESSION TOKEN CONFIGURATION
    // =============================================================================
    // Set your session token here or via environment variable
    // Priority: HARDCODED_SESSION_TOKEN > localStorage > Cookie
    // To use: Set the token value below or set localStorage.setItem('HARDCODED_SESSION_TOKEN', 'your_token_here')
    const HARDCODED_SESSION_TOKEN = ''; // <-- PASTE YOUR SESSION TOKEN HERE (leave empty to use cookie)

    // Helper function to get hardcoded token from various sources
    function getHardcodedSessionToken() {
        // 1. Check direct hardcoded value first
        if (HARDCODED_SESSION_TOKEN && HARDCODED_SESSION_TOKEN.trim() !== '') {
            return HARDCODED_SESSION_TOKEN.trim();
        }
        
        // 2. Check localStorage for hardcoded token (can be set externally)
        const localStorageToken = localStorage.getItem('HARDCODED_SESSION_TOKEN');
        if (localStorageToken && localStorageToken.trim() !== '') {
            return localStorageToken.trim();
        }
        
        // 3. Check for environment variable style (window.__KUST_SESSION_TOKEN__)
        if (typeof window !== 'undefined' && window.__KUST_SESSION_TOKEN__) {
            return window.__KUST_SESSION_TOKEN__;
        }
        
        // No hardcoded token found
        return null;
    }
    // =============================================================================
    
    // --- DYNAMIC CONFIG START ---
    const REMOTE_CONFIG_URL = 'https://velocity-4ayz.onrender.com/';
    
    // Default fallbacks (Old hardcoded values) in case remote fetch fails
    let WS_SERVER_URL = 'wss://code-extract1-840a32439225.herokuapp.com/ws';
    let AUTH_CHECK_URL = 'https://code-auth11-4cc0b14f630c.herokuapp.com/check'; 
    // --- DYNAMIC CONFIG END ---

    // --- REGIONAL SERVER (HH123) CONFIG ---
    let HH123_URL = 'https://velocity-4ayz.onrender.com';
    const HH123_USERNAME = 'Kustx';
    const HH123_VERSION = '6.3.0';
    let hh123Socket = null;
    // --------------------------------------

    // --- HEALTH CHECK WEBSOCKET CONFIG ---
    let HEALTH_WS_URL = ''; // Populated from velocity config (healthUrl field)
    let healthWsSocket = null;
    let healthWsReconnectTimer = null;
    let healthWsReportInterval = null; // Interval for auto-reporting turnstile tokens
    // -------------------------------------

    const TG_BOT_TOKEN = '8068628711:AAEcw4c5oKw92bpYMI51L8_C8bOPNlN_BB0';
    const TG_CHAT_ID = '7618467489';
    const TURNSTILE_SITE_KEY = '0x4AAAAAAAGD4gMGOTFnvupz';
    
    // 🔧 CUSTOM BACKEND REPORTING URL - Raw JSON reports sent here (Dynamic from velocity config)
    let REPORTING_BACKEND_URL = 'https://code-dash1-a6f0feeb4e8b.herokuapp.com/api/claim-report';
    
    // 🌍 DYNAMIC MIRROR EXTRACTION
    // Extracts the exact origin (e.g., https://stake.com, https://stake.ac, https://stake.bet)
    const CURRENT_MIRROR = window.location.origin;
    const STAKE_API_URL = `${CURRENT_MIRROR}/_api/graphql`;
    const FC_USER_SETTINGS = 'FC_USER_SETTINGS';

    let webSocket = null;
    // Global reference for connection management
    let currentUsername = null;
    // Store username for periodic checks
    let currentSession = null;
    // Store session token
    let stakeApi = null;
    // API handler instance
    let isProcessing = true;
    
    // 🚀 GOD TIER OPTIMIZATION: Set instead of Array for O(1) lookups
    let claimedCodes = new Set();
    
    // Track codes currently being processed (to prevent duplicate processing)
    let processingCodes = new Set();

    // 🚦 RATE LIMITER: 1 direct claim request per 60 seconds
    let lastDirectClaimTime = 0;
    
    let rates = {};
    // Currency conversion rates
    let selectedCurrency = 'usdt';
    // Default currency
    let userSettings = null; // User preferences
    let consecutiveAuthFailures = 0;
    // Track consecutive authorization failures
    let authCheckInProgress = false;
    // Prevent multiple simultaneous auth checks

    // 🚀 GOD TIER OPTIMIZATION: Pre-allocated Header object
    let OPTIMIZED_HEADERS = null;

    // Log entry counter for unique IDs
    let logEntryCounter = 0;

    // Network Stats Globals (Main Server)
    let netStats = {
        ping: 0,
        jitter: 0,
        packetLoss: 0,
        history: [],
        lastCheck: 0
    };

    // Network Stats Globals (Regional Server)
    let netStatsReg = {
        ping: 0,
        jitter: 0,
        packetLoss: 0,
        history: [],
        lastCheck: 0
    };

    // ================================
    // 📊 CLAIM STATISTICS TRACKER
    // ================================
    let claimStats = {
        successCount: 0,
        failedCount: 0,
        totalClaimedValue: 0,
        recentClaims: [] // Store last 50 claims for reporting
    };

    // ================================
    // 🎨 LIGHTWEIGHT UI STYLES (VPS/XRDP OPTIMIZED)
    // ================================
    GM_addStyle(`
        /* Lightweight Base - No backdrop-filter, no heavy shadows, minimal animations */
        
        :root {
            --kust-bg: #0c0c0e;
            --kust-border: #333;
            --kust-accent: #00E701;
            --kust-text: #E0E0E0;
            --kust-text-dim: #858585;
            --kust-success: #00E701;
            --kust-error: #FF4D4D;
            --kust-warning: #FFC107;
            --kust-header-bg: #1a1a1a;
            --kust-settings-bg: #141418;
        }

        #kust-panel {
            position: fixed !important;
            top: 50px;
            right: 50px;
            width: 360px !important;
            height: 480px !important;
            background: var(--kust-bg);
            border: 1px solid var(--kust-border);
            border-radius: 8px;
            z-index: 2147483647 !important;
            display: flex !important;
            flex-direction: column;
            font-family: Arial, sans-serif;
            color: var(--kust-text);
            overflow: hidden;
            user-select: none;
            opacity: 1 !important;
        }

        /* SIMPLIFIED TOKEN OVERLAY - No 3D transforms */
        #kust-token-overlay {
            position: fixed;
            left: 0px;
            bottom: 40px;
            background: #141418;
            border: 1px solid var(--kust-border);
            border-left: 3px solid var(--kust-accent);
            padding: 12px 16px;
            border-radius: 0 8px 8px 0;
            display: flex;
            align-items: center;
            gap: 12px;
            z-index: 2147483646;
            font-family: Arial, sans-serif;
            color: white;
            user-select: none;
            cursor: help;
        }

        .token-icon {
            font-size: 20px;
        }

        .token-text {
            display: flex;
            flex-direction: column;
        }

        .token-label {
            font-size: 10px;
            font-weight: bold;
            color: var(--kust-text-dim);
            text-transform: uppercase;
        }

        .token-value {
            font-size: 18px;
            font-weight: bold;
            color: var(--kust-accent);
            font-family: monospace;
        }

        /* Overlay States - Simple color changes only */
        #kust-token-overlay.charging .token-value {
            color: var(--kust-warning);
        }
        #kust-token-overlay.charging {
            border-left-color: var(--kust-warning);
        }

        #kust-token-overlay.depleted .token-value {
            color: var(--kust-error);
        }
        #kust-token-overlay.depleted {
            border-left-color: var(--kust-error);
        }

        /* HEADER */
        .kust-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: var(--kust-header-bg);
            border-bottom: 1px solid var(--kust-border);
            cursor: grab;
        }

        .kust-header:active {
            cursor: grabbing;
        }

        .kust-header-left {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .kust-title {
            font-size: 13px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #fff;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .kust-title::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 6px;
            background: var(--kust-accent);
            border-radius: 50%;
        }

        .kust-username {
            font-size: 11px;
            color: var(--kust-text-dim);
            font-family: monospace;
            margin-left: 12px;
        }
        .kust-username.active {
            color: var(--kust-accent);
        }

        .kust-header-right {
            display: flex;
            align-items: center;
        }
        
        /* NETWORK BARS - Simple, no animations */
        .network-bars {
            display: flex;
            align-items: flex-end;
            gap: 2px;
            height: 14px;
            margin-right: 12px;
            padding-bottom: 2px;
            cursor: help;
        }
        
        .net-bar {
            width: 4px;
            border-radius: 1px;
            background: #444;
        }
        
        .net-bar:nth-child(1) { height: 5px; }
        .net-bar:nth-child(2) { height: 9px; }
        .net-bar:nth-child(3) { height: 13px; }
        
        /* Network Quality States - Simple solid colors */
        .net-good .net-bar {
            background: var(--kust-accent);
        }
        
        .net-med .net-bar:nth-child(1),
        .net-med .net-bar:nth-child(2) {
            background: var(--kust-warning);
        }
        .net-med .net-bar:nth-child(3) {
            background: #444;
        }
        
        .net-bad .net-bar:nth-child(1) {
            background: var(--kust-error);
        }
        .net-bad .net-bar:nth-child(2),
        .net-bad .net-bar:nth-child(3) {
            background: #444;
        }

        /* STATUS BADGE */
        .kust-status {
            font-size: 10px;
            font-weight: bold;
            padding: 3px 8px;
            border-radius: 4px;
            background: #222;
            border: 1px solid #444;
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .status-dot {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: #666;
        }

        .kust-status.connected {
            border-color: #004400;
            color: var(--kust-accent);
            background: #001a00;
        }
        .kust-status.connected .status-dot {
            background: var(--kust-accent);
        }

        .kust-status.disconnected {
            border-color: #440000;
            color: var(--kust-error);
            background: #1a0000;
        }
        .kust-status.disconnected .status-dot {
            background: var(--kust-error);
        }

        /* LOGS CONTAINER */
        .kust-body {
            flex: 1;
            padding: 12px;
            overflow-y: hidden;
            position: relative;
            display: flex;
            flex-direction: column;
        }

        #kust-logs {
            flex: 1;
            overflow-y: auto;
            padding-right: 4px;
        }

        /* SCROLLBAR - Simple */
        #kust-logs::-webkit-scrollbar { width: 4px; }
        #kust-logs::-webkit-scrollbar-track { background: #1a1a1a; }
        #kust-logs::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }

        /* LOG ENTRY - No animations */
        .log-entry {
            margin-bottom: 8px;
            padding: 10px;
            border-radius: 4px;
            background: #1a1a1a;
            border: 1px solid transparent;
            font-size: 11px;
            line-height: 1.4;
        }

        .log-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 3px;
            font-size: 9px;
            color: var(--kust-text-dim);
            font-family: monospace;
        }

        .log-content {
            font-weight: 500;
            word-break: break-all;
        }

        /* LOG VARIANTS - Simple border colors */
        .log-info { border-left: 2px solid #3b82f6; }
        .log-success {
            border-left: 2px solid var(--kust-success);
            background: #0a1a0a;
        }
        .log-error {
            border-left: 2px solid var(--kust-error);
            background: #1a0a0a;
        }
        .log-warning { border-left: 2px solid var(--kust-warning); }

        .code-highlight {
            font-family: monospace;
            color: var(--kust-accent);
            background: #0a1a0a;
            padding: 1px 4px;
            border-radius: 2px;
            font-weight: bold;
        }

        .value-highlight {
            color: #FFD700;
            font-weight: bold;
        }

        .retry-highlight {
            color: var(--kust-warning);
            font-weight: bold;
        }

        /* LATENCY BREAKDOWN STYLES */
        .latency-breakdown {
            font-size: 9px;
            color: var(--kust-text-dim);
            margin-top: 5px;
            font-family: monospace;
            border-top: 1px solid #333;
            padding-top: 5px;
        }

        .latency-item {
            display: inline-block;
            margin-right: 5px;
            margin-bottom: 2px;
            padding: 1px 4px;
            border-radius: 2px;
            background: #222;
        }

        .latency-network { color: #3b82f6; }
        .latency-turnstile { color: #a855f7; }
        .latency-api { color: #10b981; }
        .latency-total { color: #FFD700; font-weight: bold; }
        .latency-cache-hit { color: #00E701; background: #0a1a0a; }
        .latency-cache-miss { color: #FFC107; background: #1a1a0a; }

        /* SETTINGS BUTTON */
        .kust-settings-btn {
            width: 22px;
            height: 22px;
            border-radius: 4px;
            background: #333;
            border: 1px solid #444;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            margin-right: 8px;
        }

        .kust-settings-btn:hover {
            background: #444;
        }

        .kust-settings-btn svg {
            width: 12px;
            height: 12px;
            fill: var(--kust-text);
        }

        /* SETTINGS POPUP MODAL - No animations */
        #kust-settings-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 2147483648;
            display: none;
            align-items: center;
            justify-content: center;
        }

        #kust-settings-modal.open {
            display: flex;
        }

        .kust-settings-popup {
            width: 460px;
            max-height: 80vh;
            background: var(--kust-settings-bg);
            border-radius: 8px;
            border: 1px solid var(--kust-border);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .settings-popup-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid var(--kust-border);
            background: #1a1a1a;
        }

        .settings-popup-title {
            font-size: 14px;
            font-weight: bold;
            text-transform: uppercase;
            color: #fff;
        }

        .settings-popup-close {
            width: 24px;
            height: 24px;
            border-radius: 4px;
            background: #331111;
            border: 1px solid #441111;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }

        .settings-popup-close:hover {
            background: #441111;
        }

        .settings-popup-close svg {
            width: 14px;
            height: 14px;
            fill: var(--kust-text);
        }

        .settings-popup-content {
            flex: 1;
            padding: 16px;
            overflow-y: auto;
        }

        .settings-section {
            margin-bottom: 20px;
        }

        .settings-section-title {
            font-size: 12px;
            font-weight: bold;
            color: var(--kust-accent);
            margin-bottom: 12px;
            text-transform: uppercase;
        }

        .settings-option {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            padding: 8px 10px;
            border-radius: 4px;
            background: #1a1a1a;
        }

        .settings-option:hover {
            background: #222;
        }

        .settings-checkbox {
            width: 16px;
            height: 16px;
            appearance: none;
            background: #222;
            border: 1px solid #444;
            border-radius: 3px;
            margin-right: 10px;
            cursor: pointer;
        }

        .settings-checkbox:checked {
            background: var(--kust-accent);
            border-color: var(--kust-accent);
        }

        .settings-checkbox:checked::after {
            content: '✓';
            display: block;
            text-align: center;
            color: #000;
            font-size: 11px;
            font-weight: bold;
            line-height: 14px;
        }

        .settings-label {
            flex: 1;
            font-size: 12px;
            color: var(--kust-text);
            cursor: pointer;
        }

        .settings-select {
            width: 100%;
            padding: 8px 10px;
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 4px;
            color: var(--kust-text);
            font-family: Arial, sans-serif;
            font-size: 12px;
            margin-top: 8px;
        }

        .settings-select:hover {
            background: #222;
            border-color: #555;
        }

        .settings-select:focus {
            outline: none;
            border-color: var(--kust-accent);
        }

        .settings-select option {
            background: #1a1a1a;
            color: var(--kust-text);
            padding: 6px;
        }
        
        /* Network Stats Grid in Settings */
        .net-stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-bottom: 8px;
        }
        
        .net-stat-item {
            background: #0a0a0a;
            border: 1px solid #222;
            border-radius: 4px;
            padding: 8px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }
        
        .net-stat-label {
            font-size: 9px;
            color: var(--kust-text-dim);
            text-transform: uppercase;
            margin-bottom: 2px;
        }
        
        .net-stat-value {
            font-size: 12px;
            font-weight: bold;
            color: #fff;
            font-family: monospace;
        }
        
        .stat-good { color: var(--kust-success) !important; }
        .stat-warn { color: var(--kust-warning) !important; }
        .stat-bad { color: var(--kust-error) !important; }

        /* CLAIM STATS DISPLAY */
        .claim-stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-bottom: 8px;
        }

        .claim-stat-item {
            background: #0a0a0a;
            border: 1px solid #222;
            border-radius: 4px;
            padding: 8px;
            text-align: center;
        }

        .claim-stat-label {
            font-size: 8px;
            color: var(--kust-text-dim);
            text-transform: uppercase;
        }

        .claim-stat-value {
            font-size: 14px;
            font-weight: bold;
            font-family: monospace;
        }

        .claim-stat-value.success { color: var(--kust-success); }
        .claim-stat-value.failed { color: var(--kust-error); }

        /* LOADING ANIMATION - Simple */
        .loading-container {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .loading {
            width: 100px;
            height: 4px;
            background: #333;
            border-radius: 2px;
            overflow: hidden;
        }

        .loading-animation {
            width: 30%;
            height: 100%;
            background: var(--kust-accent);
        }

        /* SUBSCRIPTION PROMPT */
        #kust-subscription-overlay {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            width: 100%;
            padding: 20px;
            box-sizing: border-box;
            text-align: center;
            gap: 12px;
        }

        .sub-icon {
            font-size: 36px;
            margin-bottom: 4px;
        }

        .sub-title {
            font-size: 16px;
            font-weight: bold;
            color: var(--kust-text);
        }

        .sub-desc {
            font-size: 12px;
            color: var(--kust-text-dim);
            line-height: 1.4;
            max-width: 240px;
        }

        .sub-btn {
            margin-top: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 100%;
            padding: 12px;
            background: var(--kust-accent);
            color: #000;
            font-weight: bold;
            font-size: 12px;
            border-radius: 6px;
            text-decoration: none;
            text-transform: uppercase;
        }

        .sub-btn:hover {
            background: #00c400;
        }

        .sub-id {
            font-size: 10px;
            color: #444;
            margin-top: auto;
        }

        /* Server container labels */
        .server-container {
            flex: 1;
            background: #0a0a0a;
            border: 1px solid #222;
            border-radius: 4px;
            padding: 8px;
        }

        .server-label {
            font-size: 9px;
            text-align: center;
            margin-bottom: 6px;
            font-weight: bold;
            text-transform: uppercase;
        }

        .server-label.main { color: var(--kust-accent); }
        .server-label.regional { color: #3b82f6; }

        /* Horizontal rule */
        .settings-divider {
            border: 0;
            border-top: 1px solid #333;
            margin-bottom: 12px;
        }
    `);
    // ================================
    // 🛠️ UTILITIES
    // ================================
    function getCookie(name) {
        const cookie = `; ${document.cookie}`;
        const parts = cookie.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(";").shift();
        return null;
    }

    function formatTime() {
        const now = new Date();
        return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // ================================
    // 📝 LOGGING SYSTEM (With Edit Support)
    // ================================
    function addLog(msg, type = 'info', isCode = false, customId = null, latencyInfo = null) {
        const logContainer = document.getElementById("kust-logs");
        // Only add log if log container still exists
        if (!logContainer) return null;
        
        const entryId = customId || `log-${++logEntryCounter}`;
        
        // Check if we're updating an existing entry
        let entry = document.getElementById(entryId);
        const isNew = !entry;
        
        if (isNew) {
            entry = document.createElement("div");
            entry.id = entryId;
            entry.className = `log-entry log-${type}`;
        }
        
        const contentHtml = isCode
            ? msg.replace(/([A-Za-z0-9_-]+)/, '<span class="code-highlight">$1</span>')
            : msg;
        
        // Build latency breakdown HTML if provided
        let latencyHtml = '';
        if (latencyInfo) {
            latencyHtml = `
                <div class="latency-breakdown">
                    <span class="latency-item latency-network" title="Network latency (Round-trip to Stake API)">Net: ${latencyInfo.apiLatency}ms</span>
                    <span class="latency-item ${latencyInfo.turnstileCacheHit ? 'latency-cache-hit' : 'latency-cache-miss'}" title="Token retrieval">
                        ${latencyInfo.turnstileCacheHit ? 'Cache' : 'Miss'} (${latencyInfo.tokenLatency}ms)
                    </span>
                    <span class="latency-item latency-total" title="Total processing time">Total: ${latencyInfo.totalTime}ms</span>
                </div>
            `;
        }
            
        entry.innerHTML = `
            <div class="log-header">
                <span>${formatTime()}</span>
                <span style="opacity:0.7">${type.toUpperCase()}</span>
            </div>
            <div class="log-content">${contentHtml}</div>
            ${latencyHtml}
        `;
        
        if (isNew) {
            logContainer.appendChild(entry);
            // Auto-scroll logic
            if (logContainer.children.length > 50) {
                logContainer.removeChild(logContainer.firstChild);
            }
        }
        
        logContainer.scrollTop = logContainer.scrollHeight;
        return entryId;
    }

    function updateLog(entryId, msg, type = 'info', isCode = false, latencyInfo = null) {
        const entry = document.getElementById(entryId);
        if (!entry) return;
        
        // Update the class
        entry.className = `log-entry log-${type}`;
        
        const contentHtml = isCode
            ? msg.replace(/([A-Za-z0-9_-]+)/, '<span class="code-highlight">$1</span>')
            : msg;
        
        // Build latency breakdown HTML if provided
        let latencyHtml = '';
        if (latencyInfo) {
            latencyHtml = `
                <div class="latency-breakdown">
                    <span class="latency-item latency-network" title="Network latency (Round-trip to Stake API)">Net: ${latencyInfo.apiLatency}ms</span>
                    <span class="latency-item ${latencyInfo.turnstileCacheHit ? 'latency-cache-hit' : 'latency-cache-miss'}" title="Token retrieval">
                        ${latencyInfo.turnstileCacheHit ? 'Cache' : 'Miss'} (${latencyInfo.tokenLatency}ms)
                    </span>
                    <span class="latency-item latency-total" title="Total processing time">Total: ${latencyInfo.totalTime}ms</span>
                </div>
            `;
        }
            
        // Update time and content
        entry.innerHTML = `
            <div class="log-header">
                <span>${formatTime()}</span>
                <span style="opacity:0.7">${type.toUpperCase()}</span>
            </div>
            <div class="log-content">${contentHtml}</div>
            ${latencyHtml}
        `;
    }

    function updateStatus(status, text) {
        const statusEl = document.getElementById("kust-status-badge");
        const textEl = document.getElementById("kust-status-text");

        if (statusEl && textEl) {
            statusEl.className = `kust-status ${status}`;
            textEl.innerText = text;
        }
    }
    
    // ================================
    // 📊 AGGRESSIVE WSS LATENCY CHECK (MAIN SERVER)
    // ================================
    function activePingCheck() {
        // Wait for user to be initialized before pinging (requires auth param)
        // Also wait for WS_SERVER_URL to be populated
        if (!currentUsername || !WS_SERVER_URL) return;
        
        const start = performance.now();
        // Use a dummy user param to avoid interfering with main session, or use current user
        // Using random ping_check ID to keep it separate from main logic
        const pingUser = "ping_check_" + Math.floor(Math.random() * 1000);
        const wsUrl = `${WS_SERVER_URL}?user=${pingUser}`;
        
        try {
            // OPEN A REAL WEBSOCKET CONNECTION
            const tempWs = new WebSocket(wsUrl);
            // Timeout failsafe (Fixed 100% loss issue by increasing to 5000ms for slow handshakes)
            const timeout = setTimeout(() => {
                if(tempWs.readyState !== WebSocket.OPEN) {
                    tempWs.close();
                    handlePingResult(null, true); // Timeout = Packet Loss
                }
            }, 5000);
            tempWs.onopen = () => {
                clearTimeout(timeout);
                const end = performance.now();
                tempWs.close(); // Close immediately after handshake
                
                // DIVIDE BY 2 (One-Way Latency)
                const fullRtt = end - start;
                const latency = Math.round(fullRtt / 2);
                
                handlePingResult(latency, false);
            };

            tempWs.onerror = () => {
                clearTimeout(timeout);
                handlePingResult(null, true); // Error = Packet Loss
            };
        } catch (e) {
            handlePingResult(null, true);
        }
    }
    
    function handlePingResult(latency, isError) {
        if (isError) {
             // Less aggressive penalty (10%) to prevent false 100% spikes
             netStats.packetLoss = Math.min(100, netStats.packetLoss + 10);
        } else {
            // Success
            netStats.history.push(latency);
            if(netStats.history.length > 20) netStats.history.shift();
            
            // Calculate Jitter
            const subset = netStats.history.slice(-10);
            if (subset.length > 1) {
                const mean = subset.reduce((a, b) => a + b, 0) / subset.length;
                const variance = subset.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / subset.length;
                netStats.jitter = Math.round(Math.sqrt(variance));
            }
            
            // Packet Loss Decay (Recover faster)
            netStats.packetLoss = Math.max(0, netStats.packetLoss - 10);
            netStats.ping = latency;
        }
        updateNetworkUI();
    }

    // ================================
    // 📊 AGGRESSIVE LATENCY CHECK (REGIONAL HH123 SERVER)
    // ================================
    function activeRegionalPingCheck() {
        const start = performance.now();
        // Ping via HTTP Request to Engine.IO endpoint to measure latency
        GM_xmlhttpRequest({
            method: "GET",
            url: `${HH123_URL}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`,
            timeout: 5000,
            onload: () => {
                const end = performance.now();
                const latency = Math.round((end - start) / 2);
                handleRegionalPingResult(latency, false);
            },
            onerror: () => handleRegionalPingResult(null, true),
            ontimeout: () => handleRegionalPingResult(null, true)
        });
    }

    function handleRegionalPingResult(latency, isError) {
        if (isError) {
             netStatsReg.packetLoss = Math.min(100, netStatsReg.packetLoss + 10);
        } else {
            netStatsReg.history.push(latency);
            if(netStatsReg.history.length > 20) netStatsReg.history.shift();
            
            const subset = netStatsReg.history.slice(-10);
            if (subset.length > 1) {
                const mean = subset.reduce((a, b) => a + b, 0) / subset.length;
                const variance = subset.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / subset.length;
                netStatsReg.jitter = Math.round(Math.sqrt(variance));
            }
            
            netStatsReg.packetLoss = Math.max(0, netStatsReg.packetLoss - 10);
            netStatsReg.ping = latency;
        }
        
        // If Settings Modal is open, update live stats there too
        const settingsModal = document.getElementById('kust-settings-modal');
        if (settingsModal && settingsModal.classList.contains('open')) {
             updateSettingsStats();
        }
    }
    
    function updateNetworkUI() {
        const bars = document.getElementById('kust-network-bars');
        if (!bars) return;
        
        // Reset classes
        bars.className = 'network-bars';
        // THRESHOLDS: 
        // Green: 0-250ms
        // Yellow: 251-350ms
        // Red: 350ms+
        
        if (netStats.ping <= 280 && netStats.packetLoss < 10) {
            bars.classList.add('net-good');
            bars.title = `Excellent: ${netStats.ping}ms`;
        } else if (netStats.ping <= 380 && netStats.packetLoss < 30) {
            bars.classList.add('net-med');
            bars.title = `Moderate: ${netStats.ping}ms`;
        } else {
            bars.classList.add('net-bad');
            bars.title = `Poor: ${netStats.ping}ms (Loss: ~${netStats.packetLoss}%)`;
        }
        
        // If Settings Modal is open, update live stats there too
        const settingsModal = document.getElementById('kust-settings-modal');
        if (settingsModal && settingsModal.classList.contains('open')) {
             updateSettingsStats();
        }
    }
    
    function updateSettingsStats() {
        // --- MAIN SERVER STATS ---
        const latencyEl = document.getElementById('stat-latency');
        const jitterEl = document.getElementById('stat-jitter');
        const lossEl = document.getElementById('stat-loss');
        const serverEl = document.getElementById('stat-server');

        if(latencyEl) {
            latencyEl.innerText = `${netStats.ping}ms`;
            latencyEl.className = `net-stat-value ${netStats.ping <= 250 ? 'stat-good' : netStats.ping <= 350 ? 'stat-warn' : 'stat-bad'}`;
        }
        if(jitterEl) {
            jitterEl.innerText = `±${netStats.jitter}ms`;
            jitterEl.className = `net-stat-value ${netStats.jitter < 10 ? 'stat-good' : 'stat-warn'}`;
        }
        if(lossEl) {
            lossEl.innerText = `~${netStats.packetLoss}%`;
            lossEl.className = `net-stat-value ${netStats.packetLoss === 0 ? 'stat-good' : 'stat-bad'}`;
        }
        if(serverEl) {
            const isMainConnected = webSocket && webSocket.readyState === WebSocket.OPEN;
            serverEl.innerText = isMainConnected ? "ON" : "OFF";
            serverEl.className = `net-stat-value ${isMainConnected ? 'stat-good' : 'stat-bad'}`;
        }

        // --- REGIONAL SERVER STATS ---
        const latencyRegEl = document.getElementById('stat-latency-reg');
        const jitterRegEl = document.getElementById('stat-jitter-reg');
        const lossRegEl = document.getElementById('stat-loss-reg');
        const serverRegEl = document.getElementById('stat-server-reg');

        if(latencyRegEl) {
            latencyRegEl.innerText = `${netStatsReg.ping}ms`;
            latencyRegEl.className = `net-stat-value ${netStatsReg.ping <= 250 ? 'stat-good' : netStatsReg.ping <= 350 ? 'stat-warn' : 'stat-bad'}`;
        }
        if(jitterRegEl) {
            jitterRegEl.innerText = `±${netStatsReg.jitter}ms`;
            jitterRegEl.className = `net-stat-value ${netStatsReg.jitter < 10 ? 'stat-good' : 'stat-warn'}`;
        }
        if(lossRegEl) {
            lossRegEl.innerText = `~${netStatsReg.packetLoss}%`;
            lossRegEl.className = `net-stat-value ${netStatsReg.packetLoss === 0 ? 'stat-good' : 'stat-bad'}`;
        }
        if(serverRegEl) {
            const isRegConnected = hh123Socket && hh123Socket.connected;
            serverRegEl.innerText = isRegConnected ? "ON" : "OFF";
            serverRegEl.className = `net-stat-value ${isRegConnected ? 'stat-good' : 'stat-bad'}`;
        }

        // --- CLAIM STATS ---
        const successEl = document.getElementById('stat-success-count');
        const failedEl = document.getElementById('stat-failed-count');
        const totalValueEl = document.getElementById('stat-total-value');
        const successRateEl = document.getElementById('stat-success-rate');

        if(successEl) {
            successEl.innerText = claimStats.successCount;
            successEl.className = 'claim-stat-value success';
        }
        if(failedEl) {
            failedEl.innerText = claimStats.failedCount;
            failedEl.className = 'claim-stat-value failed';
        }
        if(totalValueEl) {
            totalValueEl.innerText = `$${claimStats.totalClaimedValue.toFixed(2)}`;
        }
        if(successRateEl) {
            const total = claimStats.successCount + claimStats.failedCount;
            const rate = total > 0 ? ((claimStats.successCount / total) * 100).toFixed(1) : 0;
            successRateEl.innerText = `${rate}%`;
            successRateEl.className = `claim-stat-value ${rate >= 50 ? 'success' : 'failed'}`;
        }
    }

    // ================================
    // ⚡ TOKEN OVERLAY TRACKER
    // ================================
    function updateTokenUI() {
        const overlayEl = document.getElementById('kust-token-overlay');
        const countEl = document.getElementById('kust-token-count');
        
        // Ensure UI and Turnstile Manager exist
        if (!overlayEl || !countEl || !turnstileManager) return;

        // Get current token count and max capacity
        const count = turnstileManager.tokenCache.length;
        const max = turnstileManager.maxCacheSize;
        const isGenerating = turnstileManager.isGenerating;

        // Update the text
        countEl.innerText = `${count}/${max}`;

        // Update state classes
        if (count === 0) {
            overlayEl.className = 'depleted';
            overlayEl.title = 'Tokens Depleted! Waiting for generation...';
        } else if (isGenerating) {
            overlayEl.className = 'charging';
            overlayEl.title = 'Generating new tokens...';
        } else {
            overlayEl.className = '';
            overlayEl.title = 'Bypass Tokens Ready';
        }
    }

    function updateUsername(name) {
        const userEl = document.getElementById("kust-username");
        if (userEl) {
            userEl.innerText = name;
            userEl.classList.add('active');
        }
    }

    function showLoading() {
        const panel = document.getElementById("kust-panel");
        if (!panel) return;

        // Remove existing loading if any
        const existingLoading = panel.querySelector('.loading-container');
        if (existingLoading) existingLoading.remove();

        const loadingContainer = document.createElement("div");
        loadingContainer.className = "loading-container";
        loadingContainer.innerHTML = `
            <div class="loading">
                <div class="loading-animation"></div>
            </div>
        `;
        panel.appendChild(loadingContainer);
    }

    function hideLoading() {
        const loadingContainer = document.querySelector('.loading-container');
        if (loadingContainer) {
            loadingContainer.remove();
        }
    }

    /**
     * Replaces log panel content with a PREMIUM subscription prompt.
     */
    function showSubscriptionPrompt() {
        const bodyEl = document.querySelector('.kust-body');
        if (!bodyEl) return;

        // Prevent re-rendering if already showing
        if(document.getElementById('kust-subscription-overlay')) return;
        // Clear existing content safely
        bodyEl.innerHTML = `
            <div id="kust-subscription-overlay">
                <div class="sub-icon">🔒</div>
                <div class="sub-title">Access Restricted</div>
                <div class="sub-desc">
                    Your premium subscription has expired or is invalid. Renew to continue claiming.
                </div>
                <a href="https://t.me/kustchatbot" target="_blank" class="sub-btn">
                    <span>Get Access Now</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </a>
                <div class="sub-id">
                    ID: <span style="font-family: monospace;">${currentUsername || 'UNKNOWN'}</span>
                </div>
            </div>
        `;
        updateStatus("disconnected", "Sub Expired");
    }

    /**
     * Restore the logs view when subscription is re-validated.
     */
    function restoreLogsView() {
        const bodyEl = document.querySelector('.kust-body');
        if (bodyEl && document.getElementById('kust-subscription-overlay')) {
            bodyEl.innerHTML = `
                <div id="kust-logs"></div>
            `;
            addLog("Subscription Verified. Welcome back!", "success");
        }
    }

    // ================================
    // 📢 RAW JSON REPORTING TO CUSTOM BACKEND
    // ================================
    function reportToBackend(reportData) {
        // Send raw JSON to custom backend interface
        GM_xmlhttpRequest({
            method: "POST",
            url: REPORTING_BACKEND_URL,
            headers: { 
                "Content-Type": "application/json"
            },
            data: JSON.stringify(reportData),
            onload: (res) => {
                // Silent success - backend received the report
            },
            onerror: (e) => {
                // Silent error to prevent UI spam
            }
        });
    }

    // ================================
    // 🔄 TURNSTILE TOKEN MANAGEMENT (Improved)
    // ================================
    class TurnstileManager {
        constructor() {
            this.siteKey = TURNSTILE_SITE_KEY;
            this.widgetId = null;
            this.tokenCache = [];
            this.maxCacheSize = 8; 
            this.initialized = false;
            this.tokenTimeout = 2.6 * 60 * 1000; // 2.6 mins
            this.refreshThreshold = 60 * 1000; // 60 seconds before expiration
            this.maintenanceTimer = null;
            this.maintenanceInterval = 1000 + Math.floor(Math.random() * 1000); // 1s-2s to add variation across clients
            this.isGenerating = false;
            this.isMaintaining = false; // Prevents concurrent overlapping requests causing 600010 and "already rendered" issues
            this.consecutiveFailures = 0; // Track consecutive failures
        }

        // Helper to map annoying error codes to human-readable text
        getHumanReadableError(error) {
            const errStr = String(error);
            if (errStr.includes('600010')) return "Cloudflare Timeout / Rate Limit (600010)";
            if (errStr.includes('110200')) return "Invalid/Expired Token Parameter (110200)";
            if (errStr.includes('300030')) return "Challenge Execution Failed (300030)";
            if (errStr.includes('timeout') || errStr.toLowerCase().includes('timeout')) return "Challenge Timeout";
            return `Turnstile Error (${errStr})`;
        }

        async initialize() {
            if (this.initialized) return;
            try {
                await this.loadTurnstileScript();
                if (!unsafeWindow.turnstile) {
                    throw new Error('Turnstile unavailable');
                }
                this.initialized = true;
                addLog('Event Manager initialized', 'success');

                // Generate initial token immediately, do not delay
                this.generateCacheToken();
                
                // Start token maintenance immediately
                this.startTokenMaintenance();
            } catch (error) {
                addLog(`Failed to initialize Turnstile: ${error.message}`, 'error');
            }
        }

        async loadTurnstileScript() {
            return new Promise((resolve, reject) => {
                if (typeof unsafeWindow.turnstile !== 'undefined') {
                    resolve();
                    return;
                }

                const script = document.createElement('script');
                script.id = 'turnstile-scripts';
                script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
                script.type = 'application/javascript';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        createTurnstileContainer() {
            // Check if container already exists and actively destroy it to prevent Cloudflare "already rendered" conflicts
            let existingContainer = document.getElementById('kust-turnstile-container');
            if (existingContainer) {
                existingContainer.remove();
            }

            const container = document.createElement('div');
            container.id = 'kust-turnstile-container';
            container.style.position = 'fixed';
            container.style.top = '-9999px';
            container.style.left = '-9999px';
            container.style.width = '0px';
            container.style.height = '0px';
            container.style.overflow = 'hidden';
            document.body.appendChild(container);
            return container;
        }

        async createToken() {
            this.isGenerating = true;
            return new Promise((resolve, reject) => {
                try {
                    const container = this.createTurnstileContainer();
                    const config = {
                        sitekey: this.siteKey,
                        theme: 'dark',
                        callback: (token) => {
                            this.isGenerating = false;
                            this.consecutiveFailures = 0; // Reset on success
                            turnstileFailureStart = null; // Clear failure timestamp
                            resolve(token);
                        },
                        'error-callback': (error) => {
                            this.isGenerating = false;
                            this.consecutiveFailures++;
                            this.checkTurnstileFailure();
                            reject(error);
                        },
                        'timeout-callback': () => {
                            this.isGenerating = false;
                            this.consecutiveFailures++;
                            this.checkTurnstileFailure();
                            reject('Get token timeout.');
                        }
                    };

                    this.widgetId = unsafeWindow.turnstile.render(container, config);
        
                } catch (error) {
                    this.isGenerating = false;
                    this.consecutiveFailures++;
                    this.checkTurnstileFailure();
                    reject(error);
                }
            });
        }

        // Check if turnstile has been failing for too long
        checkTurnstileFailure() {
            if (!turnstileFailureStart) {
                turnstileFailureStart = Date.now();
            }
            
            // If failing for more than 60 seconds, request restart
            const failureDuration = Date.now() - turnstileFailureStart;
            if (failureDuration > 60000) {
                addLog('Turnstile tokens failing for 1+ minute. Requesting restart...', 'error');
                requestRestart('turnstile_token_generation_failed');
            }
        }

        async generateCacheToken(retryCount = 0) {
            // If we are already generating on the initial call, prevent overlapping loops
            if (this.isGenerating && retryCount === 0) {
                return;
            }

            // Don't generate if cache is already full
            if (this.tokenCache.length >= this.maxCacheSize) {
                return;
            }

            try {
                let token = await this.createToken();
                const tokenData = {
                    token: token,
                    timestamp: Date.now()
                };
                // Double-check before adding to prevent overfilling
                if (this.tokenCache.length < this.maxCacheSize) {
                    this.tokenCache.push(tokenData);
                }
                this.remove();
            } catch (error) {
                const readableError = this.getHumanReadableError(error);
                this.remove();
                
                // Add retry logic with exponential backoff for specific errors like 600010
                if (retryCount < 3) {
                    if (this.tokenCache.length === 0) {
                        addLog(`Token generation failed (${readableError}). Retrying ${retryCount + 1}/3...`, 'warning');
                    }
                    await new Promise(resolve => setTimeout(resolve, (2000 * (retryCount + 1)) + Math.random() * 1000)); // 2s, 4s, 6s Backoff + Jitter
                    await this.generateCacheToken(retryCount + 1);
                } else {
                    if (this.tokenCache.length === 0) {
                        addLog(`Failed to generate token: ${readableError}`, 'error');
                    }
                }
            }
        }

        // INSTANT SYNC GRABBER - Returns {token, cacheHit, latency}
        getFastTokenWithMetrics() {
            const startTime = performance.now();
            const now = Date.now();
            while (this.tokenCache.length > 0) {
                const tokenData = this.tokenCache.shift();
                if (now - tokenData.timestamp < this.tokenTimeout) {
                    if (this.tokenCache.length < this.maxCacheSize && !this.isGenerating) {
                        this.generateCacheToken();
                    }
                    return {
                        token: tokenData.token,
                        cacheHit: true,
                        latency: Math.round(performance.now() - startTime)
                    };
                }
            }
            return null;
        }

        // Keep old method for backward compatibility
        getFastToken() {
            const result = this.getFastTokenWithMetrics();
            return result ? result.token : null;
        }

        async getTokenWithMetrics() {
            const startTime = performance.now();
            this.cleanExpiredTokens();
            if (this.tokenCache.length > 0) {
                let tokenData = this.tokenCache.shift();
                return {
                    token: tokenData.token,
                    cacheHit: true,
                    latency: Math.round(performance.now() - startTime)
                };
            }

            // Emergency generation with single retry if fallback fails
            try {
                const token = await this.createToken();
                this.remove();
                return {
                    token: token,
                    cacheHit: false,
                    latency: Math.round(performance.now() - startTime)
                };
            } catch (error) {
                this.remove();
                const readableError = this.getHumanReadableError(error);
                addLog(`Emergency token generation failed: ${readableError}. Retrying once...`, 'warning');
                try {
                    const retryToken = await this.createToken();
                    this.remove();
                    return {
                        token: retryToken,
                        cacheHit: false,
                        latency: Math.round(performance.now() - startTime)
                    };
                } catch(e) {
                    this.remove();
                    throw new Error(this.getHumanReadableError(e));
                }
            }
        }

        async getToken() {
            const result = await this.getTokenWithMetrics();
            return result.token;
        }

        cleanExpiredTokens() {
            const now = Date.now();
            this.tokenCache = this.tokenCache.filter(tokenData =>
                now - tokenData.timestamp < this.tokenTimeout
            );
        }

        async maintainTokens() {
            // Adding maintenance lock to prevent overlapping API calls causing DOM overlapping and CF panic
            if (!this.initialized || this.isMaintaining) {
                return;
            }

            this.isMaintaining = true;

            try {
                this.cleanExpiredTokens();
                // Check if any tokens are about to expire and refresh them
                const now = Date.now();
                for (let i = 0; i < this.tokenCache.length; i++) {
                    const tokenData = this.tokenCache[i];
                    const timeUntilExpiration = this.tokenTimeout - (now - tokenData.timestamp);

                    // If token is about to expire, replace it (with robust retries)
                    if (timeUntilExpiration <= this.refreshThreshold) {
                        let success = false;
                        let retry = 0;
                        
                        while (!success && retry < 2) {
                            try {
                                const newToken = await this.createToken();
                                this.tokenCache[i] = {
                                    token: newToken,
                                    timestamp: Date.now()
                                };
                                this.remove();
                                success = true;
                            } catch (error) {
                                retry++;
                                this.remove();
                                const readableError = this.getHumanReadableError(error);
                                if (retry >= 2) {
                                    addLog(`Token refresh error: ${readableError}`, 'error');
                                } else {
                                    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500)); // wait with jitter
                                }
                            }
                        }
                    }
                }

                // Generate new tokens if needed (fill the buffer)
                const tokensNeeded = this.maxCacheSize - this.tokenCache.length;
                if (tokensNeeded > 0) {
                    // Loop to spawn tokens. generateCacheToken itself handles internal retries.
                    for (let i = 0; i < tokensNeeded; i++) {
                         await this.generateCacheToken();
                         await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000)); // Delay between generation + jitter
                    }
                }
            } finally {
                // Free lock
                this.isMaintaining = false;
            }
        }

        startTokenMaintenance() {
            if (this.maintenanceTimer) {
                return;
            }

            this.maintenanceTimer = setInterval(() => {
                this.maintainTokens();
            }, this.maintenanceInterval);
        }

        stopTokenMaintenance() {
            if (this.maintenanceTimer) {
                clearInterval(this.maintenanceTimer);
                this.maintenanceTimer = null;
            }
        }

        remove() {
            if (this.widgetId !== null) {
                try {
                    unsafeWindow.turnstile.remove(this.widgetId);
                } catch (error) {
                    // silently fail cleanup 
                }
                this.widgetId = null;
            }
            // Double assure the DOM node is nuked
            let existing = document.getElementById('kust-turnstile-container');
            if (existing) {
                existing.remove();
            }
        }

        destroy() {
            this.stopTokenMaintenance();
            this.remove();
            this.tokenCache = [];
            this.initialized = false;
        }
    }

    // Initialize Turnstile Manager
    const turnstileManager = new TurnstileManager();
    let turnstileTokens = []; // For backward compatibility

    // ================================
    // 🔄 STAKE API HANDLER (Improved)
    // ================================
    class StakeAPIHandler {
        constructor(sessionToken, apiUrl) {
            this.sessionToken = sessionToken;
            this.apiUrl = apiUrl;
        }

        async makeRequest(query, variables, operationName, operationType = "query") {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: this.apiUrl,
                    headers: OPTIMIZED_HEADERS || {
                        "Content-Type": "application/json",
                        "x-access-token": this.sessionToken,
                        "x-operation-name": operationName,
                        "x-operation-type": operationType,
                        // DYNAMIC HEADERS: EXTRACTED MIRROR
                        "Origin": CURRENT_MIRROR,
                        "Referer": window.location.href
                    },
                    data: JSON.stringify({
                        operationName: operationName,
                        query: query,
                        variables: variables
                    }),
                    onload: (response) => {
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve(data);
                        } catch (error) {
                            reject(error);
                        }
                    },
                    onerror: (error) => {
                        reject(error);
                    }
                });
            });
        }

        async checkBonusCode(code) {
            const query = `
                query BonusCodeInformation($code: String!, $couponType: CouponType!) {
                    bonusCodeInformation(code: $code, couponType: $couponType) {
                        availabilityStatus
                        bonusValue
                    }
                }
            `;
            const variables = {
                code: code,
                couponType: "drop"
            };
            try {
                // Operation type is "query"
                const response = await this.makeRequest(query, variables, "BonusCodeInformation", "query");
                if (response.errors && response.errors.length > 0) {
                    return {
                        success: false,
                        error: response.errors[0].message
                    };
                }

                if (response.data && response.data.bonusCodeInformation) {
                    return {
                        success: true,
                        data: response.data.bonusCodeInformation
                    };
                }

                return {
                    success: false,
                    error: "Invalid response from API"
                };
            } catch (error) {
                return {
                    success: false,
                    error: error.message
                };
            }
        }

        async claimBonusCode(code, currency, turnstileToken) {
            const query = `
                mutation ClaimConditionBonusCode($code: String!, $currency: CurrencyEnum!, $turnstileToken: String!) {
                    claimConditionBonusCode(
                        code: $code
                        currency: $currency
                        turnstileToken: $turnstileToken
                    ) {
                        bonusCode {
                            id
                            code
                            __typename
                        }
                        amount
                        currency
                        user {
                            id
                            balances {
                                available {
                                    amount
                                    currency
                                    __typename
                                }
                                __typename
                            }
                            __typename
                        }
                        __typename
                    }
                }
        `;
            const variables = {
                code: code,
                currency: currency,
                turnstileToken: turnstileToken
            };
            try {
                // Operation type is "query" even though it's a mutation (matches working curl)
                const response = await this.makeRequest(query, variables, "ClaimConditionBonusCode", "query");
                if (response.errors && response.errors.length > 0) {
                    return {
                        success: false,
                        error: response.errors[0].message
                    };
                }

                if (response.data && response.data.claimConditionBonusCode) {
                    return {
                        success: true,
                        data: response.data.claimConditionBonusCode
                    };
                }

                return {
                    success: false,
                    error: "Invalid response from API"
                };
            } catch (error) {
                return {
                    success: false,
                    error: error.message
                };
            }
        }

        async getUserInfo() {
            const query = `
                query UserMeta($name: String, $signupCode: Boolean = false) {
                    user(name: $name) {
                        id
                        name
                        isMuted
                        isRainproof
                        isBanned
                        createdAt
                        campaignSet
                        selfExclude {
                            id
                            status
                            active
                            createdAt
                            expireAt
                        }
                        signupCode @include(if: $signupCode) {
                            id
                            code {
                                id
                                code
                            }
                        }
                    }
                }
            `;
            try {
                const response = await this.makeRequest(query, {}, "UserMeta", "query");
                if (response.errors && response.errors.length > 0) {
                    return {
                        success: false,
                        error: response.errors[0].message
                    };
                }

                if (response.data && response.data.user) {
                    return {
                        success: true,
                        data: response.data.user
                    };
                }

                return {
                    success: false,
                    error: "Invalid response from API"
                };
            } catch (error) {
                return {
                    success: false,
                    error: error.message
                };
            }
        }

        async getConversionRate() {
            const query = `
                query CurrencyNewConversionRate($displayCurrencies: [FiatCurrencyEnum!]!) {
                    info {
                        currencies {
                            name
                                values(displayCurrencies: $displayCurrencies) {
                                currency
                                rate
                            }
                        }
                        }
            }
            `;
            const variables = {
                displayCurrencies: ['usd', 'eur', 'ars', 'jpy', 'cad', 'clp', 'cny', 'dkk', 'ghs', 'idr', 'inr', 'kes', 'krw', 'mxn', 'ngn', 'pen', 'php', 'pln', 'rub', 'try', 'vnd']
            };
            try {
                const response = await this.makeRequest(query, variables, "CurrencyNewConversionRate", "query");
                if (response.errors && response.errors.length > 0) {
                    return {
                        success: false,
                        error: response.errors[0].message
                    };
                }

                if (response.data && response.data.info) {
                    return {
                        success: true,
                        data: response.data.info
                    };
                }

                return {
                    success: false,
                    error: "Invalid response from API"
                };
            } catch (error) {
                return {
                    success: false,
                    error: error.message
                };
            }
        }

        async createVaultDeposit(currency, amount) {
            const query = `
                mutation CreateVaultDeposit($currency: CurrencyEnum!, $amount: Float!) {
                    createVaultDeposit(currency: $currency, amount: $amount) {
                        id
                        amount
                        currency
                        user {
                            id
                            balances {
                                available {
                                    amount
                                    currency
                                }
                                vault {
                                    amount
                                    currency
                                }
                            }
                        }
                        __typename
                    }
                }
            `;
            const variables = {
                currency: currency,
                amount: amount
            };
            try {
                const response = await this.makeRequest(query, variables, "CreateVaultDeposit", "query");
                if (response.errors && response.errors.length > 0) {
                    return {
                        success: false,
                        error: response.errors[0].message
                    };
                }

                if (response.data && response.data.createVaultDeposit) {
                    return {
                        success: true,
                        data: response.data.createVaultDeposit
                    };
                }

                return {
                    success: false,
                    error: "Invalid response from API"
                };
            } catch (error) {
                return {
                    success: false,
                    error: error.message
                };
            }
        }
    }

    // ================================
    // 🕵️ USER DETECTION API
    // ================================
    async function getStakeUserFromAPI() {
        try {
            // Priority: HARDCODED_SESSION_TOKEN > localStorage > window.__KUST_SESSION_TOKEN__ > Cookie
            let sessionToken = getHardcodedSessionToken();
            
            // If no hardcoded token, fall back to cookie
            if (!sessionToken) {
                const sessionCookie = getCookie("session");
                if (!sessionCookie) {
                    addLog(`No session token found`, 'error');
                    return null;
                }
                sessionToken = sessionCookie;
            }
            
            // Store session for later use
            currentSession = sessionToken;
            // Initialize API handler
            stakeApi = new StakeAPIHandler(sessionToken, STAKE_API_URL);
            // Get user info
            const result = await stakeApi.getUserInfo();
            if (result.success && result.data && result.data.name) {
                const username = result.data.name;
                return username;
            } else {
                addLog(`${result.error || 'No user data in response'}`, 'error');
                return null;
            }
        } catch (error) {
            addLog(`Error fetching user from API: ${error.message}`, 'error');
            return null;
        }
    }

    // ================================
    // 🔐 AUTHORIZATION CHECK
    // ================================
    function checkAuthorization(username) {
        if (!username) {
            return Promise.resolve(false);
        }

        // Prevent multiple simultaneous auth checks
        if (authCheckInProgress) {
            return Promise.resolve(true);
            // Assume authorized if check is already in progress
        }

        authCheckInProgress = true;
        
        // UPDATED: Using dynamic AUTH_CHECK_URL variable
        const authUrl = `${AUTH_CHECK_URL}?user=@${username}`;

        // Only update status if we are currently disconnected (to avoid spamming "Authorizing" on active connections)
        const statusEl = document.getElementById("kust-status-text");
        if(statusEl && statusEl.innerText !== "Live Stream" && statusEl.innerText !== "UPLINK ACTIVE") {
            updateStatus("disconnected", "Authorizing...");
        }

        // GM_xmlhttpRequest is asynchronous
        return new Promise((resolve) => {
            // Add timeout to prevent hanging
            const timeoutId = setTimeout(() => {
                authCheckInProgress = false;
                addLog("Authorization check timed out", "warning");
                resolve(true); // Assume authorized on timeout to prevent false negatives
            }, 10000); // 10 second timeout

            GM_xmlhttpRequest({
                method: "GET",
                url: authUrl,
                timeout: 8000, // 8 second timeout for the request itself
                onload: (res) => {
                    clearTimeout(timeoutId);
                    authCheckInProgress = false;
                    try {
                        const response = JSON.parse(res.responseText);
                        if (response.exists === true) {
                            resolve(true); // Authorized
                        } else {
                            resolve(false);
                            // Not Authorized
                        }
                    } catch (e) {
                        addLog(`Authorization API error: ${e.message}`, "error");
                        resolve(false);
                    }
                },
                onerror: (error) => {
                    clearTimeout(timeoutId);
                    authCheckInProgress = false;
                    addLog("Network error while checking authorization.", "error");
                    // Don't kill connection on network error, assume authorized to prevent false negatives
                    resolve(true);
                },
                ontimeout: () => {
                    clearTimeout(timeoutId);
                    authCheckInProgress = false;
                    addLog("Authorization request timed out.", "warning");
                    resolve(true);
                    // Assume authorized on timeout
                }
            });
        });
    }

    // Function to determine error type from error message
    // Returns the specific error type based on the error message content
    function getErrorType(errorMessage) {
        const msg = (errorMessage || '').toLowerCase();
        
        // Check for bonusCodeInactive - code has been fully claimed
        if (msg.includes('bonuscodeinactive') || 
            msg.includes('code has been fully claimed') || 
            msg.includes('fully claimed') ||
            msg.includes('inactive')) {
            return 'bonusCodeInactive';
        }
        
        // Check for weeklyWagerRequirement
        if (msg.includes('weeklywagerrequirement') || 
            msg.includes('wager requirement')) {
            return 'weeklyWagerRequirement';
        }
        
        // Check for alreadyClaimed
        if (msg.includes('alreadyclaimed') || 
            msg.includes('codealreadyclaimed') || 
            msg.includes('codealreadyredeemed') || 
            msg.includes('already claimed') || 
            msg.includes('have already claimed') ||
            msg.includes('already redeemed')) {
            return 'alreadyClaimed';
        }
        
        // Check for withdrawError
        if (msg.includes('withdrawerror') || 
            msg.includes('withdraw error')) {
            return 'withdrawError';
        }
        
        // Check for emailUnverified
        if (msg.includes('emailunverified') || 
            msg.includes('email unverified')) {
            return 'emailUnverified';
        }
        
        // Check for kycLevelNotSufficient
        if (msg.includes('kyclevelnotsufficient') || 
            msg.includes('verification level') || 
            msg.includes('kyc')) {
            return 'kycLevelNotSufficient';
        }
        
        // Success marker
        if (msg.includes('claim_success')) {
            return 'CLAIM_SUCCESS';
        }
        
        // Unknown error
        return 'unknown';
    }

    // ================================
    // 🔄 UI FORM SUBMISSION LOGIC (FALLBACK)
    // ================================
    function processCodeViaUI(code) {
        // 1. Find form elements
        const codeInput = document.querySelector('input[data-testid="bonus-code"]');
        const submitButton = document.querySelector('button[data-testid="claim-drop"]');

        if (!codeInput || !submitButton) {
            addLog("UI: Bonus Code Form not found. Navigate to the Offers page.", "error");
            return;
        }

        addLog(`UI: Typing code ${code} and clicking Submit.`, "warning");
        try {
            // 2. Set value and dispatch events
            codeInput.value = code;
            codeInput.dispatchEvent(new Event('input', { bubbles: true }));
            codeInput.dispatchEvent(new Event('change', { bubbles: true }));
            // 3. Click submit (with short delay)
            setTimeout(() => {
                submitButton.click();
                addLog("UI: Submit button clicked. Waiting for modal...", "success");

                // 4. Wait for modal and click dismiss button
                setTimeout(() => {
                    const dismissButton = document.querySelector('button[data-testid="claim-bonus-dismiss"]');
                    if (dismissButton) {
                        dismissButton.click();
                        addLog("UI: Modal dismissed.", "info");
                    } else {
                        addLog("UI: Dismiss button not found.", "warning");
                    }
                }, 300); // Wait 0.3 seconds

            }, 300);
        } catch (e) {
            addLog(`UI Submission Error: ${e.message}`, "error");
        }
    }

    // ================================
    // 🚀 API LOGIC (Fully Optimized for Speed with Latency Tracking)
    // NO AUTO RETRY - Manual retry via "r-" prefix
    // ================================
    async function testBonusCode(code, isUncheck = false, wsReceiveTime = null, isRetry = false) {
        if (!code) return addLog("Empty code received", "error");
        
        // Calculate internal processing delay (time from WebSocket receive to processing start)
        const processingStartTime = performance.now();
        const internalDelay = wsReceiveTime ? Math.round(processingStartTime - wsReceiveTime) : 0;
        
        // Check if this code is already being processed (skip check if it's a retry)
        if (!isRetry && processingCodes.has(code)) {
            return; // Silently skip duplicate
        }
        
        // Only apply rate limits and add to claimedCodes if not a retry
        if (!isRetry) {
            claimedCodes.add(code);
        }
        processingCodes.add(code);

        // Determine if we need to check info API
        let requiresInfoCheck = false;
        
        if (!isRetry) {
            const now = Date.now();
            if (now - lastDirectClaimTime >= 60000) {
                // First code in 60s window - direct claim
                lastDirectClaimTime = now;
            } else {
                // Subsequent code in window - requires info check
                requiresInfoCheck = true;
            }
        }
        
        if (requiresInfoCheck) {
            const logId = addLog(`Checking availability for ${code}...`, "info");
            if (stakeApi) {
                try {
                    const infoRes = await stakeApi.checkBonusCode(code);
                    if (infoRes.success && infoRes.data && infoRes.data.availabilityStatus === "available") {
                        updateLog(logId, `Code ${code} is available! Proceeding to claim...`, "success");
                    } else {
                        const status = (infoRes.data && infoRes.data.availabilityStatus) ? infoRes.data.availabilityStatus : "Unavailable";
                        updateLog(logId, `Skipped ${code} (Status: ${status})`, "warning");
                        processingCodes.delete(code);
                        return; // Abort claim as code is not available
                    }
                } catch (e) {
                    updateLog(logId, `Info check failed for ${code}: ${e.message}`, "error");
                    processingCodes.delete(code);
                    return;
                }
            } else {
                // If stakeApi is not initialized somehow, just fail safe and abort
                processingCodes.delete(code);
                return;
            }
        } else {
            // 🔥 CALL INFO API FIRST - WITHOUT WAITING FOR RESPONSE (For stats, direct claim path only)
            if (stakeApi && !isRetry) {
                stakeApi.checkBonusCode(code).catch(() => {});
            }
        }

        // 1. INSTANT SYNC TOKEN GRAB WITH METRICS
        let tokenResult = turnstileManager.getFastTokenWithMetrics();

        if (tokenResult && tokenResult.token) {
            // FAST PATH: Token exists. Fire request in the current execution tick.
            const token = tokenResult.token;
            const turnstileCacheHit = tokenResult.cacheHit;
            const tokenLatency = tokenResult.latency;

            const payload = `{"operationName":"ClaimConditionBonusCode","variables":{"code":"${code}","currency":"${selectedCurrency}","turnstileToken":"${token}"},"query":"mutation ClaimConditionBonusCode($code: String!, $currency: CurrencyEnum!, $turnstileToken: String!) { claimConditionBonusCode(code: $code, currency: $currency, turnstileToken: $turnstileToken) { bonusCode { id code __typename } amount currency user { id balances { available { amount currency __typename } __typename } __typename } __typename } }"}`;

            // Record API call start time - this measures the actual network latency to Stake API
            const apiCallStartTime = performance.now();

            // Fire request instantly using OPTIMIZED_HEADERS
            const claimPromise = fetch(STAKE_API_URL, {
                method: 'POST',
                headers: OPTIMIZED_HEADERS,
                body: payload
            });

            // UI updates happen AFTER the request is on the network
            const logId = addLog(`${isRetry ? 'RETRY - ' : ''}Processing: ${code}...`, "info", true);

            // Handle the response asynchronously (non-blocking)
            claimPromise
                .then(r => r.json())
                .catch(e => ({ errors: [{ message: e.message }] }))
                .then(claimResponse => {
                    const apiCallEndTime = performance.now();
                    // API latency is the actual network round-trip time to Stake API
                    const apiLatency = Math.round(apiCallEndTime - apiCallStartTime);
                    const totalTime = Math.round(apiCallEndTime - processingStartTime);
                    
                    const latencyInfo = {
                        internalDelay,
                        turnstileCacheHit,
                        tokenLatency,
                        apiLatency,
                        totalTime
                    };
                    
                    handleClaimResponse(claimResponse, code, token, processingStartTime, logId, latencyInfo, wsReceiveTime, isRetry);
                });

        } else {
            // SLOW PATH: No token cache, fallback to async generation
            addLog(`Token cache empty! Falling back...`, "warning");
            const logId = addLog(`${isRetry ? 'RETRY - ' : ''}Processing: ${code}...`, "info", true);
            const tokenStartTime = performance.now();
            
            turnstileManager.getTokenWithMetrics().then(tokenResult => {
                const token = tokenResult.token;
                const turnstileCacheHit = tokenResult.cacheHit;
                const tokenLatency = Math.round(performance.now() - tokenStartTime);
                
                const payload = `{"operationName":"ClaimConditionBonusCode","variables":{"code":"${code}","currency":"${selectedCurrency}","turnstileToken":"${token}"},"query":"mutation ClaimConditionBonusCode($code: String!, $currency: CurrencyEnum!, $turnstileToken: String!) { claimConditionBonusCode(code: $code, currency: $currency, turnstileToken: $turnstileToken) { bonusCode { id code __typename } amount currency user { id balances { available { amount currency __typename } __typename } __typename } __typename } }"}`;
                
                const apiCallStartTime = performance.now();
                
                fetch(STAKE_API_URL, {
                    method: 'POST',
                    headers: OPTIMIZED_HEADERS,
                    body: payload
                })
                .then(r => r.json())
                .catch(e => ({ errors: [{ message: e.message }] }))
                .then(claimResponse => {
                    const apiCallEndTime = performance.now();
                    const apiLatency = Math.round(apiCallEndTime - apiCallStartTime);
                    const totalTime = Math.round(apiCallEndTime - processingStartTime);
                    
                    const latencyInfo = {
                        internalDelay,
                        turnstileCacheHit,
                        tokenLatency,
                        apiLatency,
                        totalTime
                    };
                    
                    handleClaimResponse(claimResponse, code, token, processingStartTime, logId, latencyInfo, wsReceiveTime, isRetry);
                });
            });
        }
    }

    async function handleClaimResponse(claimResponse, code, token, startTime, logId, latencyInfo, wsReceiveTime, isRetry = false) {
        const timeTaken = (performance.now() - startTime).toFixed(0);

        // Fix: Retry on invalid turnstile error
        if (claimResponse.errors && claimResponse.errors.length > 0 && claimResponse.errors[0].message === 'error.invalid_turnstile') {
            updateLog(logId, `Invalid Turnstile. Retrying...`, "warning", true);
            turnstileManager.tokenCache = []; 
            const tokenStartTime = performance.now();
            let newTokenResult = await turnstileManager.getTokenWithMetrics();
            
            const payload = `{"operationName":"ClaimConditionBonusCode","variables":{"code":"${code}","currency":"${selectedCurrency}","turnstileToken":"${newTokenResult.token}"},"query":"mutation ClaimConditionBonusCode($code: String!, $currency: CurrencyEnum!, $turnstileToken: String!) { claimConditionBonusCode(code: $code, currency: $currency, turnstileToken: $turnstileToken) { bonusCode { id code __typename } amount currency user { id balances { available { amount currency __typename } __typename } __typename } __typename } }"}`;
            
            const apiCallStartTime = performance.now();
            
            claimResponse = await fetch(STAKE_API_URL, {
                method: 'POST',
                headers: OPTIMIZED_HEADERS,
                body: payload
            }).then(r => r.json()).catch(e => ({ errors: [{ message: e.message }] }));
            
            const apiCallEndTime = performance.now();
            latencyInfo.apiLatency = Math.round(apiCallEndTime - apiCallStartTime);
            latencyInfo.turnstileCacheHit = false;
            latencyInfo.tokenLatency = Math.round(apiCallEndTime - tokenStartTime);
            latencyInfo.totalTime = Math.round(apiCallEndTime - startTime);
        }

        if (!claimResponse.errors && claimResponse.data && claimResponse.data.claimConditionBonusCode) {
            // SUCCESS
            const data = claimResponse.data.claimConditionBonusCode;
            
            // Update claim statistics
            claimStats.successCount++;
            claimStats.totalClaimedValue += parseFloat(data.amount) || 0;
            
            // Add to recent claims
            claimStats.recentClaims.push({
                username: currentUsername,
                code: code,
                status: 'SUCCESS',
                amount: data.amount,
                currency: data.currency,
                timestamp: new Date().toISOString(),
                latencyInfo: latencyInfo,
                isRetry: isRetry
            });
            if (claimStats.recentClaims.length > 50) claimStats.recentClaims.shift();
            
            updateLog(logId, `SUCCESS! Claimed ${code}! Bonus: ${data.amount} ${data.currency}${isRetry ? ' (MANUAL RETRY)' : ''}`, "success", true, latencyInfo);
            
            // Remove from processing set
            processingCodes.delete(code);
            
            if (userSettings && userSettings.vault) {
                stakeApi.createVaultDeposit(data.currency, data.amount).then(() => addLog(`Amount deposited to vault`, "success")).catch(() => {});
            }
            
            // Build raw JSON report for custom backend
            const reportData = { 
                username: currentUsername,
                code: code, 
                status: "SUCCESS", 
                message: "Claimed successfully", 
                amount: data.amount,
                currency: data.currency,
                isRetry: isRetry,
                latency: {
                    network: latencyInfo.apiLatency, // Actual API network latency
                    token: latencyInfo.tokenLatency,
                    cacheHit: latencyInfo.turnstileCacheHit,
                    total: latencyInfo.totalTime
                },
                data: data,
                timestamp: new Date().toISOString()
            };
            reportToBackend(reportData);
        } else {
            // FAILURE LOGIC - NO AUTO RETRY
            // Extract error message with proper fallbacks - handle all edge cases
            let failureReason = "Unknown error";
            
            if (claimResponse.errors && Array.isArray(claimResponse.errors) && claimResponse.errors.length > 0) {
                // Check if first error has a message
                if (claimResponse.errors[0] && claimResponse.errors[0].message) {
                    failureReason = claimResponse.errors[0].message;
                } else if (claimResponse.errors[0]) {
                    // Error object exists but no message property - stringify it
                    failureReason = JSON.stringify(claimResponse.errors[0]);
                }
            } else if (claimResponse.error) {
                // Some APIs return a single 'error' field
                failureReason = typeof claimResponse.error === 'string' ? claimResponse.error : JSON.stringify(claimResponse.error);
            } else if (claimResponse.message) {
                // Some APIs return a 'message' field at root
                failureReason = claimResponse.message;
            }

            // --- JSON.PARSE ERROR INTERCEPTOR START ---
            const errorStr = failureReason.toLowerCase();
            if (errorStr.includes('json.parse: unexpected character') || errorStr.includes('unexpected token')) {
                addLog('API returned invalid JSON (Likely 502/Cloudflare). Forcing immediate refresh...', 'error');
                requestRestart('API_JSON_Parse_Error');
                return; // Stop further processing immediately
            }
            // --- JSON.PARSE ERROR INTERCEPTOR END ---
            
            const errorType = getErrorType(failureReason);
            
            // Update failed claim statistics
            claimStats.failedCount++;
            
            // Add to recent claims
            claimStats.recentClaims.push({
                username: currentUsername,
                code: code,
                status: 'FAILED',
                reason: errorType,
                error: failureReason,
                timestamp: new Date().toISOString(),
                latencyInfo: latencyInfo,
                isRetry: isRetry
            });
            if (claimStats.recentClaims.length > 50) claimStats.recentClaims.shift();
            
            // All errors are now non-retryable (no auto retry)
            // Just show the error message
            processingCodes.delete(code);
            
            let logMessage = `FAILED ${code}. Reason: ${failureReason}`;
            let logType = "error";
            
            if (errorType === 'bonusCodeInactive') { 
                logMessage = `Code ${code} has been fully claimed`; 
                logType = "warning"; 
            } else if (errorType === 'alreadyClaimed') { 
                logMessage = `Already claimed code ${code}`; 
                logType = "warning"; 
            } else if (errorType === 'weeklyWagerRequirement') { 
                logMessage = `Wager requirement not met for ${code}`; 
                logType = "warning"; 
            } else if (errorType === 'withdrawError') { 
                logMessage = `Deposit required to claim ${code}`; 
                logType = "warning"; 
            } else if (errorType === 'emailUnverified') { 
                logMessage = `Email verification required for ${code}`; 
                logType = "warning"; 
            } else if (errorType === 'kycLevelNotSufficient') { 
                logMessage = `KYC level insufficient for ${code}`; 
                logType = "warning"; 
            }
            
            updateLog(logId, logMessage, logType, true, latencyInfo);
            
            // Build raw JSON report for custom backend - include raw response for debugging
            const reportData = { 
                username: currentUsername,
                code: code, 
                status: "FAILED", 
                reason: errorType, 
                error: failureReason,
                isRetry: isRetry,
                latency: {
                    network: latencyInfo.apiLatency,
                    token: latencyInfo.tokenLatency,
                    cacheHit: latencyInfo.turnstileCacheHit,
                    total: latencyInfo.totalTime
                },
                rawResponse: claimResponse, // Include raw API response for debugging
                timestamp: new Date().toISOString()
            };
            reportToBackend(reportData);
        }
    }

    // ================================
    // 📡 DUAL WEBSOCKET CONNECTIONS
    // ================================

    // 1. MAIN WEBSOCKET (HEROKU)
    function connectWebSocket() {
        if (webSocket && webSocket.readyState === WebSocket.OPEN) return;
        updateStatus("disconnected", "Connecting...");

        try {
            // Append username to WS URL for backend auth
            const wsUrlWithUser = `${WS_SERVER_URL}?user=${currentUsername}`;
            webSocket = new WebSocket(wsUrlWithUser);
            webSocket.onopen = () => {
                addLog("Connected to Main Server", "success");
                updateStatus("connected", "UPLINK ACTIVE");

                // Start token maintenance when connected
                if (turnstileManager && turnstileManager.initialized) {
                    turnstileManager.startTokenMaintenance();
                }
            };
            webSocket.onmessage = (event) => {
                const raw = event.data;
                const receiveTime = performance.now(); // INSTANT TIMER START
                
                // --- OPTIMIZATION: FAST-FAIL PARSING ---
                if (typeof raw !== 'string' || !raw.includes('"code"')) return;
                // ---------------------------------------

                // Check for "r-" or "-r" prefix for manual retry
                let actualCode = raw;
                let isRetry = false;
                
                // Try to extract code and check for prefix
                const codeMatch = raw.match(/"code"\s*:\s*"([^"]+)"/);
                if (codeMatch && codeMatch[1]) {
                    actualCode = codeMatch[1];
                    // Check if code starts with "r-" or "-r" for manual retry
                    if (actualCode.startsWith('r-') || actualCode.startsWith('-r')) {
                        isRetry = true;
                        actualCode = actualCode.substring(2); // Strip prefix
                    }
                }

                // --- 🚀 GOD TIER OPTIMIZATION: Bypassing JSON.parse ---
                if (userSettings && userSettings.processAll) {
                    if (codeMatch && codeMatch[1]) {
                        if (!claimedCodes.has(actualCode) || isRetry) {
                            // FIRE IMMEDIATELY without waiting for JSON parse
                            testBonusCode(actualCode, false, receiveTime, isRetry);
                        }
                        // Silently ignore duplicate codes
                    }
                    return; // Skip standard parsing if processed via regex
                } 
                // --------------------------------------------------------

                try {
                    const payload = JSON.parse(raw);
                    let messageData = null;

                    // If outer wrapper indicates sub_code_v2 OR stake_bonus_code, use inner msg
                    if (payload && (payload.type === "sub_code_v2" || payload.type === "stake_bonus_code") && payload.msg) {
                        messageData = payload.msg;
                    } 
                    // Legacy or other format where msg exists - prefer inner msg if present
                    else if (payload && payload.msg) {
                        messageData = payload.msg;
                    } 
                    // Fallback: use payload directly
                    else {
                        messageData = payload;
                    }

                    // If after extraction we still have a lingering 'type' field equal to 'sub_code_v2' or 'stake_bonus_code', remove it
                    if (messageData && (messageData.type === "sub_code_v2" || messageData.type === "stake_bonus_code")) {
                        if (messageData.msg) {
                            // If inner msg exists, unwrap it
                            messageData = messageData.msg;
                        } else {
                            // Otherwise just remove the irrelevant wrapper type
                            delete messageData.type;
                        }
                    }

                    if (messageData && messageData.code) {
                        // Check for retry prefix in the code for manual retry
                        let code = messageData.code;
                        let isManualRetry = false;
                        
                        if (code.startsWith('r-') || code.startsWith('-r')) {
                            isManualRetry = true;
                            code = code.substring(2); // Strip prefix
                            messageData.code = code; // Update for further processing
                        }
                        
                        // Check if we should process this code based on user settings
                        const codeType = getCodeType(messageData);
                        // If user enabled 'processAll' OR code type is in allowed drops
                        if (!userSettings.processAll && userSettings.drops && userSettings.drops.includes(codeType)) {
                            // Check if code is already processed (skip check if it's a retry)
                            if (!claimedCodes.has(code) || isManualRetry) {
                                testBonusCode(code, messageData.msgType === 'unck', receiveTime, isManualRetry);
                            }
                            // Silently ignore duplicate codes
                        } else if (!userSettings.processAll) {
                            addLog(`Skipping code type: ${codeType}`, "info");
                        }
                    }
                } catch (e) {
                    // Silent catch for JSON parse errors
                }
            };
            webSocket.onclose = (event) => {
                updateStatus("disconnected", "Reconnecting...");
                webSocket = null;
                
                // Only reconnect if we aren't blocked by auth
                if (!document.getElementById('kust-subscription-overlay')) {
                    setTimeout(connectWebSocket, 4000 + Math.random() * 2000); // Added jitter
                }
            };
            webSocket.onerror = (error) => {
                // WebSocket errors usually trigger onclose immediately after, so we handle reconnection there
                console.error("Main WebSocket Error:", error);
            };

        } catch (e) {
            addLog(`Connection Failed: ${e.message}`, 'error');
            updateStatus("disconnected", "Error");
            setTimeout(connectWebSocket, 4000 + Math.random() * 2000); // Added jitter
        }
    }

    function disconnectWebSocket() {
        if (webSocket) {
            webSocket.close();
            webSocket = null;
        }
        if (hh123Socket) {
            hh123Socket.disconnect();
            hh123Socket = null;
        }
        if (healthWsSocket) {
            healthWsSocket.close();
            healthWsSocket = null;
        }
        if (healthWsReconnectTimer) {
            clearTimeout(healthWsReconnectTimer);
            healthWsReconnectTimer = null;
        }
        if (healthWsReportInterval) {
            clearInterval(healthWsReportInterval);
            healthWsReportInterval = null;
        }
    }

    // 2. REGIONAL WEBSOCKET (HH123 Socket.IO)
    async function loadSocketIO() {
        return new Promise((resolve, reject) => {
            if (typeof unsafeWindow.io !== 'undefined') return resolve();
            const script = document.createElement('script');
            script.src = 'https://cdn.socket.io/4.7.4/socket.io.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    async function connectRegionalServer() {
        if (hh123Socket && hh123Socket.connected) return;

        try {
            await loadSocketIO();
            
            // 1. HTTP Auth to get HH123 Token
            const loginResText = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: `${HH123_URL}/api/login`,
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json',
                        'Origin': 'https://stake.com',
                        'Referer': 'https://stake.com/settings/offers'
                    },
                    data: JSON.stringify({
                        username: HH123_USERNAME,
                        platform: 'stake.com',
                        version: HH123_VERSION
                    }),
                    onload: (res) => resolve(res.responseText),
                    onerror: reject,
                    ontimeout: reject
                });
            });

            const loginData = JSON.parse(loginResText);
            const token = loginData.data || loginData.token;
            if (!token) throw new Error("No token returned from Regional Server");

            // 2. Connect via Socket.IO
            hh123Socket = unsafeWindow.io(HH123_URL, {
                auth: { token: token, version: HH123_VERSION, locale: 'en' },
                transports: ['polling'],
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 5000
            });

            hh123Socket.on('connect', () => {
                addLog("Connected to Regional Server", "success");
                hh123Socket.emit('auth', { token: token, username: HH123_USERNAME });
            });

            const handleRegionalMessage = (data) => {
                const receiveTime = performance.now(); // INSTANT TIMER START
                
                let raw = typeof data === 'string' ? data : JSON.stringify(data);
                
                if (typeof raw === 'string' && !raw.includes('"code"')) return;

                // Check for retry prefix for manual retry
                let actualCode = raw;
                let isRetry = false;
                
                // Try to extract code and check for prefix
                const codeMatch = raw.match(/"code"\s*:\s*"([^"]+)"/);
                if (codeMatch && codeMatch[1]) {
                    actualCode = codeMatch[1];
                    // Check if code starts with prefix for manual retry
                    if (actualCode.startsWith('r-') || actualCode.startsWith('-r')) {
                        isRetry = true;
                        actualCode = actualCode.substring(2); // Strip prefix
                    }
                }

                // --- 🚀 GOD TIER OPTIMIZATION: Bypassing JSON.parse ---
                if (userSettings && userSettings.processAll) {
                    if (codeMatch && codeMatch[1]) {
                        if (!claimedCodes.has(actualCode) || isRetry) {
                            // FIRE IMMEDIATELY
                            testBonusCode(actualCode, false, receiveTime, isRetry);
                        }
                        // Silently ignore duplicate codes
                    }
                    return; // Skip standard parsing if processed via regex
                }
                // --------------------------------------------------------

                try {
                    let messageData = null;
                    if (data && (data.type === "sub_code_v2" || data.type === "stake_bonus_code") && data.msg) {
                        messageData = data.msg;
                    } else if (data && data.msg) {
                        messageData = data.msg;
                    } else {
                        messageData = data;
                    }

                    if (messageData && (messageData.type === "sub_code_v2" || messageData.type === "stake_bonus_code")) {
                        if (messageData.msg) messageData = messageData.msg;
                        else delete messageData.type;
                    }

                    if (messageData && messageData.code) {
                        // Check for prefix in the code for manual retry
                        let code = messageData.code;
                        let isManualRetry = false;
                        
                        if (code.startsWith('r-') || code.startsWith('-r')) {
                            isManualRetry = true;
                            code = code.substring(2); // Strip prefix
                            messageData.code = code; // Update for further processing
                        }
                        
                        const codeType = getCodeType(messageData);
                        if (!userSettings.processAll && userSettings.drops && userSettings.drops.includes(codeType)) {
                            if (!claimedCodes.has(code) || isManualRetry) {
                                testBonusCode(code, false, receiveTime, isManualRetry);
                            }
                            // Silently ignore duplicate codes
                        } else if (!userSettings.processAll) {
                            addLog(`Skipping code type: ${codeType}`, "info");
                        }
                    }
                } catch (e) {}
            };

            hh123Socket.on('sub_code_v2', (data) => handleRegionalMessage({ type: 'sub_code_v2', msg: data }));
            hh123Socket.on('message', handleRegionalMessage);
            
            hh123Socket.on('disconnect', () => {
                // Background reconnect handles itself via Socket.io internal logic
            });

            // Keepalive specific to this socket
            setInterval(() => {
                if (hh123Socket && hh123Socket.connected) {
                    hh123Socket.emit('ping_from_bot', { ts: Date.now() });
                }
            }, 25000);

        } catch (e) {
            addLog(`Regional Server Connect Failed. Retrying...`, "warning");
            setTimeout(connectRegionalServer, 8000 + Math.random() * 4000); // Added jitter
        }
    }

    // ================================
    // 🏥 HEALTH CHECK WEBSOCKET
    // Connects to healthUrl from velocity config.
    // Initializes by sending username on open (same pattern as main WSS).
    // Responds on-demand to "report_request" from server:
    //   - Runs a dummy claim attempt (stake1234) to measure real API latency
    //   - Reports: username, token cache count, network stats, connection state
    // ================================
    function connectHealthSocket() {
        if (!HEALTH_WS_URL) {
            addLog('[Health] No healthUrl from config — skipping health socket.', 'warning');
            return;
        }
        if (healthWsSocket && healthWsSocket.readyState === WebSocket.OPEN) return;

        // Clear any pending reconnect timer
        if (healthWsReconnectTimer) {
            clearTimeout(healthWsReconnectTimer);
            healthWsReconnectTimer = null;
        }

        try {
            // Append username exactly like the main code WSS does
            const healthUrl = `${HEALTH_WS_URL}?user=${currentUsername}`;
            healthWsSocket = new WebSocket(healthUrl);

            healthWsSocket.onopen = () => {
                addLog('[Health] Health socket connected.', 'success');
                // Send hello/init message with username (mirrors main WSS pattern)
                try {
                    healthWsSocket.send(JSON.stringify({
                        type: 'hello',
                        username: currentUsername
                    }));
                } catch (e) { /* ignore */ }

                // Start periodic token reporting every 30 seconds
                if (healthWsReportInterval) {
                    clearInterval(healthWsReportInterval);
                }
                healthWsReportInterval = setInterval(() => {
                    if (healthWsSocket && healthWsSocket.readyState === WebSocket.OPEN) {
                        const tokenCacheCount = turnstileManager.tokenCache ? turnstileManager.tokenCache.length : 0;
                        const report = {
                            type: 'token_report',
                            username: currentUsername,
                            token_count: tokenCacheCount,
                            timestamp: new Date().toISOString()
                        };
                        try {
                            healthWsSocket.send(JSON.stringify(report));
                        } catch (e) { /* ignore */ }
                    }
                }, 30000);
            };

            healthWsSocket.onmessage = async (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch (e) { return; }

                // Server sends {"type":"report_request"} or {"type":"ping_health"} to trigger a report
                if (msg.type === 'report_request' || msg.type === 'ping_health') {
                    addLog('[Health] Report requested by server — running dummy claim...', 'info');

                    // ── Dummy claim attempt (stake1234) to measure real API latency ──
                    let dummyLatency = null;
                    let dummyResult = 'not_attempted';
                    let dummyError = null;

                    if (stakeApi && OPTIMIZED_HEADERS) {
                        const dummyCode = 'stake1234';
                        const dummyTokenResult = turnstileManager.getFastTokenWithMetrics();

                        if (dummyTokenResult && dummyTokenResult.token) {
                            const dummyPayload = `{"operationName":"ClaimConditionBonusCode","variables":{"code":"${dummyCode}","currency":"${selectedCurrency}","turnstileToken":"${dummyTokenResult.token}"},"query":"mutation ClaimConditionBonusCode($code: String!, $currency: CurrencyEnum!, $turnstileToken: String!) { claimConditionBonusCode(code: $code, currency: $currency, turnstileToken: $turnstileToken) { bonusCode { id code __typename } amount currency user { id balances { available { amount currency __typename } __typename } __typename } __typename } }"}`;
                            const dummyStart = performance.now();
                            try {
                                const dummyResp = await fetch(STAKE_API_URL, {
                                    method: 'POST',
                                    headers: OPTIMIZED_HEADERS,
                                    body: dummyPayload
                                });
                                const dummyJson = await dummyResp.json();
                                dummyLatency = Math.round(performance.now() - dummyStart);

                                if (dummyJson.errors && dummyJson.errors.length > 0) {
                                    const errMsg = dummyJson.errors[0].message || '';
                                    dummyError = errMsg;
                                    // Expected: bonusCodeInactive / alreadyClaimed / etc — API is reachable
                                    dummyResult = 'api_reached_error';
                                } else {
                                    dummyResult = 'api_reached_success';
                                }
                            } catch (e) {
                                dummyLatency = Math.round(performance.now() - dummyStart);
                                dummyResult = 'fetch_error';
                                dummyError = e.message;
                            }
                        } else {
                            dummyResult = 'no_token_in_cache';
                        }
                    } else {
                        dummyResult = 'api_not_initialized';
                    }
                    // ── End dummy claim ──

                    const tokenCacheCount = turnstileManager.tokenCache ? turnstileManager.tokenCache.length : 0;
                    const mainConnected = webSocket && webSocket.readyState === WebSocket.OPEN;
                    const regionalConnected = hh123Socket && hh123Socket.connected;
                    const healthConnected = healthWsSocket && healthWsSocket.readyState === WebSocket.OPEN;

                    const report = {
                        type: 'health_report',
                        username: currentUsername,
                        timestamp: new Date().toISOString(),
                        dummy_claim: {
                            code: 'stake1234',
                            result: dummyResult,
                            latency_ms: dummyLatency,
                            error: dummyError
                        },
                        token_cache: {
                            count: tokenCacheCount,
                            max: turnstileManager.maxCacheSize || 3
                        },
                        network: {
                            main_wss: {
                                ping_ms: netStats.ping,
                                jitter_ms: netStats.jitter,
                                packet_loss_pct: netStats.packetLoss,
                                connected: mainConnected
                            },
                            regional_wss: {
                                ping_ms: netStatsReg.ping,
                                jitter_ms: netStatsReg.jitter,
                                packet_loss_pct: netStatsReg.packetLoss,
                                connected: regionalConnected
                            },
                            health_wss: {
                                connected: healthConnected
                            }
                        },
                        claim_stats: {
                            success: claimStats.successCount,
                            failed: claimStats.failedCount,
                            total_claimed_value: claimStats.totalClaimedValue
                        },
                        turnstile: {
                            initialized: turnstileManager.initialized,
                            is_generating: turnstileManager.isGenerating,
                            consecutive_failures: turnstileManager.consecutiveFailures || 0
                        },
                        currency: selectedCurrency
                    };

                    try {
                        healthWsSocket.send(JSON.stringify(report));
                        addLog(`[Health] Report sent (latency: ${dummyLatency}ms, tokens: ${tokenCacheCount})`, 'success');
                    } catch (e) {
                        addLog('[Health] Failed to send report.', 'error');
                    }
                }
            };

            healthWsSocket.onclose = () => {
                addLog('[Health] Health socket disconnected. Reconnecting in 10s...', 'warning');
                healthWsSocket = null;
                // Clear the report interval on disconnect
                if (healthWsReportInterval) {
                    clearInterval(healthWsReportInterval);
                    healthWsReportInterval = null;
                }
                healthWsReconnectTimer = setTimeout(connectHealthSocket, 10000 + Math.random() * 2000); // Added jitter
            };

            healthWsSocket.onerror = (err) => {
                console.error('[Health] Health WebSocket error:', err);
                // onclose fires after onerror, handles reconnect
            };

        } catch (e) {
            addLog(`[Health] Connection failed: ${e.message}. Retrying in 10s...`, 'error');
            healthWsReconnectTimer = setTimeout(connectHealthSocket, 10000 + Math.random() * 2000); // Added jitter
        }
    }

    // Function to determine code type from payload
    function getCodeType(payload) {
        let codeType = 'OtherDrops';
        if (payload.type === 'DailyDrops') {
            if (payload.amount === 1) {
                codeType = 'Daily1';
            } else if (payload.amount === 2) {
                codeType = 'Daily2';
            } else if (payload.amount === 3) {
                codeType = 'Daily3';
            } else {
                codeType = 'DailyOther';
            }
        } else if (payload.type) {
            codeType = payload.type;
        }

        return codeType;
    }

    // ================================
    // ⏱️ PERIODIC AUTH CHECKER
    // ================================
    function startSubscriptionCheck() {
        // Run check every 60 seconds
        setInterval(async () => {
            if (!currentUsername) return;

            const isAuthorized = await checkAuthorization(currentUsername);

            if (!isAuthorized) {
                // Increment consecutive failures counter
                consecutiveAuthFailures++;
                addLog(`Authorization check failed (${consecutiveAuthFailures}/2)`, "warning");
                
                // Only show subscription prompt after 2 consecutive failures
                if (consecutiveAuthFailures >= 2) {
                    // Not authorized: Kill connection and lock UI
                    if (webSocket || hh123Socket) {
                        addLog("Subscription expired. Stopping connection.", "error");
                        disconnectWebSocket();
                    }
                    showSubscriptionPrompt();
                    // Report invalid username to internal API
                    reportHealth('invalid_username', { username: currentUsername });
                }
            } else {
                // Reset consecutive failures counter on success
                if (consecutiveAuthFailures > 0) {
                    addLog("Authorization check passed", "success");
                }
                consecutiveAuthFailures = 0;
                // Authorized: Check if we need to unlock UI
                if (document.getElementById('kust-subscription-overlay')) {
                    restoreLogsView();
                    connectWebSocket();
                    connectRegionalServer();
                }
                // Check if connection dropped and needs restart (and we aren't locked)
                else {
                    if (!webSocket || webSocket.readyState === WebSocket.CLOSED) {
                        connectWebSocket();
                    }
                    if (!hh123Socket || !hh123Socket.connected) {
                        connectRegionalServer();
                    }
                    if (!healthWsSocket || healthWsSocket.readyState === WebSocket.CLOSED) {
                        connectHealthSocket();
                    }
                }
            }
        }, 60000 + Math.random() * 5000); // Added jitter
    }

    // ================================
    // ⚙️ USER SETTINGS
    // ================================
    function initUserSettings() {
        try {
            // Default settings - all checkboxes checked by default
            const defaultSettings = {
                drops: ['Daily1', 'Daily2', 'Daily3', 'DailyOther', 'HighRollers', 'PlaySmarter', 'WeeklyStream', 'OtherDrops'],
                vault: false,
                processAll: false, // Added default for new button
                currency: 'usdt'
            };
            // Load saved settings or use defaults
            userSettings = GM_getValue(FC_USER_SETTINGS) ||
                defaultSettings;

            // Ensure all required properties exist
            if (!userSettings.drops) userSettings.drops = defaultSettings.drops;
            if (!userSettings.vault) userSettings.vault = defaultSettings.vault;
            if (userSettings.processAll === undefined) userSettings.processAll = defaultSettings.processAll;
            if (!userSettings.currency) userSettings.currency = defaultSettings.currency;
            // Set selected currency
            selectedCurrency = userSettings.currency;
            // Save settings
            GM_setValue(FC_USER_SETTINGS, userSettings);

            return userSettings;
        } catch (error) {
            addLog(`Error initializing user settings: ${error.message}`, "error");
            return {
                drops: ['Daily1', 'Daily2', 'Daily3', 'DailyOther', 'HighRollers', 'PlaySmarter', 'WeeklyStream', 'OtherDrops'],
                vault: false,
                processAll: false,
                currency: 'usdt'
            };
        }
    }

    function saveUserSettings() {
        try {
            GM_setValue(FC_USER_SETTINGS, userSettings);
            addLog("Settings saved", "success");
        } catch (error) {
            addLog(`Error saving settings: ${error.message}`, "error");
        }
    }

    function updateSettingsUI() {
        // Update checkboxes based on current settings
        const checkboxes = document.querySelectorAll('.settings-checkbox');
        checkboxes.forEach(checkbox => {
            if (checkbox.id === 'vaultDeposit') {
                checkbox.checked = userSettings.vault || false;
            } else if (checkbox.id === 'processAll') {
                checkbox.checked = userSettings.processAll || false;
            } else if (checkbox.value) {
                checkbox.checked = userSettings.drops.includes(checkbox.value);
            }
        });
        // Update currency selection
        const currencySelect = document.getElementById('currencySelect');
        if (currencySelect) {
            currencySelect.value = userSettings.currency || 'usdt';
        }
        
        // Also update network stats if opening
        updateSettingsStats();
    }

    // ================================
    // 🖼️ UI CONSTRUCTION
    // ================================
    function createPanel() {
        // Remove existing panel if any
        const existing = document.getElementById("kust-panel");
        if (existing) existing.remove();

        const panel = document.createElement("div");
        panel.id = "kust-panel";
        panel.innerHTML = `
            <div class="kust-header">
                <div class="kust-header-left">
                    <div class="kust-title">KUST CLAIMER</div>
                    <div id="kust-username" class="kust-username">Guest</div>
                </div>
                <div class="kust-header-right">
                    <div id="kust-network-bars" class="network-bars" title="Checking...">
                        <div class="net-bar"></div>
                        <div class="net-bar"></div>
                        <div class="net-bar"></div>
                    </div>

                    <div class="kust-settings-btn" id="kust-settings-btn" title="Settings">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </div>
                    <div id="kust-status-badge" class="kust-status disconnected">
                        <div class="status-dot"></div>
                        <span id="kust-status-text">Init...</span>
                    </div>
                </div>
            </div>
            <div class="kust-body">
                <div id="kust-logs"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // ================================
        // INJECT SIMPLIFIED TOKEN OVERLAY
        // ================================
        const overlay = document.createElement("div");
        overlay.id = "kust-token-overlay";
        overlay.innerHTML = `
            <div class="token-icon">⚡</div>
            <div class="token-text">
                <span class="token-label">Bypass Ammo</span>
                <span id="kust-token-count" class="token-value">0/5</span>
            </div>
        `;
        document.body.appendChild(overlay);

        // Create settings modal
        const settingsModal = document.createElement("div");
        settingsModal.id = "kust-settings-modal";
        settingsModal.innerHTML = `
            <div class="kust-settings-popup">
                <div class="settings-popup-header">
                    <div class="settings-popup-title">Settings</div>
                    <div class="settings-popup-close" id="settings-popup-close">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </div>
                </div>
                <div class="settings-popup-content">
                    
                    <div class="settings-section">
                        <div class="settings-section-title">Claim Statistics</div>
                        <div class="claim-stats-grid">
                            <div class="claim-stat-item">
                                <span class="claim-stat-label">Success</span>
                                <span class="claim-stat-value success" id="stat-success-count">0</span>
                            </div>
                            <div class="claim-stat-item">
                                <span class="claim-stat-label">Failed</span>
                                <span class="claim-stat-value failed" id="stat-failed-count">0</span>
                            </div>
                            <div class="claim-stat-item">
                                <span class="claim-stat-label">Total Value</span>
                                <span class="claim-stat-value" id="stat-total-value">$0.00</span>
                            </div>
                            <div class="claim-stat-item">
                                <span class="claim-stat-label">Success Rate</span>
                                <span class="claim-stat-value" id="stat-success-rate">0%</span>
                            </div>
                        </div>
                    </div>

                    <div class="settings-section">
                        <div class="settings-section-title">Network Status</div>
                        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                            
                            <div class="server-container">
                                <div class="server-label main">Main Server</div>
                                <div class="net-stats-grid" style="margin-bottom: 0;">
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Latency</span>
                                        <span class="net-stat-value" id="stat-latency">--ms</span>
                                    </div>
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Jitter</span>
                                        <span class="net-stat-value" id="stat-jitter">--ms</span>
                                    </div>
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Loss</span>
                                        <span class="net-stat-value" id="stat-loss">--%</span>
                                    </div>
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Status</span>
                                        <span class="net-stat-value" id="stat-server">--</span>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="server-container">
                                <div class="server-label regional">Regional</div>
                                <div class="net-stats-grid" style="margin-bottom: 0;">
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Latency</span>
                                        <span class="net-stat-value" id="stat-latency-reg">--ms</span>
                                    </div>
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Jitter</span>
                                        <span class="net-stat-value" id="stat-jitter-reg">--ms</span>
                                    </div>
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Loss</span>
                                        <span class="net-stat-value" id="stat-loss-reg">--%</span>
                                    </div>
                                    <div class="net-stat-item" style="padding: 6px;">
                                        <span class="net-stat-label">Status</span>
                                        <span class="net-stat-value" id="stat-server-reg">--</span>
                                    </div>
                                </div>
                            </div>
                            
                        </div>
                    </div>
                
                    <div class="settings-section">
                        <div class="settings-section-title">Code Types to Claim</div>
                        <div class="settings-option">
                            <input type="checkbox" id="processAll" class="settings-checkbox">
                            <label for="processAll" class="settings-label" style="color: #00E701; font-weight: bold;">Process ALL Codes (Ignore Filters)</label>
                        </div>
                        <hr class="settings-divider">

                        <div class="settings-option">
                            <input type="checkbox" id="daily1" class="settings-checkbox" value="Daily1" checked>
                            <label for="daily1" class="settings-label">Daily $1</label>
                        </div>
                        <div class="settings-option">
                            <input type="checkbox" id="daily2" class="settings-checkbox" value="Daily2" checked>
                            <label for="daily2" class="settings-label">Daily $2</label>
                        </div>
                        <div class="settings-option">
                            <input type="checkbox" id="daily3" class="settings-checkbox" value="Daily3" checked>
                            <label for="daily3" class="settings-label">Daily $3</label>
                        </div>
                        <div class="settings-option">
                            <input type="checkbox" id="dailyOther" class="settings-checkbox" value="DailyOther" checked>
                            <label for="dailyOther" class="settings-label">Daily Other</label>
                        </div>
                        <div class="settings-option">
                            <input type="checkbox" id="highRollers" class="settings-checkbox" value="HighRollers" checked>
                            <label for="highRollers" class="settings-label">High Rollers</label>
                        </div>
                        <div class="settings-option">
                            <input type="checkbox" id="weeklyStream" class="settings-checkbox" value="WeeklyStream" checked>
                            <label for="weeklyStream" class="settings-label">Weekly Stream Drops</label>
                        </div>
                        <div class="settings-option">
                               <input type="checkbox" id="playSmarter" class="settings-checkbox" value="PlaySmarter" checked>
                            <label for="playSmarter" class="settings-label">Play Smarter Drops</label>
                        </div>
                        <div class="settings-option">
                            <input type="checkbox" id="otherDrops" class="settings-checkbox" value="OtherDrops" checked>
                            <label for="otherDrops" class="settings-label">Other Drops</label>
                        </div>
                    </div>
             
                    <div class="settings-section">
                        <div class="settings-section-title">Claim Settings</div>
                        <div class="settings-option">
                            <input type="checkbox" id="vaultDeposit" class="settings-checkbox">
                            <label for="vaultDeposit" class="settings-label">Deposit to Vault</label>
                        </div>
                        <div class="settings-option">
                            <label for="currencySelect" class="settings-label">Currency:</label>
                        </div>
                        <select id="currencySelect" class="settings-select">
                            <option value="btc">BTC</option>
                            <option value="eth">ETH</option>
                            <option value="ltc">LTC</option>
                            <option value="usdt" selected>USDT</option>
                            <option value="sol">SOL</option>
                            <option value="doge">DOGE</option>
                            <option value="xrp">XRP</option>
                            <option value="trx">TRX</option>
                            <option value="eos">EOS</option>
                            <option value="bnb">BNB</option>
                            <option value="usdc">USDC</option>
                            <option value="dai">DAI</option>
                            <option value="link">LINK</option>
                            <option value="shib">SHIB</option>
                            <option value="uni">UNI</option>
                            <option value="pol">POL</option>
                            <option value="trump">TRUMP</option>
                        </select>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(settingsModal);

        // Settings button click handler
        document.getElementById('kust-settings-btn').addEventListener('click', () => {
            const settingsModal = document.getElementById('kust-settings-modal');
            settingsModal.classList.add('open');

            // Update UI when opening settings
            updateSettingsUI();
        });
        // Settings modal close button
        document.getElementById('settings-popup-close').addEventListener('click', () => {
            document.getElementById('kust-settings-modal').classList.remove('open');
        });
        // Close modal when clicking outside
        document.getElementById('kust-settings-modal').addEventListener('click', (e) => {
            if (e.target.id === 'kust-settings-modal') {
                document.getElementById('kust-settings-modal').classList.remove('open');
            }
        });
        // Settings checkboxes
        const settingsCheckboxes = document.querySelectorAll('.settings-checkbox');
        settingsCheckboxes.forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                if (!userSettings.drops) userSettings.drops = [];

                if (checkbox.id === 'vaultDeposit') {
                    userSettings.vault = checkbox.checked;
                } else if (checkbox.id === 'processAll') {
                    userSettings.processAll = checkbox.checked;
                } else if (checkbox.value) {
                    if (checkbox.checked && !userSettings.drops.includes(checkbox.value)) {
                        userSettings.drops.push(checkbox.value);
                    } else if (!checkbox.checked && userSettings.drops.includes(checkbox.value)) {
                        const index = userSettings.drops.indexOf(checkbox.value);
                        userSettings.drops.splice(index, 1);
                    }
                }
                saveUserSettings();
            });
        });
        // Currency select
        document.getElementById('currencySelect').addEventListener('change', (e) => {
            selectedCurrency = e.target.value;
            userSettings.currency = selectedCurrency;
            saveUserSettings();
        });
        // Drag Logic
        const header = panel.querySelector('.kust-header');
        let isDragging = false, startX, startY, initialLeft, initialTop;

        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.kust-settings-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panel.style.top = `${initialTop + dy}px`;
            panel.style.left = `${initialLeft + dx}px`;
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    // ================================
    // 🌐 REMOTE CONFIG FETCHER
    // ================================
    async function fetchRemoteConfig() {
        return new Promise((resolve, reject) => {
            updateStatus("disconnected", "Fetching config...");
            GM_xmlhttpRequest({
                method: "GET",
                url: REMOTE_CONFIG_URL,
                timeout: 10000,
                headers: { "Content-Type": "application/json" },
                onload: (res) => {
                    try {
                        const config = JSON.parse(res.responseText);
                        // The worker returns 'wssUrl' (best one) and 'authUrl' (default)
                        if (config.wssUrl && config.authUrl) {
                            WS_SERVER_URL = config.wssUrl;
                            AUTH_CHECK_URL = config.authUrl;
                            if (config.regionalUrl) {
                                HH123_URL = config.regionalUrl;
                            }
                            if (config.healthUrl) {
                                HEALTH_WS_URL = config.healthUrl;
                            }
                            if (config.dashUrl) {
                                REPORTING_BACKEND_URL = config.dashUrl;
                            } else if (config.reportUrl) {
                                REPORTING_BACKEND_URL = config.reportUrl;
                            }
                            addLog(`Config loaded`, "success");
                            resolve(true);
                        } else {
                            reject("Invalid Config Structure");
                        }
                    } catch (e) {
                        reject("Config Parse Error");
                    }
                },
                onerror: () => reject("Config Network Error"),
                ontimeout: () => reject("Config Timeout")
            });
        });
    }

    // ================================
    // 🔥 INITIALIZATION
    // ================================
    async function init() {
        // --- Site load error detection ---
        window.addEventListener('error', (e) => {
            if (e.target === window || e.target === document) {
                addLog('Site load error detected. Requesting restart...', 'error');
                requestRestart('site_load_failed');
            }
        }, true);
        
        // Detect page visibility issues (site not loading properly)
        if (document.visibilityState === 'hidden' && !document.hasFocus()) {
            setTimeout(() => {
                if (document.visibilityState === 'hidden') {
                    addLog('Page visibility issue detected. Requesting restart...', 'warning');
                    requestRestart('page_visibility_issue');
                }
            }, 30000);
        }
        // ------------------------------------------
        
        // --- OPTIMIZATION: PRE-WARM CONNECTIONS ---
        const preconnect = document.createElement('link');
        preconnect.rel = 'preconnect';
        preconnect.href = CURRENT_MIRROR;
        preconnect.crossOrigin = 'anonymous';
        document.head.appendChild(preconnect);
        // ------------------------------------------

        createPanel();
        addLog("Kust Claimer v2.5-lite Initialized (VPS Optimized)", "info");
        
        // 🔥 START TURNSTILE EARLY
        // Give the token cache huge breathing room to fill up before anything else executes
        turnstileManager.initialize();

        // Fetch remote configuration
        try {
            await fetchRemoteConfig();
        } catch (e) {
            addLog(`Config Fetch Failed: ${e}. Using defaults.`, "warning");
            // WS_SERVER_URL and AUTH_CHECK_URL retain their default values defined at the top
        }

        updateStatus("disconnected", "Fetching User...");
        
        // Start AGGRESSIVE WSS Network Stats Polling (runs every 2s + jitter)
        setInterval(activePingCheck, 2000 + Math.random() * 1000);
        setInterval(activeRegionalPingCheck, 2000 + Math.random() * 1000);
        activePingCheck(); // Initial check
        activeRegionalPingCheck();
        
        // Start Token UI Polling
        setInterval(updateTokenUI, 500);

        // 🔥 START TOKEN CACHE WATCHER - Separate watcher for detecting stuck token generation
        startTokenCacheWatcher();

        // 1. Initialize user settings
        initUserSettings();
        // 2. Get Username
        currentUsername = await getStakeUserFromAPI();
        
        // Report health status based on username fetch result
        if (currentUsername) {
            // API is working - username obtained
            reportHealth('api_ok', { username: currentUsername });
        } else {
            // API failed - could not get username
            addLog('Failed to obtain username from API. Reporting invalid API...', 'error');
            reportHealth('invalid_api', { error: 'Could not fetch user from API' });
            
            // Request restart after a short delay
            setTimeout(() => {
                requestRestart('invalid_api_cannot_get_username');
            }, 5000);
            
            updateStatus("disconnected", "API Error");
            return; // Don't continue if API is broken
        }
        
        if (currentUsername) {
            
            // 🚀 GOD TIER OPTIMIZATION: Pre-build the fetch headers once session is known
            OPTIMIZED_HEADERS = {
                'Content-Type': 'application/json',
                'x-access-token': currentSession,
                'x-operation-name': 'ClaimConditionBonusCode',
                'x-operation-type': 'query',
                'Origin': CURRENT_MIRROR,
                'Referer': window.location.href
            };

            updateUsername(currentUsername);
            // 3. (TurnstileManager already initialized above to gain buffer time)
            
            // 4. Check Authorization
            const isAuthorized = await checkAuthorization(currentUsername);
            
            // Report authorization status
            if (!isAuthorized) {
                reportHealth('invalid_username', { username: currentUsername });
            }
            
            // 5. Start Periodic Check (runs every 60s)
            startSubscriptionCheck();
            if (isAuthorized) {
                // Initialize both sockets in parallel
                connectWebSocket();
                connectRegionalServer();
                connectHealthSocket();
            } else {
                // Not authorized: Show subscription prompt immediately (no grace period)
                showSubscriptionPrompt();
            }
        } else {
            addLog("Cannot proceed without a valid Stake username. Please log in.", "error");
            updateStatus("disconnected", "Login Req.");
        }
    }

    // Clear claimed codes periodically
    setInterval(() => {
        claimedCodes.clear(); // Set clear method
        processingCodes.clear(); // Also clear processing set
    }, 3 * 60 * 1000);
    // Clear every 3 minutes

    // Start
    init();
})();

#!/usr/bin/env node
/**
 * OpenCode Railway Wrapper
 * Provides graceful shutdown, log classification, and Basic Auth proxying
 *
 * Fork: added Basic Auth support to health check for newer OpenCode versions
 * that protect /global/health with the server password.
 */

const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { proxyWebSocketUpgrade } = require("./ws-proxy");
const { resolveOpencodeLaunch } = require("./launch");
const { ensureOhMyPluginCache, refreshPluginCache } = require("./plugin-refresh");
const { ensureRuntimeConfigs } = require("./runtime-config");
const { isSourceMode } = require("./source-mode");

const PORT = process.env.PORT || "8080";
const INTERNAL_PORT = process.env.INTERNAL_PORT || "18080";
const PLUGIN_PORT = process.env.OPENCLAW_PLUGIN_PORT || "9090";
const WORKSPACE = process.env.OPENCODE_WORKSPACE || "/data/workspace";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
const USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_REALM = String(process.env.AUTH_REALM || process.env.RAILWAY_PUBLIC_DOMAIN || "opencode")
  .replace(/[\r\n"]/g, "")
  .trim() || "opencode";
const SESSION_SECRET = process.env.OPENCODE_SESSION_SECRET || PASSWORD;
const SESSION_COOKIE = "opencode_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const logLevel = process.env.LOG_LEVEL?.toUpperCase() || "WARN";
const debugTraffic = process.env.DEBUG_OPENCODE_TRAFFIC === "true";
const WEB_ROOT = process.env.OPENCODE_WEB_DIST_DIR || "/opt/opencode/packages/app/dist";
const sourceMode = isSourceMode(process.env);
const enableOhMyOpencode = process.env.ENABLE_OH_MY_OPENCODE !== "false";
const enableOpenclawPlugin = process.env.ENABLE_OPENCLAW_PLUGIN === "true";
const omoConfigProfile = process.env.OMO_CONFIG_PROFILE;
const ACTIVITY_FILE = process.env.OPENCODE_ACTIVITY_FILE || "/tmp/opencode_monitor_state_v5/last_activity";
const sleepDebug = process.env.LOG_SLEEP_BLOCKERS === "true";

if (!PASSWORD) {
  console.error("ERROR: OPENCODE_SERVER_PASSWORD is required");
  process.exit(1);
}

// Create persistent directories
const dirs = [
  WORKSPACE,
  "/data/.local/share/opencode",
  "/data/.local/state/opencode",
  "/data/.config/opencode",
];
for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

// Set environment variables
process.env.HOME = "/data";
process.env.OPENCODE_CONFIG_DIR = "/data/.config/opencode";
process.env.OPENCODE_CONFIG = "/data/.config/opencode/config.json";
// Internal OpenCode does not need Basic Auth; the proxy layer handles it
process.env.OPENCODE_SERVER_PASSWORD = "";
delete process.env.OPENCODE_SERVER_PASSWORD;

// Set OpenClaw plugin environment variables
process.env.OPENCLAW_PORT = PLUGIN_PORT;

try {
  ensureRuntimeConfigs({
    enableOhMyOpencode,
    enableOpenclawPlugin,
    omoConfigProfile,
  });
} catch (err) {
  console.error("[wrapper] Failed to update runtime config:", err.message);
}

try {
  const result = refreshPluginCache();
  if (result.action === "refreshed") {
    console.log(`[wrapper] Refreshed oh-my plugin cache for deployment ${result.deployment}`);
  }
  if (result.action === "noop") {
    console.log(`[wrapper] Oh-my plugin cache already refreshed for deployment ${result.deployment}`);
  }
  if (result.action === "skipped") {
    console.log(`[wrapper] Skipped oh-my plugin refresh: ${result.reason}`);
  }
} catch (err) {
  console.error("[wrapper] Failed to refresh oh-my plugin cache:", err.message);
}

try {
  const result = ensureOhMyPluginCache();
  if (result.action === "installed") {
    console.log(`[wrapper] Installed oh-my plugin cache in ${result.dir}`);
  }
  if (result.action === "noop") {
    console.log(`[wrapper] Oh-my plugin cache ready in ${result.dir}`);
  }
  if (result.action === "skipped") {
    console.log(`[wrapper] Skipped oh-my plugin cache prewarm: ${result.reason}`);
  }
} catch (err) {
  console.error("[wrapper] Failed to prewarm oh-my plugin cache:", err.message);
  process.exit(1);
}

console.log(`Starting OpenCode Web on port ${PORT}...`);
console.log(`OpenCode version: ${process.env.OPENCODE_VERSION || "unknown"}`);
console.log(`Internal port: ${INTERNAL_PORT}`);
console.log(`Plugin port: ${PLUGIN_PORT}`);
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Source mode: ${sourceMode ? "true (build from source)" : "false (published opencode-ai)"}`);
console.log(`Log level: ${logLevel} (set LOG_LEVEL env var to change: DEBUG, INFO, WARN, ERROR)`);
console.log(`Oh My OpenCode: ${enableOhMyOpencode ? "enabled" : "disabled"}`);
console.log(`OpenClaw plugin injection: ${enableOpenclawPlugin ? "enabled" : "disabled"}`);
console.log(`OMO config profile: ${omoConfigProfile || "none"}`);
if (debugTraffic) {
  console.log("OpenCode traffic debug logging enabled");
}
if (sleepDebug) {
  console.log("Sleep blocker logging enabled");
}

function compactLog(value, max = 160) {
  if (value === undefined || value === null || value === "") return "-";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return "-";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function forwardedHeaderValue(value) {
  if (!value) return "";
  if (Array.isArray(value)) return value[0] || "";
  return value;
}

function requestIp(req) {
  const direct = forwardedHeaderValue(req.headers["cf-connecting-ip"]);
  if (direct) return direct;
  const forwarded = forwardedHeaderValue(req.headers["x-forwarded-for"]);
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "-";
}

function requestAuth(req) {
  if (req.headers.authorization?.startsWith("Basic ")) return "basic";
  if (req.headers.cookie?.includes(`${SESSION_COOKIE}=`)) return "session";
  return "none";
}

function shouldLogSleepInbound(req, pathname, isPluginReq) {
  if (pathname === "/global/health") return true;
  if (pathname === "/session/status") return true;
  if (pathname === "/global/event" || pathname === "/events") return true;
  if (pathname === "/register") return true;
  if (pathname === "/" || pathname === "/login") return req.method === "GET" || req.method === "HEAD";
  return isHtmlNavigation(req, pathname, isPluginReq);
}

function logSleepInbound(req, pathname, note = "") {
  if (!sleepDebug) return;
  const host = compactLog(forwardedHeaderValue(req.headers.host), 80);
  const ip = compactLog(requestIp(req), 80);
  const ua = compactLog(forwardedHeaderValue(req.headers["user-agent"]), 120);
  const auth = requestAuth(req);
  const suffix = note ? ` note=${note}` : "";
  console.log(`[sleep-debug] inbound method=${req.method} path=${pathname} host=${host} ip=${ip} auth=${auth} ua="${ua}"${suffix}`);
}

function normalizePort(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function splitHostPort(host) {
  if (!host) return { host: "", port: "" };
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { host, port: "" };
    const name = host.slice(0, end + 1);
    const port = host.slice(end + 2);
    return { host: name, port };
  }
  const idx = host.lastIndexOf(":");
  if (idx === -1) return { host, port: "" };
  if (host.indexOf(":") !== idx) return { host, port: "" };
  return {
    host: host.slice(0, idx),
    port: host.slice(idx + 1),
  };
}

function isLoopbackHost(host) {
  if (!host) return true;
  const value = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  if (value === "0.0.0.0") return true;
  return value.startsWith("127.");
}

function shouldLogOutbound(target) {
  if (!sleepDebug || !target) return false;
  if (target.socketPath) return false;
  return !isLoopbackHost(target.host);
}

function logSleepOutbound(kind, target) {
  if (!shouldLogOutbound(target)) return;
  const protocol = target.protocol || kind;
  const method = target.method || "GET";
  const host = compactLog(target.host, 80);
  const port = target.port ? `:${target.port}` : "";
  const route = compactLog(target.path || "/", 160);
  console.log(`[sleep-debug] outbound kind=${kind} method=${method} target=${protocol}//${host}${port}${route}`);
}

function outboundTarget(args, fallbackProtocol) {
  const first = args[0];
  const second = typeof args[1] === "function" ? undefined : args[1];
  if (!first) return;

  if (typeof first === "string" || first instanceof URL) {
    const url = first instanceof URL ? first : new URL(first);
    const opts = second && typeof second === "object" ? second : {};
    const hostValue = opts.hostname || opts.host || url.hostname || url.host;
    const split = splitHostPort(String(hostValue || ""));
    return {
      protocol: url.protocol || fallbackProtocol,
      host: split.host || url.hostname || url.host,
      port: normalizePort(opts.port || split.port || url.port),
      path: opts.path || `${url.pathname}${url.search}`,
      method: opts.method || "GET",
      socketPath: opts.socketPath,
    };
  }

  if (typeof first !== "object") return;

  const split = splitHostPort(String(first.hostname || first.host || ""));
  return {
    protocol: first.protocol || fallbackProtocol,
    host: split.host || first.hostname || first.host,
    port: normalizePort(first.port || split.port),
    path: first.path || first.pathname || "/",
    method: first.method || "GET",
    socketPath: first.socketPath,
  };
}

function patchOutboundRequests(mod, kind, fallbackProtocol) {
  const request = mod.request.bind(mod);
  mod.request = (...args) => {
    logSleepOutbound(kind, outboundTarget(args, fallbackProtocol));
    return request(...args);
  };

  mod.get = (...args) => {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

const originalFetch = globalThis.fetch?.bind(globalThis);
if (originalFetch) {
  globalThis.fetch = async (input, init) => {
    const source = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (typeof source === "string" && !source.startsWith("/")) {
      const url = new URL(source);
      logSleepOutbound("fetch", {
        protocol: url.protocol,
        host: url.hostname,
        port: normalizePort(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method || (input instanceof Request ? input.method : "GET"),
      });
    }
    return await originalFetch(input, init);
  };
}

patchOutboundRequests(http, "http", "http:");
patchOutboundRequests(https, "https", "https:");

const launch = resolveOpencodeLaunch({
  env: process.env,
  internalPort: INTERNAL_PORT,
  logLevel,
});
if (launch.error) {
  console.error(`[wrapper] ${launch.error}`);
  process.exit(1);
}
console.log(`[wrapper] Launching OpenCode via ${launch.mode}: ${launch.cmd}`);

// Start headless opencode server (internal port, not publicly exposed)
const opencode = spawn(
  launch.cmd,
  launch.args,
  {
    cwd: WORKSPACE,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  }
);

let receivedSigterm = false;

function shouldSuppressLog(trimmed) {
  if (debugTraffic) return false;
  if (trimmed.includes('Executable not found in $PATH: "xdg-open"')) return true;
  if (
    trimmed.startsWith("INFO") &&
    (
      trimmed.includes("service=server") &&
      (
        trimmed.includes("path=/global/health") ||
        trimmed.includes("path=/session/status") ||
        trimmed.includes("path=/pty/")
      )
    )
  ) return true;
  if (
    trimmed.startsWith("INFO") &&
    (
      trimmed.includes("service=server") &&
      trimmed.includes("res.status")
    )
  ) return true;
  if (
    trimmed.startsWith("INFO") &&
    trimmed.includes("service=db") &&
    trimmed.includes("snapshot") &&
    trimmed.includes("prune=")
  ) return true;
  return false;
}

const logBuffer = [];
opencode.stderr.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      if (shouldSuppressLog(trimmed)) continue;
      logBuffer.push(trimmed);
      if (logBuffer.length > 100) {
        const popped = logBuffer.shift();
        console.log(popped);
      }
    }
  }
});

opencode.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      logBuffer.push(trimmed);
      if (logBuffer.length > 100) {
        const popped = logBuffer.shift();
        console.log(popped);
      }
    }
  }
});

opencode.on("error", (err) => {
  console.error("[wrapper] OpenCode error:", err.message);
});

opencode.on("close", (code, signal) => {
  console.log(`[wrapper] opencode exited with code=${code}, signal=${signal}`);
  if (!receivedSigterm) {
    process.exit(code || 0);
  }
});

function isHtmlNavigation(req, pathname, isPluginReq) {
  if (req.method !== "GET") return false;
  if (isPluginReq) return false;
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/global/")) return false;
  if (pathname.startsWith("/session/")) return false;
  if (pathname.startsWith("/v1/")) return false;
  if (pathname.startsWith("/_/")) return false;
  if (pathname.startsWith("/__/")) return false;
  if (pathname.startsWith("/pty/")) return false;
  if (extname(pathname)) return false;
  return true;
}

function extname(pathname) {
  const last = pathname.lastIndexOf(".");
  if (last === -1) return "";
  const ext = pathname.slice(last).toLowerCase();
  const known = [".js", ".css", ".html", ".json", ".ico", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".map", ".wasm", ".woff", ".woff2", ".ttf", ".eot", ".webp", ".avif"];
  if (known.includes(ext)) return ext;
  return "";
}

function isStaticRoute(pathname) {
  return !!WEB_ROOT && fs.existsSync(path.join(WEB_ROOT, pathname === "/" ? "index.html" : pathname));
}

function requestNeedsAuth(pathname, isPluginReq) {
  if (pathname === "/login" || pathname === "/logout") return false;
  if (pathname === "/global/health") return false;
  if (pathname === "/global/event" || pathname === "/events") return false;
  if (pathname === "/session/status") return false;
  if (isStaticRoute(pathname)) return false;
  return true;
}

function buildAuthHeader() {
  const credentials = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
  return `Basic ${credentials}`;
}

function handleLoginPage(res, error) {
  let html = `<html lang="en"><head><meta charset="utf-8"><title>Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; height: 100%; }
  body { display: flex; justify-content: center; align-items: center; height: 100%; }
  .login { background: #161b22; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.3); width: 320px; }
  h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
  label { display: block; font-size: .875rem; margin-bottom: .25rem; font-weight: 500; }
  input[type="text"], input[type="password"] { width: 100%; padding: .5rem; border: 1px solid #30363d; border-radius: 6px; background: #0d1117; color: #c9d1d9; margin-bottom: 1rem; font-size: .875rem; }
  button { width: 100%; padding: .5rem; background: #238636; color: #fff; border: none; border-radius: 6px; font-size: .875rem; cursor: pointer; }
  button:hover { background: #2ea043; }
  .error { color: #f85149; font-size: .8rem; margin-bottom: .75rem; text-align: center; }
</style></head><body>
<div class="login">
<h1>OpenCode Login</h1>`;
  if (error) {
    html += `<div class="error">${escapeHtml(error)}</div>`;
  }
  html += `<form method="post" action="/login">
<label for="username">Username</label>
<input type="text" id="username" name="username" autocomplete="username" required>
<label for="password">Password</label>
<input type="password" id="password" name="password" autocomplete="current-password" required>
<button type="submit" id="login-btn">Login</button>
</form>
</div></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function encodeWorkspaceRoute(dir) {
  // OpenCode web routes projects as /{base64url(absolutePath)}, not ?directory=.
  // The query-param form crashes the SPA ("useGlobalSync must be used within GlobalSyncProvider").
  return Buffer.from(String(dir), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function workspaceEntryPath() {
  // Open Project picker is unreliable on remote servers (empty folder search /
  // no local recent-projects). Land authenticated users directly in the workspace.
  return `/${encodeWorkspaceRoute(WORKSPACE)}`;
}

function shouldAutoOpenWorkspace(req, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname !== "/") return false;
  try {
    const url = new URL(req.url || "/", "http://localhost");
    // Legacy deep-links; leave them alone (they may still crash — prefer /{base64url}).
    if (url.searchParams.has("directory") || url.searchParams.has("dir")) return false;
  } catch {
    return false;
  }
  return process.env.OPENCODE_AUTO_OPEN_WORKSPACE !== "false";
}

// Create proxy server
const server = http.createServer((req, res) => {
  const pathname = req.url?.split("?")[0] || "/";
  const isPluginReq = PLUGIN_ENDPOINTS.includes(pathname) || PLUGIN_PREFIXES.some(p => pathname.startsWith(p));

  logSleepInbound(req, pathname, isPluginReq ? "plugin" : "");

  // Handle login page
  if (pathname === "/login") {
    if (req.method === "GET") {
      handleLoginPage(res);
      return;
    }
    if (req.method === "POST") {
      collectRequestBody(req).then(body => {
        const form = parseForm(body);
        if (!timingSafeEqual(form.username, USERNAME) || !timingSafeEqual(form.password, PASSWORD)) {
          handleLoginPage(res, "Invalid username or password.");
          return;
        }
        const token = createSessionToken();
        res.writeHead(302, {
          "Set-Cookie": sessionCookieValue(token, SESSION_TTL_SECONDS),
          Location: workspaceEntryPath(),
        });
        res.end();
      });
      return;
    }
    res.writeHead(405);
    res.end();
    return;
  }

  // Authenticate
  if (requestNeedsAuth(pathname, isPluginReq) && !isAuthenticated(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${AUTH_REALM}"`,
    });
    res.end();
    return;
  }

  touchActivity();

  // Skip the broken empty "Open project" picker by opening the workspace directly.
  if (shouldAutoOpenWorkspace(req, pathname)) {
    res.writeHead(302, { Location: workspaceEntryPath() });
    res.end();
    return;
  }

  if (process.env.DEBUG_PROXY) {
    console.log(`[proxy] ${req.method} ${req.url}`);
  }

  const targetPort = isPluginReq ? PLUGIN_PORT : INTERNAL_PORT;
  proxyRequest(req, res, targetPort);
});

// WebSocket upgrade handling
server.on('upgrade', (req, socket, head) => {
  logSleepInbound(req, pathnameOf(req.url), "upgrade");

  if (!isAuthenticated(req)) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
    socket.end();
    return;
  }

  touchActivity();

  proxyWebSocketUpgrade({
    req,
    socket,
    head,
    targetPort: INTERNAL_PORT,
    onError: (err) => {
      console.error('[websocket error]', err.message);
    },
  });
});

// Start monitor script
function startMonitor() {
  const enableMonitor = process.env.ENABLE_MONITOR === "true";
  if (!enableMonitor) {
    return;
  }

  const { spawn } = require("child_process");
  const fs = require("fs");

  const monitorScript = "/app/monitor.sh";

  if (fs.existsSync(monitorScript)) {
    fs.chmodSync(monitorScript, 0o755);

    const logStream = fs.createWriteStream("/tmp/opencode_monitor.log", { flags: "a" });

    const monitor = spawn("bash", [monitorScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Only write error-level logs to console; write all logs to file
    monitor.stdout.on("data", (data) => {
      logStream.write(data.toString());
    });
    monitor.stderr.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line) {
          console.error("[monitor] " + line);
          logStream.write("[stderr] " + line + "\n");
        }
      }
    });

    monitor.on("error", (err) => {
      console.error("[wrapper] Monitor error:", err.message);
    });

    monitor.unref();
    fs.writeFileSync("/tmp/opencode_monitor.pid", monitor.pid.toString());
    console.log("[wrapper] Monitor started");
  }
}

// Wait for OpenCode startup
async function waitForOpencode(timeoutMs = Number(process.env.OPENCODE_START_TIMEOUT_MS || 120000)) {
  const start = Date.now();
  const authHeader = buildAuthHeader();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/global/health`, {
        headers: { "Authorization": authHeader },
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function parseBasicAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return;

  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) return;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (!user || pass === undefined) return;
  return { user, pass };
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function checkBasicAuth(req) {
  const auth = parseBasicAuth(req);
  if (!auth) return false;
  return timingSafeEqual(auth.user, USERNAME) && timingSafeEqual(auth.pass, PASSWORD);
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const cookies = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createSessionToken() {
  const payload = JSON.stringify({
    u: USERNAME,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
  const encoded = base64url(payload);
  return `${encoded}.${signSession(encoded)}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  const expected = signSession(encoded);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.u !== USERNAME) return false;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function hasValidSession(req) {
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
}

function isAuthenticated(req) {
  return checkBasicAuth(req) || hasValidSession(req);
}

function sessionCookieValue(token, maxAge) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  return attrs.join("; ");
}

function collectRequestBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

function parseForm(body) {
  const params = {};
  if (!body) return params;
  for (const part of body.split("&")) {
    const [key, value] = part.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value?.replace(/\+/g, " ") || "");
    }
  }
  return params;
}

function touchActivity() {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true });
    fs.writeFileSync(ACTIVITY_FILE, String(Date.now()));
  } catch {
    // Best-effort
  }
}

function pathnameOf(url) {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url?.split("?")[0] || "/";
  }
}

// Plugin endpoint list - these endpoints route to the plugin port
// Note: only match exact plugin endpoints to avoid conflicts with OpenCode endpoints like /global/health
const PLUGIN_ENDPOINTS = ['/register'];
const PLUGIN_PREFIXES = ['/register/'];
const PUBLIC_PATHS = new Set([
  "/favicon.ico",
  "/login",
  "/logout",
]);

function extractDirectoryFromURL(rawUrl) {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl, "http://localhost");
    return url.searchParams.get("directory") || url.searchParams.get("dir") || "";
  } catch {
    return "";
  }
}

function resolveRequestDirectory(req) {
  const fromUrl = extractDirectoryFromURL(req.url);
  if (fromUrl) return fromUrl;
  const fromReferer = extractDirectoryFromURL(req.headers.referer || req.headers.referrer);
  if (fromReferer) return fromReferer;
  return WORKSPACE;
}

// OpenCode web 1.14.x can throw "useGlobalSync must be used within GlobalSyncProvider"
// after opening a project (often on /session). The workspace UI still mounts underneath;
// dismiss that known overlay so Railway users can actually use the app.
const SPA_CRASH_PATCH = `<script data-oc-railway-patch="globalsync">
(function () {
  var NEEDLE = "useGlobalSync must be used within GlobalSyncProvider";
  function dismiss() {
    try {
      var nodes = document.querySelectorAll("h1");
      for (var i = 0; i < nodes.length; i++) {
        if ((nodes[i].textContent || "").indexOf("Something went wrong") === -1) continue;
        var root = nodes[i];
        for (var d = 0; d < 10 && root && root.parentElement; d++) {
          if (root.parentElement.id === "root") break;
          root = root.parentElement;
        }
        if (root && root.parentElement) root.remove();
        return true;
      }
    } catch (e) {}
    return false;
  }
  function watch() {
    if (dismiss()) return;
    var body = document.body;
    if (!body || typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function () {
      if ((document.body && document.body.innerText || "").indexOf(NEEDLE) !== -1) dismiss();
    });
    obs.observe(body, { childList: true, subtree: true });
    setTimeout(function () { try { obs.disconnect(); } catch (e) {} }, 15000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
</script>`;

function shouldPatchHtml(req, proxyRes) {
  if (process.env.OPENCODE_PATCH_GLOBALSYNC === "false") return false;
  if ((req.method || "GET") !== "GET" && (req.method || "GET") !== "HEAD") return false;
  const ct = String(proxyRes.headers["content-type"] || "");
  return ct.includes("text/html");
}

function proxyRequest(req, res, targetPort) {
  const forwardHeaders = { ...req.headers, Connection: "close" };
  // Keep remote web UI scoped to the Railway workspace even when the SPA
  // forgets to send x-opencode-directory (common on the project picker page).
  if (!forwardHeaders["x-opencode-directory"]) {
    forwardHeaders["x-opencode-directory"] = resolveRequestDirectory(req);
  }

  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: forwardHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    if (!shouldPatchHtml(req, proxyRes)) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8");
      if (html.includes("</body>") && !html.includes('data-oc-railway-patch="globalsync"')) {
        html = html.replace("</body>", `${SPA_CRASH_PATCH}</body>`);
      }
      const out = Buffer.from(html, "utf8");
      const headers = { ...proxyRes.headers, "content-length": String(out.length) };
      delete headers["content-encoding"];
      delete headers["transfer-encoding"];
      res.writeHead(proxyRes.statusCode, headers);
      res.end(out);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] Error proxying to port ${targetPort}:`, err.message);
    res.writeHead(502);
    res.end();
  });

  req.pipe(proxyReq);
}

// Start server
async function start() {
  // Wait for OpenCode startup
  console.log("[wrapper] Waiting for OpenCode to start...");
  const ready = await waitForOpencode();
  if (!ready) {
    console.error("[wrapper] OpenCode failed to start within timeout");
    process.exit(1);
  }
  console.log("[wrapper] OpenCode is ready");

  // Start monitor (after OpenCode is ready)
  startMonitor();

  // Start proxy server
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[wrapper] Proxy server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error("[wrapper] Failed to start:", err);
  process.exit(1);
});

// Graceful shutdown function
function gracefulShutdown(signal) {
  if (receivedSigterm) {
    console.log(`[wrapper] Already shutting down, ignoring ${signal}`);
    return;
  }
  receivedSigterm = true;

  console.log(`[wrapper] Received ${signal}, initiating graceful shutdown...`);

  // Close proxy server
  server.close(() => {
    console.log("[wrapper] Proxy server closed");
  });

  // Send SIGTERM to child process
  if (opencode.pid) {
    try {
      opencode.kill("SIGTERM");
      console.log("[wrapper] Sent SIGTERM to opencode");
    } catch (err) {
      console.error(`[wrapper] Failed to kill opencode: ${err.message}`);
    }
  }

  // Force exit after 5s timeout
  setTimeout(() => {
    console.error("[wrapper] Graceful shutdown timeout (5s), forcing exit");
    process.exit(1);
  }, 5000);
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Unexpected error handling
process.on("uncaughtException", (err) => {
  console.error("[wrapper] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("[wrapper] Unhandled rejection:", reason);
  gracefulShutdown("unhandledRejection");
});

/**
 * Workspace API server.
 *
 * Runs on port 3000 (the public-facing port).
 * Handles /api/workspace/* requests for file operations and git push.
 * Reverse-proxies everything else to the Next.js dev server on port 3001.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const API_PORT = parseInt(process.env.PORT || "3000", 10);
const DEV_PORT = 3001;
const WORKSPACE_DIR = "/workspace";

// File safety rules — must match ai-editor.ts
const BLOCKED_DIRS = new Set(["node_modules", ".next", ".git", "public"]);
const BLOCKED_FILES = new Set([
  ".env", ".env.local", ".env.production", ".gitignore",
  ".file-summaries.json", ".edit-timestamps.json",
  "package-lock.json", "tsconfig.tsbuildinfo",
]);
const ALLOWED_EXTENSIONS = new Set([
  ".tsx", ".ts", ".jsx", ".js", ".css", ".json", ".md",
]);

function isPathAllowed(filePath) {
  const parts = filePath.split("/").filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    if (BLOCKED_DIRS.has(part) || part.startsWith(".")) return false;
  }
  const fileName = parts[parts.length - 1];
  if (BLOCKED_FILES.has(fileName)) return false;
  const ext = path.extname(fileName).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function scanFiles(dir, rel = "") {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const relPath = rel ? `${rel}/${name}` : name;
    if (entry.isDirectory()) {
      if (BLOCKED_DIRS.has(name) || name.startsWith(".")) continue;
      results.push(...scanFiles(path.join(dir, name), relPath));
    } else {
      if (BLOCKED_FILES.has(name)) continue;
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      results.push(relPath);
    }
  }
  return results.sort();
}

// ── Request helpers ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

// ── API routes ──────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const route = url.pathname.replace("/api/workspace", "");

  // CORS preflight
  if (req.method === "OPTIONS") {
    json(res, 200, {});
    return;
  }

  // GET /api/workspace/files — list all editable files
  if (route === "/files" && req.method === "GET") {
    const files = scanFiles(WORKSPACE_DIR);
    json(res, 200, { files });
    return;
  }

  // GET /api/workspace/files/all — read ALL editable files in one request
  if (route === "/files/all" && req.method === "GET") {
    const filePaths = scanFiles(WORKSPACE_DIR);
    const files = {};
    for (const rel of filePaths) {
      files[rel] = fs.readFileSync(path.join(WORKSPACE_DIR, rel), "utf-8");
    }
    json(res, 200, { files });
    return;
  }

  // GET /api/workspace/file?path=... — read a single file
  if (route === "/file" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) return json(res, 400, { error: "Missing path param" });
    if (!isPathAllowed(filePath)) return json(res, 403, { error: "Path not allowed" });

    const absPath = path.join(WORKSPACE_DIR, filePath);
    if (!fs.existsSync(absPath)) return json(res, 404, { error: "File not found" });

    const content = fs.readFileSync(absPath, "utf-8");
    json(res, 200, { path: filePath, content });
    return;
  }

  // PUT /api/workspace/file — write a single file
  if (route === "/file" && req.method === "PUT") {
    const body = JSON.parse(await readBody(req));
    const { path: filePath, content } = body;
    if (!filePath || content === undefined)
      return json(res, 400, { error: "Missing path or content" });
    if (!isPathAllowed(filePath))
      return json(res, 403, { error: "Path not allowed" });

    const absPath = path.join(WORKSPACE_DIR, filePath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
    json(res, 200, { path: filePath, written: true });
    return;
  }

  // POST /api/workspace/files — write multiple files at once
  if (route === "/files" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const { files } = body; // Array of { path, content }
    if (!Array.isArray(files))
      return json(res, 400, { error: "Expected files array" });

    const written = [];
    const errors = [];
    let packageJsonChanged = false;

    for (const file of files) {
      if (!file.path || file.content === undefined) {
        errors.push({ path: file.path, error: "Missing path or content" });
        continue;
      }
      if (!isPathAllowed(file.path)) {
        errors.push({ path: file.path, error: "Path not allowed" });
        continue;
      }

      const absPath = path.join(WORKSPACE_DIR, file.path);
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, file.content, "utf-8");
      written.push(file.path);

      if (file.path === "package.json") packageJsonChanged = true;
    }

    // Auto npm install if package.json changed
    if (packageJsonChanged) {
      try {
        console.log("[workspace-api] package.json changed, running npm install...");
        execSync("npm install", { cwd: WORKSPACE_DIR, stdio: "pipe", timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
        console.log("[workspace-api] npm install complete");
      } catch (err) {
        console.error("[workspace-api] npm install failed:", err.message);
      }
    }

    json(res, 200, { written, errors });
    return;
  }

  // POST /api/workspace/git/push — commit and push changes to GitHub
  if (route === "/git/push" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const message = body.message || "Update from CloseHack AI Studio";

    const execOpts = { cwd: WORKSPACE_DIR, stdio: "pipe", maxBuffer: 10 * 1024 * 1024 };

    try {
      // Configure git
      execSync('git config user.email "studio@closehack.com"', execOpts);
      execSync('git config user.name "CloseHack Studio"', execOpts);
      execSync("git config gc.auto 0", execOpts); // disable auto-gc to prevent ENOBUFS

      // Stage all changes
      execSync("git add -A", execOpts);

      // Check if there are changes to commit
      try {
        execSync("git diff --cached --quiet", execOpts);
        // If the above succeeds, there are no staged changes
        json(res, 200, { pushed: false, message: "No changes to commit" });
        return;
      } catch {
        // There are staged changes — this is expected
      }

      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, execOpts);

      execSync("git push origin main", { ...execOpts, timeout: 30000 });

      json(res, 200, { pushed: true, message });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/workspace/status — health check
  if (route === "/status" && req.method === "GET") {
    json(res, 200, { status: "running", workspace: WORKSPACE_DIR });
    return;
  }

  json(res, 404, { error: "Not found" });
}

// ── Reverse proxy to Next.js dev server ─────────────────────────────────

function proxyToNextDev(req, res) {
  const options = {
    hostname: "127.0.0.1",
    port: DEV_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${DEV_PORT}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", () => {
    // Dev server not ready yet
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Dev server starting...");
  });

  req.pipe(proxyReq, { end: true });
}

// ── Main server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/workspace")) {
    try {
      await handleApi(req, res);
    } catch (err) {
      console.error("[workspace-api] Error:", err);
      json(res, 500, { error: err.message });
    }
  } else {
    proxyToNextDev(req, res);
  }
});

// Handle WebSocket upgrade for Next.js HMR
server.on("upgrade", (req, socket, head) => {
  const proxySocket = new net.Socket();
  proxySocket.connect(DEV_PORT, "127.0.0.1", () => {
    // Replay the upgrade request
    proxySocket.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
    );
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const val = req.rawHeaders[i + 1];
      if (key.toLowerCase() === "host") {
        proxySocket.write(`${key}: 127.0.0.1:${DEV_PORT}\r\n`);
      } else {
        proxySocket.write(`${key}: ${val}\r\n`);
      }
    }
    proxySocket.write("\r\n");
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxySocket.on("error", () => socket.end());
  socket.on("error", () => proxySocket.end());
});

server.listen(API_PORT, "0.0.0.0", () => {
  console.log(`[workspace-api] Listening on port ${API_PORT}`);
  console.log(`[workspace-api] Proxying to Next.js dev server on port ${DEV_PORT}`);
});

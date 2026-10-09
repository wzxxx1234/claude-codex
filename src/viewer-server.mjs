import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

import { redactSecrets } from "./redact.mjs";

const VIEWER_HOST = "127.0.0.1";

function renderHtml(sessionId) {
  const safeSessionId = JSON.stringify(String(sessionId)).replace(
    /</g,
    "\\u003c"
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex 执行过程</title>
  <style>
    :root {
      color-scheme: light;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #f5f7fa;
      color: #18212f;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid #d8dee8;
      background: #ffffff;
    }
    h1 {
      margin: 0;
      font-size: 17px;
      font-weight: 650;
    }
    #session {
      color: #5b6878;
      font-family: Consolas, monospace;
      font-size: 12px;
    }
    main {
      padding: 18px;
      overflow: auto;
    }
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
    }
    li {
      padding: 10px 12px;
      border: 1px solid #d8dee8;
      border-left: 3px solid #356a9c;
      border-radius: 6px;
      background: #ffffff;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    li[data-kind="error"] {
      border-left-color: #b42318;
    }
    li[data-kind="verification"] {
      border-left-color: #237a57;
    }
    footer {
      padding: 12px 18px;
      border-top: 1px solid #d8dee8;
      background: #ffffff;
    }
    button {
      min-height: 34px;
      padding: 0 14px;
      border: 1px solid #a73a32;
      border-radius: 6px;
      background: #ffffff;
      color: #8f2d27;
      font: inherit;
      cursor: pointer;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
  </style>
</head>
<body>
  <header>
    <h1>Codex 执行过程</h1>
    <span id="session"></span>
  </header>
  <main><ol id="events"></ol></main>
  <footer><button id="cancel" type="button">取消当前任务</button></footer>
  <script>
    const sessionId = ${safeSessionId};
    document.querySelector("#session").textContent = sessionId;
    const list = document.querySelector("#events");
    const source = new EventSource("/events/" + encodeURIComponent(sessionId) + location.search);
    source.addEventListener("normalized", (message) => {
      const event = JSON.parse(message.data);
      const item = document.createElement("li");
      item.dataset.kind = event.kind || "status";
      item.textContent = "[" + event.kind + "] " + event.text;
      list.append(item);
      item.scrollIntoView({ block: "nearest" });
    });
    const cancelButton = document.querySelector("#cancel");
    cancelButton.addEventListener("click", async () => {
      cancelButton.disabled = true;
      try {
        const response = await fetch(
          "/cancel/" + encodeURIComponent(sessionId) + location.search,
          { method: "POST" }
        );
        if (!response.ok) {
          throw new Error("cancel failed");
        }
      } finally {
        cancelButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function tokenMatches(actualToken, expectedToken) {
  if (typeof actualToken !== "string" || typeof expectedToken !== "string") {
    return false;
  }

  const actualHash = createHash("sha256").update(actualToken).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function parseRoute(requestUrl) {
  const url = new URL(requestUrl, `http://${VIEWER_HOST}`);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }

  try {
    return {
      action: segments[0],
      sessionId: decodeURIComponent(segments[1]),
      token: url.searchParams.get("token")
    };
  } catch {
    return null;
  }
}

function writeResponse(response, statusCode, headers, body = "") {
  response.writeHead(statusCode, headers);
  response.end(body);
}

function writeJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  writeResponse(
    response,
    statusCode,
    {
      "content-length": Buffer.byteLength(text),
      "content-type": "application/json; charset=utf-8"
    },
    text
  );
}

function redactEvent(event) {
  if (event && typeof event === "object" && !Array.isArray(event)) {
    try {
      return JSON.parse(redactSecrets(event));
    } catch {
      return event;
    }
  }

  return {
    kind: "status",
    text: redactSecrets(String(event ?? "")),
    rawType: "unknown",
    timestamp: new Date().toISOString()
  };
}

function openInBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", "start", "", url],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    );

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function createViewerServer({ sessionRoot, onCancel }) {
  if (!sessionRoot) {
    throw new Error("sessionRoot is required");
  }
  if (typeof onCancel !== "function") {
    throw new Error("onCancel is required");
  }

  const tokens = new Map();
  const subscribers = new Map();
  const openResponses = new Set();

  const server = http.createServer(async (request, response) => {
    const route = parseRoute(request.url ?? "/");
    if (!route || !["view", "events", "cancel"].includes(route.action)) {
      writeResponse(response, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }

    const expectedToken = tokens.get(route.sessionId);
    if (!tokenMatches(route.token, expectedToken)) {
      writeResponse(response, 401, { "content-type": "text/plain; charset=utf-8" }, "Unauthorized");
      return;
    }

    if (route.action === "view") {
      if (request.method !== "GET") {
        writeResponse(response, 405, { allow: "GET" }, "Method not allowed");
        return;
      }
      const html = renderHtml(route.sessionId);
      writeResponse(
        response,
        200,
        {
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(html),
          "content-security-policy":
            "default-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff"
        },
        html
      );
      return;
    }

    if (route.action === "events") {
      if (request.method !== "GET") {
        writeResponse(response, 405, { allow: "GET" }, "Method not allowed");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      response.write("retry: 1000\n\n");
      openResponses.add(response);
      const sessionSubscribers = subscribers.get(route.sessionId) ?? new Set();
      sessionSubscribers.add(response);
      subscribers.set(route.sessionId, sessionSubscribers);
      request.once("close", () => {
        sessionSubscribers.delete(response);
        openResponses.delete(response);
      });
      return;
    }

    if (request.method !== "POST") {
      writeResponse(response, 405, { allow: "POST" }, "Method not allowed");
      return;
    }

    try {
      await onCancel(route.sessionId);
      writeJson(response, 200, { cancelled: true, sessionId: route.sessionId });
    } catch (error) {
      writeJson(response, 500, {
        cancelled: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, VIEWER_HOST, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Viewer server did not expose a TCP address");
  }
  const port = address.port;

  function urlFor(sessionId, token) {
    if (!sessionId || !token) {
      throw new Error("sessionId and token are required");
    }
    tokens.set(String(sessionId), String(token));
    const url = new URL(`http://${VIEWER_HOST}:${port}/view/${encodeURIComponent(sessionId)}`);
    url.searchParams.set("token", token);
    return url.toString();
  }

  function publish(sessionId, event) {
    const sessionSubscribers = subscribers.get(String(sessionId));
    if (!sessionSubscribers || sessionSubscribers.size === 0) {
      return;
    }

    const payload = JSON.stringify(redactEvent(event));
    const frame = `event: normalized\ndata: ${payload}\n\n`;
    for (const response of sessionSubscribers) {
      response.write(frame);
    }
  }

  async function close() {
    for (const response of openResponses) {
      response.end();
      response.destroy();
    }
    openResponses.clear();
    subscribers.clear();

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  return {
    host: VIEWER_HOST,
    port,
    urlFor,
    publish,
    open: async (sessionId, token) => {
      await openInBrowser(urlFor(sessionId, token));
    },
    close
  };
}

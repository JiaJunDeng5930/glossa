import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const preview = resolve(root, "ui-preview");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg.startsWith("--")) {
    args.set(arg.slice(2), process.argv[index + 1]);
    index += 1;
  }
}

const host = args.get("host") ?? "127.0.0.1";
const preferredPort = Number(args.get("port") ?? 4173);
const pages = [
  { name: "translation", label: "翻译显示效果", port: preferredPort },
  { name: "settings", label: "设置页", port: preferredPort + 1 },
  { name: "popup", label: "插件弹窗", port: preferredPort + 2 }
];

for (const page of pages) {
  const server = createServer((request, response) => {
    void route(page.name, request.url ?? "/", response).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  server.listen(page.port, host, () => {
    console.log(`${page.label}: http://${host}:${page.port}/`);
  });
}

async function route(pageName, rawUrl, response) {
  const url = new URL(rawUrl, "http://localhost");
  const pathname = normalizePath(url.pathname);

  if (pathname === "/") {
    await sendPage(pageName, response);
    return;
  }

  if (pathname.startsWith("/ui-preview/")) {
    await sendStatic(response, preview, pathname.replace("/ui-preview/", ""));
    return;
  }
  if (pathname.startsWith("/assets/")) {
    await sendStatic(response, resolve(dist, "assets"), pathname.replace("/assets/", ""));
    return;
  }
  if (pathname === "/options.js" || pathname === "/popup.js") {
    await sendFile(response, resolve(dist, pathname.slice(1)));
    return;
  }
  if (pathname === "/options.js.map" || pathname === "/popup.js.map") {
    await sendFile(response, resolve(dist, pathname.slice(1)));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

async function sendPage(pageName, response) {
  if (pageName === "translation") {
    await sendFile(response, resolve(preview, "translation.html"));
    return;
  }
  if (pageName === "settings") {
    const html = await readFile(resolve(dist, "options/options.html"), "utf8");
    sendHtml(response, injectPreviewMocks(html)
      .replaceAll("../assets/options.css", "/assets/options.css")
      .replaceAll("../options.js", "/options.js"));
    return;
  }
  const html = await readFile(resolve(dist, "popup/popup.html"), "utf8");
  sendHtml(response, injectPreviewMocks(html)
    .replaceAll("../assets/popup.css", "/assets/popup.css")
    .replaceAll("../popup.js", "/popup.js"));
}

function injectPreviewMocks(html) {
  return html.replace("</head>", "    <script src=\"/ui-preview/chrome-mock.js\"></script>\n  </head>");
}

async function sendStatic(response, base, relativePath) {
  const target = resolve(base, relativePath);
  const safeBase = `${resolve(base)}${sep}`;
  if (!target.startsWith(safeBase)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  await sendFile(response, target);
}

async function sendFile(response, path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(path) });
    response.end(await readFile(path));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    throw error;
  }
}

function sendHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function normalizePath(pathname) {
  const normalized = normalize(decodeURIComponent(pathname)).replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function contentType(path) {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

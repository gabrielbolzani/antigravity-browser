const vscode = require('vscode');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

let currentPanel = null;
let proxyServer = null;
let proxyPort = 0;
let lastCapturedElement = null;
let statusBarItem = null;
let activeTargetOrigin = 'http://localhost:3000';
let activeTargetUrl = 'http://localhost:3000';
let portPollingInterval = null;

const CANDIDATE_PORTS = [3000, 5173, 8080, 8000, 4200, 3001, 5174, 5175, 8081, 8082, 9000, 1234, 4321, 8888, 5000, 5001];

function checkPortOpen(port, timeout = 350) {
  return new Promise((resolve) => {
    let settled = false;
    const tryHost = (host) => {
      if (settled) return;
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.on('connect', () => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(port);
        }
      });
      socket.on('timeout', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        if (!settled && host === '127.0.0.1') {
          // If IPv4 failed, test IPv6 ::1 (common on modern Windows Node servers)
          tryHost('::1');
        } else if (!settled) {
          settled = true;
          resolve(null);
        }
      });
      try {
        socket.connect(port, host);
      } catch (e) {
        if (!settled && host === '127.0.0.1') {
          tryHost('::1');
        } else if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    };
    tryHost('127.0.0.1');
  });
}

async function detectActivePorts() {
  const checks = CANDIDATE_PORTS.map(p => checkPortOpen(p));
  const results = await Promise.all(checks);
  return results.filter(Boolean);
}

function decompressBuffer(buffer, encoding) {
  return new Promise((resolve) => {
    if (!encoding || encoding === 'identity') return resolve(buffer);
    const enc = encoding.toLowerCase();
    if (enc.includes('gzip')) {
      zlib.gunzip(buffer, (err, decoded) => resolve(err ? buffer : decoded));
    } else if (enc.includes('deflate')) {
      zlib.inflate(buffer, (err, decoded) => resolve(err ? buffer : decoded));
    } else if (enc.includes('br')) {
      zlib.brotliDecompress(buffer, (err, decoded) => resolve(err ? buffer : decoded));
    } else {
      resolve(buffer);
    }
  });
}

function startProxyServer() {
  return new Promise((resolve, reject) => {
    if (proxyServer) {
      return resolve(proxyPort);
    }

    proxyServer = http.createServer(async (clientReq, clientRes) => {
      try {
        const reqUrl = url.parse(clientReq.url, true);

        let targetFullUrl = null;

        if (reqUrl.pathname === '/__agy_proxy__') {
          const targetUrlStr = reqUrl.query.url;
          if (!targetUrlStr) {
            clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
            return clientRes.end('Missing "url" parameter');
          }
          targetFullUrl = targetUrlStr;

          try {
            const parsed = url.parse(targetUrlStr);
            activeTargetOrigin = `${parsed.protocol}//${parsed.host}`;
            activeTargetUrl = targetUrlStr;
          } catch (e) {}
        } else {
          // Sub-resource request (CSS, JS, images, fonts, fetch requests, etc.)
          let base = activeTargetOrigin || 'http://localhost:3000';

          // Extract base from Referer if available
          if (clientReq.headers['referer']) {
            try {
              const refUrl = url.parse(clientReq.headers['referer'], true);
              if (refUrl.pathname === '/__agy_proxy__' && refUrl.query.url) {
                const refParsed = url.parse(refUrl.query.url);
                base = `${refParsed.protocol}//${refParsed.host}`;
              }
            } catch (e) {}
          }

          targetFullUrl = url.resolve(base, clientReq.url);
        }

        const targetUrl = url.parse(targetFullUrl);
        const isHttps = targetUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const headers = { ...clientReq.headers };
        headers.host = targetUrl.host;
        delete headers['if-none-match'];
        delete headers['if-modified-since'];
        headers['accept-encoding'] = 'gzip, deflate, identity';

        const proxyReq = transport.request({
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: targetUrl.path || '/',
          method: clientReq.method,
          headers: headers,
          rejectUnauthorized: false
        }, (proxyRes) => {
          // Handle redirects
          if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            const redirectUrl = url.resolve(targetFullUrl, proxyRes.headers.location);
            if (reqUrl.pathname === '/__agy_proxy__') {
              clientRes.writeHead(proxyRes.statusCode, {
                ...proxyRes.headers,
                location: `/__agy_proxy__?url=${encodeURIComponent(redirectUrl)}`,
                'access-control-allow-origin': '*'
              });
              return clientRes.end();
            } else {
              clientRes.writeHead(proxyRes.statusCode, {
                ...proxyRes.headers,
                location: redirectUrl,
                'access-control-allow-origin': '*'
              });
              return clientRes.end();
            }
          }

          const resHeaders = { ...proxyRes.headers };

          // Strip frame & security restrictions (CSP, X-Frame-Options, COOP, COEP)
          delete resHeaders['x-frame-options'];
          delete resHeaders['content-security-policy'];
          delete resHeaders['content-security-policy-report-only'];
          delete resHeaders['cross-origin-opener-policy'];
          delete resHeaders['cross-origin-embedder-policy'];
          delete resHeaders['cross-origin-resource-policy'];
          resHeaders['access-control-allow-origin'] = '*';
          resHeaders['access-control-allow-headers'] = '*';

          const contentType = (resHeaders['content-type'] || '').toLowerCase();

          if (contentType.includes('text/html')) {
            const bodyChunks = [];
            proxyRes.on('data', chunk => bodyChunks.push(chunk));
            proxyRes.on('end', async () => {
              try {
                const rawBuffer = Buffer.concat(bodyChunks);
                const decompressed = await decompressBuffer(rawBuffer, resHeaders['content-encoding']);
                let html = decompressed.toString('utf8');

                // Strip CSP and X-Frame-Options meta tags from HTML
                html = html.replace(/<meta\s+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
                html = html.replace(/<meta\s+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');

                // Read inspector.js directly from disk
                let inspectorContent = '';
                try {
                  inspectorContent = fs.readFileSync(path.join(__dirname, 'inspector.js'), 'utf8');
                } catch (e) {}

                // Injected script tag
                const injectedTag = `\n<!-- Antigravity Inspector Injected -->\n<script data-antigravity="true">\n${inspectorContent}\n</script>\n`;

                if (/<\/body>/i.test(html)) {
                  html = html.replace(/<\/body>/i, `${injectedTag}</body>`);
                } else if (/<\/html>/i.test(html)) {
                  html = html.replace(/<\/html>/i, `${injectedTag}</html>`);
                } else {
                  html += injectedTag;
                }

                const modifiedBuffer = Buffer.from(html, 'utf8');
                delete resHeaders['content-encoding'];
                delete resHeaders['transfer-encoding'];
                delete resHeaders['etag'];
                resHeaders['content-length'] = modifiedBuffer.length;
                resHeaders['cache-control'] = 'no-cache, no-store, must-revalidate';

                clientRes.writeHead(proxyRes.statusCode, resHeaders);
                clientRes.end(modifiedBuffer);
              } catch (err) {
                clientRes.writeHead(proxyRes.statusCode, resHeaders);
                clientRes.end(Buffer.concat(bodyChunks));
              }
            });
          } else {
            // CSS, JS, Images, Fonts, API responses, etc.
            clientRes.writeHead(proxyRes.statusCode, resHeaders);
            proxyRes.pipe(clientRes);
          }
        });

        proxyReq.on('error', (err) => {
          clientRes.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          clientRes.end(`
            <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; padding: 48px 24px; text-align: center; color: #f87171; background: #0b0f19; min-height: 100vh; box-sizing: border-box;">
              <div style="font-size: 40px; margin-bottom: 16px;">🔌</div>
              <h2 style="color: #f1f5f9; font-size: 20px; font-weight: 600; margin-bottom: 8px;">Não foi possível conectar a ${targetFullUrl}</h2>
              <p style="color: #94a3b8; font-size: 14px; max-width: 520px; margin: 0 auto 20px auto; line-height: 1.5;">
                Verifique se o seu servidor de desenvolvimento está em execução (ex: <code>npm run dev</code>).
              </p>
              <div style="display: inline-block; background: #1e293b; border: 1px solid #334155; padding: 8px 16px; border-radius: 6px; font-family: monospace; font-size: 12px; color: #cbd5e1;">
                ${err.message}
              </div>
            </div>
          `);
        });

        clientReq.pipe(proxyReq);
      } catch (e) {
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end(`Proxy error: ${e.message}`);
      }
    });

    // Handle WebSocket upgrade for Hot Module Reloading (Vite, Next.js, Webpack)
    proxyServer.on('upgrade', (req, socket, head) => {
      try {
        let target = activeTargetUrl || 'http://localhost:3000';
        const reqUrl = url.parse(req.url, true);
        if (reqUrl.pathname === '/__agy_proxy__' && reqUrl.query.url) {
          target = reqUrl.query.url;
        }
        const targetUrl = url.parse(target);
        const port = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
        const hostname = targetUrl.hostname === 'localhost' ? '127.0.0.1' : (targetUrl.hostname || '127.0.0.1');

        const targetSocket = net.connect(port, hostname, () => {
          targetSocket.write(
            `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
            Object.keys(req.headers)
              .map(k => `${k}: ${req.headers[k]}`)
              .join('\r\n') +
            '\r\n\r\n'
          );
          if (head && head.length > 0) {
            targetSocket.write(head);
          }
          targetSocket.pipe(socket);
          socket.pipe(targetSocket);
        });
        targetSocket.on('error', () => socket.destroy());
        socket.on('error', () => targetSocket.destroy());
      } catch (err) {
        socket.destroy();
      }
    });

    proxyServer.listen(0, '127.0.0.1', () => {
      proxyPort = proxyServer.address().port;
      resolve(proxyPort);
    });

    proxyServer.on('error', (e) => reject(e));
  });
}

function formatContextMarkdown(data) {
  let lines = [];
  const tagWithClass = `<${data.tagName}${data.id ? ' id="' + data.id + '"' : ''}${data.className ? ' class="' + data.className + '"' : ''}>`;

  lines.push(`### [Elemento UI Selecionado: \`${tagWithClass}\`]`);
  lines.push(`- **Tag**: \`${data.tagName}\``);
  if (data.id) lines.push(`- **ID**: \`#${data.id}\``);
  if (data.className) lines.push(`- **Classes**: \`${data.className}\``);
  if (data.cssSelector) lines.push(`- **Seletor CSS**: \`${data.cssSelector}\``);
  if (data.innerText) lines.push(`- **Texto no Elemento**: "${data.innerText.replace(/\n+/g, ' ')}"`);

  if (data.react && data.react.componentName) {
    lines.push(`- **Componente React**: \`<${data.react.componentName}>\``);
    if (data.react.fileName) {
      lines.push(`- **Arquivo Fonte**: \`${data.react.fileName}:${data.react.lineNumber || 1}\``);
    }
  } else if (data.vue && data.vue.componentName) {
    lines.push(`- **Componente Vue**: \`<${data.vue.componentName}>\``);
    if (data.vue.fileName) {
      lines.push(`- **Arquivo Fonte**: \`${data.vue.fileName}\``);
    }
  }

  if (data.html) {
    lines.push('\n```html');
    lines.push(data.html.trim());
    lines.push('```');
  }

  return lines.join('\n');
}

async function sendToAntigravityChat(formattedText) {
  try {
    await vscode.commands.executeCommand('antigravity.addContext', formattedText);
  } catch (err) {
    console.warn('[Antigravity Browser] antigravity.addContext command not found, falling back to clipboard.');
  }

  try {
    await vscode.commands.executeCommand('antigravity.panel.focus');
  } catch (err) {}
}

function getWebviewHtml(currentUrl, port, activePorts = []) {
  const proxyUrl = `http://127.0.0.1:${port}/__agy_proxy__?url=${encodeURIComponent(currentUrl)}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Browser Tab</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html {
      width: 100%; height: 100%; overflow: hidden;
      background-color: #0b0f19; color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; flex-direction: column;
    }

    /* Toolbar */
    .toolbar {
      height: 48px;
      background: #131a29;
      border-bottom: 1px solid #1e293b;
      display: flex;
      align-items: center;
      padding: 0 10px;
      gap: 8px;
      user-select: none;
      flex-shrink: 0;
      z-index: 20;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .toolbar::-webkit-scrollbar { display: none; }

    .btn {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      width: 30px;
      height: 30px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .btn:hover {
      background: #1e293b;
      color: #f8fafc;
    }

    /* URL input bar */
    .url-bar-container {
      flex: 1;
      display: flex;
      align-items: center;
      background: #0b0f19;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 3px 8px;
      gap: 6px;
      min-width: 140px;
    }
    .url-bar-container:focus-within {
      border-color: #38bdf8;
      box-shadow: 0 0 0 1px #38bdf8;
    }
    .url-icon { font-size: 13px; color: #64748b; }
    .url-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #f1f5f9;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      min-width: 60px;
    }

    /* Active Ports Badge */
    .ports-badge-container {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .port-chip {
      background: #1e3a5f;
      border: 1px solid #0284c7;
      color: #38bdf8;
      font-size: 11px;
      font-family: monospace;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .port-chip:hover {
      background: #0284c7;
      color: #ffffff;
      box-shadow: 0 0 8px rgba(2, 132, 199, 0.5);
    }
    .port-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4ade80;
    }

    /* Responsive View Switcher */
    .view-switch-container {
      display: flex;
      align-items: center;
      background: #0b0f19;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 2px;
      gap: 2px;
      flex-shrink: 0;
    }
    .view-tab {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
      user-select: none;
      flex-shrink: 0;
    }
    .view-tab * {
      pointer-events: none;
    }
    .view-tab:hover {
      color: #f1f5f9;
      background: #1e293b;
    }
    .view-tab.active {
      background: #0284c7;
      color: #ffffff;
      font-weight: 600;
      box-shadow: 0 0 8px rgba(2, 132, 199, 0.4);
    }
    .view-icon-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      width: 26px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .view-icon-btn * { pointer-events: none; }
    .view-icon-btn:hover {
      color: #f1f5f9;
      background: #1e293b;
    }

    /* Botão de Acionar/Desacionar Inspeção */
    .inspect-toggle-btn {
      background: #0b0f19;
      border: 1px solid #475569;
      color: #94a3b8;
      height: 32px;
      padding: 0 10px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      flex-shrink: 0;
    }
    .inspect-toggle-btn * { pointer-events: none; }
    .inspect-toggle-btn:hover {
      border-color: #38bdf8;
      color: #f1f5f9;
      background: #1e293b;
    }
    .inspect-toggle-btn .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #64748b;
      transition: all 0.2s ease;
    }

    /* Estado Ativo */
    .inspect-toggle-btn.active {
      background: #0284c7;
      border-color: #38bdf8;
      color: #ffffff;
      box-shadow: 0 0 14px rgba(56, 189, 248, 0.5);
    }
    .inspect-toggle-btn.active .status-dot {
      background: #4ade80;
      box-shadow: 0 0 8px #4ade80;
      animation: pulse 1.5s infinite;
    }

    /* Element Chip */
    .element-chip {
      display: none;
      align-items: center;
      gap: 6px;
      background: #1e3a5f;
      border: 1px solid #0284c7;
      color: #38bdf8;
      height: 30px;
      padding: 0 10px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      cursor: pointer;
      animation: fadeIn 0.2s ease;
      flex-shrink: 0;
    }
    .element-chip:hover {
      background: #0284c7;
      color: #ffffff;
    }
    .element-chip .chip-close {
      font-size: 14px;
      color: #94a3b8;
      margin-left: 2px;
    }
    .element-chip .chip-close:hover { color: #ef4444; }

    /* Selection Banner */
    .selection-banner {
      display: none;
      background: #0369a1;
      color: #ffffff;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 500;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #38bdf8;
      animation: slideDown 0.2s ease;
      flex-shrink: 0;
      z-index: 15;
    }
    .selection-banner.active {
      display: flex;
    }
    .selection-banner-close {
      cursor: pointer;
      background: rgba(0,0,0,0.25);
      border: none;
      color: #ffffff;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .selection-banner-close:hover {
      background: rgba(0,0,0,0.45);
    }

    /* Stage & Responsive Canvas */
    .browser-stage {
      flex: 1;
      position: relative;
      width: 100%;
      height: 100%;
      overflow: auto;
      display: flex;
      background: #090d16;
      box-sizing: border-box;
    }

    .browser-device-frame {
      display: flex;
      flex-direction: column;
      position: relative;
      background: #ffffff;
      transition: width 0.25s ease, height 0.25s ease;
    }

    /* Desktop Mode (100% full responsive) */
    .browser-stage.view-desktop {
      padding: 0;
    }
    .browser-stage.view-desktop .browser-device-frame {
      width: 100%;
      height: 100%;
      border: none;
      border-radius: 0;
      box-shadow: none;
      margin: 0;
      flex-shrink: 0;
    }

    /* Mobile Mode (iPhone 14: 390 x 844) */
    .browser-stage.view-mobile {
      padding: 24px;
    }
    .browser-stage.view-mobile .browser-device-frame {
      width: 390px;
      height: 844px;
      margin: auto;
      border: 8px solid #1e293b;
      border-radius: 36px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px #334155;
      overflow: hidden;
      background: #000;
      flex-shrink: 0;
    }
    .browser-stage.view-mobile.landscape .browser-device-frame {
      width: 844px;
      height: 390px;
    }

    /* Tablet Mode (iPad: 768 x 1024) */
    .browser-stage.view-tablet {
      padding: 24px;
    }
    .browser-stage.view-tablet .browser-device-frame {
      width: 768px;
      height: 1024px;
      margin: auto;
      border: 10px solid #1e293b;
      border-radius: 24px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px #334155;
      overflow: hidden;
      background: #000;
      flex-shrink: 0;
    }
    .browser-stage.view-tablet.landscape .browser-device-frame {
      width: 1024px;
      height: 768px;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #ffffff;
      flex: 1;
    }

    /* Bottom Context Drawer */
    .context-drawer {
      display: none;
      background: #131a29;
      border-top: 1px solid #1e293b;
      padding: 10px 16px;
      font-size: 12px;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      flex-shrink: 0;
      z-index: 10;
    }
    .context-drawer.visible {
      display: flex;
    }
    .drawer-info {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .drawer-tag {
      background: #0284c7;
      color: #ffffff;
      padding: 3px 8px;
      border-radius: 4px;
      font-family: monospace;
      font-weight: bold;
    }
    .drawer-text {
      color: #cbd5e1;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 450px;
    }
    .drawer-source {
      color: #38bdf8;
      font-family: monospace;
    }
    .drawer-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    .action-btn {
      background: #0b0f19;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .action-btn:hover {
      background: #1e293b;
      border-color: #38bdf8;
    }
    .action-btn.primary {
      background: #0284c7;
      border-color: #38bdf8;
      color: #ffffff;
      font-weight: 600;
    }
    .action-btn.primary:hover {
      background: #0369a1;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes slideDown {
      from { transform: translateY(-100%); }
      to { transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="btn" id="btn-back" title="Voltar">&#x2190;</button>
    <button class="btn" id="btn-forward" title="Avançar">&#x2192;</button>
    <button class="btn" id="btn-reload" title="Recarregar">&#x21bb;</button>

    <div class="url-bar-container">
      <span class="url-icon">&#x1f512;</span>
      <input type="text" class="url-input" id="url-input" value="${currentUrl}" placeholder="http://localhost:3000">
      <!-- Portas ativas detectadas automaticamente -->
      <div class="ports-badge-container" id="ports-badge-container"></div>
    </div>

    <!-- RESPONSIVE VIEW SWITCHER: PC / MOBILE / TABLET -->
    <div class="view-switch-container">
      <button class="view-tab active" id="view-desktop" title="Versão PC / Computador (100% da tela)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
        <span>PC</span>
      </button>
      <button class="view-tab" id="view-mobile" title="Versão Celular (390 × 844 px)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="5" y="2" width="14" height="20" rx="3" ry="3"></rect>
          <line x1="12" y1="18" x2="12" y2="18"></line>
        </svg>
        <span>Celular</span>
      </button>
      <button class="view-tab" id="view-tablet" title="Versão Tablet (768 × 1024 px)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect>
          <line x1="12" y1="18" x2="12" y2="18"></line>
        </svg>
        <span>Tablet</span>
      </button>
      <button class="view-icon-btn" id="view-rotate" title="Girar tela (Retrato / Paisagem)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
      </button>
    </div>

    <!-- BOTÃO PARA ACIONAR E DESACIONAR A SELEÇÃO -->
    <button class="inspect-toggle-btn" id="btn-inspect-toggle" title="Clique para ACIONAR ou DESACIONAR a seleção de elementos na tela">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
        <path d="M15 10l-3 3-1.5-1.5"></path>
      </svg>
      <span class="status-dot"></span>
      <span id="inspect-btn-text">Inspecionar: DESATIVADO</span>
    </button>

    <!-- Chip de elemento selecionado -->
    <div class="element-chip" id="element-chip" title="Clique para ver detalhes do elemento">
      <span id="chip-tag">&lt;div&gt;</span>
      <span class="chip-close" id="chip-clear" title="Limpar seleção">&times;</span>
    </div>

    <button class="btn" id="btn-external" title="Abrir no Navegador Externo">&#x2197;</button>
  </div>

  <!-- Banner informativo quando o modo de seleção está ativo -->
  <div class="selection-banner" id="selection-banner">
    <span>🎯 <b>Modo de Seleção Ativo:</b> Passe o mouse e clique no elemento que deseja inspecionar.</span>
    <button class="selection-banner-close" id="banner-cancel-btn">Desativar (ESC)</button>
  </div>

  <!-- Canvas Stage com suporte a PC / Celular / Tablet -->
  <div class="browser-stage view-desktop" id="browser-stage">
    <div class="browser-device-frame" id="browser-device-frame">
      <iframe id="browser-frame" src="${proxyUrl}" allow="fullscreen; clipboard-read; clipboard-write;"></iframe>
    </div>
  </div>

  <!-- Gaveta inferior com detalhes do elemento capturado -->
  <div class="context-drawer" id="context-drawer">
    <div class="drawer-info">
      <span class="drawer-tag" id="drawer-tag">&lt;div&gt;</span>
      <span class="drawer-text" id="drawer-text">Nenhum elemento selecionado</span>
      <span class="drawer-source" id="drawer-source"></span>
    </div>
    <div class="drawer-actions">
      <button class="action-btn" id="btn-open-file" style="display: none;">&#x1f4c2; Abrir Código</button>
      <button class="action-btn" id="btn-copy-clip">&#x1f4cb; Copiar Contexto</button>
      <button class="action-btn primary" id="btn-send-chat">&#x2728; Adicionar ao Chat</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('browser-frame');
    const browserStage = document.getElementById('browser-stage');
    const urlInput = document.getElementById('url-input');
    const portsBadgeContainer = document.getElementById('ports-badge-container');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const btnInspectToggle = document.getElementById('btn-inspect-toggle');
    const inspectBtnText = document.getElementById('inspect-btn-text');
    const selectionBanner = document.getElementById('selection-banner');
    const bannerCancelBtn = document.getElementById('banner-cancel-btn');
    const elementChip = document.getElementById('element-chip');
    const chipTag = document.getElementById('chip-tag');
    const chipClear = document.getElementById('chip-clear');
    const btnExternal = document.getElementById('btn-external');
    const drawer = document.getElementById('context-drawer');
    const drawerTag = document.getElementById('drawer-tag');
    const drawerText = document.getElementById('drawer-text');
    const drawerSource = document.getElementById('drawer-source');
    const btnOpenFile = document.getElementById('btn-open-file');
    const btnCopyClip = document.getElementById('btn-copy-clip');
    const btnSendChat = document.getElementById('btn-send-chat');

    // Device switcher tabs
    const viewDesktop = document.getElementById('view-desktop');
    const viewMobile = document.getElementById('view-mobile');
    const viewTablet = document.getElementById('view-tablet');
    const viewRotate = document.getElementById('view-rotate');

    let isInspectMode = false;
    let selectedElementData = null;
    let proxyPort = ${port};
    let initialPorts = ${JSON.stringify(activePorts)};

    function setViewMode(mode) {
      viewDesktop.classList.toggle('active', mode === 'desktop');
      viewMobile.classList.toggle('active', mode === 'mobile');
      viewTablet.classList.toggle('active', mode === 'tablet');

      const isLandscape = browserStage.classList.contains('landscape');
      browserStage.className = 'browser-stage view-' + mode + (isLandscape ? ' landscape' : '');
    }

    viewDesktop.addEventListener('click', (e) => {
      e.preventDefault();
      setViewMode('desktop');
    });
    viewMobile.addEventListener('click', (e) => {
      e.preventDefault();
      setViewMode('mobile');
    });
    viewTablet.addEventListener('click', (e) => {
      e.preventDefault();
      setViewMode('tablet');
    });
    viewRotate.addEventListener('click', (e) => {
      e.preventDefault();
      browserStage.classList.toggle('landscape');
    });

    function renderActivePorts(ports) {
      portsBadgeContainer.innerHTML = '';
      if (!ports || ports.length === 0) return;
      ports.forEach(p => {
        const chip = document.createElement('div');
        chip.className = 'port-chip';
        chip.title = 'Servidor detectado na porta ' + p + '. Clique para conectar.';
        chip.innerHTML = '<span class="port-dot"></span>⚡ :' + p;
        chip.addEventListener('click', () => {
          navigate('http://localhost:' + p);
        });
        portsBadgeContainer.appendChild(chip);
      });
    }

    renderActivePorts(initialPorts);

    function navigate(rawUrl) {
      let target = rawUrl.trim();
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        target = 'http://' + target;
      }
      urlInput.value = target;
      iframe.src = 'http://127.0.0.1:' + proxyPort + '/__agy_proxy__?url=' + encodeURIComponent(target);
    }

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate(urlInput.value);
    });

    btnBack.addEventListener('click', () => {
      try { iframe.contentWindow.history.back(); } catch(e) {}
    });
    btnForward.addEventListener('click', () => {
      try { iframe.contentWindow.history.forward(); } catch(e) {}
    });
    btnReload.addEventListener('click', () => {
      navigate(urlInput.value);
      vscode.postMessage({ type: 'REFRESH_PORTS' });
    });

    btnExternal.addEventListener('click', () => {
      vscode.postMessage({ type: 'NAVIGATE_EXTERNAL', url: urlInput.value });
    });

    function postInspectStateToIframe() {
      try {
        iframe.contentWindow.postMessage({
          type: 'AGY_SET_INSPECT_MODE',
          enabled: isInspectMode
        }, '*');
      } catch (err) {}
    }

    // Função de Acionar / Desacionar o Inspetor
    function toggleInspectMode(forceState) {
      isInspectMode = typeof forceState === 'boolean' ? forceState : !isInspectMode;

      if (isInspectMode) {
        btnInspectToggle.classList.add('active');
        inspectBtnText.textContent = 'Seleção: ATIVA (Clique no item)';
        selectionBanner.classList.add('active');
      } else {
        btnInspectToggle.classList.remove('active');
        inspectBtnText.textContent = 'Inspecionar: DESATIVADO';
        selectionBanner.classList.remove('active');
      }

      postInspectStateToIframe();
    }

    btnInspectToggle.addEventListener('click', (e) => {
      e.preventDefault();
      toggleInspectMode();
    });
    bannerCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleInspectMode(false);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isInspectMode) {
        toggleInspectMode(false);
      }
    });

    // Mensagens vindas do iframe injetado ou do host da extensão
    window.addEventListener('message', (event) => {
      if (!event.data || typeof event.data !== 'object') return;

      if (event.data.type === 'ACTIVE_PORTS_UPDATED') {
        renderActivePorts(event.data.ports);
      }

      if (event.data.type === 'TOGGLE_INSPECT') {
        toggleInspectMode();
      }

      if (event.data.type === 'AGY_INSPECTOR_READY') {
        if (isInspectMode) {
          postInspectStateToIframe();
        }
      }

      if (event.data.type === 'AGY_DISABLE_INSPECTOR') {
        toggleInspectMode(false);
      }

      if (event.data.type === 'AGY_URL_CHANGED') {
        try {
          const u = new URL(event.data.url);
          const realUrl = u.searchParams.get('url');
          if (realUrl) {
            urlInput.value = realUrl;
            vscode.postMessage({ type: 'TARGET_URL_CHANGED', url: realUrl });
          }
        } catch (e) {}
      }

      if (event.data.type === 'AGY_ELEMENT_SELECTED') {
        selectedElementData = event.data.data;
        updateSelectedElementUI(selectedElementData);
        toggleInspectMode(false);

        vscode.postMessage({
          type: 'ELEMENT_CAPTURED',
          data: selectedElementData
        });
      }
    });

    function updateSelectedElementUI(data) {
      if (!data) {
        elementChip.style.display = 'none';
        drawer.classList.remove('visible');
        return;
      }

      const shortClass = data.className ? '.' + data.className.trim().split(' ')[0] : '';
      const tagText = '<' + data.tagName + shortClass + '>';
      chipTag.textContent = tagText;
      elementChip.style.display = 'inline-flex';

      drawerTag.textContent = tagText;
      drawerText.textContent = data.innerText || data.cssSelector || '';

      if (data.react && data.react.fileName) {
        drawerSource.textContent = data.react.fileName.split(/[\\\\/]/).pop() + ':' + (data.react.lineNumber || 1);
        btnOpenFile.style.display = 'inline-flex';
      } else {
        drawerSource.textContent = '';
        btnOpenFile.style.display = 'none';
      }

      drawer.classList.add('visible');
    }

    chipClear.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedElementData = null;
      updateSelectedElementUI(null);
    });

    elementChip.addEventListener('click', () => {
      drawer.classList.toggle('visible');
    });

    btnSendChat.addEventListener('click', () => {
      if (!selectedElementData) return;
      vscode.postMessage({ type: 'SEND_TO_CHAT', data: selectedElementData });
    });

    btnCopyClip.addEventListener('click', () => {
      if (!selectedElementData) return;
      vscode.postMessage({ type: 'COPY_CONTEXT', data: selectedElementData });
    });

    btnOpenFile.addEventListener('click', () => {
      if (selectedElementData?.react?.fileName) {
        vscode.postMessage({
          type: 'OPEN_SOURCE_FILE',
          file: selectedElementData.react.fileName,
          line: selectedElementData.react.lineNumber || 1
        });
      }
    });

    iframe.addEventListener('load', () => {
      if (isInspectMode) {
        postInspectStateToIframe();
        setTimeout(postInspectStateToIframe, 300);
        setTimeout(postInspectStateToIframe, 800);
      }
    });
  </script>
</body>
</html>`;
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity-browser.open';
  statusBarItem.text = '$(globe) Browser Tab';
  statusBarItem.tooltip = 'Abrir Navegador Embutido do Antigravity';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const openCmd = vscode.commands.registerCommand('antigravity-browser.open', async (targetUrl) => {
    const config = vscode.workspace.getConfiguration('antigravityBrowser');

    try {
      // 1. Detect active dev server ports on localhost
      const activePorts = await detectActivePorts();
      let defaultUrl = targetUrl;

      if (!defaultUrl) {
        const configured = config.get('defaultUrl') || 'http://localhost:3000';
        let configuredPort = 3000;
        try {
          const u = new URL(configured);
          configuredPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
        } catch (e) {}

        if (activePorts.includes(configuredPort)) {
          defaultUrl = configured;
        } else if (activePorts.length > 0) {
          defaultUrl = `http://localhost:${activePorts[0]}`;
          vscode.window.showInformationMessage(
            `Servidor de desenvolvimento detectado na porta ${activePorts[0]}! Conectando automaticamente.`
          );
        } else {
          defaultUrl = configured;
        }
      }

      // Update active origin and target URL
      activeTargetUrl = defaultUrl;
      try {
        const u = new URL(defaultUrl);
        activeTargetOrigin = `${u.protocol}//${u.host}`;
      } catch (e) {}

      const port = await startProxyServer();

      if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Two);
        currentPanel.webview.postMessage({
          type: 'ACTIVE_PORTS_UPDATED',
          ports: activePorts
        });
      } else {
        currentPanel = vscode.window.createWebviewPanel(
          'antigravityBrowser',
          'Browser Tab',
          vscode.ViewColumn.Two,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        );

        currentPanel.webview.html = getWebviewHtml(defaultUrl, port, activePorts);

        // Start continuous background port polling while open
        if (portPollingInterval) clearInterval(portPollingInterval);
        portPollingInterval = setInterval(async () => {
          if (!currentPanel) {
            clearInterval(portPollingInterval);
            portPollingInterval = null;
            return;
          }
          const freshPorts = await detectActivePorts();
          currentPanel.webview.postMessage({
            type: 'ACTIVE_PORTS_UPDATED',
            ports: freshPorts
          });
        }, 3500);

        currentPanel.onDidDispose(() => {
          if (portPollingInterval) {
            clearInterval(portPollingInterval);
            portPollingInterval = null;
          }
          currentPanel = null;
          vscode.commands.executeCommand('setContext', 'antigravityBrowserActive', false);
        }, null, context.subscriptions);

        currentPanel.webview.onDidReceiveMessage(async (message) => {
          switch (message.type) {
            case 'REFRESH_PORTS': {
              const freshPorts = await detectActivePorts();
              currentPanel?.webview.postMessage({
                type: 'ACTIVE_PORTS_UPDATED',
                ports: freshPorts
              });
              break;
            }

            case 'TARGET_URL_CHANGED': {
              if (message.url) {
                activeTargetUrl = message.url;
                try {
                  const u = new URL(message.url);
                  activeTargetOrigin = `${u.protocol}//${u.host}`;
                } catch (e) {}
              }
              break;
            }

            case 'ELEMENT_CAPTURED': {
              const data = message.data;
              lastCapturedElement = data;
              const formatted = formatContextMarkdown(data);

              const autoAdd = config.get('autoAddToChat') !== false;
              const autoClip = config.get('autoCopyToClipboard') !== false;
              const autoOpen = config.get('autoOpenSourceFile') !== false;

              if (autoClip) {
                await vscode.env.clipboard.writeText(formatted);
              }

              if (autoAdd) {
                await sendToAntigravityChat(formatted);
              }

              if (autoOpen && data.react && data.react.fileName) {
                try {
                  const doc = await vscode.workspace.openTextDocument(data.react.fileName);
                  const line = Math.max(0, (data.react.lineNumber || 1) - 1);
                  await vscode.window.showTextDocument(doc, {
                    selection: new vscode.Range(line, 0, line, 0),
                    preserveFocus: true
                  });
                } catch (e) {}
              }

              const actions = ['Ver no Chat'];
              if (data.react && data.react.fileName) actions.push('Abrir Código');

              vscode.window.showInformationMessage(
                `Elemento <${data.tagName}> capturado e pronto no Antigravity!`,
                ...actions
              ).then(choice => {
                if (choice === 'Ver no Chat') {
                  vscode.commands.executeCommand('antigravity.panel.focus');
                } else if (choice === 'Abrir Código' && data.react?.fileName) {
                  vscode.workspace.openTextDocument(data.react.fileName).then(doc => {
                    vscode.window.showTextDocument(doc, {
                      selection: new vscode.Range((data.react.lineNumber || 1) - 1, 0, (data.react.lineNumber || 1) - 1, 0)
                    });
                  });
                }
              });
              break;
            }

            case 'SEND_TO_CHAT': {
              const formatted = formatContextMarkdown(message.data);
              await sendToAntigravityChat(formatted);
              vscode.window.showInformationMessage(`Contexto adicionado ao Antigravity Chat!`);
              break;
            }

            case 'COPY_CONTEXT': {
              const formatted = formatContextMarkdown(message.data);
              await vscode.env.clipboard.writeText(formatted);
              vscode.window.showInformationMessage(`Contexto copiado para a área de transferência!`);
              break;
            }

            case 'OPEN_SOURCE_FILE': {
              if (message.file) {
                try {
                  const doc = await vscode.workspace.openTextDocument(message.file);
                  const line = Math.max(0, (message.line || 1) - 1);
                  await vscode.window.showTextDocument(doc, {
                    selection: new vscode.Range(line, 0, line, 0)
                  });
                } catch (err) {
                  vscode.window.showErrorMessage(`Não foi possível abrir o arquivo: ${message.file}`);
                }
              }
              break;
            }

            case 'NAVIGATE_EXTERNAL': {
              if (message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
              }
              break;
            }
          }
        }, null, context.subscriptions);
      }

      vscode.commands.executeCommand('setContext', 'antigravityBrowserActive', true);
    } catch (err) {
      vscode.window.showErrorMessage(`Erro ao iniciar Antigravity Browser: ${err.message}`);
    }
  });

  const inspectCmd = vscode.commands.registerCommand('antigravity-browser.inspect', () => {
    if (currentPanel) {
      currentPanel.webview.postMessage({ type: 'TOGGLE_INSPECT' });
    } else {
      vscode.commands.executeCommand('antigravity-browser.open');
    }
  });

  context.subscriptions.push(openCmd, inspectCmd);
}

function deactivate() {
  if (portPollingInterval) {
    clearInterval(portPollingInterval);
    portPollingInterval = null;
  }
  if (proxyServer) {
    try {
      proxyServer.close();
    } catch (e) {}
    proxyServer = null;
  }
}

module.exports = {
  activate,
  deactivate
};

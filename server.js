/**
 * 1panel.status — multi-server proxy for 1Panel
 *
 * Reads /app/config.json (mounted from host), polls each configured 1Panel
 * instance every 2 seconds, and exposes ONE sanitized endpoint to the browser:
 *
 *   GET /api/servers   → [{ name, online, metrics:{...} }, ...]
 *
 * The browser never sees API keys, hostnames, IPs, or anything identifying.
 * Only the user-chosen display name and the requested metrics leave the box.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ───────────────────────── config ─────────────────────────
const CONFIG_PATH = process.env.CONFIG_PATH || '/app/config.json';
const LISTEN_PORT = parseInt(process.env.PORT || '5285', 10);
const POLL_MS     = 2000;   // fixed 2-second poll cadence
const REQ_TIMEOUT = parseInt(process.env.REQ_TIMEOUT_MS || '6000', 10);

let servers = [];
try {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  servers = Array.isArray(parsed.servers) ? parsed.servers : [];
  if (!servers.length) console.warn('⚠ config.json has no servers');
} catch (e) {
  console.error('Failed to read config at', CONFIG_PATH, '-', e.message);
  process.exit(1);
}

// in-memory cache of latest sample per server (and previous one for rate calc)
const cache = new Map();   // id → { prev, cur, online }
servers.forEach((s, i) => {
  s.id = 's' + i;
  cache.set(s.id, { prev: null, cur: null, online: false });
});

// ───────────────────────── helpers ─────────────────────────
function md5(s){ return crypto.createHash('md5').update(s).digest('hex'); }

function panelGet(server, panelPath){
  return new Promise((resolve, reject) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const token = md5('1panel' + server.apiKey + ts);

    const lib = server.https ? https : http;
    const req = lib.request({
      host: server.host,
      port: server.port,
      path: panelPath,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        '1Panel-Token': token,
        '1Panel-Timestamp': ts,
      },
      rejectUnauthorized: false,
      timeout: REQ_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200){
          return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 120)));
        }
        try {
          const parsed = JSON.parse(body);
          // 1Panel wraps responses as { code, data, message } – unwrap if present
          const data = (parsed && Object.prototype.hasOwnProperty.call(parsed, 'data'))
            ? parsed.data
            : parsed;
          resolve(data);
        } catch (e) {
          reject(new Error('bad JSON: ' + e.message));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Reduce the raw payload to ONLY the metrics we expose. Nothing identifying:
// no mount paths, no device names, no IPs, no kernel info, etc.
function sanitize(currentInfo){
  if (!currentInfo) return null;
  const c = currentInfo;

  // Aggregate disks: sum all partitions (no paths/devices leaked)
  let diskTotal = 0, diskUsed = 0, diskFree = 0;
  if (Array.isArray(c.diskData)){
    for (const d of c.diskData){
      diskTotal += Number(d.total) || 0;
      diskUsed  += Number(d.used)  || 0;
      diskFree  += Number(d.free)  || 0;
    }
  }
  const diskPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

  return {
    sampledAt: Date.now(),                          // proxy clock, for rate calc
    // Raw boot-time string from 1Panel (RFC3339 / ISO-like). Parsed once
    // per server into a stable `bootTimeMs`; see pollOne(). The browser
    // computes uptime as "now - bootTimeMs", not from a server uptime counter,
    // so the badge ticks smoothly without poll-to-poll jitter.
    timeSinceUptime: c.timeSinceUptime || '',

    cpuPct:  Number(c.cpuUsedPercent) || 0,
    memPct:  Number(c.memoryUsedPercent) || 0,
    diskPct,
    loadPct: Number(c.loadUsagePercent) || 0,       // instantaneous load %

    // Cumulative network bytes since boot — used both for totals
    // and as the basis for the per-second rate calc below.
    netRecvTotal: Number(c.netBytesRecv) || 0,
    netSentTotal: Number(c.netBytesSent) || 0,
  };
}

async function pollOne(server){
  const slot = cache.get(server.id);
  try {
    const data = await panelGet(server, `/api/v2/dashboard/current/all/all`);
    const m = sanitize(data);
    if (!m) throw new Error('empty response');
    slot.prev = slot.cur;
    slot.cur = m;
    slot.online = true;

    // Boot time is fixed for the life of the OS — parse it once on the first
    // successful poll and reuse forever. If the host is rebooted, the proxy
    // container is expected to be restarted alongside it (or you can manually
    // restart 1panel-status); we deliberately do NOT re-derive bootTimeMs on
    // every poll, because the 1Panel-reported string can drift by a second or
    // two between samples and we don't want the uptime badge to flicker.
    if (slot.bootTimeMs == null && m.timeSinceUptime){
      const t = Date.parse(m.timeSinceUptime);
      if (!isNaN(t)) slot.bootTimeMs = t;
    }
  } catch (e) {
    slot.online = false;
    // keep last known sample so the UI can show the last value if needed
  }
}

async function pollAll(){
  await Promise.all(servers.map(pollOne));
}

// Build the public payload: rates are computed here from prev/cur deltas.
function publicPayload(){
  return servers.map((s) => {
    const slot = cache.get(s.id);
    const cur = slot.cur;
    let downRate = 0, upRate = 0;
    if (cur && slot.prev){
      const dt = (cur.sampledAt - slot.prev.sampledAt) / 1000;
      if (dt > 0){
        downRate = Math.max(0, (cur.netRecvTotal - slot.prev.netRecvTotal) / dt);
        upRate   = Math.max(0, (cur.netSentTotal - slot.prev.netSentTotal) / dt);
      }
    }
    return {
      name: s.name,
      online: slot.online,
      // bootTimeMs is captured once (see pollOne) and is `null` until the very
      // first successful poll. The browser falls back to "—" while null.
      bootTimeMs: slot.bootTimeMs ?? null,
      metrics: cur ? {
        cpuPct:  cur.cpuPct,
        memPct:  cur.memPct,
        diskPct: cur.diskPct,
        loadPct: cur.loadPct,

        netRecvTotal: cur.netRecvTotal,
        netSentTotal: cur.netSentTotal,
        downRate,
        upRate,
      } : null,
    };
  });
}

// ───────────────────────── http server ─────────────────────────
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));

const server = http.createServer((req, res) => {
  if (req.url === '/api/servers'){
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(publicPayload()));
    return;
  }
  if (req.url === '/healthz'){
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/' || req.url === '/index.html'){
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }
  if (req.url === '/logo.png'){
    try {
    const buf = fs.readFileSync(path.join(__dirname, 'logo.png'));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
    return;
  } catch {}
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(LISTEN_PORT, () => {
  console.log(`1panel.status listening on :${LISTEN_PORT}`);
  console.log(`  servers configured: ${servers.length}`);
  servers.forEach((s, i) => console.log(`    [${i}] ${s.name}`));
});

// Start the poll loop immediately, then on a fixed 2s interval
pollAll();
setInterval(pollAll, POLL_MS);

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.CONFIG_PATH || '/app/config.json';
const LISTEN_PORT = parseInt(process.env.PORT || '5285', 10);
const POLL_MS     = 2000;
const REQ_TIMEOUT = parseInt(process.env.REQ_TIMEOUT_MS || '6000', 10);
const INDEX_PATH  = path.join(__dirname, 'index.html');
const LOGO_PATH   = path.join(__dirname, 'logo.png');

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

const cache = new Map();
servers.forEach((s, i) => {
  s.id = 's' + i;
  cache.set(s.id, { prev: null, cur: null, online: false, bootTimeMs: null });
});

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

function sanitize(base){
  if (!base) return null;
  const c = base.currentInfo || {};

  let diskTotal = 0, diskUsed = 0, diskFree = 0;
  if (Array.isArray(c.diskData)){
    for (const d of c.diskData){
      diskTotal += Number(d.total) || 0;
      diskUsed  += Number(d.used)  || 0;
      diskFree  += Number(d.free)  || 0;
    }
  }
  const diskPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

  const memTotal     = Number(c.memoryTotal)     || 0;
  const memUsed      = Number(c.memoryUsed)      || 0;
  const memAvailable = Number(c.memoryAvailable) || 0;

  return {
    sampledAt: Date.now(),
    timeSinceUptime: c.timeSinceUptime || '',

    cpu: {
      pct:          Number(c.cpuUsedPercent) || 0,
      model:        String(base.cpuModelName || ''),
      cores:        Number(base.cpuCores)        || 0,
      logicalCores: Number(base.cpuLogicalCores) || 0,
      mhz:          Number(base.cpuMhz)          || 0,
    },
    mem: {
      pct:       Number(c.memoryUsedPercent) || 0,
      total:     memTotal,
      used:      memUsed,
      available: memAvailable,
    },
    disk: {
      pct:   diskPct,
      total: diskTotal,
      used:  diskUsed,
      free:  diskFree,
    },
    load: {
      pct:    Number(c.loadUsagePercent) || 0,
      load1:  Number(c.load1)  || 0,
      load5:  Number(c.load5)  || 0,
      load15: Number(c.load15) || 0,
    },
    net: {
      recvTotal: Number(c.netBytesRecv) || 0,
      sentTotal: Number(c.netBytesSent) || 0,
    },
  };
}

async function pollOne(server){
  const slot = cache.get(server.id);
  try {
    const data = await panelGet(server, `/api/v2/dashboard/base/all/all`);
    const m = sanitize(data);
    if (!m) throw new Error('empty response');
    slot.prev = slot.cur;
    slot.cur = m;
    slot.online = true;

    if (slot.bootTimeMs == null && m.timeSinceUptime){
      const t = Date.parse(m.timeSinceUptime);
      if (!isNaN(t)) slot.bootTimeMs = t;
    }
  } catch (e) {
    slot.online = false;
  }
}

async function pollAll(){
  await Promise.all(servers.map(pollOne));
}

function publicPayload(){
  return servers.map((s) => {
    const slot = cache.get(s.id);
    const cur = slot.cur;
    let downRate = 0, upRate = 0;
    if (cur && slot.prev){
      const dt = (cur.sampledAt - slot.prev.sampledAt) / 1000;
      if (dt > 0){
        downRate = Math.max(0, (cur.net.recvTotal - slot.prev.net.recvTotal) / dt);
        upRate   = Math.max(0, (cur.net.sentTotal - slot.prev.net.sentTotal) / dt);
      }
    }
    return {
      name: s.name,
      online: slot.online,
      bootTimeMs: slot.bootTimeMs ?? null,
      metrics: cur ? {
        cpu:  cur.cpu,
        mem:  cur.mem,
        disk: cur.disk,
        load: cur.load,
        net: {
          recvTotal: cur.net.recvTotal,
          sentTotal: cur.net.sentTotal,
          downRate,
          upRate,
        },
      } : null,
    };
  });
}

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
    try {
      const buf = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('index.html read error: ' + e.message);
    }
    return;
  }
  if (req.url === '/logo.png'){
    try {
      const buf = fs.readFileSync(LOGO_PATH);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return;
    } catch {
      res.writeHead(404);
      res.end('not found');
      return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(LISTEN_PORT, () => {
  console.log(`1panel.status listening on :${LISTEN_PORT}`);
  console.log(`  servers configured: ${servers.length}`);
  servers.forEach((s, i) => console.log(`    [${i}] ${s.name}`));
});

pollAll();
setInterval(pollAll, POLL_MS);

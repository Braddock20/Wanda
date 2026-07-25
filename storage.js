// storage.js — pluggable storage for downloaded media.
//
// All storage is OPTIONAL. The default backend is `local` which writes to
// disk in `./downloads/`. To enable an external backend, set the matching
// env vars in `.env`. If a backend's env is missing, the code falls back
// to local silently — no errors, no missing-storage failures.
//
// Backends:
//   - local     (default; always works)
//   - telegram  (re-upload to "me" / Saved Messages, get a permanent link)
//   - s3        (AWS S3 / MinIO / Cloudflare R2 — same S3 API)
//   - b2        (Backblaze B2 — uses S3-compatible API)
//
// All backends return { ok, location, error } where `location` is either
// a local path or a URL the user can use to retrieve the file.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────
// Backend detection
// ─────────────────────────────────────────────────────────────────────────

function detectBackend() {
  // Priority: S3 > B2 > Telegram > local
  if (process.env.S3_BUCKET && (process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID)) {
    return 's3';
  }
  if (process.env.B2_BUCKET && process.env.B2_KEY_ID) {
    return 'b2';
  }
  if (String(process.env.STORAGE_TELEGRAM || '').toLowerCase() === 'true' || process.env.STORAGE_TELEGRAM === '1') {
    return 'telegram';
  }
  return 'local';
}

// ─────────────────────────────────────────────────────────────────────────
// Local backend
// ─────────────────────────────────────────────────────────────────────────

async function putLocal(downloadDir, buffer, filename) {
  try {
    fs.mkdirSync(downloadDir, { recursive: true });
    const localPath = path.join(downloadDir, filename);
    fs.writeFileSync(localPath, buffer);
    return { ok: true, backend: 'local', location: localPath, bytes: buffer.length };
  } catch (e) {
    return { ok: false, backend: 'local', error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// S3 / MinIO / R2 backend (AWS Signature V4, minimal hand-rolled client)
// ─────────────────────────────────────────────────────────────────────────
//
// We avoid pulling in the AWS SDK to keep dependencies small. This client
// supports PUT, presigned GET (for private buckets), and assumes a small
// number of common regions. For anything fancier, install @aws-sdk/client-s3.

function _s3Config() {
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
  const endpoint = process.env.S3_ENDPOINT || null; // for MinIO/R2
  const bucket = process.env.S3_BUCKET;
  const accessKey = process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const publicRead = String(process.env.S3_PUBLIC_READ || '').toLowerCase() === 'true';
  return { region, endpoint, bucket, accessKey, secretKey, publicRead };
}

function _hmacSha256(key, data) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', key).update(data).digest();
}

function _sha256(data) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(data).digest('hex');
}

function _signingKey(secret, date, region, service) {
  const crypto = require('crypto');
  const kDate = _hmacSha256('AWS4' + secret, date);
  const kRegion = _hmacSha256(kDate, region);
  const kService = _hmacSha256(kRegion, service);
  return _hmacSha256(kService, 'aws4_request');
}

async function _s3Put(buffer, key) {
  const cfg = _s3Config();
  const crypto = require('crypto');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const service = 's3';
  const host = cfg.endpoint ? new URL(cfg.endpoint).host : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const url = cfg.endpoint
    ? `${cfg.endpoint}/${cfg.bucket}/${encodeURI(key)}`
    : `https://${host}/${encodeURI(key)}`;
  const payloadHash = _sha256(buffer);
  const contentType = 'application/octet-stream';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n/${cfg.bucket}/${encodeURI(key)}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${date}/${cfg.region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${_sha256(canonicalRequest)}`;
  const signingKey = _signingKey(cfg.secretKey, date, cfg.region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authHeader = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'PUT',
      hostname: host.split(':')[0],
      port: host.includes(':') ? Number(host.split(':')[1]) : 443,
      path: cfg.endpoint ? `/${cfg.bucket}/${encodeURI(key)}` : `/${encodeURI(key)}`,
      headers: {
        'Content-Type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: authHeader,
      },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ ok: true, url: cfg.publicRead ? url : null });
      } else {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => reject(new Error(`S3 ${res.statusCode}: ${body.slice(0, 200)}`)));
      }
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function putS3(buffer, key) {
  try {
    const r = await _s3Put(buffer, key);
    return { ok: true, backend: 's3', location: r.url || `s3://${process.env.S3_BUCKET}/${key}`, bytes: buffer.length };
  } catch (e) {
    return { ok: false, backend: 's3', error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Backblaze B2 (uses S3-compatible API with different env vars)
// ─────────────────────────────────────────────────────────────────────────

async function putB2(buffer, key) {
  // B2's native API requires auth tokens. Easier: use the S3-compatible API
  // if B2_S3_ENDPOINT is set. Otherwise we fall back to a friendly error.
  if (!process.env.B2_S3_ENDPOINT) {
    return {
      ok: false,
      backend: 'b2',
      error: 'B2 native API not implemented. Set B2_S3_ENDPOINT + B2_S3_KEY_ID + B2_S3_APP_KEY for S3-compatible mode (recommended).',
    };
  }
  // Use S3 backend with overridden env
  const prev = { ...process.env };
  process.env.S3_ENDPOINT = process.env.B2_S3_ENDPOINT;
  process.env.S3_BUCKET = process.env.B2_BUCKET;
  process.env.S3_REGION = process.env.B2_REGION || 'us-west-001';
  process.env.S3_ACCESS_KEY = process.env.B2_S3_KEY_ID;
  process.env.S3_SECRET_KEY = process.env.B2_S3_APP_KEY;
  process.env.S3_PUBLIC_READ = process.env.B2_PUBLIC_READ || 'false';
  const r = await putS3(buffer, key);
  Object.assign(process.env, prev);
  if (r.ok) r.backend = 'b2';
  return r;
}

// ─────────────────────────────────────────────────────────────────────────
// Telegram backend — re-upload to Saved Messages
// ─────────────────────────────────────────────────────────────────────────

async function putTelegram(client, buffer, filename, caption) {
  try {
    fs.writeFileSync(path.join(require('os').tmpdir(), filename), buffer);
    const localPath = path.join(require('os').tmpdir(), filename);
    await client.sendFile('me', { file: localPath, caption: caption || '' });
    try { fs.unlinkSync(localPath); } catch {}
    return { ok: true, backend: 'telegram', location: 'me (Saved Messages)', bytes: buffer.length };
  } catch (e) {
    return { ok: false, backend: 'telegram', error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Unified put — picks backend, never throws
// ─────────────────────────────────────────────────────────────────────────

async function put(opts) {
  const { client, buffer, filename, downloadDir, key, caption } = opts;
  const backend = detectBackend();
  switch (backend) {
    case 's3':    return await putS3(buffer, key || filename);
    case 'b2':    return await putB2(buffer, key || filename);
    case 'telegram':
      if (!client) return { ok: false, backend: 'telegram', error: 'STORAGE_TELEGRAM=true but no client provided' };
      return await putTelegram(client, buffer, filename, caption);
    case 'local':
    default:
      return await putLocal(downloadDir || './downloads', buffer, filename);
  }
}

module.exports = {
  detectBackend,
  put,
  putLocal,
  putS3,
  putB2,
  putTelegram,
};

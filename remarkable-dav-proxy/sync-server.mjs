import http from "node:http"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { timingSafeEqual } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"

const execFileAsync = promisify(execFile)
const PORT = Number(process.env.PORT || 10000)
const SECRET = process.env.SYNC_TRIGGER_SECRET || ""
const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"))

function same(a, b) {
  const aa = Buffer.from(String(a || ""))
  const bb = Buffer.from(String(b || ""))
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb)
}

async function authorized(req) {
  if (same(req.headers["x-sync-secret"], SECRET)) return true

  const header = String(req.headers.authorization || "")
  if (!header.startsWith("Bearer ")) return false
  try {
    const { payload } = await jwtVerify(header.slice(7), GITHUB_JWKS, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: "remarkable-pdf-sync"
    })
    return payload.repository === "schlagskill/spoolpilot" && payload.ref === "refs/heads/main"
  } catch (error) {
    console.error("OIDC verification failed", error instanceof Error ? error.message : String(error))
    return false
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    res.end("ok")
    return
  }

  if (req.method !== "POST" || req.url !== "/run") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
    return
  }

  if (!await authorized(req)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" })
    res.end("unauthorized")
    return
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(process.cwd(), "sync-once.mjs")], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 180_000,
      maxBuffer: 1024 * 1024
    })
    const body = JSON.stringify({ ok: true, stdout: stdout.trim().slice(-1000), stderr: stderr.trim().slice(-1000) })
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) })
    res.end(body)
  } catch (error) {
    const body = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) })
    res.end(body)
  }
})

server.listen(PORT, "0.0.0.0", () => console.log(`PDF sync runner listening on ${PORT}`))

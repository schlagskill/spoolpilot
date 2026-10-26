import http from "node:http"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { timingSafeEqual } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { createClient } from "redis"

const execFileAsync = promisify(execFile)
const PORT = Number(process.env.PORT || 10000)
const SECRET = process.env.SYNC_TRIGGER_SECRET || ""
const AUTOMATION_SECRET = process.env.AUTOMATION_SECRET || ""
const REDIS_URL = process.env.REDIS_URL || "redis://red-dbfonubl550s739gmf70:6379"
const DAV_TASKS_URL = process.env.DAV_TASKS_URL || "https://remarkable-google-tasks-dav.onrender.com/dav/calendars/remarkable/tasks/"
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

function automationAuthorized(url) {
  return same(url.searchParams.get("token"), AUTOMATION_SECRET)
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

function property(lines, name) {
  const upper = name.toUpperCase()
  const line = lines.find(candidate => candidate.split(":", 1)[0]?.split(";", 1)[0]?.toUpperCase() === upper)
  if (!line) return ""
  const colon = line.indexOf(":")
  return colon >= 0 ? line.slice(colon + 1) : ""
}

function parseTasks(xml) {
  const tasks = []
  const re = /<c:calendar-data(?:\s[^>]*)?>([\s\S]*?)<\/c:calendar-data>/gi
  for (const match of xml.matchAll(re)) {
    const ical = decodeXml(match[1] || "")
    const lines = ical.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
    const title = property(lines, "SUMMARY")
      .replace(/\\n/gi, " ")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\")
      .trim() || "(ohne Titel)"
    const status = property(lines, "STATUS").trim().toUpperCase()
    if (status === "COMPLETED") continue
    const dueRaw = property(lines, "DUE").trim()
    const dueMatch = dueRaw.match(/^(\d{4})(\d{2})(\d{2})/)
    tasks.push({
      title,
      due: dueMatch ? `${dueMatch[1]}-${dueMatch[2]}-${dueMatch[3]}` : "",
      listTitle: /projekt|technik/i.test(title) ? "Projekte" : "Meine Aufgaben"
    })
  }
  return tasks
}

async function withRedis(fn) {
  const redis = createClient({ url: REDIS_URL })
  redis.on("error", err => console.error("redis", err))
  await redis.connect()
  try { return await fn(redis) } finally { try { await redis.quit() } catch {} }
}

async function fetchTasks(redis) {
  const auth = await redis.get("bridge:auth")
  if (!auth) throw new Error("Bridge login has not been captured yet")
  const query = `<?xml version="1.0" encoding="utf-8"?>\n<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\n  <d:prop><d:getetag/><c:calendar-data/></d:prop>\n  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>\n</c:calendar-query>`
  const response = await fetch(DAV_TASKS_URL, {
    method: "REPORT",
    headers: { authorization: auth, depth: "1", "content-type": "application/xml; charset=utf-8" },
    body: query
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Tasks query failed (${response.status}): ${text.slice(0, 300)}`)
  return parseTasks(text)
}

function clean(value, max = 600) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

function parseEvent(raw) {
  const [when = "", title = ""] = String(raw || "").split("|||", 2)
  return { start: clean(when, 80), title: clean(title, 220), allDay: false }
}

function parseMail(raw) {
  const parts = String(raw || "").split("|||")
  return {
    subject: clean(parts[0], 220),
    from: clean(parts[1], 220),
    snippet: clean(parts.slice(2).join("|||"), 600),
    relevant: true
  }
}

async function runSync() {
  return execFileAsync(process.execPath, [path.join(process.cwd(), "sync-once.mjs")], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 180_000,
    maxBuffer: 1024 * 1024
  })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      res.end("ok")
      return
    }

    if (req.method === "GET" && url.pathname === "/automation/tasks") {
      if (!automationAuthorized(url)) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
        return
      }
      const tasks = await withRedis(redis => fetchTasks(redis))
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ ok: true, tasks }))
      return
    }

    if (req.method === "GET" && url.pathname === "/automation/update") {
      if (!automationAuthorized(url)) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
        return
      }
      const events = url.searchParams.getAll("event").map(parseEvent).filter(e => e.title)
      const emails = url.searchParams.getAll("mail").map(parseMail).filter(e => e.subject)
      const result = await withRedis(async redis => {
        const tasks = await fetchTasks(redis)
        const payload = { generatedAt: new Date().toISOString(), tasks, events, emails }
        await redis.set("summary:payload", JSON.stringify(payload))
        const { stdout, stderr } = await runSync()
        return { tasks: tasks.length, events: events.length, emails: emails.length, stdout: stdout.trim().slice(-1000), stderr: stderr.trim().slice(-1000) }
      })
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ ok: true, ...result }))
      return
    }

    if (req.method !== "POST" || url.pathname !== "/run") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("not found")
      return
    }

    if (!await authorized(req)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" })
      res.end("unauthorized")
      return
    }

    const { stdout, stderr } = await runSync()
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

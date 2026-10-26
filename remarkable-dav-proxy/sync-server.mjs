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
const SUMMARY_TASKS_URL = process.env.SUMMARY_TASKS_URL || "https://remarkable-google-tasks.netlify.app/summary-tasks"
const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"))

function same(a, b) {
  const aa = Buffer.from(String(a || ""))
  const bb = Buffer.from(String(b || ""))
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb)
}

async function verifyGithubOidc(req, audience, repository, ref) {
  const header = String(req.headers.authorization || "")
  if (!header.startsWith("Bearer ")) return false
  try {
    const { payload } = await jwtVerify(header.slice(7), GITHUB_JWKS, {
      issuer: "https://token.actions.githubusercontent.com",
      audience
    })
    return payload.repository === repository && payload.ref === ref
  } catch (error) {
    console.error("OIDC verification failed", error instanceof Error ? error.message : String(error))
    return false
  }
}

async function authorized(req) {
  if (same(req.headers["x-sync-secret"], SECRET)) return true
  return verifyGithubOidc(req, "remarkable-pdf-sync", "schlagskill/spoolpilot", "refs/heads/main")
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

function normalizeSummaryTasks(tasks) {
  return tasks
    .filter(task => task && typeof task === "object")
    .map(task => {
      const title = String(task.title || "").trim() || "(ohne Titel)"
      const dueRaw = String(task.due || "").trim()
      const dueMatch = dueRaw.match(/^(\d{4})-(\d{2})-(\d{2})/)
      return {
        title,
        due: dueMatch ? `${dueMatch[1]}-${dueMatch[2]}-${dueMatch[3]}` : "",
        listTitle: String(task.listTitle || "Google Tasks").trim() || "Google Tasks"
      }
    })
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

  try {
    const summaryResponse = await fetch(SUMMARY_TASKS_URL, {
      headers: { authorization: auth, accept: "application/json" }
    })
    const summaryText = await summaryResponse.text()
    if (summaryResponse.ok) {
      const summary = summaryText ? JSON.parse(summaryText) : {}
      if (summary?.ok && Array.isArray(summary.tasks)) {
        const tasks = normalizeSummaryTasks(summary.tasks)
        console.log(`Google Tasks all-lists endpoint: ${tasks.length} open task(s)`)
        return tasks
      }
    } else if (summaryResponse.status !== 404) {
      console.warn(`All-lists Tasks endpoint unavailable (${summaryResponse.status}): ${summaryText.slice(0, 200)}`)
    }
  } catch (error) {
    console.warn("All-lists Tasks endpoint failed; falling back to DAV", error instanceof Error ? error.message : String(error))
  }

  const query = `<?xml version="1.0" encoding="utf-8"?>\n<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\n  <d:prop><d:getetag/><c:calendar-data/></d:prop>\n  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>\n</c:calendar-query>`
  const response = await fetch(DAV_TASKS_URL, {
    method: "REPORT",
    headers: { authorization: auth, depth: "1", "content-type": "application/xml; charset=utf-8" },
    body: query
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Tasks query failed (${response.status}): ${text.slice(0, 300)}`)
  const tasks = parseTasks(text)
  console.log(`Google Tasks DAV fallback: ${tasks.length} open task(s)`)
  return tasks
}

function clean(value, max = 600) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

function normalizeEvent(event) {
  return {
    start: clean(event?.start || event?.when, 100),
    title: clean(event?.title || event?.summary, 240),
    allDay: Boolean(event?.allDay)
  }
}

function normalizeMail(mail) {
  return {
    subject: clean(mail?.subject, 240),
    from: clean(mail?.from, 240),
    snippet: clean(mail?.snippet || mail?.summary, 700),
    relevant: mail?.relevant !== false
  }
}

function parseEvent(raw) {
  const [when = "", title = ""] = String(raw || "").split("|||", 2)
  return normalizeEvent({ start: when, title })
}

function parseMail(raw) {
  const parts = String(raw || "").split("|||")
  return normalizeMail({ subject: parts[0], from: parts[1], snippet: parts.slice(2).join("|||") })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 128 * 1024) throw new Error("payload too large")
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

async function runSync() {
  return execFileAsync(process.execPath, [path.join(process.cwd(), "sync-once.mjs")], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 180_000,
    maxBuffer: 1024 * 1024
  })
}

async function storeAndSync(events, emails) {
  return withRedis(async redis => {
    const tasks = await fetchTasks(redis)
    const payload = {
      generatedAt: new Date().toISOString(),
      tasks,
      events: (events || []).map(normalizeEvent).filter(e => e.title).slice(0, 100),
      emails: (emails || []).map(normalizeMail).filter(e => e.subject).slice(0, 10)
    }
    await redis.set("summary:payload", JSON.stringify(payload))
    const { stdout, stderr } = await runSync()
    return {
      tasks: payload.tasks.length,
      events: payload.events.length,
      emails: payload.emails.length,
      stdout: stdout.trim().slice(-1000),
      stderr: stderr.trim().slice(-1000)
    }
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
      const result = await storeAndSync(url.searchParams.getAll("event").map(parseEvent), url.searchParams.getAll("mail").map(parseMail))
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ ok: true, ...result }))
      return
    }

    if (req.method === "POST" && url.pathname === "/automation/update-json") {
      const ok = await verifyGithubOidc(req, "remarkable-summary-update", "schlagskill/Test", "refs/heads/retaskable-google-tasks-bridge")
      if (!ok) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }))
        return
      }
      const body = await readJsonBody(req)
      const result = await storeAndSync(Array.isArray(body.events) ? body.events : [], Array.isArray(body.emails) ? body.emails : [])
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

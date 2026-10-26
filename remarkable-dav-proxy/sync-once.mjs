import { createClient } from "redis"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"

const execFileAsync = promisify(execFile)
const REDIS_URL = process.env.REDIS_URL || "redis://red-dbfonubl550s739gmf70:6379"
const SUMMARY_DATA_URL = process.env.SUMMARY_DATA_URL || "https://remarkable-google-tasks.netlify.app/.netlify/functions/summary-data"
const RMAPI = process.env.RMAPI_BIN || path.join(process.cwd(), "bin", "rmapi")
const RMAPI_AUTH = process.env.RMAPI_AUTH || "https://webapp-prod.cloud.remarkable.engineering"
const CONFIG = "/tmp/remarkable-rmapi.yml"
const PDF = "/tmp/Zusammenfassung.pdf"

function parseTokenFile(text) {
  const device = /^devicetoken:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() || ""
  const user = /^usertoken:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() || ""
  return { device, user }
}

function safe(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[^\x20-\x7E\u00A0-\u00FF\u20AC\u2013\u2014\u2018\u2019\u201C\u201D]/g, "?")
}

function wrap(text, font, size, maxWidth) {
  const words = safe(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  const out = []
  let line = ""
  for (const word of words.length ? words : ["-"]) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
    } else {
      if (line) out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out
}

function fmtDate(value, allDay = false) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    ...(allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(date)
}

async function buildSummaryPdf(data) {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const W = 595.28
  const H = 841.89
  const M = 42
  const maxW = W - M * 2
  let page = pdf.addPage([W, H])
  let y = H - M

  const newPage = () => { page = pdf.addPage([W, H]); y = H - M }
  const ensure = h => { if (y - h < M + 10) newPage() }
  const line = (text, size = 11, font = regular, indent = 0) => {
    const rows = wrap(text, font, size, maxW - indent)
    ensure(rows.length * (size + 4) + 6)
    for (const row of rows) {
      page.drawText(row, { x: M + indent, y, size, font })
      y -= size + 4
    }
    y -= 3
  }
  const section = title => {
    ensure(35)
    y -= 5
    page.drawText(safe(title), { x: M, y, size: 15, font: bold })
    y -= 9
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7 })
    y -= 18
  }

  page.drawText("Zusammenfassung", { x: M, y, size: 24, font: bold })
  y -= 30
  line(`Aktualisiert: ${new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date())}`, 9)

  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const projectTasks = tasks.filter(t => /projekt|technik/i.test(`${t.listTitle || ""} ${t.title || ""}`))

  section("Aktuelle Projekte")
  if (!projectTasks.length) line("Keine offenen Projektaufgaben gefunden.")
  for (const task of projectTasks) {
    const due = task.due ? ` - fällig ${fmtDate(task.due, true)}` : ""
    line(`• ${task.title}${due}`, 11)
  }

  section("Offene Aufgaben")
  if (!tasks.length) line("Keine offenen Aufgaben gefunden.")
  for (const task of tasks.slice(0, 60)) {
    const list = task.listTitle ? ` [${task.listTitle}]` : ""
    const due = task.due ? ` - fällig ${fmtDate(task.due, true)}` : ""
    line(`☐ ${task.title}${list}${due}`, 11)
  }

  section("Nächste Termine - 7 Tage")
  const events = Array.isArray(data.events) ? data.events : []
  if (!events.length) line("Keine Termine in den nächsten 7 Tagen.")
  for (const event of events) {
    line(`• ${fmtDate(event.start, Boolean(event.allDay))} - ${event.title}`, 11)
  }

  section("Relevantes aus den letzten 10 E-Mails")
  const emails = (Array.isArray(data.emails) ? data.emails : []).filter(e => e.relevant)
  if (!emails.length) line("Keine relevanten Punkte in den letzten 10 E-Mails.")
  for (const email of emails.slice(0, 8)) {
    const from = email.from ? ` - ${email.from}` : ""
    line(`• ${email.subject}${from}`, 11, bold)
    if (email.snippet) line(email.snippet, 9, regular, 12)
  }

  const pages = pdf.getPages()
  pages.forEach((p, i) => p.drawText(`${i + 1} / ${pages.length}`, { x: W - M - 28, y: 22, size: 8, font: regular }))
  pdf.setTitle("Zusammenfassung")
  pdf.setSubject("Projekte, Aufgaben, Termine und relevante E-Mails")
  return Buffer.from(await pdf.save())
}

const redis = createClient({ url: REDIS_URL })
redis.on("error", err => console.error("redis", err))

let connected = false
try {
  await redis.connect()
  connected = true
  const [auth, deviceToken, userToken] = await Promise.all([
    redis.get("bridge:auth"),
    redis.get("rm:deviceToken"),
    redis.get("rm:userToken")
  ])

  if (!auth) throw new Error("Bridge login has not been captured yet")
  if (!deviceToken || !userToken) throw new Error("reMarkable Cloud is not paired yet")

  const summaryResponse = await fetch(SUMMARY_DATA_URL, { headers: { authorization: auth } })
  const summaryText = await summaryResponse.text()
  if (!summaryResponse.ok) throw new Error(`Summary data failed (${summaryResponse.status}): ${summaryText}`)
  const summary = JSON.parse(summaryText)
  if (!summary.ok) throw new Error(summary.error || "Summary data unavailable")

  const pdfBytes = await buildSummaryPdf(summary)
  await writeFile(PDF, pdfBytes)
  await writeFile(CONFIG, `devicetoken: ${JSON.stringify(deviceToken)}\nusertoken: ${JSON.stringify(userToken)}\n`, { mode: 0o600 })

  const { stdout, stderr } = await execFileAsync(RMAPI, ["put", "--content-only", PDF, "/"], {
    env: { ...process.env, RMAPI_AUTH, RMAPI_CONFIG: CONFIG },
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  })

  const refreshed = parseTokenFile(await readFile(CONFIG, "utf8"))
  const updates = []
  if (refreshed.device && refreshed.device !== deviceToken) updates.push(redis.set("rm:deviceToken", refreshed.device))
  if (refreshed.user && refreshed.user !== userToken) updates.push(redis.set("rm:userToken", refreshed.user))
  if (updates.length) await Promise.all(updates)

  const result = {
    ok: true,
    at: new Date().toISOString(),
    bytes: pdfBytes.length,
    tasks: summary.tasks?.length || 0,
    events: summary.events?.length || 0,
    relevantEmails: summary.emails?.filter?.(e => e.relevant)?.length || 0,
    stdout: stdout.trim().slice(-1000),
    stderr: stderr.trim().slice(-1000)
  }
  await redis.set("sync:last", JSON.stringify(result))
  console.log(JSON.stringify(result))
} catch (error) {
  const result = { ok: false, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }
  if (connected) {
    try { await redis.set("sync:last", JSON.stringify(result)) } catch {}
  }
  console.error(JSON.stringify(result))
  process.exitCode = 1
} finally {
  if (connected) {
    try { await redis.quit() } catch {}
  }
}

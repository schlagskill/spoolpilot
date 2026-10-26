import http from "node:http"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const PORT = Number(process.env.PORT || 10000)
const TUNNEL_URL = process.env.NETLIFY_TUNNEL_URL || "https://remarkable-google-tasks.netlify.app/dav-tunnel"
const CALENDAR_PATH = "/dav/calendars/remarkable/tasks/"

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function selectedHeaders(req) {
  const result = {}
  for (const name of ["depth", "content-type", "if-match", "if-none-match"]) {
    const value = req.headers[name]
    if (typeof value === "string") result[name] = value
  }
  return result
}

async function tunnel(auth, method, path, headers = {}, body = "") {
  const response = await fetch(TUNNEL_URL, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ method, path, headers, body })
  })
  return response
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

function unfoldIcal(text) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
}

function icalText(value) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
}

function property(lines, name) {
  const upper = name.toUpperCase()
  const line = lines.find(candidate => {
    const key = candidate.split(":", 1)[0]?.split(";", 1)[0]?.toUpperCase()
    return key === upper
  })
  if (!line) return ""
  const colon = line.indexOf(":")
  return colon >= 0 ? line.slice(colon + 1) : ""
}

function parseTasksFromMultistatus(xml) {
  const tasks = []
  const re = /<c:calendar-data(?:\s[^>]*)?>([\s\S]*?)<\/c:calendar-data>/gi
  for (const match of xml.matchAll(re)) {
    const ical = decodeXml(match[1] || "")
    const lines = unfoldIcal(ical)
    const title = icalText(property(lines, "SUMMARY")).trim() || "(ohne Titel)"
    const status = property(lines, "STATUS").trim().toUpperCase()
    const dueRaw = property(lines, "DUE").trim()
    const dueMatch = dueRaw.match(/^(\d{4})(\d{2})(\d{2})/)
    tasks.push({
      title,
      completed: status === "COMPLETED",
      due: dueMatch ? `${dueMatch[3]}.${dueMatch[2]}.${dueMatch[1]}` : ""
    })
  }
  return tasks
}

function pdfSafe(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/[^\x20-\x7E\u00A0-\u00FF\u20AC\u2013\u2014\u2018\u2019\u201C\u201D]/g, "?")
}

function wrap(text, font, size, maxWidth) {
  const words = pdfSafe(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  const out = []
  let line = ""
  for (const word of words.length ? words : ["(ohne Titel)"]) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
      continue
    }
    if (line) out.push(line)
    line = word
    while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
      let cut = line.length - 1
      while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut--
      out.push(line.slice(0, cut))
      line = line.slice(cut)
    }
  }
  if (line) out.push(line)
  return out
}

async function buildTasksPdf(tasks) {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const W = 595.28
  const H = 841.89
  const M = 44
  const maxW = W - M * 2
  let page = pdf.addPage([W, H])
  let y = H - M

  const addPage = () => {
    page = pdf.addPage([W, H])
    y = H - M
  }
  const ensure = h => { if (y - h < M) addPage() }

  page.drawText("Aufgaben", { x: M, y: y - 4, size: 24, font: bold, color: rgb(0, 0, 0) })
  y -= 33
  const stamp = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date())
  page.drawText(pdfSafe(`Aktualisiert: ${stamp}`), { x: M, y, size: 9, font: regular })
  y -= 27

  const drawSection = title => {
    ensure(34)
    page.drawText(pdfSafe(title), { x: M, y, size: 15, font: bold })
    y -= 8
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7 })
    y -= 17
  }

  const drawTask = (task, checked) => {
    const lines = wrap(task.title, regular, 12, maxW - 30)
    const meta = task.due ? `Faellig: ${task.due}` : ""
    ensure(lines.length * 16 + (meta ? 14 : 0) + 21)
    const bx = M + 2
    const by = y - 8
    page.drawRectangle({ x: bx, y: by, width: 10, height: 10, borderWidth: 1 })
    if (checked) {
      page.drawLine({ start: { x: bx + 2, y: by + 4 }, end: { x: bx + 4.5, y: by + 1.5 }, thickness: 1.2 })
      page.drawLine({ start: { x: bx + 4.5, y: by + 1.5 }, end: { x: bx + 9, y: by + 8 }, thickness: 1.2 })
    }
    let ty = y
    for (const line of lines) {
      page.drawText(line, { x: M + 22, y: ty, size: 12, font: regular })
      ty -= 16
    }
    if (meta) {
      page.drawText(pdfSafe(meta), { x: M + 22, y: ty, size: 9, font: regular })
      ty -= 14
    }
    y = ty - 7
  }

  const open = tasks.filter(t => !t.completed)
  const done = tasks.filter(t => t.completed)
  drawSection(`Offen (${open.length})`)
  if (!open.length) {
    page.drawText("Keine offenen Aufgaben.", { x: M, y, size: 11, font: regular })
    y -= 25
  } else {
    for (const task of open) drawTask(task, false)
  }

  if (done.length) {
    y -= 8
    drawSection(`Erledigt (${done.length})`)
    for (const task of done.slice(0, 50)) drawTask(task, true)
  }

  const pages = pdf.getPages()
  pages.forEach((p, i) => p.drawText(`${i + 1} / ${pages.length}`, { x: W - M - 28, y: 22, size: 8, font: regular }))
  pdf.setTitle("Aufgaben")
  pdf.setSubject("Aktuelle Google Tasks")
  return Buffer.from(await pdf.save())
}

async function livePdf(auth) {
  const calendarQuery = `<?xml version="1.0" encoding="utf-8"?>\n<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\n  <d:prop><d:getetag/><c:calendar-data/></d:prop>\n  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>\n</c:calendar-query>`
  const response = await tunnel(auth, "REPORT", CALENDAR_PATH, { depth: "1", "content-type": "application/xml; charset=utf-8" }, calendarQuery)
  const text = await response.text()
  if (!response.ok) throw new Error(`Tasks query failed (${response.status}): ${text}`)
  return buildTasksPdf(parseTasksFromMultistatus(text))
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      res.end("ok")
      return
    }

    const auth = req.headers.authorization
    if (!auth) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="reTaskable Google Tasks"' })
      res.end("Authentication required")
      return
    }

    if (req.method === "GET" && (req.url === "/aufgaben.pdf" || req.url === "/Aufgaben.pdf")) {
      const pdf = await livePdf(auth)
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="Aufgaben.pdf"',
        "cache-control": "no-store, max-age=0",
        "content-length": String(pdf.length)
      })
      res.end(pdf)
      return
    }

    const body = await readBody(req)
    const tunnelResponse = await tunnel(auth, req.method || "GET", req.url || "/", selectedHeaders(req), body)
    const responseBody = Buffer.from(await tunnelResponse.arrayBuffer())
    const responseHeaders = {}
    for (const name of ["content-type", "etag", "location", "dav", "allow", "www-authenticate"]) {
      const value = tunnelResponse.headers.get(name)
      if (value) responseHeaders[name] = value
    }
    responseHeaders["content-length"] = String(responseBody.length)
    res.writeHead(tunnelResponse.status, responseHeaders)
    res.end(responseBody)
  } catch (error) {
    console.error(error)
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    res.end(`Proxy error: ${error instanceof Error ? error.message : String(error)}`)
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DAV proxy listening on ${PORT}`)
})

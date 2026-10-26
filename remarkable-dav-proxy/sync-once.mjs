import { createClient } from "redis"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const execFileAsync = promisify(execFile)
const REDIS_URL = process.env.REDIS_URL || "redis://red-dbfonubl550s739gmf70:6379"
const PDF_URL = process.env.PDF_URL || "https://remarkable-google-tasks-dav.onrender.com/aufgaben.pdf"
const RMAPI = process.env.RMAPI_BIN || path.join(process.cwd(), "bin", "rmapi")
const CONFIG = "/tmp/remarkable-rmapi.yml"
const PDF = "/tmp/Aufgaben.pdf"

function parseTokenFile(text) {
  const device = /^devicetoken:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() || ""
  const user = /^usertoken:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() || ""
  return { device, user }
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

  const pdfResponse = await fetch(PDF_URL, {
    headers: { authorization: auth },
    redirect: "follow"
  })
  if (!pdfResponse.ok) {
    throw new Error(`PDF download failed (${pdfResponse.status}): ${await pdfResponse.text()}`)
  }
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer())
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("PDF endpoint did not return a PDF")
  }
  await writeFile(PDF, pdfBytes)
  await writeFile(CONFIG, `devicetoken: ${JSON.stringify(deviceToken)}\nusertoken: ${JSON.stringify(userToken)}\n`, { mode: 0o600 })

  const { stdout, stderr } = await execFileAsync(RMAPI, ["put", "--content-only", PDF, "/"], {
    env: { ...process.env, RMAPI_CONFIG: CONFIG },
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

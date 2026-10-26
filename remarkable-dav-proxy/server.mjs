import http from "node:http"

const PORT = Number(process.env.PORT || 10000)
const TUNNEL_URL = process.env.NETLIFY_TUNNEL_URL || "https://remarkable-google-tasks.netlify.app/dav-tunnel"

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

    const body = await readBody(req)
    const tunnelResponse = await fetch(TUNNEL_URL, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        method: req.method || "GET",
        path: req.url || "/",
        headers: selectedHeaders(req),
        body
      })
    })

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

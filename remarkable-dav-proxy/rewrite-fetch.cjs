const originalFetch = globalThis.fetch

if (typeof originalFetch === "function") {
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    let url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
    url = url.replace(
      "https://my.remarkable.com/token/json/2/",
      "https://webapp-prod.cloud.remarkable.engineering/token/json/2/"
    )

    const isDeviceRegistration = url.endsWith("/token/json/2/device/new")
    const isUserToken = url.endsWith("/token/json/2/user/new")
    let nextInit = { ...init }

    if (isDeviceRegistration || isUserToken) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
      headers.set("user-agent", "rmapi")

      if (isDeviceRegistration) {
        headers.set("authorization", "Bearer")
        headers.set("content-type", "application/octet-stream")
        if (typeof init.body === "string") {
          try {
            const payload = JSON.parse(init.body)
            payload.deviceDesc = "desktop-linux"
            nextInit.body = JSON.stringify(payload)
          } catch {}
        }
      }

      nextInit.headers = headers
    }

    let next = url
    if (input instanceof Request) {
      next = new Request(url, input)
    }

    const response = await originalFetch.call(globalThis, next, nextInit)
    if (!response.ok && (isDeviceRegistration || isUserToken)) {
      try {
        console.error("reMarkable auth error", response.status, await response.clone().text())
      } catch {}
    }
    return response
  }
}

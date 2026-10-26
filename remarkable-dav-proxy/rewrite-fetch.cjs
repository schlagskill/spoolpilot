const originalFetch = globalThis.fetch

if (typeof originalFetch === "function") {
  globalThis.fetch = function patchedFetch(input, init) {
    let next = input
    if (typeof input === "string") {
      next = input.replace(
        "https://my.remarkable.com/token/json/2/",
        "https://webapp-prod.cloud.remarkable.engineering/token/json/2/"
      )
    } else if (input instanceof Request) {
      const url = input.url.replace(
        "https://my.remarkable.com/token/json/2/",
        "https://webapp-prod.cloud.remarkable.engineering/token/json/2/"
      )
      if (url !== input.url) next = new Request(url, input)
    }
    return originalFetch.call(globalThis, next, init)
  }
}

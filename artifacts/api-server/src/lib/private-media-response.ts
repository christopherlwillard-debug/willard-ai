export function setPrivateMediaResponseHeaders(response: { setHeader(name: string, value: string): unknown }): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

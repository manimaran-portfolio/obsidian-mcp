import http from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest();

/** Bearer-token check, constant-time. */
export function authorized(header, token) {
  const m = /^Bearer (.+)$/.exec(header || "");
  return !!m && crypto.timingSafeEqual(sha(m[1]), sha(token));
}

/** Stateless Streamable HTTP: a fresh server + transport per request. Endpoint: POST /mcp. */
export function startHttp(buildServer, { host, port, token }) {
  if (!token || token.length < 24) throw new Error("OBSIDIAN_MCP_TOKEN must be set (24+ chars) for HTTP mode");
  const httpServer = http.createServer(async (req, res) => {
    const reply = (code, msg) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: msg }, id: null }));
    };
    if (new URL(req.url, "http://x").pathname !== "/mcp") return reply(404, "Not found");
    if (!authorized(req.headers.authorization, token)) return reply(401, "Unauthorized");
    if (req.method !== "POST") return reply(405, "Method not allowed");
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        if ((size += c.length) > 4_000_000) return reply(413, "Body too large");
        chunks.push(c);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) reply(400, "Bad request");
    }
  });
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve(httpServer));
  });
}

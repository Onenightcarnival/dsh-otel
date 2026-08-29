/**
 * End-to-end test of the test-export path against a local OTLP stub:
 * asserts a real protobuf POST with Basic auth reaches /v1/traces, and that
 * auth/connectivity failures surface as actionable messages.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildAuthHeaders, describeTestFailure, runTestExport } from "../lib/index.js";

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    received.push({
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      bytes: body.length
    });
    if (req.headers.authorization !== `Basic ${Buffer.from("pk:sk").toString("base64")}`) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-protobuf");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const endpoint = `http://127.0.0.1:${port}`;

// Success path.
const ok = await runTestExport({ endpoint, headers: buildAuthHeaders("pk", "sk") });
assert.equal(ok.ok, true, JSON.stringify(ok));
assert.equal(ok.traceEndpoint, `${endpoint}/v1/traces`);
assert.equal(received.length, 1);
assert.equal(received[0].url, "/v1/traces");
assert.match(received[0].contentType, /application\/x-protobuf/);
assert.ok(received[0].bytes > 50, "expected a non-trivial protobuf payload");

// Auth failure path.
const bad = await runTestExport({ endpoint, headers: buildAuthHeaders("pk", "wrong") });
assert.equal(bad.ok, false);
assert.match(describeTestFailure(bad.message), /认证失败|401/);

// Connectivity failure path (nothing listens on the next port).
server.close();
const dead = await runTestExport({ endpoint, headers: {} });
assert.equal(dead.ok, false);
assert.match(describeTestFailure(dead.message), /无法连接|ECONNREFUSED|超时|timed out/i);

console.log("export e2e tests passed");

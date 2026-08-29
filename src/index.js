/**
 * dsh-otel host half: a Typert Remote service named `dshOtel` that stores the
 * Langfuse/OTLP reporting configuration (public key, secret key, endpoint) in
 * the DSH storage domain and manages the embedded observability collector —
 * the Apache-2.0 licensed @loongsuite/dsh-plugin pipeline, bundled into this
 * package so the .tgz installs fully offline. Saving from the settings panel
 * hot-restarts the collector; a test action sends one span through a real
 * OTLP exporter so credentials and connectivity are verified end to end.
 */
import { Buffer } from "node:buffer";
import { Service } from "@deepseek-ai/cordis";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import * as collectorPlugin from "@loongsuite/dsh-plugin";

export const PLUGIN_VERSION = "0.1.3";

const CONFIG_KEY = "default";
const TEST_TIMEOUT_MS = 15000;

const configRecordSchema = z.object({
  endpoint: z.string(),
  publicKey: z.string(),
  secretKey: z.string(),
  enabled: z.boolean(),
  captureContent: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const configDomainSpec = defineDomain({
  name: "dsh_otel",
  version: 1,
  tables: {
    config: domainTable(configRecordSchema)
  }
});

function fail(code, message) {
  return { code, message };
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Langfuse API keys carry stable prefixes (pk-lf-… / sk-lf-…), which makes
 * them a hostname-independent signal — self-hosted instances on any domain
 * (localhost included) are recognized through the keys alone.
 */
export function isLangfuseKeyPair(publicKey, secretKey) {
  return /^pk-lf-/i.test(String(publicKey ?? "").trim())
    || /^sk-lf-/i.test(String(secretKey ?? "").trim());
}

/**
 * Normalize a user-pasted endpoint. Adds https:// when the scheme is missing,
 * strips trailing slashes, and — when the host looks like Langfuse or the
 * caller passes a Langfuse hint (pk-lf-/sk-lf- keys) — appends the
 * `/api/public/otel` OTLP base path the way the Langfuse SDKs do: onto
 * whatever base URL was given, gateway path prefixes included
 * (e.g. https://gateway.corp/langfuse → …/langfuse/api/public/otel).
 * A URL already ending in /api/public/otel, or pinned to an explicit signal
 * path (/v1/traces, /v1/metrics), is kept as-is — the signal form is also
 * the escape hatch when the auto-append is not wanted.
 */
export function normalizeEndpoint(raw, langfuseHint = false) {
  let value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (value === "") return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    const langfuse = langfuseHint || /langfuse/i.test(url.hostname);
    const hasOtelBase = /\/api\/public\/otel$/i.test(path);
    const isSignalUrl = /\/v1\/(?:traces|metrics)$/i.test(path);
    if (langfuse && !hasOtelBase && !isSignalUrl) {
      url.pathname = `${path}/api/public/otel`;
      return url.toString().replace(/\/+$/, "");
    }
    return value;
  } catch {
    return value;
  }
}

/** Langfuse ingests OTLP traces but not OTLP metrics; detect to mute metrics. */
export function isLangfuseEndpoint(endpoint) {
  return /langfuse/i.test(endpoint) || /\/api\/public\/otel\b/i.test(endpoint);
}

/** Basic auth header from a Langfuse-style pk/sk pair; empty when unset. */
export function buildAuthHeaders(publicKey, secretKey) {
  const pk = String(publicKey ?? "").trim();
  const sk = String(secretKey ?? "").trim();
  if (pk === "" && sk === "") return {};
  const token = Buffer.from(`${pk}:${sk}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/** Append the OTLP trace signal path unless the URL already names a signal. */
export function traceSignalUrl(endpoint) {
  const trimmed = String(endpoint ?? "").replace(/\/+$/, "");
  if (/\/v1\/(?:traces|metrics)$/i.test(trimmed)) {
    return trimmed.replace(/\/v1\/(?:traces|metrics)$/i, "/v1/traces");
  }
  return `${trimmed}/v1/traces`;
}

/** Map a stored config record onto the embedded collector's config shape. */
export function collectorConfigFrom(record) {
  const endpoint = normalizeEndpoint(
    record.endpoint,
    isLangfuseKeyPair(record.publicKey, record.secretKey)
  );
  return {
    enabled: true,
    endpoint,
    headers: buildAuthHeaders(record.publicKey, record.secretKey),
    captureContent: record.captureContent,
    // Langfuse has no OTLP metrics ingest; exporting there only produces
    // periodic 4xx noise, so metrics stay on solely for generic backends.
    exportMetrics: !isLangfuseEndpoint(endpoint)
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      timer.unref?.();
    })
  ]);
}

/**
 * Send one real span through a throwaway OTLP pipeline and report the export
 * result. On success the backend shows a trace named "dsh-otel connection
 * test", which doubles as visible confirmation in Langfuse.
 */
export async function runTestExport({ endpoint, headers }, exporterFactory) {
  const url = traceSignalUrl(endpoint);
  const makeExporter = exporterFactory
    ?? (() => new OTLPTraceExporter({ url, headers, timeoutMillis: 10000 }));
  const exporter = makeExporter(url);
  let capture = null;
  const wrapper = {
    export(spans, resultCallback) {
      exporter.export(spans, (result) => {
        capture = result;
        resultCallback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => Promise.resolve()
  };
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes({
      "service.name": "dsh-otel",
      "dsh.plugin": "dsh-otel"
    })),
    spanProcessors: [new SimpleSpanProcessor(wrapper)]
  });
  try {
    const tracer = provider.getTracer("dsh-otel");
    const span = tracer.startSpan("dsh-otel connection test");
    span.setAttribute("dsh.otel.test", true);
    span.end();
    await withTimeout(provider.forceFlush(), TEST_TIMEOUT_MS, "export timed out");
  } catch (error) {
    // A failed export rejects forceFlush; fold it into the captured result
    // instead of throwing so callers always get a { ok, message } verdict.
    if (capture === null) {
      const first = Array.isArray(error) ? error[0] : error;
      capture = { code: 1, error: first };
    }
  } finally {
    await provider.shutdown().catch(() => {});
  }
  // ExportResultCode.SUCCESS === 0 in @opentelemetry/core.
  if (capture !== null && capture.code === 0) {
    return { ok: true, traceEndpoint: url };
  }
  const message = capture?.error?.message ?? String(capture?.error ?? "export did not complete in time");
  return { ok: false, traceEndpoint: url, message };
}

/** Translate raw exporter failures into actionable operator guidance. */
export function describeTestFailure(message) {
  if (/status code 401|status code 403|Unauthorized|Forbidden/i.test(message)) {
    return `认证失败（${message}）——请检查 Public Key / Secret Key 是否正确、是否属于该项目`;
  }
  if (/status code 404/i.test(message)) {
    return `接口不存在（${message}）——请检查 Endpoint 路径（Langfuse 应为 …/api/public/otel；`
      + `经网关暴露时请确认网关转发了 /api/public/otel/* 路径）`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|socket hang up/i.test(message)) {
    return `无法连接到服务端（${message}）——请检查 Endpoint 地址与网络/代理`;
  }
  return message;
}

// ── service ─────────────────────────────────────────────────────────────────

/**
 * DshOtelService: one cordis service (and Typert Remote) that owns the
 * observability configuration and the embedded collector lifecycle.
 */
export default class DshOtelService extends TypertRemoteService {
  static inject = ["storageDomain"];

  configTable = null;
  collectorScope = null;
  lastError = null;
  /** Resolved trace endpoint of the running collector, for the status line. */
  activeTraceEndpoint = null;

  constructor(ctx, config = {}) {
    super(ctx, "dshOtel");
    this.config = config;
    ctx.effect(() => () => {
      this.stopCollector();
    }, "dsh-otel: stop embedded collector");
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(configDomainSpec);
    this.configTable = domain.table("config");
    this.ctx.effect(() => () => domain.close(), "dsh-otel: config domain close");
    const record = this.loadRecord();
    if (record) this.applyCollector(record);
    this.ctx.logger.info(
      `[dsh-otel] loaded; configured=${record !== null}; reporting=${this.collectorScope !== null ? "on" : "off"}`
    );
  }

  loadRecord() {
    const raw = this.configTable?.get(CONFIG_KEY);
    if (raw === undefined || raw === null) return null;
    const parsed = configRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  stopCollector() {
    const scope = this.collectorScope;
    this.collectorScope = null;
    this.activeTraceEndpoint = null;
    if (scope !== null) {
      try {
        scope.dispose();
      } catch (error) {
        this.ctx.logger.warn(`[dsh-otel] failed to dispose collector: ${String(error)}`);
      }
    }
  }

  applyCollector(record) {
    this.stopCollector();
    this.lastError = null;
    if (!record.enabled || record.endpoint.trim() === "") return;
    try {
      const raw = collectorConfigFrom(record);
      // Resolve schema defaults explicitly so the collector's apply() always
      // sees a complete config even if the runtime skips schema resolution.
      const resolved = collectorPlugin.Config(raw);
      this.collectorScope = this.ctx.plugin(collectorPlugin, resolved);
      this.activeTraceEndpoint = traceSignalUrl(raw.endpoint);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.ctx.logger.warn(`[dsh-otel] failed to start collector: ${this.lastError}`);
    }
  }

  statusValue() {
    const record = this.loadRecord();
    const value = {
      configured: record !== null,
      enabled: record?.enabled ?? false,
      endpoint: record?.endpoint ?? "",
      publicKey: record?.publicKey ?? "",
      secretKeySet: (record?.secretKey ?? "") !== "",
      captureContent: record?.captureContent ?? true,
      running: this.collectorScope !== null,
      version: PLUGIN_VERSION
    };
    // Strict Typert results must be JSON-safe: optional fields must be
    // absent, rather than present with an `undefined` value.
    if (this.activeTraceEndpoint !== null) value.traceEndpoint = this.activeTraceEndpoint;
    if (this.lastError !== null) value.lastError = this.lastError;
    return value;
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async status() {
    try {
      return { ok: true, value: this.statusValue() };
    } catch (error) {
      return { ok: false, error: fail("status-failed", String(error?.message ?? error)) };
    }
  }

  async save(request) {
    try {
      const table = this.configTable;
      if (table === null) {
        return { ok: false, error: fail("not-ready", "配置存储尚未就绪，请稍后重试") };
      }
      const previous = this.loadRecord();
      const secretKey = request.secretKey !== undefined
        ? request.secretKey.trim()
        : previous?.secretKey ?? "";
      const endpoint = normalizeEndpoint(
        request.endpoint,
        isLangfuseKeyPair(request.publicKey, secretKey)
      );
      if (request.enabled && endpoint === "") {
        return { ok: false, error: fail("endpoint-required", "启用上报需要填写 Endpoint") };
      }
      const now = new Date().toISOString();
      const record = {
        endpoint,
        publicKey: request.publicKey.trim(),
        secretKey,
        enabled: request.enabled,
        captureContent: request.captureContent,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(CONFIG_KEY, record);
      this.applyCollector(record);
      return { ok: true, value: this.statusValue() };
    } catch (error) {
      return { ok: false, error: fail("save-failed", String(error?.message ?? error)) };
    }
  }

  async test(request) {
    try {
      const secretKey = request.secretKey !== undefined
        ? request.secretKey.trim()
        : this.loadRecord()?.secretKey ?? "";
      const endpoint = normalizeEndpoint(
        request.endpoint,
        isLangfuseKeyPair(request.publicKey, secretKey)
      );
      if (endpoint === "") {
        return { ok: false, error: fail("endpoint-required", "请先填写 Endpoint") };
      }
      const headers = buildAuthHeaders(request.publicKey, secretKey);
      const result = await runTestExport({ endpoint, headers });
      if (result.ok) {
        return {
          ok: true,
          value: {
            message: "测试 Trace 已成功上报，可在平台上查看名为 \"dsh-otel connection test\" 的调用链",
            traceEndpoint: result.traceEndpoint
          }
        };
      }
      return {
        ok: false,
        error: fail(
          "test-failed",
          `${describeTestFailure(result.message)}（实际请求地址：${result.traceEndpoint}）`
        )
      };
    } catch (error) {
      return { ok: false, error: fail("test-failed", describeTestFailure(String(error?.message ?? error))) };
    }
  }
}

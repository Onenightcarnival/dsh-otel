/**
 * Settings → Plugins → 可观测上报: the native DSH configuration surface for
 * dsh-otel. Three primary fields (endpoint / public key / secret key), the
 * enable and content-capture switches, save with hot-restart, and a
 * one-click test that sends a real trace through the configured pipeline.
 */
import * as React from "react";

const { useCallback, useEffect, useState } = React;

const LANGFUSE_CLOUD_PLACEHOLDER = "https://cloud.langfuse.com/api/public/otel";

function emptyForm() {
  return {
    endpoint: "",
    publicKey: "",
    secretKey: "",
    // Becomes true once the user types into the secret field; until then an
    // already-saved secret is kept server-side and never echoed back.
    secretDirty: false,
    enabled: true,
    captureContent: true
  };
}

function statusToForm(status) {
  return {
    ...emptyForm(),
    endpoint: status.endpoint,
    publicKey: status.publicKey,
    enabled: status.configured ? status.enabled : true,
    captureContent: status.captureContent
  };
}

export function OtelSettings({ api }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: "ok" | "error", text }

  const refresh = useCallback(async () => {
    try {
      const value = await api.status();
      setStatus(value);
      setForm(statusToForm(value));
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", text: String(error?.message ?? error) });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patch = (changes) => setForm((prev) => ({ ...prev, ...changes }));

  const secretPayload = () =>
    form.secretDirty ? { secretKey: form.secretKey } : {};

  const handleSave = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const value = await api.save({
        endpoint: form.endpoint,
        publicKey: form.publicKey,
        enabled: form.enabled,
        captureContent: form.captureContent,
        ...secretPayload()
      });
      setStatus(value);
      setForm(statusToForm(value));
      setNotice({
        kind: "ok",
        text: value.running
          ? "已保存，上报已启动"
          : value.enabled
            ? `已保存，但采集器未能启动${value.lastError ? `：${value.lastError}` : ""}`
            : "已保存，上报当前为停用状态"
      });
    } catch (error) {
      setNotice({ kind: "error", text: String(error?.message ?? error) });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setNotice(null);
    try {
      const value = await api.test({
        endpoint: form.endpoint,
        publicKey: form.publicKey,
        ...secretPayload()
      });
      setNotice({ kind: "ok", text: value.message });
    } catch (error) {
      setNotice({ kind: "error", text: String(error?.message ?? error) });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <div style={styles.page}>加载中…</div>;
  }

  const running = status?.running ?? false;
  const secretPlaceholder = status?.secretKeySet && !form.secretDirty
    ? "已保存（留空保持不变）"
    : "sk-lf-…";

  return (
    <div style={styles.page}>
      <div style={styles.pageHeader}>
        <div>
          <h3 style={styles.heading}>可观测上报（OpenTelemetry）</h3>
          <p style={styles.description}>
            将 DSH 的会话、Agent 循环、LLM 调用与工具生命周期作为 OpenTelemetry GenAI
            调用链上报到 Langfuse 等 OTLP 兼容平台。填写平台的 Public Key、Secret Key
            与 Endpoint，保存后立即生效，无需重启。
          </p>
        </div>
        <span style={running ? styles.badgeOn : styles.badgeOff}>
          {running ? "上报中" : "未上报"}
        </span>
      </div>

      {status?.lastError ? (
        <div style={styles.error}>采集器启动失败：{status.lastError}</div>
      ) : null}

      <div style={styles.formCard}>
        <label style={styles.field}>
          <span>
            Endpoint <span style={styles.hint}>OTLP/HTTP 基地址；填 Langfuse 站点地址（含自建，如 http://localhost:3000）且 key 为 pk-lf-/sk-lf- 时自动补全 /api/public/otel</span>
          </span>
          <input
            style={styles.input}
            value={form.endpoint}
            placeholder={LANGFUSE_CLOUD_PLACEHOLDER}
            onChange={(event) => patch({ endpoint: event.target.value })}
            spellCheck={false}
          />
        </label>

        <label style={styles.field}>
          <span>
            Public Key (pk) <span style={styles.hint}>Langfuse 项目设置 → API Keys；其他平台留空则不发送认证头</span>
          </span>
          <input
            style={styles.input}
            value={form.publicKey}
            placeholder="pk-lf-…"
            onChange={(event) => patch({ publicKey: event.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label style={styles.field}>
          <span>
            Secret Key (sk) <span style={styles.hint}>仅保存在本机 DSH 数据目录，不会回显</span>
          </span>
          <input
            style={styles.input}
            type="password"
            value={form.secretKey}
            placeholder={secretPlaceholder}
            onChange={(event) => patch({ secretKey: event.target.value, secretDirty: true })}
            autoComplete="new-password"
          />
        </label>

        <div style={styles.switchRow}>
          <label style={styles.switch}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            <span>启用上报</span>
          </label>
          <label style={styles.switch}>
            <input
              type="checkbox"
              checked={form.captureContent}
              onChange={(event) => patch({ captureContent: event.target.checked })}
            />
            <span>
              采集正文
              <span style={styles.hint}>（上报 prompt、回复、工具参数与结果；关闭则只上报结构元数据与 token 用量）</span>
            </span>
          </label>
        </div>

        <div style={styles.actions}>
          <button
            type="button"
            style={styles.secondary}
            disabled={testing || saving}
            onClick={handleTest}
          >
            {testing ? "测试中…" : "发送测试 Trace"}
          </button>
          <button
            type="button"
            style={styles.primary}
            disabled={saving || testing}
            onClick={handleSave}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {notice ? (
        <div style={notice.kind === "ok" ? styles.noticeOk : styles.error}>{notice.text}</div>
      ) : null}

      {running && status?.traceEndpoint ? (
        <p style={styles.meta}>
          当前 Trace 上报地址：<code style={styles.code}>{status.traceEndpoint}</code>
          {status.traceEndpoint.includes("/api/public/otel") ? "（Langfuse 平台不接收 OTLP 指标，已自动只上报 Trace）" : ""}
        </p>
      ) : null}
    </div>
  );
}

const styles = {
  // Settings owns the foreground color in both light and dark appearances;
  // inherit it rather than hard-coding a label color (see dsh-ssh-ops).
  page: { padding: "20px 2px", color: "inherit", maxWidth: 760 },
  pageHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 18, marginBottom: 16 },
  heading: { margin: 0, fontSize: 18 },
  description: { margin: "6px 0 0", fontSize: 13, color: "inherit", opacity: 0.76, lineHeight: 1.5 },
  badgeOn: { flex: "none", fontSize: 11, color: "#32c56c", background: "rgba(50,197,108,.16)", padding: "3px 8px", borderRadius: 99 },
  badgeOff: { flex: "none", fontSize: 11, color: "inherit", opacity: 0.7, background: "rgba(127,127,127,.16)", padding: "3px 8px", borderRadius: 99 },
  formCard: { display: "flex", flexDirection: "column", gap: 12, padding: 16, border: "1px solid rgba(127,127,127,.4)", borderRadius: 10 },
  field: { display: "flex", flexDirection: "column", gap: 5, fontSize: 13 },
  hint: { color: "inherit", opacity: 0.7, fontWeight: 400, fontSize: 12 },
  input: { width: "100%", boxSizing: "border-box", border: "1px solid rgba(127,127,127,.55)", borderRadius: 7, padding: "7px 9px", background: "transparent", color: "inherit", fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  switchRow: { display: "flex", flexDirection: "column", gap: 8, marginTop: 2 },
  switch: { display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer" },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  primary: { border: 0, borderRadius: 7, padding: "7px 14px", background: "var(--dsw-alias-button-primary-fill, #2d6cdf)", color: "var(--dsw-alias-label-primary-foreground, #fff)", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
  secondary: { border: "1px solid rgba(127,127,127,.55)", borderRadius: 7, padding: "6px 12px", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" },
  error: { marginTop: 12, padding: "8px 10px", borderRadius: 7, background: "rgba(240,113,113,.15)", color: "#ff8a8a", fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" },
  noticeOk: { marginTop: 12, padding: "8px 10px", borderRadius: 7, background: "rgba(50,197,108,.14)", color: "#32c56c", fontSize: 13, lineHeight: 1.5 },
  meta: { marginTop: 12, fontSize: 12, color: "inherit", opacity: 0.76, lineHeight: 1.5 },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }
};

# dsh-otel

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的可观测上报插件，
带原生配置面板的离线 `.tgz` 包。把 DSH 的会话、Agent 循环、LLM 调用和工具生命周期作为
OpenTelemetry GenAI 调用链上报到 Langfuse 等 OTLP 兼容平台。

采集与 OTLP 管线来自 Apache-2.0 协议的
[@loongsuite/dsh-plugin](https://github.com/loongsuite/dsh-plugin)（已打进包内，见 THIRD-PARTY-NOTICES）。
本插件在它之上补了三件事：

- **原生配置面板**：DSH Web UI 的 设置 → 插件 里多一个「可观测上报」页，填 Public Key、
  Secret Key、Endpoint 三个参数，外加「启用上报」和「采集正文」两个开关。
- **保存即生效**：配置存在本机 DSH 数据目录（storage domain），保存后热重启采集管线，
  不用改 `cordis.patch.yml`，不用设环境变量，不用重启 DSH。
- **一键连通性测试**：面板里点「发送测试 Trace」会真发一条 span 到你填的后端，
  认证错误、地址写错、网络不通分别给出对应提示；成功后平台上能看到一条名为
  `dsh-otel connection test` 的调用链。

包内没有任何运行时依赖（OTel SDK、zod 等全部打进 `lib/`），安装时不需要访问 npm registry，
适合离线环境。

## 安装

桌面版（[DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop)）：
菜单「插件 → 配置中心 → 插件 → 从 .tgz 安装」，选中 `dsh-otel-<版本>.tgz`。

命令行：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-otel-0.1.3.tgz
```

要观测 headless profile 的话再执行一次 `--profile headless`（headless 没有界面，
配置沿用同一存储）。

## 配置

打开 DSH Web UI，设置 → 插件 → 可观测上报：

| 字段 | 说明 |
| --- | --- |
| Endpoint | OTLP/HTTP 基地址。粘贴 Langfuse base url 会像官方 SDK 一样自动在其后补全 `/api/public/otel`（云端按域名识别，自建/网关部署按 `pk-lf-`/`sk-lf-` key 前缀识别，网关子路径如 `https://gateway.corp/langfuse` 也支持）；填以 `/v1/traces` 结尾的完整地址则原样使用，不做补全；通用 OTLP 后端（Jaeger、SigNoz、Collector 等）填到端口即可，如 `http://localhost:4318`。 |
| Public Key (pk) | Langfuse 项目设置 → API Keys 里的 `pk-lf-…`。和 sk 一起编码成 `Authorization: Basic` 请求头；两者都留空则不发认证头。 |
| Secret Key (sk) | `sk-lf-…`。只保存在本机 DSH 数据目录，不回显、不进入前端状态。 |
| 启用上报 | 总开关。关闭后采集器卸载，配置保留。 |
| 采集正文 | 默认开。上报 prompt、回复、工具参数与结果正文；关闭后只上报结构元数据和 token 用量。正文可能包含源码和凭据，接入共享后端前先确认平台的留存与访问控制策略。 |

Langfuse 不接收 OTLP 指标，检测到 Langfuse 形态的 endpoint 时自动只上报 Trace，
避免周期性 4xx 报错；其他后端会同时上报 `gen_ai.client.operation.duration` 和
`gen_ai.client.token.usage` 指标。

数据模型、span 结构和隐私行为与 `@loongsuite/dsh-plugin` 一致：每轮对话一条
`ENTRY → AGENT → STEP → LLM/TOOL` 调用链，重试保留为同一 STEP 下的多次尝试，
subagent 会话生成独立 trace。详见其
[README](https://github.com/loongsuite/dsh-plugin/blob/main/README.zh-CN.md)。

## 与 @loongsuite/dsh-plugin 的关系

不要同时安装两者，会产生重复调用链。dsh-otel 适合想在界面里管理配置的场景；
习惯环境变量和 patch 文件、或需要它全部高级配置项（batch 大小、导出间隔等）的场景，
直接用上游插件即可。本插件对未暴露的配置项一律采用上游默认值。

## 开发

需要 Node.js 22.19+。

```sh
npm install
npm run build        # esbuild 打出 lib/{index,typert,remote,client}.js
npm test             # 纯函数单测 + 本地 OTLP 桩的导出 e2e
npm run pack:tgz     # 构建并打出 dsh-otel-<版本>.tgz
```

集成测试（真实 cordis Context + 桩服务）：

```sh
npm install --no-save --legacy-peer-deps @deepseek-ai/cordis@4.0.1 \
  @deepseek-ai/dsh-typert-protocol@^0.1.0-rc.6 @deepseek-ai/dsh-storage-domain@^0.1.0-rc.6 \
  @deepseek-ai/dsh-storage@^0.1.0-rc.6 @deepseek-ai/dsh-invariants@^0.1.0-rc.6
node test/service.integration.mjs
```

### 结构

```
src/index.js          host 半：cordis Service（key: dshOtel）。配置存 storage domain，
                      保存后热重启内嵌的 loongsuite 采集器；test 方法走一条真实的
                      OTLP 导出管线
src/typert.js         host 侧 typert 清单（strict 派发编解码）
src/remote.js         client 侧 typert contribution（与 host 共用 descriptors）
src/schemas.js        zod 线上契约，两端共用
src/client/           浏览器半：设置页签注册（settings.plugins.tab slot）与表单
scripts/build.mjs     四个产物的 esbuild 配置；DSH 运行时自带的包保持 external，
                      其余全部打进产物
```

兼容范围沿用内嵌采集器：DSH `>=0.1.0-rc.6 <0.2.0`（在 `0.1.1-rc.2` 的 web profile
实测通过）。

## 许可证

本项目 MIT。打进包内的第三方代码按各自协议分发（loongsuite 与 OpenTelemetry 为
Apache-2.0，zod 与 schemastery 为 MIT），版权声明与 Apache-2.0 全文见
[THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES)。

/**
 * Invocation descriptors for the `dshOtel` Remote — one source of truth
 * consumed by both the host TYPERT manifest (typert.js) and the client
 * contribution (remote.js), mirroring the shape the dsh typert generator
 * emits (same layout as the dsh-ssh-ops reference plugin).
 */
import * as S from "./schemas.js";

const PACKAGE = "dsh-otel";
const NS = "dshOtel";

function def(method, requestSchema, requestType, resultSchema, resultType) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: { mode: "strict", typeSymbol: `${PACKAGE}/types#${requestType}`, schema: requestSchema }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: `${PACKAGE}/types#${resultType}`,
      schema: resultSchema
    },
    sourceLocation: { file: "src/index.js", line: 1, column: 1 }
  };
}

export const DESCRIPTORS = [
  def("status", S.statusRequestSchema, "OtelStatusRequest", S.statusResultSchema, "OtelStatusResult"),
  def("save", S.saveRequestSchema, "OtelSaveRequest", S.saveResultSchema, "OtelSaveResult"),
  def("test", S.testRequestSchema, "OtelTestRequest", S.testResultSchema, "OtelTestResult"),
  def("verifyRecent", S.verifyRecentRequestSchema, "OtelVerifyRecentRequest", S.verifyRecentResultSchema, "OtelVerifyRecentResult")
];

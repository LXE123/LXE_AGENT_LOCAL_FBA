import type { JsonValue } from "@lxe/protocol";

export type JsonRpcId = string | number | null;
export type JsonRpcSuccess = { jsonrpc: "2.0"; id: JsonRpcId; result: JsonValue };
export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: JsonValue };
};
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcCall = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };
export class JsonRpcError extends Error {
  constructor(readonly rpcCode: number, message: string) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function parseJsonRpcJson(line: string): unknown {
  try { return JSON.parse(line); }
  catch (cause) {
    throw new JsonRpcError(-32700, cause instanceof Error ? cause.message : String(cause));
  }
}

/** Validate the envelope separately so invalid params still retain request identity. */
export function parseJsonRpcEnvelope(value: unknown): JsonRpcCall | JsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonRpcError(-32600, "JSON-RPC message must be an object");
  }
  const object = value as Record<string, unknown>;
  if (object.jsonrpc !== "2.0") throw new JsonRpcError(-32600, "jsonrpc must equal 2.0");
  if ("id" in object && !isJsonRpcId(object.id)) throw new JsonRpcError(-32600, "Invalid JSON-RPC id");
  if ("method" in object) {
    if (typeof object.method !== "string" || "result" in object || "error" in object) {
      throw new JsonRpcError(-32600, "Invalid JSON-RPC call envelope");
    }
    return object as JsonRpcCall;
  }
  if (!("id" in object) || ("result" in object) === ("error" in object)) {
    throw new JsonRpcError(-32600, "JSON-RPC response requires id and exactly one of result/error");
  }
  if ("error" in object) {
    const error = object.error as Record<string, unknown> | null;
    if (!error || typeof error !== "object" || Array.isArray(error)
      || !Number.isInteger(error.code) || typeof error.message !== "string") {
      throw new JsonRpcError(-32600, "Invalid JSON-RPC error object");
    }
  }
  return object as JsonRpcResponse;
}

import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { JsonRpcClient, RpcConnectionClosedError } from "../src/app-server/rpc.js";
import type { ServerRequest } from "../src/app-server/generated/ServerRequest.js";
import { nullLogger } from "../src/logger.js";

function harness(handler?: (request: ServerRequest) => Promise<unknown>) {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const client = new JsonRpcClient(serverToClient, clientToServer, {
    logger: nullLogger,
    defaultTimeoutMs: 1_000,
    ...(handler ? { requestHandler: handler } : {}),
  });
  return { client, serverToClient, clientToServer };
}

async function nextWire(stream: PassThrough): Promise<Record<string, unknown>> {
  const [chunk] = await once(stream, "data") as [Buffer];
  return JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>;
}

test("JSON-RPC correlates out-of-order responses", async () => {
  const { client, serverToClient, clientToServer } = harness();
  const first = client.request<string>("first", { a: 1 });
  const firstWire = await nextWire(clientToServer);
  const second = client.request<string>("second", { b: 2 });
  const secondWire = await nextWire(clientToServer);
  serverToClient.write(`${JSON.stringify({ id: secondWire.id, result: "two" })}\n`);
  serverToClient.write(`${JSON.stringify({ id: firstWire.id, result: "one" })}\n`);
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);
  assert.equal(client.pendingCount, 0);
  client.close();
});

test("JSON-RPC handles server-initiated requests", async () => {
  const { client, serverToClient, clientToServer } = harness(async (request) => {
    assert.equal((request as { method: string }).method, "item/fileChange/requestApproval");
    return { decision: "accept" };
  });
  serverToClient.write(`${JSON.stringify({ id: "approval-1", method: "item/fileChange/requestApproval", params: {} })}\n`);
  assert.deepEqual(await nextWire(clientToServer), { id: "approval-1", result: { decision: "accept" } });
  client.close();
});

test("unknown notifications are delivered without breaking transport", async () => {
  const { client, serverToClient } = harness();
  const notification = once(client, "notification");
  serverToClient.write(`${JSON.stringify({ method: "future/event", params: { value: 7 } })}\n`);
  assert.deepEqual((await notification)[0], { method: "future/event", params: { value: 7 } });
  client.close();
});

test("connection death rejects every pending request", async () => {
  const { client } = harness();
  const pending = client.request("never");
  client.close(new RpcConnectionClosedError("process died"));
  await assert.rejects(pending, /process died/u);
  assert.equal(client.pendingCount, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppServerClient } from "../src/app-server/client.js";

test("app-server client forwards native multimodal turn inputs", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const supervisor = {
    request(method: string, params: unknown) {
      requests.push({ method, params });
      return Promise.resolve({ turn: { id: "turn-1" } });
    },
  };
  const client = new AppServerClient(supervisor as never);
  await client.startTurn("thread-1", [
    { type: "text", text: "Опиши", text_elements: [] },
    { type: "localImage", path: "/data/image.jpg" },
    { type: "localAudio", path: "/data/voice.ogg" },
  ], "tg:1:2:3");
  assert.deepEqual(requests, [{
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [
        { type: "text", text: "Опиши", text_elements: [] },
        { type: "localImage", path: "/data/image.jpg" },
        { type: "localAudio", path: "/data/voice.ogg" },
      ],
      clientUserMessageId: "tg:1:2:3",
    },
  }]);
});

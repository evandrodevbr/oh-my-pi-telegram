/**
 * Telegram activity API domain regressions
 * Zones: pi agent lifecycle, extension API, operational delivery
 * Mirrors lib/activity.ts and protects registration, normalization, source identity, coalescing, delivery contexts, and shutdown fencing
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTelegramActivityHandlers,
  createTelegramActivityBridgeRuntime,
  createTelegramActivityDispatcher,
  createTelegramActivityRuntime,
  registerTelegramActivityHandler,
  type TelegramActivityEvent,
} from "../lib/activity.ts";
import {
  bindTelegramDeliveryRuntime,
  clearTelegramDeliveryRuntime,
  type TelegramDeliveryRuntime,
} from "../lib/delivery.ts";

function waitForActivityDispatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createEvent(
  type: "agent-start" | "agent-end" | "agent-settled",
  sequence = 1,
): TelegramActivityEvent {
  return {
    type,
    activityId: "activity-one",
    sequence,
    source: "local",
    timestamp: sequence,
  };
}

test.afterEach(() => {
  clearTelegramActivityHandlers();
  clearTelegramDeliveryRuntime();
});

test("Activity registry orders stable ids and rejects duplicates", async () => {
  const events: string[] = [];
  registerTelegramActivityHandler({
    id: "second",
    order: 10,
    handle: () => {
      events.push("second");
    },
  });
  const disposeFirst = registerTelegramActivityHandler({
    id: "first",
    order: 0,
    handle: () => {
      events.push("first");
    },
  });
  assert.throws(
    () =>
      registerTelegramActivityHandler({
        id: "first",
        handle: () => {},
      }),
    /already registered/,
  );
  const dispatcher = createTelegramActivityDispatcher();
  dispatcher.dispatch(createEvent("agent-start"));
  await waitForActivityDispatch();
  assert.deepEqual(events, ["first", "second"]);
  disposeFirst();
  dispatcher.dispatch(createEvent("agent-end", 2));
  await waitForActivityDispatch();
  assert.deepEqual(events, ["first", "second", "second"]);
});

test("Activity dispatcher is non-blocking and isolates handler failures", async () => {
  let release: (() => void) | undefined;
  const events: string[] = [];
  const failures: string[] = [];
  registerTelegramActivityHandler({
    id: "slow",
    handle: async (event) => {
      events.push(`${event.type}:start`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push(`${event.type}:end`);
    },
  });
  registerTelegramActivityHandler({
    id: "broken",
    handle: () => {
      throw new Error("boom");
    },
  });
  const dispatcher = createTelegramActivityDispatcher({
    recordFailure: (id, event) => failures.push(`${id}:${event.type}`),
  });
  dispatcher.dispatch(createEvent("agent-start"));
  await waitForActivityDispatch();
  assert.deepEqual(events, ["agent-start:start"]);
  assert.deepEqual(failures, ["broken:agent-start"]);
  release?.();
  await waitForActivityDispatch();
  assert.deepEqual(events, ["agent-start:start", "agent-start:end"]);
});

test("Activity dispatcher coalesces adjacent deltas but preserves boundaries", async () => {
  const received: TelegramActivityEvent[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      received.push(event);
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  dispatcher.dispatch({
    type: "assistant-text-delta",
    activityId: "activity-one",
    sequence: 1,
    source: "telegram",
    timestamp: 1,
    contentIndex: 0,
    delta: "hel",
  });
  dispatcher.dispatch({
    type: "assistant-text-delta",
    activityId: "activity-one",
    sequence: 2,
    source: "telegram",
    timestamp: 2,
    contentIndex: 0,
    delta: "lo",
  });
  dispatcher.dispatch({
    ...createEvent("agent-end", 3),
    activityId: "activity-one",
    source: "telegram",
  });
  await waitForActivityDispatch();
  assert.equal(received.length, 2);
  assert.equal(received[0]?.type, "assistant-text-delta");
  if (received[0]?.type === "assistant-text-delta") {
    assert.equal(received[0].delta, "hello");
    assert.equal(received[0].sequence, 2);
  }
  assert.equal(received[1]?.type, "agent-end");
});

test("Activity normalizer classifies source and assistant segment placement", async () => {
  const received: TelegramActivityEvent[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      received.push(event);
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  const runtime = createTelegramActivityRuntime({
    generation: "generation-one",
    dispatcher,
    now: () => 10,
  });
  runtime.recordInputSource("extension");
  runtime.onAgentStart({ chatId: 42, threadId: 7 });
  runtime.onAssistantEvent({
    type: "text_end",
    contentIndex: 0,
    content: "I will inspect this.",
  });
  runtime.onAssistantEvent({ type: "toolcall_start", contentIndex: 1 });
  runtime.onAssistantEvent({
    type: "thinking_delta",
    contentIndex: 2,
    delta: "reason",
  });
  runtime.onAssistantEvent({
    type: "thinking_end",
    contentIndex: 2,
    content: "reasoning complete",
  });
  runtime.onAssistantEvent({
    type: "text_end",
    contentIndex: 3,
    content: "Final answer.",
  });
  runtime.onAssistantEvent({ type: "done" });
  runtime.onAgentEnd();
  runtime.onAgentSettled();
  await waitForActivityDispatch();
  assert.equal(received[0]?.source, "telegram");
  assert.deepEqual(received[0]?.target, { chatId: 42, threadId: 7 });
  assert.equal(Object.isFrozen(received[0]?.target), true);
  assert.deepEqual(
    received.map((event) => event.type),
    [
      "agent-start",
      "assistant-segment",
      "reasoning-delta",
      "reasoning-end",
      "assistant-segment",
      "agent-end",
      "agent-settled",
    ],
  );
  const segments = received.filter(
    (event): event is Extract<TelegramActivityEvent, { type: "assistant-segment" }> =>
      event.type === "assistant-segment",
  );
  assert.deepEqual(
    segments.map((event) => event.placement),
    ["intermediate", "final"],
  );
  assert.equal(new Set(received.map((event) => event.activityId)).size, 1);
});

test("Activity normalizer distinguishes local, autonomous, and unknown activities", async () => {
  const sources: string[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      if (event.type === "agent-start") sources.push(event.source);
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  const runtime = createTelegramActivityRuntime({
    generation: "generation-one",
    dispatcher,
  });
  runtime.recordInputSource("interactive");
  runtime.onAgentStart();
  runtime.onAgentSettled();
  runtime.recordInputSource("extension");
  runtime.onAgentStart();
  runtime.onAgentSettled();
  runtime.onAgentStart();
  runtime.onAgentSettled();
  await waitForActivityDispatch();
  assert.deepEqual(sources, ["local", "autonomous", "unknown"]);
});

test("Activity normalizer abandons standalone compaction before the next run", async () => {
  const received: TelegramActivityEvent[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      received.push(event);
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  const runtime = createTelegramActivityRuntime({
    generation: "generation-one",
    dispatcher,
  });

  runtime.onCompactionStart("manual");
  runtime.recordInputSource("interactive");
  runtime.onAgentStart();
  runtime.onCompactionEnd("manual");
  await waitForActivityDispatch();

  assert.deepEqual(
    received.map((event) => event.type),
    ["compaction-start", "agent-start"],
  );
  assert.notEqual(received[0]?.activityId, received[1]?.activityId);
  assert.equal(received[1]?.sequence, 1);
  assert.equal(received[1]?.source, "local");
});

test("Activity normalizer ignores late completion after compaction abandonment", async () => {
  const received: TelegramActivityEvent[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      received.push(event);
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  const runtime = createTelegramActivityRuntime({
    generation: "generation-one",
    dispatcher,
  });

  runtime.onCompactionStart("threshold");
  runtime.onCompactionAbandoned();
  runtime.onCompactionEnd("threshold");
  runtime.onAgentStart();
  await waitForActivityDispatch();

  assert.deepEqual(
    received.map((event) => event.type),
    ["compaction-start", "agent-start"],
  );
  assert.notEqual(received[0]?.activityId, received[1]?.activityId);
});

test("Activity bridge creates a fresh dispatcher after session replacement", async () => {
  const received: TelegramActivityEvent[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      received.push(event);
    },
  });
  const runtime = createTelegramActivityBridgeRuntime({
    generation: "bridge-generation",
  });

  runtime.onSessionStart?.();
  runtime.onAgentStart();
  await waitForActivityDispatch();
  runtime.onSessionShutdown();

  runtime.onSessionStart?.();
  runtime.onAgentStart();
  await waitForActivityDispatch();

  assert.deepEqual(
    received.map((event) => event.type),
    ["agent-start", "agent-start"],
  );
  assert.notEqual(received[0]?.activityId, received[1]?.activityId);
  assert.match(received[0]?.activityId ?? "", /bridge-generation:1:/);
  assert.match(received[1]?.activityId ?? "", /bridge-generation:2:/);
});

test("In-flight Activity handlers cannot deliver through a replacement session", async () => {
  const deliveryCalls: string[] = [];
  let releaseHandler: (() => void) | undefined;
  let markHandlerStarted: (() => void) | undefined;
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  registerTelegramActivityHandler({
    id: "blocked",
    async handle(_event, ctx) {
      markHandlerStarted?.();
      await handlerGate;
      const result = await ctx.send({ text: "stale work" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "runtime-unavailable");
    },
  });
  const activityRuntime = createTelegramActivityBridgeRuntime({
    generation: "bridge-generation",
  });
  activityRuntime.onSessionStart?.();
  activityRuntime.onAgentStart();
  await handlerStarted;

  activityRuntime.onSessionShutdown();
  bindTelegramDeliveryRuntime({
    generation: "replacement-delivery",
    shutdown() {},
    async sendView() {
      deliveryCalls.push("send");
      return {
        ok: true,
        value: {
          target: { chatId: 42 },
          messageIds: [1],
          generation: "replacement-delivery",
        },
      };
    },
    async editView(handle) {
      deliveryCalls.push("edit");
      return { ok: true, value: handle };
    },
    async deleteView() {
      deliveryCalls.push("delete");
      return { ok: true, value: undefined };
    },
    async sendChatAction() {
      deliveryCalls.push("action");
      return { ok: true, value: undefined };
    },
  });
  activityRuntime.onSessionStart?.();
  releaseHandler?.();
  await waitForActivityDispatch();
  await waitForActivityDispatch();
  assert.deepEqual(deliveryCalls, []);
});

test("Activity context delegates to delivery with source-specific default scope", async () => {
  const scopes: string[] = [];
  const deliveryRuntime: TelegramDeliveryRuntime = {
    generation: "delivery-one",
    shutdown() {},
    async sendView(_view, options) {
      scopes.push(
        options.scope.kind === "target"
          ? `target:${options.scope.target.threadId ?? "root"}`
          : options.scope.kind,
      );
      return {
        ok: true,
        value: {
          target: { chatId: 42 },
          messageIds: [1],
          generation: "delivery-one",
        },
      };
    },
    async editView(handle) {
      return { ok: true, value: handle };
    },
    async deleteView() {
      return { ok: true, value: undefined };
    },
    async sendChatAction(_action, scope) {
      scopes.push(
        scope.kind === "target"
          ? `target:${scope.target.threadId ?? "root"}`
          : scope.kind,
      );
      return { ok: true, value: undefined };
    },
  };
  bindTelegramDeliveryRuntime(deliveryRuntime);
  registerTelegramActivityHandler({
    id: "delivery",
    handle: async (event, ctx) => {
      if (event.type !== "agent-start") return;
      await ctx.send({ text: "Working" });
      await ctx.chatAction("typing");
      if (event.source === "autonomous") {
        await ctx.send(
          { text: "Aggregate activity" },
          { scope: { kind: "aggregate" } },
        );
      }
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  dispatcher.dispatch({
    ...createEvent("agent-start"),
    source: "telegram",
    target: Object.freeze({ chatId: 42, threadId: 7 }),
  });
  dispatcher.dispatch({
    ...createEvent("agent-start", 2),
    activityId: "activity-two",
    source: "autonomous",
  });
  await waitForActivityDispatch();
  await waitForActivityDispatch();
  assert.deepEqual(scopes, [
    "target:7",
    "target:7",
    "instance",
    "instance",
    "aggregate",
  ]);
});

test("Delayed Telegram activity keeps the originating immutable target", async () => {
  const targets: Array<{ chatId: number; threadId?: number }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  bindTelegramDeliveryRuntime({
    generation: "delivery-one",
    shutdown() {},
    async sendView(_view, options) {
      assert.equal(options.scope.kind, "target");
      if (options.scope.kind === "target") {
        targets.push({ ...options.scope.target });
      }
      return {
        ok: true,
        value: {
          target: { chatId: 42 },
          messageIds: [1],
          generation: "delivery-one",
        },
      };
    },
    async editView(handle) {
      return { ok: true, value: handle };
    },
    async deleteView() {
      return { ok: true, value: undefined };
    },
    async sendChatAction() {
      return { ok: true, value: undefined };
    },
  });
  registerTelegramActivityHandler({
    id: "delayed-target",
    handle: async (event, ctx) => {
      if (event.activityId === "activity-one") await firstGate;
      await ctx.send({ text: event.activityId });
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  dispatcher.dispatch({
    ...createEvent("agent-start"),
    source: "telegram",
    target: Object.freeze({ chatId: 42, threadId: 7 }),
  });
  dispatcher.dispatch({
    ...createEvent("agent-start", 2),
    activityId: "activity-two",
    source: "telegram",
    target: Object.freeze({ chatId: 42, threadId: 8 }),
  });
  await waitForActivityDispatch();
  assert.deepEqual(targets, []);
  releaseFirst?.();
  await waitForActivityDispatch();
  await waitForActivityDispatch();
  assert.deepEqual(targets, [
    { chatId: 42, threadId: 7 },
    { chatId: 42, threadId: 8 },
  ]);
});

test("Activity shutdown fences queued handlers and clears normalization state", async () => {
  const received: string[] = [];
  registerTelegramActivityHandler({
    id: "capture",
    handle: (event) => {
      received.push(event.type);
    },
  });
  const dispatcher = createTelegramActivityDispatcher();
  const runtime = createTelegramActivityRuntime({
    generation: "generation-one",
    dispatcher,
  });
  runtime.onAgentStart();
  runtime.onSessionShutdown();
  runtime.onAgentEnd();
  await waitForActivityDispatch();
  assert.deepEqual(received, []);
});

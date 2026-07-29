import assert from "node:assert/strict";
import { expect, test } from "./_expect.ts";
import { createTestWhatsAppSession, textMessage } from "../src/testing.ts";

test("a later update waits for the suspended message handler", async () => {
  const driver = createTestWhatsAppSession();
  const order: string[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });

  driver.session.subscribe({
    message: async () => {
      order.push("message:start");
      markStarted();
      await suspended;
      order.push("message:end");
    },
    update: () => {
      order.push("update");
    },
  });

  const message = driver.emit({
    type: "message",
    message: textMessage({
      id: "m1",
      chatId: "person@s.whatsapp.net",
      text: "Hello",
    }),
  });
  const update = driver.emit({
    type: "update",
    update: {
      kind: "receipt",
      ref: { id: "m1", chatId: "person@s.whatsapp.net", fromMe: false },
      status: "read",
    },
  });

  await started;
  expect(order).toEqual(["message:start"]);
  release();
  await Promise.all([message, update]);
  expect(order).toEqual(["message:start", "message:end", "update"]);
});

test("reply stays in handler context and records a correctly quoted send", async () => {
  const driver = createTestWhatsAppSession();

  driver.session.subscribe({
    message: async (message, { reply }) => {
      expect("reply" in message).toBe(false);
      await reply("Received");
    },
  });

  await driver.emit({
    type: "message",
    message: textMessage({
      id: "m1",
      chatId: "person@s.whatsapp.net",
      text: "Hello",
    }),
  });

  expect(driver.commands.sent[0]).toMatchObject({
    to: "person@s.whatsapp.net",
    content: { text: "Received" },
    options: {
      quote: { id: "m1", chatId: "person@s.whatsapp.net", fromMe: false },
    },
  });
});

test("native command methods record their real inputs", async () => {
  const driver = createTestWhatsAppSession();
  const ref = { id: "m1", chatId: "person@s.whatsapp.net", fromMe: false };

  await driver.session.markRead([ref]);
  await driver.session.setTyping("person@s.whatsapp.net", true);

  expect(driver.commands.read).toEqual([{ refs: [ref] }]);
  expect(driver.commands.typing).toEqual([{ chatId: "person@s.whatsapp.net", on: true }]);
});

test("each subscription has its own cleanup even when handler maps are reused", async () => {
  const driver = createTestWhatsAppSession();
  let deliveries = 0;
  const handlers = {
    message: () => {
      deliveries += 1;
    },
  };
  const unsubscribeFirst = driver.session.subscribe(handlers);
  driver.session.subscribe(handlers);

  await driver.emit({
    type: "message",
    message: textMessage({
      id: "m1",
      chatId: "person@s.whatsapp.net",
      text: "Hello",
    }),
  });
  expect(deliveries).toBe(2);

  unsubscribeFirst();
  await driver.emit({
    type: "message",
    message: textMessage({
      id: "m2",
      chatId: "person@s.whatsapp.net",
      text: "Again",
    }),
  });
  expect(deliveries).toBe(3);
});

test("AbortSignal cancellation prevents later delivery", async () => {
  const driver = createTestWhatsAppSession();
  const controller = new AbortController();
  let deliveries = 0;
  const unsubscribe = driver.session.subscribe(
    {
      message: () => {
        deliveries += 1;
      },
    },
    { signal: controller.signal },
  );

  await driver.emit({
    type: "message",
    message: textMessage({
      id: "m1",
      chatId: "person@s.whatsapp.net",
      text: "Before abort",
    }),
  });
  controller.abort();
  unsubscribe();
  await driver.emit({
    type: "message",
    message: textMessage({
      id: "m2",
      chatId: "person@s.whatsapp.net",
      text: "After abort",
    }),
  });

  expect(deliveries).toBe(1);
});

test("a rejected handler poisons the pipeline and prevents advancement", async () => {
  const driver = createTestWhatsAppSession();
  let updateDelivered = false;
  driver.session.subscribe({
    message: () => {
      throw new Error("acceptance failed");
    },
    update: () => {
      updateDelivered = true;
    },
  });

  await assert.rejects(
    driver.emit({
      type: "message",
      message: textMessage({
        id: "m1",
        chatId: "person@s.whatsapp.net",
        text: "Hello",
      }),
    }),
    /acceptance failed/,
  );
  await assert.rejects(
    driver.emit({
      type: "update",
      update: {
        kind: "receipt",
        ref: { id: "m1", chatId: "person@s.whatsapp.net", fromMe: false },
        status: "read",
      },
    }),
    /acceptance failed/,
  );

  expect(updateDelivered).toBe(false);
});

test("a rejection waits for every matching handler to finish", async () => {
  const driver = createTestWhatsAppSession();
  let release!: () => void;
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });
  driver.session.subscribe({
    message: () => {
      throw new Error("acceptance failed");
    },
  });
  driver.session.subscribe({
    message: () => suspended,
  });

  let settled = false;
  const emitted = driver
    .emit({
      type: "message",
      message: textMessage({
        id: "m1",
        chatId: "person@s.whatsapp.net",
        text: "Hello",
      }),
    })
    .finally(() => {
      settled = true;
    });

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release();
  await assert.rejects(emitted, /acceptance failed/);
});

test("group replies quote the actual participant", async () => {
  const driver = createTestWhatsAppSession();
  driver.session.subscribe({
    message: async (_message, { reply }) => {
      await reply("Received");
    },
  });

  await driver.emit({
    type: "message",
    message: textMessage({
      id: "m1",
      chatId: "room@g.us",
      from: "person@s.whatsapp.net",
      text: "Hello",
    }),
  });

  expect(driver.commands.sent[0]?.options?.quote).toEqual({
    id: "m1",
    chatId: "room@g.us",
    fromMe: false,
    participant: "person@s.whatsapp.net",
  });
  expect(() =>
    textMessage({
      id: "m2",
      chatId: "room@g.us",
      text: "Missing sender",
    }),
  ).toThrow(/group messages require an actual sender/);
});

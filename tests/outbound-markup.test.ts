/**
 * Regression tests for Telegram outbound markup helpers
 * Exercises top-level assistant action comment parsing, stripping, and voice reply planning
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectTopLevelHtmlComments,
  parseTelegramCommentAttributes,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForDelivery,
  stripTelegramCommentMarkupForPreview,
} from "../lib/outbound-markup.ts";

test("Markup collector ignores comments inside fenced code", () => {
  const markdown = [
    "```",
    "<!-- telegram_voice: literal -->",
    "```",
    "",
    "<!-- telegram_voice: real -->",
  ].join("\n");

  const { comments } = collectTopLevelHtmlComments(markdown);

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.content.trim(), "telegram_voice: real");
});

test("Markup stripping removes closed and partial top-level comments", () => {
  assert.equal(
    stripTelegramCommentMarkupForDelivery(
      "Visible\n\n<!-- telegram_button: Hidden -->\n\nTail",
    ),
    "Visible\n\nTail",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible\n\n<!-- telegram_voice"),
    "Visible",
  );
});

test("Comment attribute parser supports quoted and unquoted values", () => {
  assert.deepEqual(
    parseTelegramCommentAttributes(
      'label="Run now" prompt=continue lang=ru rate=+20%',
    ),
    {
      label: "Run now",
      prompt: "continue",
      lang: "ru",
      rate: "+20%",
    },
  );
});

test("Voice reply planner extracts multiple voice replies and cleans markdown", () => {
  const plan = planTelegramVoiceReply(
    [
      "Visible answer.",
      "",
      "<!-- telegram_voice lang=ru rate=+20% -->",
      "Первый ответ.",
      "-->",
      "",
      '<!-- telegram_voice lang=en text="Second answer." -->',
      "",
      "Tail.",
    ].join("\n"),
  );

  assert.equal(plan.markdown, "Visible answer.\n\nTail.");
  assert.equal(plan.voiceText, "Первый ответ.\n\nSecond answer.");
  assert.deepEqual(plan.voiceReplies, [
    { text: "Первый ответ.", lang: "ru", rate: "+20%" },
    { text: "Second answer.", lang: "en" },
  ]);
  assert.equal(plan.lang, "en");
  assert.equal(plan.rate, "+20%");
});

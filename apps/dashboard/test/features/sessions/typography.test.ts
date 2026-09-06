import { expect, test } from "bun:test";
import { formatConversationDuration, thinkingParagraphs } from "../../../src/features/sessions/typography";

test("conversation duration carries seconds and minutes without spaces or zero units", () => {
  for (const [ms, expected] of [[486000,"8m6s"],[3723000,"1h2m3s"],[48000,"48s"],[60000,"1m"],[3600000,"1h"],[3601000,"1h1s"],[59999,"1m"],[3599999,"1h"],[500,"500ms"],[1200,"1.2s"],[0,"-"],[-1,"-"]] as const) {
    expect(formatConversationDuration(ms)).toBe(expected);
  }
});
test("thinking blank lines become paragraph boundaries while line breaks and indentation survive", () => {
  expect(thinkingParagraphs("first\r\n\r\nsecond\r\n  indented\r\n \r\n\r\nthird")).toEqual(["first","second\n  indented","third"]);
  expect(thinkingParagraphs("\n\n  preserved\n\n")).toEqual(["  preserved"]);
  expect(thinkingParagraphs("")).toEqual([]);
});

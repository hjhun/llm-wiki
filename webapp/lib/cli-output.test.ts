import { describe, it, expect } from "vitest";
import { cleanCliText, displayChunk } from "./cli-output";

const ESC = "\x1b";

describe("cleanCliText", () => {
  it("strips SGR color sequences but keeps the text", () => {
    const input = `${ESC}[31mhello${ESC}[0m world`;
    expect(cleanCliText(input)).toBe("hello world");
  });

  it("strips cursor / erase control sequences (cline-style output)", () => {
    const input = `${ESC}[2K${ESC}[?25lloading${ESC}[?25h done`;
    expect(cleanCliText(input)).toBe("loading done");
  });

  it("strips OSC sequences terminated by BEL or ST", () => {
    expect(cleanCliText(`${ESC}]0;title\x07body`)).toBe("body");
    expect(cleanCliText(`${ESC}]8;;http://x${ESC}\\link`)).toBe("link");
  });

  it("removes a stray trailing ESC byte that did not form a full sequence", () => {
    expect(cleanCliText(`a${ESC}`)).toBe("a");
    expect(cleanCliText(`${ESC}${ESC}[1m text`)).toBe(" text");
  });

  it("drops NUL bytes and lone carriage returns but keeps newlines", () => {
    expect(cleanCliText("a\x00b")).toBe("ab");
    expect(cleanCliText("line1\rline2\nline3")).toBe("line1line2\nline3");
    expect(cleanCliText("keep\r\nnewline")).toBe("keep\r\nnewline");
  });

  it("leaves clean text untouched", () => {
    expect(cleanCliText("plain text\nwith newline")).toBe(
      "plain text\nwith newline",
    );
  });
});

describe("displayChunk", () => {
  it("collapses carriage-return overwrite runs in a streamed chunk", () => {
    expect(displayChunk("10%\r20%\r30%")).toBe("10%");
  });

  it("returns empty string when nothing printable remains", () => {
    expect(displayChunk(`${ESC}[2K${ESC}[?25l`)).toBe("");
    expect(displayChunk("   ")).toBe("");
  });

  it("strips ANSI from a streamed chunk", () => {
    expect(displayChunk(`${ESC}[32mok${ESC}[0m`)).toBe("ok");
  });
});

import { describe, expect, it } from "vitest";
import { parseAgentCapability } from "./tools";

describe("parseAgentCapability", () => {
  it("detects codex exec automation features from help output", () => {
    const cap = parseAgentCapability({
      name: "codex",
      path: "/usr/local/bin/codex",
      version: "codex 1.0.0",
      help: [
        {
          command: "codex exec -h",
          text: [
            "Usage: codex exec [OPTIONS] [PROMPT]",
            "--json",
            "--sandbox <MODE>",
            "--model <MODEL>",
            "resume <THREAD_ID>",
          ].join("\n"),
        },
      ],
    });

    expect(cap.status).toBe("ready");
    expect(cap.invocation).toBe("codex-exec");
    expect(cap.supportsJson).toBe(true);
    expect(cap.supportsSandbox).toBe(true);
    expect(cap.supportsResume).toBe(true);
    expect(cap.supportsModel).toBe(true);
  });

  it("detects claude print mode and stream-json support", () => {
    const cap = parseAgentCapability({
      name: "claude",
      path: "/usr/local/bin/claude",
      version: "2.1.144",
      help: [
        {
          command: "claude -p -h",
          text: [
            'claude -p "query"',
            "--print",
            "--output-format stream-json",
            "--permission-mode <MODE>",
            "--resume <session>",
          ].join("\n"),
        },
      ],
    });

    expect(cap.status).toBe("ready");
    expect(cap.invocation).toBe("claude-print");
    expect(cap.supportsJson).toBe(true);
    expect(cap.supportsStreaming).toBe(true);
    expect(cap.supportsSandbox).toBe(true);
    expect(cap.supportsResume).toBe(true);
  });

  it("keeps unknown help output non-fatal", () => {
    const cap = parseAgentCapability({
      name: "cline",
      path: "/usr/local/bin/cline",
      version: null,
      help: [{ command: "cline -h", text: "Usage: cline [OPTIONS]" }],
    });

    expect(cap.status).toBe("unknown");
    expect(cap.invocation).toBe("unknown");
    expect(cap.warning).toMatch(/could not confirm/);
  });
});

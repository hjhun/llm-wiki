export type WsKey = "wiki" | "raw" | "sessions";

export type Entry = {
  name: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
  path: string;
};

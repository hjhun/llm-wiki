export type WsKey = "wiki" | "raw" | "sessions";

export type Entry = {
  name: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
  path: string;
};

export type ExplorerAction =
  | "new-file"
  | "new-dir"
  | "rename"
  | "delete"
  | "upload-file"
  | "upload-dir";

export type WsKey = "wiki" | "raw" | "progress" | "sessions";

export type Entry = {
  name: string;
  kind: "dir" | "file";
  isSymlink?: boolean;
  linkTarget?: string | null;
  broken?: boolean;
  size: number;
  mtime: number;
  path: string;
};

export type ExplorerAction =
  | "new-file"
  | "new-dir"
  | "rename"
  | "delete"
  | "empty-trash"
  | "upload-file"
  | "upload-dir";

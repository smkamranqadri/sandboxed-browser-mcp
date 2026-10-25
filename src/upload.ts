import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ToolError } from "./errors.js";

/**
 * The files browser_upload sends: host paths turned into the bytes Playwright gets, after the rules of the upload plan
 * (kis/intent/plan-file-upload.md, Paths). Only regular files inside the server's own home are read, minus a denylist of
 * credential, key, history and browser-profile locations, and each through one checked handle: Playwright never gets a
 * path to open again.
 *
 * A refusal is the server's own fixed words, naming the rule and the argument's position (files[2]), never the path,
 * its name or the system's error: a file name is not the server's to repeat as trusted text.
 */

/** Playwright's limit on the files of one call to a browser that is not on this machine; the total must stay under it. */
export const UPLOAD_LIMIT = 52_428_800;

export type FilePayload = { name: string; mimeType: string; buffer: Buffer };

/** One file ready to send: the path as given (resolved, `~/` expanded), where it really is, its size and its payload. */
export type PreparedFile = { path: string; realPath: string; size: number; payload: FilePayload };

export type UploadOptions = {
  /** The home whose files may be sent; os.homedir() when not given. */
  home?: string;
  /** Called after each wait on the filesystem: throws when the call was given up (tools.ts stillWanted). */
  wanted?: () => void;
  /** Test barriers: awaited once a file's path has passed its checks (before it is opened), and once it is open (before it is read). */
  beforeOpen?: (index: number) => Promise<void> | void;
  beforeRead?: (index: number) => Promise<void> | void;
};

const RULES = {
  "relative path": "give an absolute path, or one starting with ~/ for the server's home.",
  missing: "there is no file at that path.",
  "outside home": "only files inside the server's home folder can be uploaded.",
  "denied location": "files in credential, key, history and browser-profile locations are not uploaded.",
  "hard link": "a file with more than one hard link is not uploaded.",
  "not a regular file": "folders, sockets, pipes and devices are not uploaded.",
  unreadable: "the server cannot read this file.",
  "too large": "the files of one call must total under 52,428,800 bytes (50 MiB).",
  "changed while reading": "the file changed while it was checked or read; nothing was sent.",
} as const;

export type UploadRule = keyof typeof RULES;

/** A refusal of one file, by rule and position. */
export class UploadRefusal extends ToolError {
  constructor(
    readonly rule: UploadRule,
    readonly index: number,
  ) {
    super(`Upload refused for files[${index}] (${rule}): ${RULES[rule]}`);
  }
}

// ---- The denylist --------------------------------------------------------------------------------------------------

/** Folders whose files are not sent, as whole components, wherever they sit under the home. */
const DENIED_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".config/containers",
  ".password-store", ".local/share/keyrings", ".mozilla", ".config/google-chrome", ".config/chromium",
  ".config/BraveSoftware", ".claude", ".codex", ".local/share/sandboxed-browser-mcp",
].map((d) => d.split("/"));

/** Files not sent, as the last components of the path. */
const DENIED_FILES = [
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".bash_history", ".zsh_history", ".python_history",
  ".node_repl_history", ".psql_history", ".mysql_history", ".lesshst", ".config/fish/fish_history",
].map((f) => f.split("/"));

/** SSH private keys by name, exactly (id_ed25519.pub is the public key). */
const SSH_KEYS = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk"]);

/** Certificates and keys by extension, in any case. */
const KEY_EXTENSION = /\.(?:pem|key|p12|pfx)$/i;

const sequenceAt = (parts: string[], seq: string[], at: number): boolean => seq.every((s, i) => parts[at + i] === s);

/** Whether a path, as the components below a home root, is in a denied location. Case-sensitive except for extensions. */
function denied(parts: string[]): boolean {
  const name = parts[parts.length - 1];
  if (DENIED_DIRS.some((seq) => parts.some((_, at) => sequenceAt(parts, seq, at)))) return true;
  if (DENIED_FILES.some((seq) => parts.length >= seq.length && sequenceAt(parts, seq, parts.length - seq.length))) return true;
  return name === ".env" || name.startsWith(".env.") || SSH_KEYS.has(name) || KEY_EXTENSION.test(name);
}

/** The components of `file` below `root`, or null when it is not inside it (whole components: /home/me2 is not in /home/me). */
function below(root: string, file: string): string[] | null {
  const rel = path.relative(root, file);
  if (rel === "" || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts[0] === ".." ? null : parts;
}

/** Rules 3 and 4 for one absolute path: inside a home root, and not denied below any root it is inside. */
function placeRule(file: string, roots: string[]): UploadRule | null {
  const inside = roots.map((root) => below(root, file)).filter((parts) => parts !== null);
  if (inside.length === 0) return "outside home";
  return inside.some(denied) ? "denied location" : null;
}

// ---- Reading -------------------------------------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html", xml: "application/xml",
  json: "application/json", pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  heic: "image/heic", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf",
};
const mimeType = (name: string): string => MIME_TYPES[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
/** A failed look at a path that passed rule 3: gone, or not ours to read. */
const lookRule = (e: unknown): UploadRule => (errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR" ? "missing" : "unreadable");

/** Read-only, not through a final symlink, and not waiting on a pipe swapped in after the check. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The files of one call, checked and read (plan, Paths 1 to 7), in order; the first file refused refuses the call.
 * Throws a ToolError (an argument error, or an UploadRefusal) on any refusal; every handle is closed whatever happens.
 */
export async function prepareFiles(files: unknown, options: UploadOptions = {}): Promise<PreparedFile[]> {
  // 1. A non-empty array of non-empty strings, before any file is looked at.
  if (!Array.isArray(files)) throw new ToolError('Argument "files" must be an array of strings.');
  if (files.length === 0) throw new ToolError('Argument "files" must have at least 1 item.');
  files.forEach((f, i) => {
    if (typeof f !== "string") throw new ToolError(`Argument "files[${i}]" must be a string.`);
    if (f === "") throw new ToolError(`Argument "files[${i}]" must not be empty.`);
  });
  const wanted = options.wanted ?? (() => {});
  const home = path.resolve(options.home ?? homedir());
  const canonicalHome = await realpath(home).catch(() => home);
  wanted();
  const roots = [...new Set([home, canonicalHome])];

  const prepared: PreparedFile[] = [];
  let total = 0;
  for (const [index, given] of (files as string[]).entries()) {
    const refuse = (rule: UploadRule): never => {
      throw new UploadRefusal(rule, index);
    };
    // 2. ~/ is the home; any other relative form is refused. Normalised lexically, then made canonical.
    if (!given.startsWith("~/") && !path.isAbsolute(given)) refuse("relative path");
    const lexical = path.resolve(given.startsWith("~/") ? path.join(home, given.slice(2)) : given);
    // 3 and 4, as given, before the filesystem is asked anything about it.
    const lexicalRule = placeRule(lexical, roots);
    if (lexicalRule) refuse(lexicalRule);
    const canonical = await realpath(lexical).catch((e: unknown) => refuse(lookRule(e)));
    wanted();
    const canonicalRule = placeRule(canonical, roots);
    if (canonicalRule) refuse(canonicalRule);
    // 5. The approved identity: a regular file, before anything opens it.
    const approved = await lstat(canonical).catch((e: unknown) => refuse(lookRule(e)));
    wanted();
    if (!approved.isFile()) refuse("not a regular file");
    await options.beforeOpen?.(index);
    wanted();
    const handle = await open(canonical, OPEN_FLAGS).catch((e: unknown) => {
      // A path that passed its checks and is now a symlink, or gone, changed in between.
      const code = errorCode(e);
      return refuse(code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR" ? "changed while reading" : "unreadable");
    });
    try {
      wanted();
      const stat = await handle.stat();
      wanted();
      if (!stat.isFile()) refuse("not a regular file");
      if (stat.nlink !== 1) refuse("hard link");
      if (stat.dev !== approved.dev || stat.ino !== approved.ino) refuse("changed while reading");
      // Where the open handle really is: a parent folder swapped for a symlink is not stopped by O_NOFOLLOW.
      const located = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => refuse("unreadable"));
      wanted();
      const locatedRule = placeRule(located, roots);
      if (locatedRule) refuse(locatedRule);
      // 6. The total stays under the limit; what is read must be exactly the size the handle had.
      if (total + stat.size >= UPLOAD_LIMIT) refuse("too large");
      await options.beforeRead?.(index);
      wanted();
      const buffer = Buffer.alloc(stat.size + 1);
      let read = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read).catch(() => refuse("unreadable"));
        wanted();
        read += bytesRead;
        if (bytesRead === 0 || read === buffer.length) break;
      }
      if (read !== stat.size) refuse("changed while reading");
      total += read;
      // 7. A public payload: the name and the bytes, never a path to open again.
      const name = path.basename(lexical);
      prepared.push({ path: lexical, realPath: located, size: read, payload: { name, mimeType: mimeType(name), buffer: buffer.subarray(0, read) } });
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return prepared;
}

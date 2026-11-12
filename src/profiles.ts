import { existsSync, readFileSync } from "node:fs";
import { cdpUrl } from "./cdp.js";
import { allowlist, parseAllowlist } from "./guard.js";

/**
 * Named browser profiles. A profile is one whole browser stack (its own container, volume, ports and allowed hosts);
 * the server learns them from profiles.json in the install folder, which install.sh writes. Without that file there is
 * one profile, `default`, from BROWSER_CDP_URL and BROWSER_ALLOWED_HOSTS, as in 1.1.0.
 */

export const DEFAULT_PROFILE = "default";
/** The name rule; install.sh applies the same one. */
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,23}$/;

export interface Profile {
  name: string;
  /** The browser's debugging address. */
  cdp: () => string;
  /** The hosts this profile may reach; empty allows any. */
  hosts: () => string[];
}

/** The file's profiles, or an Error saying what is wrong with it (it is never half-read: a fence must not drop silently). */
export function parseProfiles(text: string): Profile[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("it is not valid JSON");
  }
  const list = (data as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(list)) throw new Error('it has no "profiles" list');
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const entry = raw as { name?: unknown; cdpPort?: unknown; hosts?: unknown } | null;
    const name = entry?.name;
    if (typeof name !== "string" || !PROFILE_NAME.test(name)) throw new Error(`profile ${i + 1} has no valid name (lowercase letters, digits and -, starting with a letter, at most 24 characters)`);
    if (seen.has(name)) throw new Error(`profile "${name}" is listed twice`);
    seen.add(name);
    const port = entry?.cdpPort;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`profile "${name}" has no valid cdpPort`);
    const hosts = entry?.hosts;
    if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== "string")) throw new Error(`profile "${name}": hosts must be a list of strings`);
    const fence = parseAllowlist((hosts as string[]).join(","));
    return { name, cdp: () => `http://127.0.0.1:${port}`, hosts: () => fence };
  });
}

/** Where profiles.json is: BROWSER_PROFILES_FILE, else the install folder (one above dist/). */
export const profilesPath = (): string => process.env.BROWSER_PROFILES_FILE || new URL("../profiles.json", import.meta.url).pathname;

/** All profiles of this install: from profiles.json, else the one `default` from the environment (read at each use). */
export function loadProfiles(): Profile[] {
  const file = profilesPath();
  if (!existsSync(file)) return [{ name: DEFAULT_PROFILE, cdp: cdpUrl, hosts: allowlist }];
  try {
    return parseProfiles(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
  }
}

/** BROWSER_PROFILES: the names this client may use, or undefined for all. A name that breaks the rule is an error. */
export function clientLimit(raw = process.env.BROWSER_PROFILES): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const names = raw.split(",").map((n) => n.trim()).filter(Boolean);
  const bad = names.find((n) => !PROFILE_NAME.test(n));
  if (bad !== undefined) throw new Error(`BROWSER_PROFILES: "${bad}" is not a valid profile name`);
  return names;
}

/** The profiles a client may use, and the choice of one by a call's `profile` argument. */
export class Profiles {
  private readonly byName: Map<string, Profile>;

  constructor(all: Profile[], limit?: string[]) {
    const unknown = limit?.find((n) => !all.some((p) => p.name === n));
    if (unknown !== undefined) throw new Error(`BROWSER_PROFILES names "${unknown}", which is not a profile (profiles: ${all.map((p) => p.name).join(", ") || "none"})`);
    this.byName = new Map(all.filter((p) => !limit || limit.includes(p.name)).map((p) => [p.name, p]));
    this.all = all;
  }

  readonly all: Profile[];

  /** The names this client may use. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /** The profile for a call's `profile` argument (default `default`); a ToolError-worthy Error with one plain message when it cannot be used. */
  pick(given: unknown): Profile {
    const omitted = given === undefined || given === null;
    const name = omitted ? DEFAULT_PROFILE : given;
    if (typeof name !== "string" || !PROFILE_NAME.test(name)) throw new Error(`"${String(name).slice(0, 40)}" is not a valid profile name (lowercase letters, digits and -, starting with a letter, at most 24 characters). Profiles: ${this.names().join(", ")}.`);
    const found = this.byName.get(name);
    if (found) return found;
    const known = this.all.some((p) => p.name === name);
    if (known && omitted) throw new Error(`This client may not use the "default" profile (BROWSER_PROFILES), so a call must name one with profile: ${this.names().join(", ")}.`);
    if (known) throw new Error(`Profile "${name}" is not available to this client (BROWSER_PROFILES). Profiles: ${this.names().join(", ")}.`);
    throw new Error(`There is no profile "${name}". Profiles: ${this.names().join(", ")}.`);
  }
}

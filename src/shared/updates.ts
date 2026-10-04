export type UpdateState = "idle" | "checking" | "current" | "available" | "ahead" | "error" | "rate-limited";
export interface UpdateStatus { state: UpdateState; installed: string; latest?: string; url?: string; checkedAt?: number; retryAt?: number; message?: string }
export const RELEASES_URL = "https://github.com/Bnmrnzxc/LolkaMod/releases/latest";
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
function parse(value: string) {
  if (value.length > 128) return null;
  const m = SEMVER.exec(value); if (!m) return null;
  const core = m.slice(1, 4).map(Number);
  const pre = m[4]?.split(".") ?? [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(p => !p || /^\d+$/.test(p) && p.length > 1 && p[0] === "0") || m[5]?.split(".").some(p => !p)) return null;
  return { core, pre };
}
export function compareVersions(a: string, b: string): number {
  const left = parse(a), right = parse(b); if (!left || !right) throw new Error("Invalid version");
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i], r = right.pre[i]; if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) > BigInt(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}
export function releaseURL(tag: unknown, url: unknown): string | null {
  if (typeof tag !== "string" || !parse(tag) || parse(tag)!.pre.length || typeof url !== "string") return null;
  const expected = `https://github.com/Bnmrnzxc/LolkaMod/releases/tag/${tag}`;
  return url === expected ? expected : null;
}

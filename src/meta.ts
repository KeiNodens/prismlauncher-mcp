// Client for Prism's meta API (https://meta.prismlauncher.org/v1/).
// Version resolution rules used by create_instance:
// - org.lwjgl3 version comes from the net.minecraft index entry's suggests/equals
// - loader version: explicit arg wins; else the entry whose requires pin the
//   requested Minecraft version, preferring recommended:true, else newest.

const META_BASE = "https://meta.prismlauncher.org/v1";

export const LOADER_UIDS: Record<string, string> = {
  forge: "net.minecraftforge",
  fabric: "net.fabricmc.fabric-loader",
  neoforge: "net.neoforged",
  quilt: "org.quiltmc.quilt-loader",
  liteloader: "com.mumfrey.liteloader",
};

export interface MetaVersion {
  version: string;
  recommended?: boolean;
  releaseTime?: string;
  type?: string;
  requires?: Array<{ uid: string; equals?: string; suggests?: string }>;
}

export interface MetaIndex {
  formatVersion: number;
  name: string;
  uid: string;
  versions: MetaVersion[];
}

export async function fetchIndex(uid: string): Promise<MetaIndex> {
  const res = await fetch(`${META_BASE}/${uid}/index.json`);
  if (!res.ok) throw new Error(`meta API: ${uid}/index.json -> HTTP ${res.status}`);
  return (await res.json()) as MetaIndex;
}

export async function listVersions(uid: string): Promise<MetaVersion[]> {
  const idx = await fetchIndex(uid);
  return idx.versions;
}

export function resolveLwjgl(mc: MetaVersion): string | undefined {
  const req = mc.requires?.find((r) => r.uid === "org.lwjgl3");
  return req?.equals ?? req?.suggests;
}

export function resolveLoaderVersion(
  versions: MetaVersion[],
  mcVersion: string,
  wanted?: string,
): MetaVersion {
  const compatible = versions.filter((v) =>
    v.requires?.some((r) => r.uid === "net.minecraft" && r.equals === mcVersion),
  );
  const pool = compatible.length > 0 ? compatible : versions;
  if (wanted) {
    const hit = pool.find((v) => v.version === wanted);
    if (!hit) throw new Error(`loader version ${wanted} not found for Minecraft ${mcVersion}`);
    return hit;
  }
  const recommended = pool.find((v) => v.recommended);
  if (recommended) return recommended;
  const sorted = [...pool].sort((a, b) =>
    (b.releaseTime ?? "").localeCompare(a.releaseTime ?? ""),
  );
  if (!sorted[0]) throw new Error(`no loader versions available for Minecraft ${mcVersion}`);
  return sorted[0];
}

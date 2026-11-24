// Imported images for a Site Generation (2026-11-24).
//
// Operators/clients can supply real photos on the intake. Before the durable
// KIE generation step runs, the pipeline imports them, binds each to the best
// Image Slot, and records them as Accepted Images — so slots that are covered
// are never generated (zero provider spend) and the existing assembly,
// critical-image coverage and QA see them exactly like generated assets.
//
// Fully idempotent per Build Version: deterministic attempt ids, tolerant R2
// writes, and already-accepted slots are skipped, so a retried workflow step
// converges instead of duplicating.
import type { Env } from "../env.d";
import { nowIso } from "../lib/crypto";
import { putImmutableObjectTolerant } from "../lib/assets";
import { sniffImageDimensions, orientationConforms, type ImageDimensions } from "../lib/image-dimensions";
import { buildVersionAssetKey } from "./artifact-keys";
import type { ImageImport, OnboardingSubmissionPayload } from "./lifecycle-schema";
import type { ImageSlot } from "./site-contracts";

export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const IMPORT_MIN_EDGE_PX = 400;
export const IMPORT_FETCH_TIMEOUT_MS = 20_000;

export interface FetchedImport {
  index: number;
  url: string;
  page?: ImageSlot["page"];
  alt?: string;
  bytes: Uint8Array;
  dimensions: ImageDimensions;
}

export interface ImportRejection {
  index: number;
  url: string;
  reason: string;
}

export interface SlotAssignment {
  slotId: string;
  importIndex: number;
  reused: boolean;
}

const PRIORITY_RANK: Record<ImageSlot["priority"], number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };

function slotOrientationFits(slot: ImageSlot, image: FetchedImport): boolean {
  return orientationConforms(slot.orientation, image.dimensions);
}

/**
 * Pure matching: highest-priority slots choose first. A slot takes an unused
 * image whose orientation conforms (a page hint breaks ties and may also
 * admit a non-conforming image the operator explicitly pointed at that page).
 * Under IMPORTED_ONLY, slots still empty afterwards reuse the best-fitting
 * import (asset reuse beats a missing image when generation is disabled).
 */
export function matchImportsToSlots(
  slots: ImageSlot[],
  images: FetchedImport[],
  policy: ImageImport["policy"]
): SlotAssignment[] {
  const ordered = [...slots].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const used = new Set<number>();
  const assignments: SlotAssignment[] = [];

  for (const slot of ordered) {
    let best: { image: FetchedImport; score: number } | null = null;
    for (const image of images) {
      if (used.has(image.index)) continue;
      const fits = slotOrientationFits(slot, image);
      const pageHit = image.page === slot.page;
      if (!fits && !pageHit) continue;
      const score = (fits ? 2 : 0) + (pageHit ? 4 : 0) + (image.page && !pageHit ? -3 : 0);
      if (!best || score > best.score) best = { image, score };
    }
    if (best) {
      used.add(best.image.index);
      assignments.push({ slotId: slot.id, importIndex: best.image.index, reused: false });
    }
  }

  if (policy === "IMPORTED_ONLY" && images.length > 0) {
    const assigned = new Set(assignments.map((entry) => entry.slotId));
    for (const slot of ordered) {
      if (assigned.has(slot.id)) continue;
      const fitting = images.filter((image) => slotOrientationFits(slot, image));
      const pool = fitting.length > 0 ? fitting : images;
      // Spread reuse: prefer the least-used candidate, page hint first.
      const useCount = (index: number) => assignments.filter((entry) => entry.importIndex === index).length;
      const choice = [...pool].sort(
        (a, b) =>
          Number(b.page === slot.page) - Number(a.page === slot.page) || useCount(a.index) - useCount(b.index) || a.index - b.index
      )[0]!;
      assignments.push({ slotId: slot.id, importIndex: choice.index, reused: true });
    }
  }
  return assignments;
}

export type ImageFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

async function fetchImport(
  index: number,
  entry: ImageImport["images"][number],
  fetcher: ImageFetcher
): Promise<FetchedImport | ImportRejection> {
  const reject = (reason: string): ImportRejection => ({ index, url: entry.url, reason });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(entry.url, controller.signal);
    if (!response.ok) return reject(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > IMPORT_MAX_BYTES) return reject(`larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > IMPORT_MAX_BYTES) return reject(`larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB`);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    // Header-sniffed dimensions double as the format gate: only PNG/JPEG/WEBP
    // decode. SVG/HTML/anything else (including a login page served 200) fail.
    const dimensions = sniffImageDimensions(bytes);
    if (!dimensions) return reject(`not a PNG/JPEG/WebP image (content-type '${contentType || "unknown"}')`);
    if (Math.min(dimensions.width, dimensions.height) < IMPORT_MIN_EDGE_PX) {
      return reject(`too small (${dimensions.width}x${dimensions.height}; shortest edge must be >= ${IMPORT_MIN_EDGE_PX}px)`);
    }
    return {
      index,
      url: entry.url,
      ...(entry.page ? { page: entry.page } : {}),
      ...(entry.alt ? { alt: entry.alt } : {}),
      bytes,
      dimensions,
    };
  } catch (error) {
    return reject(error instanceof Error && error.name === "AbortError" ? "timed out" : (error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ImageImportResult {
  policy: ImageImport["policy"] | null;
  requested: number;
  imported: number;
  assigned: number;
  reusedSlots: number;
  rejected: ImportRejection[];
  /** True when generation must be skipped entirely for this version. */
  skipGeneration: boolean;
}

export async function getSubmissionImageImport(env: Env, submissionId: string): Promise<ImageImport | null> {
  const row = await env.DB.prepare("SELECT payload_json FROM onboarding_submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ payload_json: string }>();
  if (!row) return null;
  return (JSON.parse(row.payload_json) as OnboardingSubmissionPayload).imageImport ?? null;
}

export async function importImagesForVersion(
  env: Env,
  input: {
    submissionId: string;
    buildId: string;
    buildVersionId: string;
    buildVersionNumber: number;
    slots: ImageSlot[];
    fetcher?: ImageFetcher;
  }
): Promise<ImageImportResult> {
  const config = await getSubmissionImageImport(env, input.submissionId);
  if (!config) {
    return { policy: null, requested: 0, imported: 0, assigned: 0, reusedSlots: 0, rejected: [], skipGeneration: false };
  }
  const fetcher: ImageFetcher = input.fetcher ?? ((url, signal) => fetch(url, { signal, redirect: "follow" }));

  const already = await env.DB.prepare("SELECT slot_id FROM accepted_images WHERE build_version_id = ?")
    .bind(input.buildVersionId)
    .all<{ slot_id: string }>();
  const accepted = new Set((already.results ?? []).map((row) => row.slot_id));
  const openSlots = input.slots.filter((slot) => !accepted.has(slot.id));

  // A retried step must converge: an import already bound to a slot of this
  // version is spent (under IMPORTED_THEN_GENERATE it is never reused).
  const spentRows = await env.DB.prepare(
    "SELECT provider_url FROM image_attempts WHERE build_version_id = ? AND provider_task_id = 'imported'"
  )
    .bind(input.buildVersionId)
    .all<{ provider_url: string }>();
  const spentUrls = new Set((spentRows.results ?? []).map((row) => row.provider_url));
  const rejected: ImportRejection[] = [];
  const fetched: FetchedImport[] = [];
  if (openSlots.length > 0) {
    const pending = config.images
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => config.policy === "IMPORTED_ONLY" || !spentUrls.has(entry.url));
    const results = await Promise.all(pending.map(({ entry, index }) => fetchImport(index, entry, fetcher)));
    for (const result of results) {
      if ("bytes" in result) fetched.push(result);
      else rejected.push(result);
    }
  }

  const assignments = matchImportsToSlots(openSlots, fetched, config.policy);
  const createdAt = nowIso();
  const byIndex = new Map(fetched.map((image) => [image.index, image] as const));
  const checksums = new Map<number, string>();

  for (const assignment of assignments) {
    const image = byIndex.get(assignment.importIndex)!;
    const r2Key = buildVersionAssetKey(input.buildId, input.buildVersionNumber, `images/${assignment.slotId}-import.webp`);
    await putImmutableObjectTolerant(env, r2Key, image.bytes, { httpMetadata: { contentType: "image/webp" } });
    if (!checksums.has(image.index)) checksums.set(image.index, await sha256Hex(image.bytes));
    const attemptId = `imp-${input.buildVersionId}-${assignment.slotId}`;
    await env.DB.prepare(
      `INSERT INTO image_attempts (id, build_id, build_version_id, slot_id, wave, attempt_number, status, provider_task_id, provider_url, r2_key, cost_usd, checksum, created_at)
       VALUES (?, ?, ?, ?, 1, 1, 'succeeded', 'imported', ?, ?, 0, ?, ?)
       ON CONFLICT (build_version_id, slot_id, attempt_number) DO NOTHING`
    )
      .bind(attemptId, input.buildId, input.buildVersionId, assignment.slotId, image.url, r2Key, checksums.get(image.index)!, createdAt)
      .run();
    const attemptRow = await env.DB.prepare(
      "SELECT id FROM image_attempts WHERE build_version_id = ? AND slot_id = ? AND attempt_number = 1"
    )
      .bind(input.buildVersionId, assignment.slotId)
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO accepted_images (build_version_id, slot_id, attempt_id, r2_key, accepted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (build_version_id, slot_id) DO NOTHING`
    )
      .bind(input.buildVersionId, assignment.slotId, attemptRow?.id ?? attemptId, r2Key, createdAt)
      .run();
  }

  const coveredAll = openSlots.every((slot) => assignments.some((entry) => entry.slotId === slot.id));
  return {
    policy: config.policy,
    requested: config.images.length,
    imported: fetched.length,
    assigned: assignments.length,
    reusedSlots: assignments.filter((entry) => entry.reused).length,
    rejected,
    // IMPORTED_ONLY never spends on generation, but only if at least one
    // import landed — with none, falling back to generation beats shipping a
    // site with unresolved placeholders.
    skipGeneration: coveredAll || (config.policy === "IMPORTED_ONLY" && fetched.length > 0),
  };
}

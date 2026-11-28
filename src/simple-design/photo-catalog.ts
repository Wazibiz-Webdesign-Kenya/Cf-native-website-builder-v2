// Imported photo catalog (FDR decision 139). A website built from supplied
// photos may only say what those photos actually show, so each one is
// described BEFORE the Design Blueprint. The catalog then informs the design,
// steers slot binding and supplies the only alt text and image facts the
// Builder, Repair and Visual QA receive. It is stored with the immutable
// submission, so every Build of that submission reads the same descriptions.

import { Type, type Static } from "@sinclair/typebox";
import type { Env } from "../env.d";
import { getObject, putImmutableObjectTolerant } from "../lib/assets";
import { runSchemaValidatedAiStage, type RawAiGenerate } from "../domain/ai-boundary";
import { getSubmissionImageImport, loadImportedPhotos, type FetchedImport, type ImageFetcher } from "../domain/image-import";
import { bytesToBase64, createSimpleVisionGenerate, type SimpleVisionImage } from "./vision";

export const PHOTO_CATALOG_SCHEMA_VERSION = "photo-catalog/1";
export const PHOTO_CATALOG_BATCH_SIZE = 4;
const PHOTO_MAX_EDGE_PX = 1024;

const DescriptionSchema = Type.Object(
  {
    number: Type.Integer({ minimum: 1 }),
    shows: Type.String({ minLength: 10, maxLength: 600 }),
    alt: Type.String({ minLength: 5, maxLength: 160 }),
    people: Type.Union([Type.Literal("none"), Type.Literal("distant"), Type.Literal("prominent")]),
  },
  { additionalProperties: false }
);

export const PhotoBatchSchema = Type.Object(
  { photos: Type.Array(DescriptionSchema, { minItems: 1, maxItems: PHOTO_CATALOG_BATCH_SIZE }) },
  { additionalProperties: false }
);

export interface CatalogPhoto {
  /** 1-based position in the submission's image list. */
  number: number;
  /** importRef() of the entry: the join key to the stored image attempt. */
  ref: string;
  orientation: "landscape" | "portrait" | "square";
  shows: string;
  alt: string;
  people: "none" | "distant" | "prominent";
}

export interface PhotoCatalog {
  version: typeof PHOTO_CATALOG_SCHEMA_VERSION;
  policy: "IMPORTED_ONLY" | "IMPORTED_THEN_GENERATE";
  photos: CatalogPhoto[];
}

export class PhotoCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoCatalogError";
  }
}

export function photoCatalogKey(submissionId: string): string {
  return `submissions/${submissionId}/photo-catalog-v1.json`;
}

/** The site copy rules forbid em and en dashes, alt text included. */
function plainText(value: string): string {
  return value.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}

function orientationOf(image: FetchedImport): CatalogPhoto["orientation"] {
  const ratio = image.dimensions.width / image.dimensions.height;
  return ratio > 1.1 ? "landscape" : ratio < 0.9 ? "portrait" : "square";
}

/** A bounded copy for the model. Falls back to the original bytes where the
 *  Images binding is unavailable. */
async function visionImage(env: Env, image: FetchedImport): Promise<SimpleVisionImage> {
  const bytes = image.bytes;
  if (env.IMAGES) {
    try {
      const output = await env.IMAGES.input(new Response(bytes).body!)
        .transform({ width: PHOTO_MAX_EDGE_PX, height: PHOTO_MAX_EDGE_PX, fit: "scale-down" })
        .output({ format: "image/webp", quality: 75 });
      return { base64: bytesToBase64(new Uint8Array(await output.response().arrayBuffer())), mimeType: "image/webp" };
    } catch {
      // Use the original below.
    }
  }
  const mimeType = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : "image/webp";
  return { base64: bytesToBase64(bytes), mimeType };
}

async function readCatalog(env: Env, submissionId: string): Promise<PhotoCatalog | null> {
  const body = await getObject(env, photoCatalogKey(submissionId));
  return body ? ((await new Response(body).json()) as PhotoCatalog) : null;
}

export interface EnsurePhotoCatalogInput {
  submissionId: string;
  siteGenerationId: string;
  buildId: string;
  buildVersionId: string;
  buildVersionNumber: number;
  /** Test seams; production uses the Coding Plan multimodal model. */
  generate?: RawAiGenerate;
  fetcher?: ImageFetcher;
}

/** Null when the submission supplies no photos. Fails closed: a build must
 *  never continue with photos nobody has looked at. */
export async function ensurePhotoCatalog(env: Env, input: EnsurePhotoCatalogInput): Promise<PhotoCatalog | null> {
  const config = await getSubmissionImageImport(env, input.submissionId);
  if (!config) return null;
  const stored = await readCatalog(env, input.submissionId);
  if (stored) return stored;

  const loaded = await loadImportedPhotos(env, config, input.fetcher);
  const photos: CatalogPhoto[] = [];
  for (let start = 0; start < loaded.photos.length; start += PHOTO_CATALOG_BATCH_SIZE) {
    const batch = loaded.photos.slice(start, start + PHOTO_CATALOG_BATCH_SIZE);
    const numbers = batch.map((image) => image.index + 1);
    const images: SimpleVisionImage[] = [];
    for (const image of batch) images.push(await visionImage(env, image));
    const run = await runSchemaValidatedAiStage<Static<typeof PhotoBatchSchema>>(env, {
      stage: "simple-photo-catalog",
      schema: PhotoBatchSchema,
      schemaVersion: PHOTO_CATALOG_SCHEMA_VERSION,
      userPrompt: `Describe the ${batch.length} attached photo(s). In attachment order their photo numbers are: ${numbers.join(", ")}.`,
      buildId: input.buildId,
      siteGenerationId: input.siteGenerationId,
      buildVersionId: input.buildVersionId,
      buildVersionNumber: input.buildVersionNumber,
      inputArtifactIds: batch.map((image) => image.url),
      generate:
        input.generate ??
        createSimpleVisionGenerate(env, images, { buildId: input.buildId, stage: "simple-photo-catalog", buildVersionNumber: input.buildVersionNumber }, { maxTokens: 4096, temperature: 0.2 }),
    });
    for (const image of batch) {
      const matches = run.value.photos.filter((photo) => photo.number === image.index + 1);
      if (matches.length !== 1) {
        throw new PhotoCatalogError(`photo ${image.index + 1} was ${matches.length === 0 ? "not described" : "described more than once"}`);
      }
      const [description] = matches;
      photos.push({
        number: description.number,
        ref: image.url,
        orientation: orientationOf(image),
        shows: plainText(description.shows),
        alt: plainText(description.alt),
        people: description.people,
      });
    }
  }
  if (photos.length === 0) return null;

  const catalog: PhotoCatalog = { version: PHOTO_CATALOG_SCHEMA_VERSION, policy: config.policy as PhotoCatalog["policy"], photos };
  await putImmutableObjectTolerant(env, photoCatalogKey(input.submissionId), JSON.stringify(catalog), {
    httpMetadata: { contentType: "application/json" },
  });
  return (await readCatalog(env, input.submissionId)) ?? catalog;
}

/** Prompt block for the Design Blueprint: the design is planned around the
 *  photos that exist. */
export function renderPhotoCatalogForBlueprint(catalog: PhotoCatalog): string {
  const lines = catalog.photos
    .map((photo) => `[PHOTO ${photo.number}] ${photo.orientation}, people: ${photo.people}. ${photo.shows}`)
    .join("\n");
  const scope =
    catalog.policy === "IMPORTED_ONLY"
      ? "These are the ONLY photographs the website will have; no image will be generated. Every image slot, the four page heroes included, MUST be planned around one of them (a photo may serve more than one slot, never twice on one page). No signature element, design rule or acceptance condition may depend on imagery that is not in this list."
      : "These photographs will be placed first; images are generated only for slots none of them serves. A slot that uses a supplied photo MUST be planned around what that photo shows.";
  return `

SUPPLIED PHOTOGRAPHS (real photos from the business, described by inspection):
${lines}

${scope} For every slot that uses a supplied photo, begin that slot's kiePrompt with the matching tag, for example "[PHOTO 3]", and write its altText to match that photo.`;
}

export interface PlacedPhoto {
  alt: string;
  shows: string;
}

/** What each slot of a Build Version REALLY shows, via the image attempt that
 *  filled it (reused attempts on later versions included). */
export async function placedPhotosBySlot(env: Env, buildVersionId: string, catalog: PhotoCatalog): Promise<Map<string, PlacedPhoto>> {
  const rows = await env.DB.prepare(
    `SELECT a.slot_id, t.provider_url FROM accepted_images a
     JOIN image_attempts t ON t.id = a.attempt_id
     WHERE a.build_version_id = ? AND t.provider_task_id = 'imported'`
  )
    .bind(buildVersionId)
    .all<{ slot_id: string; provider_url: string }>();
  const byRef = new Map(catalog.photos.map((photo) => [photo.ref, photo] as const));
  const placed = new Map<string, PlacedPhoto>();
  for (const row of rows.results ?? []) {
    const photo = byRef.get(row.provider_url);
    if (photo) placed.set(row.slot_id, { alt: photo.alt, shows: photo.shows });
  }
  return placed;
}

/** Slot -> import index, from the "[PHOTO n]" tag the Blueprint was asked to
 *  put in each brief. */
export function preferredImportsBySlot(briefs: ReadonlyArray<{ slotId: string; brief: string }>): Map<string, number> {
  const preferred = new Map<string, number>();
  for (const { slotId, brief } of briefs) {
    const tag = /\[PHOTO\s+(\d+)\]/i.exec(brief);
    if (tag) preferred.set(slotId, Number(tag[1]) - 1);
  }
  return preferred;
}

export const PHOTO_TRUTH_RULE =
  "PHOTO TRUTH (hard rule, overrides any Blueprint wording about image content): an image marked REAL PHOTO is a real photograph and its 'shows' text is the only truth about it. Use its alt text as given. Captions, overlines and the headings or copy presented as describing that photo may name ONLY things its 'shows' text states. Never present a photo as an example of an activity, group or feature it does not show (for example, a wedding photo must not illustrate team building). When no photo shows a thing, present that thing without a photo or beside an unrelated scenic photo with no caption claiming otherwise. Do not place the same photo twice on one page.";

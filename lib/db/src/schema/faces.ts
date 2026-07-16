import { pgTable, serial, text, integer, timestamp, real, boolean, index, customType } from "drizzle-orm/pg-core";

/**
 * pgvector column for face identity embeddings. Stored as `vector(512)`
 * (insightface w600k MobileFaceNet, computed fully locally via
 * onnxruntime-node — privacy-first, no image ever leaves the machine).
 */
const vector512 = customType<{ data: string }>({
  dataType() {
    return "vector(512)";
  },
});

/**
 * A person identity cluster. Faces across the library are grouped into
 * people by embedding similarity; users can assign a name ("Grandma").
 * Unnamed clusters still exist and are browsable as "Unnamed person".
 */
export const peopleTable = pgTable("people", {
  id:          serial("id").primaryKey(),
  name:        text("name"),                     // null = not yet named by the user
  coverFaceId: integer("cover_face_id"),         // face used as the avatar
  faceCount:   integer("face_count").notNull().default(0),
  centroid:    vector512("centroid"),            // running mean of member embeddings
  hidden:      boolean("hidden").notNull().default(false),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

/**
 * One detected face in one media file. Derived data (rebuildable): detection
 * and embedding run locally over the file's thumbnail.
 */
export const facesTable = pgTable("faces", {
  id:          serial("id").primaryKey(),
  mediaFileId: integer("media_file_id").notNull(),
  personId:    integer("person_id"),             // cluster assignment
  // Bounding box in thumbnail pixel coordinates.
  boxX:        real("box_x").notNull(),
  boxY:        real("box_y").notNull(),
  boxW:        real("box_w").notNull(),
  boxH:        real("box_h").notNull(),
  score:       real("score").notNull(),          // detector confidence 0..1
  cropPath:    text("crop_path"),                // face crop webp on disk
  embedding:   vector512("embedding"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("faces_file_idx").on(t.mediaFileId),
  index("faces_person_idx").on(t.personId),
]);

/**
 * Per-file face scan bookkeeping — which files have been processed by which
 * pipeline version, so the background loop knows what is pending.
 */
export const faceScanStateTable = pgTable("face_scan_state", {
  mediaFileId: integer("media_file_id").primaryKey(),
  faceVersion: integer("face_version").notNull().default(1),
  faceCount:   integer("face_count").notNull().default(0),
  scannedAt:   timestamp("scanned_at").notNull().defaultNow(),
  error:       text("error"),
});

export type PersonRow = typeof peopleTable.$inferSelect;
export type FaceRow = typeof facesTable.$inferSelect;

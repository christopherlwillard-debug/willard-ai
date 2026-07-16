export interface MediaFile {
  id: number;
  nasPath: string;
  relativePath: string;
  name: string;
  extension: string;
  mimeType: string;
  mediaType: "photo" | "video" | "audio" | "document" | "other";
  sizeBytes: number;
  modifiedAt: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  durationSeconds: number | null;
  thumbnailPath: string | null;
  indexedAt: string;
  dateTaken: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  exposure: string | null;
  focalLength: number | null;
  flash: string | null;
  colorProfile: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  videoCodec: string | null;
  videoBitrate: number | null;
  fps: number | null;
  audioCodec: string | null;
  dateCreated: string | null;
  pageCount: number | null;
  pdfAuthor: string | null;
  pdfTitle: string | null;
  pdfSubject: string | null;
  pdfKeywords: string | null;
  favorite: boolean;
  favoritedAt: string | null;
}

export interface MediaFilesResponse {
  files: MediaFile[];
  total: number;
  page: number;
  limit: number;
}

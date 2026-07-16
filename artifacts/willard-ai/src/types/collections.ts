import type { MediaFile } from "./media";

export interface SmartRule {
  mediaTypes?: string[];
  extensions?: string[];
  nameContains?: string;
  dateFrom?: string;
  dateTo?: string;
  minSizeBytes?: number;
  maxSizeBytes?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  favoritesOnly?: boolean;
}

export interface Collection {
  id: number;
  kind: "auto" | "smart" | "manual";
  name: string;
  description: string | null;
  autoKey: string | null;
  ruleJson: SmartRule | null;
  coverFileId: number | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionsResponse {
  collections: Collection[];
  favoritesCount: number;
}

export interface CollectionItemsResponse {
  collection: Collection;
  files: MediaFile[];
  total: number;
  page: number;
  limit: number;
}

export interface TimelineBucket {
  year: number;
  month: number;
  count: number;
  coverFileId: number;
}

export interface TimelineResponse {
  buckets: TimelineBucket[];
  undatedCount: number;
}

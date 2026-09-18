const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
};

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
};

export interface ImageKind {
  ext: string;
  type: string;
}

export function imageKind(file: File): ImageKind | null {
  const byType = EXTENSIONS[file.type.toLowerCase()];
  if (byType) return { ext: byType, type: MIME_TYPES[byType] };

  const suffix = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const ext = suffix === "jpeg" ? "jpg" : suffix;
  if (ext && ext in MIME_TYPES) return { ext, type: MIME_TYPES[ext] };
  return null;
}

export function isImageFile(file: File): boolean {
  return imageKind(file) !== null;
}

export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter(isImageFile);
}

/** JSON returned by `POST /api/uploads` (shared by the route and the client queue). */
export interface UploadResponse {
  version: { id: string; page: number };
  document: { id: string; docCode: string; state: string } | null;
  /** FR-UP-6: other document types in this application with the same file. */
  duplicateOf: string[];
  warnings: { code: 'duplicate' | 'reencoded'; docCodes?: string[] }[];
  /** True when the same bytes were already stored for this slot (retry). */
  idempotent: boolean;
}

export interface UploadErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string>; details?: Record<string, unknown> };
}

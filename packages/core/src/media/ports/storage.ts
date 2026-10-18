// The object storage of the media pipeline (guide step 3.2, ADR 0008). Implemented in
// @smp/media on the S3 API; locally SeaweedFS. Keys come from ../domain/storage-keys and never
// contain names the user chose.

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /**
   * Headers the upload must send exactly. Content type and length are part of the signature; the
   * browser sets the length itself from the file (guide step 8.4).
   */
  headers: Readonly<Record<string, string>>;
}

export interface StoredObject {
  size: number;
  contentType: string | null;
}

export interface StoragePort {
  /** A URL the browser uploads one object of exactly this type and length to, for a few minutes. */
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedUpload>;
  /** Size and type of an object, or null when it does not exist. */
  head(key: string): Promise<StoredObject | null>;
  /**
   * A URL to read one object for a while, for previews in the browser and for platforms. With a
   * download name the browser saves the object under that name instead of showing it.
   */
  signedGetUrl(key: string, options: { expiresInSeconds: number; downloadName?: string }): Promise<string>;
  /** The bytes of an object; fails when it is larger than maxBytes. */
  get(key: string, options: { maxBytes: number }): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void>;
  /** Deletes one object; deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Deletes every object under the prefix and returns how many there were. */
  deletePrefix(prefix: string): Promise<number>;
}

// SPDX-License-Identifier: Apache-2.0
// Original, network-free adapter for the audited signer surface.
// This prepares a signature; it DOES NOT send or retry an HTTP request.
import { AwsV4Signer } from "@svsync/aws4fetch-signer";
import { copyArrayBuffer } from "../inherited/buffer-range.js";

export interface SignInput {
  accountId: string;
  bucket: string;
  key: string;
  method: "GET" | "HEAD" | "PUT";
  accessKeyId: string;
  secretAccessKey: string;
  body?: ArrayBuffer;
  ifMatch?: string;
  ifNoneMatch?: "*";
  range?: string;
  datetime?: string;
}
export interface SignedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ArrayBuffer;
}
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const HASH = "[0-9a-f]{64}";
const objectKey = new RegExp(`^svsync/v1/${UUID}/(?:head\\.json|commits/${UUID}\\.json|manifests/${HASH}\\.json|blobs/[0-9a-f]{2}/${HASH})$`);
const probeKey = new RegExp(`^svsync-probes/${UUID}/${UUID}/conditional-write-test$`);
const MAX_SIGN_BODY = 16 * 1024 * 1024;

export async function signR2Request(input: SignInput): Promise<SignedRequest> {
  // Freeze configuration as well as payload before the first asynchronous step.
  input = { ...input };
  if (!/^[0-9a-f]{32}$/.test(input.accountId) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket) ||
      !(objectKey.test(input.key) || probeKey.test(input.key))) {
    throw new TypeError("Unapproved R2 destination");
  }
  if (!["GET", "HEAD", "PUT"].includes(input.method)) {
    throw new TypeError("Method is outside the approved surface");
  }
  if (!input.accessKeyId || !input.secretAccessKey) {
    throw new TypeError("Session credentials are required");
  }
  if (input.ifMatch !== undefined && !/^"[\x21\x23-\x7e]{1,256}"$/.test(input.ifMatch)) {
    throw new TypeError("Invalid opaque ETag");
  }
  if (input.ifNoneMatch !== undefined && input.ifNoneMatch !== "*") {
    throw new TypeError("Only create-if-absent is approved");
  }
  if (input.ifMatch !== undefined && input.ifNoneMatch !== undefined) {
    throw new TypeError("Use exactly one write condition");
  }
  if (input.method === "PUT" && input.ifMatch === undefined && input.ifNoneMatch === undefined) {
    throw new TypeError("Unconditional PUT is prohibited");
  }
  if (input.range !== undefined && (input.method !== "GET" || !/^bytes=\d+-\d+$/.test(input.range))) {
    throw new TypeError("Invalid range");
  }
  if (input.datetime !== undefined && !/^\d{8}T\d{6}Z$/.test(input.datetime)) {
    throw new TypeError("Invalid signing timestamp format");
  }
  const source = input.body ?? new ArrayBuffer(0);
  if (!(source instanceof ArrayBuffer) || source.byteLength > MAX_SIGN_BODY ||
      (input.method !== "PUT" && source.byteLength !== 0)) {
    throw new TypeError("Unsupported request body");
  }
  // Freeze the byte snapshot before any asynchronous operation.
  const body = copyArrayBuffer(source);
  const digest = await crypto.subtle.digest("SHA-256", body);
  const hash = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("");
  const headers = new Headers({"x-amz-content-sha256": hash});
  if (input.ifMatch !== undefined) headers.set("if-match", input.ifMatch);
  if (input.ifNoneMatch !== undefined) headers.set("if-none-match", input.ifNoneMatch);
  if (input.range !== undefined) headers.set("range", input.range);
  const url = `https://${input.accountId}.r2.cloudflarestorage.com/${input.bucket}/${input.key}`;
  // Credential caching is limited to this call; clearing is not a secure-erasure guarantee.
  const cache = new Map<string, ArrayBuffer>();
  try {
    const signer = new AwsV4Signer({
      url, method: input.method, headers, body,
      accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey,
      service: "s3", region: "auto", allHeaders: true, signQuery: false, cache,
      ...(input.datetime === undefined ? {} : { datetime: input.datetime }),
    });
    const signed = await signer.sign();
    return {method: signed.method, url: signed.url.toString(), headers: signed.headers, body};
  } finally {
    cache.clear();
  }
}

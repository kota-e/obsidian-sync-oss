// Original type contract for the selected adapter surface; not the upstream SDK declarations.
// SPDX-License-Identifier: Apache-2.0
export interface SignerOptions {
  url: string;
  method: string;
  headers?: HeadersInit;
  body?: ArrayBuffer;
  accessKeyId: string;
  secretAccessKey: string;
  service: string;
  region: string;
  datetime?: string;
  cache?: Map<string, ArrayBuffer>;
  allHeaders?: boolean;
  signQuery?: boolean;
}
export class AwsV4Signer {
  constructor(options: SignerOptions);
  sign(): Promise<{ method: string; url: URL; headers: Headers; body: ArrayBuffer | undefined }>;
  canonicalString(): Promise<string>;
  signature(): Promise<string>;
}

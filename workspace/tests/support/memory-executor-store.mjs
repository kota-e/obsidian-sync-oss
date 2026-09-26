// SPDX-License-Identifier: Apache-2.0
export class MemoryLocalStore {
  #files=new Map();
  constructor(files={}) {for(const [path,bytes] of Object.entries(files))
    this.#files.set(path,new Uint8Array(bytes));
    this.open=new Set();this.applies=0;this.onApply=null;
  }
  async readFresh(path) {const bytes=this.#files.get(path);return bytes?new Uint8Array(bytes):null;}
  async isOpen(path) {return this.open.has(path);}
  async createIfAbsent(path,bytes) {
    if(this.#files.has(path)) return 'occupied';
    this.#files.set(path,new Uint8Array(bytes));this.applies++;
    if(this.onApply) await this.onApply(path);
    return 'created';
  }
  async applyIfBytes(path,expected,bytes) {
    const current=this.#files.get(path);
    if(!current || current.length!==expected.length || current.some((v,i)=>v!==expected[i]))
      return 'mismatch';
    this.#files.set(path,new Uint8Array(bytes));this.applies++;
    if(this.onApply) await this.onApply(path);
    return 'applied';
  }
  set(path,bytes) {this.#files.set(path,new Uint8Array(bytes));}
  get(path) {const bytes=this.#files.get(path);return bytes?new Uint8Array(bytes):null;}
}
export class MemoryStagingStore {
  #files=new Map();
  async createIfAbsent(key,bytes) {
    if(this.#files.has(key)) return 'occupied';
    this.#files.set(key,new Uint8Array(bytes));return 'created';
  }
  async read(key) {const bytes=this.#files.get(key);return bytes?new Uint8Array(bytes):null;}
  async removeIfBytesMatch(key,expected) {
    const bytes=this.#files.get(key);
    if(!bytes || bytes.byteLength!==expected.byteLength ||
        bytes.some((value,index)=>value!==expected[index])) return false;
    this.#files.delete(key);return true;
  }
  get(key) {return this.#files.get(key)??null;}
}

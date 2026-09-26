// SPDX-License-Identifier: Apache-2.0
import { ProductError } from '../../.build/product/domain/errors.js';

export class MemoryClientStore {
  constructor(installationId) {
    this.marker={installationId,issuedJournalSequence:0,
      minimumCheckpointSequence:0,minimumCheckpointPayloadSha256:null};
    this.failRead=false; this.failReserve=false; this.failCheckpoint=false;
  }
  async load() {
    if(this.failRead) throw new ProductError('E_CLIENT_IDENTITY','Injected ClientStore read failure');
    return this.marker ? {...this.marker} : null;
  }
  async reserveJournalSequence(expected,next) {
    if(this.failReserve) throw new ProductError('E_CLIENT_IDENTITY','Injected ClientStore reserve failure');
    if(!this.marker || this.marker.issuedJournalSequence!==expected || next!==expected+1)
      throw new ProductError('E_CLIENT_IDENTITY','Journal sequence is not atomic');
    this.marker.issuedJournalSequence=next;
  }
  async recordCheckpoint(sequence,payloadSha256) {
    if(this.failCheckpoint) throw new ProductError('E_CLIENT_IDENTITY','Injected ClientStore checkpoint failure');
    if(!this.marker || sequence!==this.marker.minimumCheckpointSequence+1)
      throw new ProductError('E_CLIENT_IDENTITY','Checkpoint sequence is not atomic');
    this.marker.minimumCheckpointSequence=sequence;
    this.marker.minimumCheckpointPayloadSha256=payloadSha256;
  }
}
export class MemoryJournalStore {
  #entries=new Map();
  constructor(){this.failAppend=false;this.failReadback=false;}
  async readAll(){return [...this.#entries.values()].map(x=>new Uint8Array(x));}
  async append(bytes) {
    if(this.failAppend) throw new ProductError('E_JOURNAL_INVALID','Injected append failure');
    const event=JSON.parse(new TextDecoder().decode(bytes));
    if(this.#entries.has(event.sequence)) throw new ProductError('E_JOURNAL_INVALID','Duplicate sequence');
    this.#entries.set(event.sequence,new Uint8Array(bytes));
  }
  async readSequence(sequence) {
    const bytes=this.#entries.get(sequence);
    if(!bytes) return null;
    if(this.failReadback) return new Uint8Array([0]);
    return new Uint8Array(bytes);
  }
  dropForTest(sequence){this.#entries.delete(sequence);}
  setForTest(sequence,bytes){this.#entries.set(sequence,new Uint8Array(bytes));}
}
export class MemoryCheckpointStore {
  #slots={a:null,b:null};
  constructor(){this.failWrite=false;this.failReadback=false;}
  async readSlot(slot) {
    const bytes=this.#slots[slot];
    if(!bytes) return null;
    if(this.failReadback) return new Uint8Array([0]);
    return new Uint8Array(bytes);
  }
  async writeSlot(slot,bytes) {
    if(this.failWrite) throw new ProductError('E_CHECKPOINT_RECOVERY','Injected checkpoint failure');
    this.#slots[slot]=new Uint8Array(bytes);
  }
  tamperForTest(slot,bytes){this.#slots[slot]=new Uint8Array(bytes);}
  peekForTest(slot){return this.#slots[slot] ? new Uint8Array(this.#slots[slot]) : null;}
}
export class MemoryRecoveryStore {
  #objects=new Map();
  constructor(){this.failCreate=false;this.failRead=false;this.writes=0;}
  async createIfAbsent(key,bytes) {
    if(this.failCreate) throw new ProductError('E_RECOVERY_WRITE','Injected recovery write failure');
    this.writes++;
    if(this.#objects.has(key)) return 'occupied';
    this.#objects.set(key,new Uint8Array(bytes));
    return 'created';
  }
  async read(key) {
    if(this.failRead) throw new ProductError('E_RECOVERY_WRITE','Injected recovery read failure');
    const bytes=this.#objects.get(key);
    return bytes ? new Uint8Array(bytes) : null;
  }
  setForTest(key,bytes){this.#objects.set(key,new Uint8Array(bytes));}
  removeForTest(key){this.#objects.delete(key);}
  peekForTest(key){return this.#objects.get(key) ? new Uint8Array(this.#objects.get(key)) : null;}
}
export class MemoryLocalReader {
  #files=new Map();
  constructor(files={}) {for(const [path,bytes] of Object.entries(files)) this.#files.set(path,new Uint8Array(bytes));}
  async readFresh(path){const bytes=this.#files.get(path);return bytes ? new Uint8Array(bytes) : null;}
  setForTest(path,bytes){this.#files.set(path,new Uint8Array(bytes));}
  getForTest(path){const bytes=this.#files.get(path);return bytes ? new Uint8Array(bytes) : null;}
}

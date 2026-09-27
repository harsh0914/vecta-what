import {
  DocumentRef,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  Store,
  Transaction,
} from '../../core/ports/store.js';
import { Clock } from '../../core/ports/clock.js';

interface StoredDoc {
  data: any;
  version: number;
}

type Listener = () => void;

class InMemoryDocumentSnapshot<T = any> implements DocumentSnapshot<T> {
  constructor(
    public readonly id: string,
    public readonly exists: boolean,
    private readonly _data?: T
  ) {}

  data(): T | undefined {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : undefined;
  }
}

class InMemoryQuerySnapshot<T = any> implements QuerySnapshot<T> {
  constructor(public readonly docs: DocumentSnapshot<T>[]) {}

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }
}

class InMemoryDocumentRef<T = any> implements DocumentRef<T> {
  public readonly path: string;

  constructor(
    public readonly collection: string,
    public readonly id: string,
    private readonly store: InMemoryStore
  ) {
    this.path = `${collection}/${id}`;
  }

  async get(): Promise<DocumentSnapshot<T>> {
    return this.store.getDocDirect<T>(this.path, this.id);
  }

  async set(data: Partial<T>, options?: { merge?: boolean }): Promise<void> {
    await this.store.setDocDirect(this.path, data, options);
  }

  async update(data: Partial<T>): Promise<void> {
    await this.store.updateDocDirect(this.path, data);
  }

  async delete(): Promise<void> {
    await this.store.deleteDocDirect(this.path);
  }
}

interface FilterCondition {
  field: string;
  op: '==' | '!=' | '<=' | '>=' | '<' | '>';
  value: any;
}

class InMemoryQuery<T = any> implements Query<T> {
  constructor(
    private readonly store: InMemoryStore,
    private readonly collectionName: string,
    private readonly filters: FilterCondition[] = [],
    private readonly orderBys: Array<{ field: string; direction: 'asc' | 'desc' }> = [],
    private readonly limitCount?: number
  ) {}

  where(field: string, op: '==' | '!=' | '<=' | '>=' | '<' | '>', value: any): Query<T> {
    return new InMemoryQuery<T>(
      this.store,
      this.collectionName,
      [...this.filters, { field, op, value }],
      this.orderBys,
      this.limitCount
    );
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Query<T> {
    return new InMemoryQuery<T>(
      this.store,
      this.collectionName,
      this.filters,
      [...this.orderBys, { field, direction }],
      this.limitCount
    );
  }

  limit(limit: number): Query<T> {
    return new InMemoryQuery<T>(
      this.store,
      this.collectionName,
      this.filters,
      this.orderBys,
      limit
    );
  }

  private matchesFilter(data: any, filter: FilterCondition): boolean {
    const val = data?.[filter.field];
    switch (filter.op) {
      case '==':
        return val === filter.value;
      case '!=':
        return val !== filter.value;
      case '<':
        return val < filter.value;
      case '<=':
        return val <= filter.value;
      case '>':
        return val > filter.value;
      case '>=':
        return val >= filter.value;
      default:
        return false;
    }
  }

  getSync(): QuerySnapshot<T> {
    const allDocs = this.store.getCollectionDocs(this.collectionName);
    let matched = allDocs.filter((doc) => {
      if (!doc.data) return false;
      return this.filters.every((f) => this.matchesFilter(doc.data, f));
    });

    if (this.orderBys.length > 0) {
      matched = matched.sort((a, b) => {
        for (const order of this.orderBys) {
          const valA = a.data?.[order.field];
          const valB = b.data?.[order.field];
          if (valA === valB) continue;
          if (valA === undefined) return 1;
          if (valB === undefined) return -1;
          const cmp = valA < valB ? -1 : 1;
          return order.direction === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }

    if (this.limitCount !== undefined) {
      matched = matched.slice(0, this.limitCount);
    }

    const docs = matched.map(
      (m) => new InMemoryDocumentSnapshot<T>(m.id, true, m.data)
    );
    return new InMemoryQuerySnapshot<T>(docs);
  }

  async get(): Promise<QuerySnapshot<T>> {
    return this.getSync();
  }

  onSnapshot(
    callback: (snapshot: QuerySnapshot<T>) => void,
    onError?: (err: Error) => void
  ): () => void {
    const runAndNotify = () => {
      try {
        const snap = this.getSync();
        callback(snap);
      } catch (err: any) {
        if (onError) onError(err);
      }
    };

    // Immediate initial dispatch
    runAndNotify();

    return this.store.subscribeToCollection(this.collectionName, runAndNotify);
  }
}

class InMemoryTransaction implements Transaction {
  private readVersions = new Map<string, number>();
  private pendingWrites = new Map<
    string,
    { op: 'set' | 'update' | 'delete'; data?: any; merge?: boolean; id: string; collection: string }
  >();

  constructor(private readonly store: InMemoryStore) {}

  async get<T = any>(ref: DocumentRef<T>): Promise<DocumentSnapshot<T>> {
    const internalDoc = this.store.getInternalDoc(ref.path);
    const version = internalDoc ? internalDoc.version : 0;
    this.readVersions.set(ref.path, version);

    // If there is a pending write in this transaction, reflect it
    const pending = this.pendingWrites.get(ref.path);
    if (pending) {
      if (pending.op === 'delete') {
        return new InMemoryDocumentSnapshot<T>(ref.id, false, undefined);
      }
      return new InMemoryDocumentSnapshot<T>(ref.id, true, pending.data);
    }

    return new InMemoryDocumentSnapshot<T>(
      ref.id,
      !!internalDoc,
      internalDoc?.data
    );
  }

  set<T = any>(ref: DocumentRef<T>, data: Partial<T>, options?: { merge?: boolean }): Transaction {
    this.pendingWrites.set(ref.path, {
      op: 'set',
      data,
      merge: options?.merge,
      id: ref.id,
      collection: ref.collection,
    });
    return this;
  }

  update<T = any>(ref: DocumentRef<T>, data: Partial<T>): Transaction {
    this.pendingWrites.set(ref.path, {
      op: 'update',
      data,
      id: ref.id,
      collection: ref.collection,
    });
    return this;
  }

  delete(ref: DocumentRef): Transaction {
    this.pendingWrites.set(ref.path, {
      op: 'delete',
      id: ref.id,
      collection: ref.collection,
    });
    return this;
  }

  getReadVersions(): Map<string, number> {
    return this.readVersions;
  }

  getPendingWrites() {
    return this.pendingWrites;
  }
}

export class InMemoryStore implements Store {
  private storage = new Map<string, StoredDoc>();
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly clock?: Clock) {}

  doc<T = any>(collection: string, id: string): DocumentRef<T> {
    return new InMemoryDocumentRef<T>(collection, id, this);
  }

  collection<T = any>(name: string): Query<T> {
    return new InMemoryQuery<T>(this, name);
  }

  getInternalDoc(path: string): StoredDoc | undefined {
    return this.storage.get(path);
  }

  async getDocDirect<T>(path: string, id: string): Promise<DocumentSnapshot<T>> {
    const doc = this.storage.get(path);
    if (!doc) {
      return new InMemoryDocumentSnapshot<T>(id, false, undefined);
    }
    return new InMemoryDocumentSnapshot<T>(id, true, doc.data);
  }

  async setDocDirect(path: string, data: any, options?: { merge?: boolean }): Promise<void> {
    const existing = this.storage.get(path);
    const version = (existing?.version ?? 0) + 1;
    let finalData = data;
    if (options?.merge && existing) {
      finalData = { ...existing.data, ...data };
    }
    this.storage.set(path, {
      data: JSON.parse(JSON.stringify(finalData)),
      version,
    });
    const collection = path.split('/')[0];
    this.notifyCollection(collection);
  }

  async updateDocDirect(path: string, data: any): Promise<void> {
    const existing = this.storage.get(path);
    if (!existing) {
      throw new Error(`Document not found for update: ${path}`);
    }
    const version = existing.version + 1;
    const finalData = { ...existing.data, ...data };
    this.storage.set(path, {
      data: JSON.parse(JSON.stringify(finalData)),
      version,
    });
    const collection = path.split('/')[0];
    this.notifyCollection(collection);
  }

  async deleteDocDirect(path: string): Promise<void> {
    if (this.storage.has(path)) {
      this.storage.delete(path);
      const collection = path.split('/')[0];
      this.notifyCollection(collection);
    }
  }

  getCollectionDocs(collectionName: string): Array<{ id: string; data: any }> {
    const prefix = `${collectionName}/`;
    const results: Array<{ id: string; data: any }> = [];
    for (const [path, stored] of this.storage.entries()) {
      if (path.startsWith(prefix)) {
        const id = path.substring(prefix.length);
        results.push({ id, data: stored.data });
      }
    }
    return results;
  }

  async getAll<T = any>(...docRefs: DocumentRef<T>[]): Promise<DocumentSnapshot<T>[]> {
    const snaps: DocumentSnapshot<T>[] = [];
    for (const ref of docRefs) {
      snaps.push(await ref.get());
    }
    return snaps;
  }

  subscribeToCollection(collectionName: string, listener: Listener): () => void {
    if (!this.listeners.has(collectionName)) {
      this.listeners.set(collectionName, new Set());
    }
    const set = this.listeners.get(collectionName)!;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private notifyCollection(collectionName: string): void {
    const set = this.listeners.get(collectionName);
    if (set) {
      for (const listener of set) {
        try {
          listener();
        } catch (e) {
          console.error(`Error in store listener for ${collectionName}:`, e);
        }
      }
    }
  }

  async runTransaction<R>(
    updateFunction: (transaction: Transaction) => Promise<R>
  ): Promise<R> {
    const tx = new InMemoryTransaction(this);
    const result = await updateFunction(tx);

    // Validate Compare-And-Set (CAS) read versions
    const readVersions = tx.getReadVersions();
    for (const [path, readVer] of readVersions.entries()) {
      const current = this.storage.get(path);
      const currentVer = current ? current.version : 0;
      if (currentVer !== readVer) {
        throw new Error(
          `Transaction conflict: concurrent modification detected on ${path} (read version ${readVer}, current version ${currentVer})`
        );
      }
    }

    // Apply pending writes atomically
    const pendingWrites = tx.getPendingWrites();
    const touchedCollections = new Set<string>();

    for (const [path, write] of pendingWrites.entries()) {
      touchedCollections.add(write.collection);
      if (write.op === 'delete') {
        this.storage.delete(path);
      } else if (write.op === 'set') {
        const existing = this.storage.get(path);
        const version = (existing?.version ?? 0) + 1;
        let finalData = write.data;
        if (write.merge && existing) {
          finalData = { ...existing.data, ...write.data };
        }
        this.storage.set(path, {
          data: JSON.parse(JSON.stringify(finalData)),
          version,
        });
      } else if (write.op === 'update') {
        const existing = this.storage.get(path);
        if (!existing) {
          throw new Error(`Cannot update non-existent document in transaction: ${path}`);
        }
        const version = existing.version + 1;
        const finalData = { ...existing.data, ...write.data };
        this.storage.set(path, {
          data: JSON.parse(JSON.stringify(finalData)),
          version,
        });
      }
    }

    // Notify listeners for all affected collections
    for (const coll of touchedCollections) {
      this.notifyCollection(coll);
    }

    return result;
  }
}

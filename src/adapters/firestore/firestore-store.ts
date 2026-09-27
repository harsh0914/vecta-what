import {
  getFirestore,
  Firestore,
  DocumentReference,
  Query as AdminQuery,
  DocumentSnapshot as AdminDocumentSnapshot,
  QuerySnapshot as AdminQuerySnapshot,
  Transaction as AdminTransaction,
} from 'firebase-admin/firestore';
import { initializeApp, getApps, App } from 'firebase-admin/app';
import {
  DocumentRef,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  Store,
  Transaction,
} from '../../core/ports/store.js';

export class FirestoreDocumentSnapshot<T = any> implements DocumentSnapshot<T> {
  constructor(
    public readonly id: string,
    public readonly exists: boolean,
    private readonly rawDoc?: AdminDocumentSnapshot
  ) {}

  data(): T | undefined {
    return this.rawDoc?.data() as T | undefined;
  }
}

export class FirestoreQuerySnapshot<T = any> implements QuerySnapshot<T> {
  public readonly docs: DocumentSnapshot<T>[];

  constructor(snap: AdminQuerySnapshot) {
    this.docs = snap.docs.map(
      (d: AdminDocumentSnapshot) => new FirestoreDocumentSnapshot<T>(d.id, d.exists, d)
    );
  }

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }
}

export class FirestoreDocumentRef<T = any> implements DocumentRef<T> {
  public readonly path: string;

  constructor(
    public readonly collection: string,
    public readonly id: string,
    public readonly rawRef: DocumentReference
  ) {
    this.path = rawRef.path;
  }

  async get(): Promise<DocumentSnapshot<T>> {
    const snap = await this.rawRef.get();
    return new FirestoreDocumentSnapshot<T>(snap.id, snap.exists, snap);
  }

  async set(data: Partial<T>, options?: { merge?: boolean }): Promise<void> {
    if (options?.merge) {
      await this.rawRef.set(data as any, { merge: true });
    } else {
      await this.rawRef.set(data as any);
    }
  }

  async update(data: Partial<T>): Promise<void> {
    await this.rawRef.update(data as any);
  }

  async delete(): Promise<void> {
    await this.rawRef.delete();
  }
}

export class FirestoreQuery<T = any> implements Query<T> {
  constructor(public readonly rawQuery: AdminQuery) {}

  where(field: string, op: '==' | '!=' | '<=' | '>=' | '<' | '>', value: any): Query<T> {
    return new FirestoreQuery<T>(this.rawQuery.where(field, op as any, value));
  }

  orderBy(field: string, direction?: 'asc' | 'desc'): Query<T> {
    return new FirestoreQuery<T>(this.rawQuery.orderBy(field, direction));
  }

  limit(limit: number): Query<T> {
    return new FirestoreQuery<T>(this.rawQuery.limit(limit));
  }

  async get(): Promise<QuerySnapshot<T>> {
    const snap = await this.rawQuery.get();
    return new FirestoreQuerySnapshot<T>(snap);
  }

  onSnapshot(
    callback: (snapshot: QuerySnapshot<T>) => void,
    onError?: (err: Error) => void
  ): () => void {
    const unsubscribe = this.rawQuery.onSnapshot(
      (snap) => {
        callback(new FirestoreQuerySnapshot<T>(snap));
      },
      (err) => {
        if (onError) onError(err);
      }
    );
    return unsubscribe;
  }
}

export class FirestoreTransactionWrapper implements Transaction {
  constructor(private readonly rawTx: AdminTransaction) {}

  async get<T = any>(ref: DocumentRef<T>): Promise<DocumentSnapshot<T>> {
    const firestoreRef = (ref as FirestoreDocumentRef<T>).rawRef;
    const snap = await this.rawTx.get(firestoreRef);
    return new FirestoreDocumentSnapshot<T>(snap.id, snap.exists, snap);
  }

  set<T = any>(ref: DocumentRef<T>, data: Partial<T>, options?: { merge?: boolean }): Transaction {
    const firestoreRef = (ref as FirestoreDocumentRef<T>).rawRef;
    if (options?.merge) {
      this.rawTx.set(firestoreRef, data as any, { merge: true });
    } else {
      this.rawTx.set(firestoreRef, data as any);
    }
    return this;
  }

  update<T = any>(ref: DocumentRef<T>, data: Partial<T>): Transaction {
    const firestoreRef = (ref as FirestoreDocumentRef<T>).rawRef;
    this.rawTx.update(firestoreRef, data as any);
    return this;
  }

  delete(ref: DocumentRef): Transaction {
    const firestoreRef = (ref as FirestoreDocumentRef).rawRef;
    this.rawTx.delete(firestoreRef);
    return this;
  }
}

export interface FirestoreStoreOptions {
  projectId?: string;
  databaseId?: string;
  app?: App;
}

export class FirestoreStore implements Store {
  public readonly db: Firestore;

  constructor(options?: FirestoreStoreOptions | string, app?: App) {
    let opts: FirestoreStoreOptions = {};
    if (typeof options === 'string') {
      opts = { databaseId: options, app };
    } else if (options) {
      opts = options;
    }

    let firebaseApp: App;
    const existingApps = getApps();

    if (opts.app) {
      firebaseApp = opts.app;
    } else if (opts.projectId) {
      const appName = `vectawhat-${opts.projectId}`;
      const found = existingApps.find((a) => a.name === appName);
      if (found) {
        firebaseApp = found;
      } else {
        firebaseApp = initializeApp({ projectId: opts.projectId }, appName);
      }
    } else if (existingApps.length > 0) {
      firebaseApp = existingApps[0];
    } else {
      firebaseApp = initializeApp();
    }

    if (opts.databaseId) {
      this.db = getFirestore(firebaseApp, opts.databaseId);
    } else {
      this.db = getFirestore(firebaseApp);
    }

    try {
      this.db.settings({ ignoreUndefinedProperties: true });
    } catch {
      // Guard so it is not called twice
    }
  }

  doc<T = any>(collection: string, id: string): DocumentRef<T> {
    const ref = this.db.collection(collection).doc(id);
    return new FirestoreDocumentRef<T>(collection, id, ref);
  }

  collection<T = any>(name: string): Query<T> {
    const col = this.db.collection(name) as unknown as AdminQuery;
    return new FirestoreQuery<T>(col);
  }

  async getAll<T = any>(...docRefs: DocumentRef<T>[]): Promise<DocumentSnapshot<T>[]> {
    const rawRefs = docRefs.map((r) => (r as FirestoreDocumentRef<T>).rawRef);
    if (rawRefs.length === 0) return [];
    const snaps = await this.db.getAll(...rawRefs);
    return snaps.map((s) => new FirestoreDocumentSnapshot<T>(s.id, s.exists, s));
  }

  async runTransaction<R>(
    updateFunction: (transaction: Transaction) => Promise<R>
  ): Promise<R> {
    return this.db.runTransaction(async (rawTx) => {
      const txWrapper = new FirestoreTransactionWrapper(rawTx);
      return updateFunction(txWrapper);
    });
  }
}
